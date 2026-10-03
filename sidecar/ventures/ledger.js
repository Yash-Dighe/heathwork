'use strict';
/* sidecar/ventures/ledger.js — read a coloring-book venture's REAL state off disk.

   A venture directory is the colorbook pipeline's working directory:
     <dir>/books/<slug>/book.json      (written by `colorbook`: plan, page statuses, listing, published…)
     <dir>/books/<slug>/build/interior.pdf, cover.pdf
     <dir>/books/<slug>/listing.md
     <dir>/sales.json                  (written here, from imported KDP reports)

   readVenture(dir, { now }) -> metrics   (pure apart from file reads; `now` is injected)
   Nothing is inferred that a file does not state: a book is "live" only when book.json has a `published`
   record (set by `colorbook publish` or the Workshop's MARK LIVE), sales only come from imported reports. */
const fs = require('node:fs');
const path = require('node:path');
const { saleKey } = require('./kdp-report.js');

const STAGES = ['planned', 'drawing', 'review', 'approved', 'print-ready', 'listed', 'live'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e && e.code === 'ENOENT') return fallback; throw e; }
}

function bookFrom(dir, slug) {
  const b = readJson(path.join(dir, 'book.json'), null);
  if (!b || !b.plan) return null;
  const pages = Array.isArray(b.pages) ? b.pages : [];
  const total = (b.plan.pages || []).length || pages.length;
  const generated = pages.filter(p => p.variants && p.variants.length).length;
  const approved = pages.filter(p => p.status === 'approved').length;
  const rejected = pages.filter(p => p.status === 'rejected').length;
  const built = fs.existsSync(path.join(dir, 'build', 'interior.pdf')) && fs.existsSync(path.join(dir, 'build', 'cover.pdf'));
  const listed = !!b.listing && fs.existsSync(path.join(dir, 'listing.md'));
  const published = b.published && (b.published.asin || b.published.date) ? b.published : null;
  let stage;
  if (published) stage = 'live';
  else if (built && listed) stage = 'listed';
  else if (built) stage = 'print-ready';
  else if (total && approved >= total) stage = 'approved';
  else if (total && generated >= total) stage = 'review';
  else if (generated > 0) stage = 'drawing';
  else stage = 'planned';
  return {
    slug, title: b.plan.title || slug, subtitle: b.plan.subtitle || '', audience: b.plan.audience || '',
    stage, stageIndex: STAGES.indexOf(stage),
    pagesTotal: total, pagesGenerated: generated, pagesApproved: approved, pagesRejected: rejected,
    pagesAwaiting: Math.max(0, generated - approved - rejected),
    printReady: built, listed, published,
    price: published && Number(published.price) || (b.listing && Number(b.listing.suggested_price_usd)) || null,
    imagesGenerated: (b.usage && b.usage.image_calls) || 0,
    created: b.created || '',
  };
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function readVenture(dir, opts) {
  const now = (opts && opts.now) || 0;
  const booksDir = path.join(dir, 'books');
  const books = [];
  if (fs.existsSync(booksDir)) {
    for (const slug of fs.readdirSync(booksDir).sort()) {
      const d = path.join(booksDir, slug);
      if (!fs.statSync(d).isDirectory()) continue;
      const b = bookFrom(d, slug);
      if (b) books.push(b);
    }
  }
  const sales = readJson(path.join(dir, 'sales.json'), { rows: [], imports: [] });
  const rows = Array.isArray(sales.rows) ? sales.rows : [];

  // attribute each sale to a book: by ASIN when the book has one, else by normalised title prefix
  const byAsin = new Map(books.filter(b => b.published && b.published.asin).map(b => [String(b.published.asin).toUpperCase(), b]));
  const perBook = new Map(books.map(b => [b.slug, { units: 0, usd: 0 }]));
  let unitsSold = 0, royaltyUSD = 0, lastSaleDate = '';
  const royaltyOther = {}, monthUSD = {};
  let unmatched = 0;
  for (const r of rows) {
    const units = Number(r.units) || 0, money = Number(r.royalty) || 0;
    unitsSold += units;
    if ((r.currency || 'USD') === 'USD') { royaltyUSD += money; if (r.date) monthUSD[r.date.slice(0, 7)] = (monthUSD[r.date.slice(0, 7)] || 0) + money; }
    else royaltyOther[r.currency] = Math.round(((royaltyOther[r.currency] || 0) + money) * 100) / 100;
    if (r.date && r.date > lastSaleDate && units > 0) lastSaleDate = r.date;
    let b = r.asin ? byAsin.get(String(r.asin).toUpperCase()) : null;
    if (!b) { const t = norm(r.title); b = books.find(x => t && (t === norm(x.title) || t.startsWith(norm(x.title)))); }
    if (b) { const s = perBook.get(b.slug); s.units += units; if ((r.currency || 'USD') === 'USD') s.usd += money; }
    else unmatched++;
  }
  for (const b of books) { const s = perBook.get(b.slug); b.unitsSold = s.units; b.royaltyUSD = Math.round(s.usd * 100) / 100; }

  const imports = Array.isArray(sales.imports) ? sales.imports : [];
  const lastImport = imports.length ? imports[imports.length - 1].at : 0;
  const months = Object.keys(monthUSD).sort().map(k => ({ month: k, usd: Math.round(monthUSD[k] * 100) / 100 }));
  return {
    books,
    stageCounts: Object.fromEntries(STAGES.map(s => [s, books.filter(b => b.stage === s).length])),
    pagesApproved: books.reduce((n, b) => n + b.pagesApproved, 0),
    pagesAwaiting: books.reduce((n, b) => n + b.pagesAwaiting, 0),
    booksPrintReady: books.filter(b => b.printReady).length,
    booksLive: books.filter(b => b.stage === 'live').length,
    unitsSold, royaltyUSD: Math.round(royaltyUSD * 100) / 100, royaltyOther,
    months, bestMonthUSD: months.reduce((m, x) => Math.max(m, x.usd), 0),
    lastSaleDate, unmatchedSales: unmatched,
    imports: imports.length, lastImportAt: lastImport,
    daysSinceImport: lastImport && now ? Math.floor((now - lastImport) / 86400000) : null,
  };
}

/* Merge parsed report rows into <dir>/sales.json, de-duplicated by saleKey. Atomic write. */
function importSales(dir, parsed, meta) {
  const file = path.join(dir, 'sales.json');
  const cur = readJson(file, { rows: [], imports: [] });
  const seen = new Set((cur.rows || []).map(saleKey));
  let added = 0;
  for (const r of parsed.rows) {
    const k = saleKey(r);
    if (seen.has(k)) continue;
    seen.add(k); cur.rows.push(r); added++;
  }
  cur.imports = (cur.imports || []).concat([{ file: String(meta.file || '').slice(0, 200), at: meta.at, rows: parsed.rows.length, added }]).slice(-200);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
  fs.renameSync(tmp, file);
  return { added, duplicates: parsed.rows.length - added, total: cur.rows.length };
}

/* Mark a book live (the Commander did the KDP upload; this records it). Writes only the `published` key. */
function markPublished(dir, slug, rec) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(slug))) throw new Error('bad book id');
  const file = path.join(dir, 'books', slug, 'book.json');
  const b = readJson(file, null);
  if (!b) throw new Error('no such book');
  b.published = {
    asin: String(rec.asin || '').trim().toUpperCase().slice(0, 20),
    price: Number.isFinite(Number(rec.price)) ? Number(rec.price) : null,
    marketplace: String(rec.marketplace || 'amazon.com').slice(0, 40),
    date: String(rec.date || '').slice(0, 10),
  };
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2));
  fs.renameSync(tmp, file);
  return b.published;
}

