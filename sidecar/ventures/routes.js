'use strict';
/* sidecar/ventures/routes.js — the WORKSHOP API. Ventures live under <workspaces>/ventures/<id>/; each is the
   working directory of its pipeline (for coloring books: the `colorbook` CLI's cwd, books/ underneath).

   GET  /api/ventures                         → { ok, root, ventures:[{ id, name, kind, dir, metrics, game }] }
   POST /api/ventures            {name,kind}  → create a venture (kind: 'coloring-books')
   POST /api/ventures/sales?id=…              → body = the KDP report file (xlsx/csv); header x-filename
   POST /api/ventures/publish    {id, book, asin, price, date} → MARK LIVE
   GET  /api/ventures/art?id=…&book=…          → the book's cover art (or first approved page) as PNG, for the shelf

   Every number in the response is recomputed from disk on each GET (ledger.js → progress.js); the API keeps no
   score of its own, so it can never disagree with the files. */
const fs = require('node:fs');
const path = require('node:path');
const { parseReport } = require('./kdp-report.js');
const { readVenture, importSales, markPublished, pagesFor, reviewPages } = require('./ledger.js');
const { summarize } = require('./progress.js');

const KINDS = { 'coloring-books': { label: 'Coloring Books', building: 'Coloring Book Press' } };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_REPORT = 20 * 1024 * 1024;

