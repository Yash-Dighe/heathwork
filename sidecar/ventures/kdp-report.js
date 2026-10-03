'use strict';
/* sidecar/ventures/kdp-report.js — turn an Amazon KDP report download (.xlsx or .csv) into sales rows.

   KDP has no public sales API, so the Commander downloads a report (Reports → Royalties / Prior Months'
   Royalties / Orders) and drops it in. Column layouts differ between report types and change over time, so
   this matches columns by HEADER MEANING, not position, and searches the first rows of every sheet for the
   header line. Rows it cannot read are counted and reported, never guessed.

   parseReport(buffer, filename) -> { rows:[Sale], sheets:[{name, used, skipped}], warnings:[string] }
   Sale = { date:'YYYY-MM-DD'|'', title, asin, marketplace, kind, units, royalty, currency } */
const { readXlsx } = require('./xlsx.js');

// header matchers, most specific first; each returns the column index or -1
const COLS = {
  date: [/^royalty date$/i, /^(order )?date$/i, /date/i],
  title: [/^title$/i, /title/i],
  asin: [/^asin$/i, /asin/i, /isbn/i],
  marketplace: [/marketplace/i, /^store$/i],
  kind: [/^royalty type$/i, /^transaction type$/i, /format/i],
  units: [/^net units sold$/i, /net units/i, /^units sold$/i, /^paid units$/i, /units/i],
  royalty: [/^royalty$/i, /^royalties$/i, /^(estimated )?royalt(y|ies)( amount)?$/i],
  currency: [/^currency$/i, /currency/i],
};

function findCol(header, patterns) {
  for (const re of patterns) {
    const i = header.findIndex(h => re.test(String(h || '').trim()));
    if (i >= 0) return i;
  }
  return -1;
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// '1,234.56' / '$9.99' / '(1.20)' -> number; '' -> NaN
function num(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()\s$€£¥]/g, '').replace(/^-/, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');   // 1.234,56
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

// Excel serial (days since 1899-12-30) or common date strings -> 'YYYY-MM-DD'
function isoDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^\d{4,6}(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);                         // US m/d/yyyy
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})$/);                                    // month-level reports
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-01`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

function rowsFromTable(rows) {
  // header = the first row (within 20) that names a title AND a royalty column
  for (let h = 0; h < Math.min(rows.length, 20); h++) {
    const header = rows[h].map(x => String(x || ''));
    const idx = {};
    for (const k of Object.keys(COLS)) idx[k] = findCol(header, COLS[k]);
    // "Royalty Date"/"Royalty Type" must never be taken as the money column
    if (idx.royalty >= 0 && /date|type/i.test(header[idx.royalty])) idx.royalty = -1;
    if (idx.title < 0 || idx.royalty < 0) continue;
    const out = []; let skipped = 0;
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every(c => String(c || '').trim() === '')) continue;
      const title = String(row[idx.title] || '').trim();
      const royalty = num(row[idx.royalty]);
      if (!title || !Number.isFinite(royalty) || /^total/i.test(title)) { skipped++; continue; }
      const units = idx.units >= 0 ? num(row[idx.units]) : NaN;
      out.push({
        date: idx.date >= 0 ? isoDate(row[idx.date]) : '',
        title,
        asin: idx.asin >= 0 ? String(row[idx.asin] || '').trim() : '',
        marketplace: idx.marketplace >= 0 ? String(row[idx.marketplace] || '').trim() : '',
        kind: idx.kind >= 0 ? String(row[idx.kind] || '').trim() : '',
        units: Number.isFinite(units) ? units : 0,
        royalty: Math.round(royalty * 100) / 100,
        currency: idx.currency >= 0 ? (String(row[idx.currency] || '').trim().toUpperCase() || 'USD') : 'USD',
      });
    }
    return { rows: out, skipped, header: true };
  }
  return { rows: [], skipped: 0, header: false };
}

function parseReport(buf, filename) {
  const name = String(filename || '').toLowerCase();
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  const sheets = isZip || name.endsWith('.xlsx')
    ? readXlsx(buf)
    : [{ name: 'csv', rows: parseCsv(buf.toString('utf8').replace(/^﻿/, '')) }];
  const rows = [], info = [], warnings = [];
  for (const s of sheets) {
    const got = rowsFromTable(s.rows);
    info.push({ name: s.name, used: got.rows.length, skipped: got.skipped });
    rows.push(...got.rows);
  }
  if (!rows.length) warnings.push('no sales rows found — expected a sheet with Title and Royalty columns (KDP Reports → Royalties or Prior Months\' Royalties)');
  return { rows, sheets: info, warnings };
}

// stable identity of a sale row, so re-importing the same report never double-counts
function saleKey(r) {
  return [r.date, r.asin || r.title.toLowerCase(), r.marketplace, r.kind, r.units, r.royalty, r.currency].join('|');
}

module.exports = { parseReport, saleKey, _internals: { parseCsv, num, isoDate, rowsFromTable } };