/* PAGE REVIEW — the Commander's approval step, the same semantics as the colorbook CLI (approve / choose / reject):
     approve: [n]                 status → approved (needs a chosen variant)
     choose:  [{ n, file }]       use another generated variant for page n
     reject:  [{ n, note }]       status → rejected; the chosen variant is flagged so QC never re-picks it; the
                                  note rides the page's next generate prompt
   Writes only book.json, atomically. */
function pagesFor(dir, slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(slug))) throw new Error('bad book id');
  const b = readJson(path.join(dir, 'books', slug, 'book.json'), null);
  if (!b) throw new Error('no such book');
  const concept = new Map(((b.plan && b.plan.pages) || []).map(c => [c.n, c]));
  return { book: { slug, title: (b.plan && b.plan.title) || slug, complexity: (b.plan && b.plan.complexity) || '' },
    pages: (b.pages || []).map(p => ({ n: p.n, title: (concept.get(p.n) || {}).title || '', scene: (concept.get(p.n) || {}).scene || '',
      status: p.status, chosen: p.chosen || null, notes: p.notes || [],
      variants: (p.variants || []).map(v => ({ file: v.file, score: v.score == null ? null : v.score, flags: v.flags || [] })) })) };
}
function reviewPages(dir, slug, ops) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(slug))) throw new Error('bad book id');
  const file = path.join(dir, 'books', slug, 'book.json');
  const b = readJson(file, null);
  if (!b) throw new Error('no such book');
  const page = n => { const p = (b.pages || []).find(x => x.n === Number(n)); if (!p) throw new Error('no page ' + n); return p; };
  let changed = 0;
  for (const c of ops.choose || []) {
    const p = page(c.n);
    if (!(p.variants || []).some(v => v.file === c.file)) throw new Error('page ' + c.n + ' has no variant ' + c.file);
    p.chosen = c.file; if (p.status === 'rejected') p.status = 'generated'; changed++;
  }
  for (const n of ops.approve || []) {
    const p = page(n);
    if (!p.chosen) throw new Error('page ' + n + ' has no chosen image yet (run qc first)');
    p.status = 'approved'; changed++;
  }
  for (const r of ops.reject || []) {
    const p = page(r.n);
    if (p.chosen) {
      const v = (p.variants || []).find(x => x.file === p.chosen);
      if (v) { v.flags = v.flags || []; if (!v.flags.includes('rejected in review')) v.flags.push('rejected in review'); }
      p.chosen = null;
    }
    p.status = 'rejected';
    const note = String(r.note || '').trim().slice(0, 300);
    if (note) p.notes = (p.notes || []).concat([note]);
    changed++;
  }
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2));
  fs.renameSync(tmp, file);
  return { changed };
}

module.exports = { readVenture, importSales, markPublished, pagesFor, reviewPages, STAGES };