function makeVentureRoutes(deps) {
  const { root, readBody, readBodyBuffer, respondJson } = deps;
  const now = deps.now || (() => Date.now());
  const regFile = path.join(root, 'ventures.json');

  function registry() {
    try { return JSON.parse(fs.readFileSync(regFile, 'utf8')).ventures || []; }
    catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  }
  function saveRegistry(list) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = regFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ventures: list }, null, 2));
    fs.renameSync(tmp, regFile);
  }
  const dirOf = v => path.join(root, v.id);
  const find = id => registry().find(v => v.id === id) || null;

  function view(v) {
    const metrics = readVenture(dirOf(v), { now: now() });
    return { id: v.id, name: v.name, kind: v.kind, kindLabel: (KINDS[v.kind] || {}).label || v.kind,
      building: (KINDS[v.kind] || {}).building || 'Workshop', dir: dirOf(v), createdAt: v.createdAt,
      metrics, game: summarize(metrics) };
  }

  async function list(req, res) {
    try { respondJson(res, 200, { ok: true, root, kinds: KINDS, ventures: registry().map(view) }); }
    catch (e) { respondJson(res, 500, { ok: false, error: 'could not read ventures: ' + ((e && e.message) || e) }); }
  }

  async function create(req, res) {
    let b; try { b = JSON.parse(await readBody(req, 4096, res)) || {}; } catch (_) { return respondJson(res, 400, { ok: false, error: 'bad json' }); }
    const kind = String(b.kind || 'coloring-books');
    if (!KINDS[kind]) return respondJson(res, 400, { ok: false, error: 'unknown venture kind' });
    const name = String(b.name || KINDS[kind].label).trim().slice(0, 60) || KINDS[kind].label;
    const list0 = registry();
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || kind;
    for (let n = 2; list0.some(v => v.id === id); n++) id = id.replace(/-\d+$/, '') + '-' + n;
    if (!ID_RE.test(id)) return respondJson(res, 400, { ok: false, error: 'bad venture name' });
    const v = { id, name, kind, createdAt: now() };
    fs.mkdirSync(path.join(dirOf(v), 'books'), { recursive: true });
    saveRegistry(list0.concat([v]));
    respondJson(res, 200, { ok: true, venture: view(v) });
  }

  async function sales(req, res) {
    const u = new URL(req.url, 'http://x');
    const v = find(String(u.searchParams.get('id') || ''));
    if (!v) return respondJson(res, 404, { ok: false, error: 'no such venture' });
    let buf; try { buf = await readBodyBuffer(req, MAX_REPORT, res); } catch (e) { if (e && e.tooLarge) return; return respondJson(res, 400, { ok: false, error: 'could not read upload' }); }
    const fileName = String(req.headers['x-filename'] || 'report').slice(0, 200);
    let parsed;
    try { parsed = parseReport(buf, fileName); }
    catch (e) { return respondJson(res, 400, { ok: false, error: 'could not read that file as a KDP report (' + ((e && e.message) || e) + ')' }); }
    if (!parsed.rows.length) return respondJson(res, 422, { ok: false, error: parsed.warnings[0] || 'no sales rows found', sheets: parsed.sheets });
    const result = importSales(dirOf(v), parsed, { file: fileName, at: now() });
    respondJson(res, 200, { ok: true, import: result, sheets: parsed.sheets, venture: view(v) });
  }

  async function publish(req, res) {
    let b; try { b = JSON.parse(await readBody(req, 4096, res)) || {}; } catch (_) { return respondJson(res, 400, { ok: false, error: 'bad json' }); }
    const v = find(String(b.id || ''));
    if (!v) return respondJson(res, 404, { ok: false, error: 'no such venture' });
    try { markPublished(dirOf(v), String(b.book || ''), b); }
    catch (e) { return respondJson(res, 400, { ok: false, error: (e && e.message) || String(e) }); }
    respondJson(res, 200, { ok: true, venture: view(v) });
  }

  async function art(req, res) {
    const u = new URL(req.url, 'http://x');
    const v = find(String(u.searchParams.get('id') || ''));
    const slug = String(u.searchParams.get('book') || '');
    if (!v || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) { res.writeHead(404); return res.end(); }
    const bdir = path.join(dirOf(v), 'books', slug);
    let rel = null;
    try {
      const b = JSON.parse(fs.readFileSync(path.join(bdir, 'book.json'), 'utf8'));
      rel = b.cover_art || ((b.pages || []).find(p => p.status === 'approved' && p.chosen) || {}).chosen
        || ((b.pages || []).find(p => p.chosen) || {}).chosen || null;
    } catch (_) { rel = null; }
    const file = rel ? path.resolve(bdir, rel) : '';
    if (!rel || !file.startsWith(bdir + path.sep) || !/\.png$/i.test(file) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  async function pages(req, res) {
    const u = new URL(req.url, 'http://x');
    const v = find(String(u.searchParams.get('id') || ''));
    if (!v) return respondJson(res, 404, { ok: false, error: 'no such venture' });
    try { respondJson(res, 200, Object.assign({ ok: true }, pagesFor(dirOf(v), String(u.searchParams.get('book') || '')))); }
    catch (e) { respondJson(res, 400, { ok: false, error: (e && e.message) || String(e) }); }
  }

  // a generated page image: only PNGs under the book's raw/ folder
  async function img(req, res) {
    const u = new URL(req.url, 'http://x');
    const v = find(String(u.searchParams.get('id') || ''));
    const slug = String(u.searchParams.get('book') || ''), rel = String(u.searchParams.get('file') || '');
    if (!v || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug) || !/^raw\/[A-Za-z0-9_.-]+\.png$/.test(rel)) { res.writeHead(404); return res.end(); }
    const file = path.join(dirOf(v), 'books', slug, rel);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }

  async function review(req, res) {
    let b; try { b = JSON.parse(await readBody(req, 65536, res)) || {}; } catch (_) { return respondJson(res, 400, { ok: false, error: 'bad json' }); }
    const v = find(String(b.id || ''));
    if (!v) return respondJson(res, 404, { ok: false, error: 'no such venture' });
    try {
      const r = reviewPages(dirOf(v), String(b.book || ''), { approve: b.approve, reject: b.reject, choose: b.choose });
      respondJson(res, 200, Object.assign({ ok: true, changed: r.changed, venture: view(v) }, pagesFor(dirOf(v), String(b.book))));
    } catch (e) { respondJson(res, 400, { ok: false, error: (e && e.message) || String(e) }); }
  }

  // The press tools work in ONE venture of a kind; the first one, created on first use so an agent can start.
  function ensureVenture(kind) {
    let v = registry().find(x => x.kind === kind);
    if (!v) {
      v = { id: kind, name: (KINDS[kind] || {}).label || kind, kind, createdAt: now() };
      saveRegistry(registry().concat([v]));
    }
    fs.mkdirSync(path.join(dirOf(v), 'books'), { recursive: true });
    return v;
  }
  const ensureVentureDir = kind => dirOf(ensureVenture(kind));
  const viewKind = kind => view(ensureVenture(kind));

  return {
    ensureVentureDir, viewKind,
    routes: [
      { m: 'GET', exact: '/api/ventures', h: list },
      { m: 'POST', exact: '/api/ventures', h: create },
      { m: 'POST', qsplit: '/api/ventures/sales', h: sales },
      { m: 'POST', exact: '/api/ventures/publish', h: publish },
      { m: 'GET', qsplit: '/api/ventures/art', h: art },
      { m: 'GET', qsplit: '/api/ventures/pages', h: pages },
      { m: 'GET', qsplit: '/api/ventures/img', h: img },
      { m: 'POST', exact: '/api/ventures/review', h: review },
    ],
    _internals: { registry, view },
  };
}

module.exports = { makeVentureRoutes, KINDS };
