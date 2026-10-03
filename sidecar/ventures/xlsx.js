'use strict';
/* sidecar/ventures/xlsx.js — a minimal, dependency-free .xlsx reader (Node core only, like the rest of the
   sidecar). Enough for spreadsheet exports such as the Amazon KDP royalty report: it reads the zip central
   directory, inflates the parts it needs, resolves shared strings, and returns every sheet as rows of cell
   text. It does not evaluate formulas (it reads their cached values), styles, merged cells or dates beyond
   returning Excel serial numbers as numbers — callers convert dates they expect.

   readXlsx(buffer) -> [{ name, rows: string[][] }]   (throws on a malformed or non-xlsx file) */
const zlib = require('node:zlib');

const MAX_PART = 64 * 1024 * 1024;   // refuse absurd parts (zip bombs)

function unzip(buf) {
  // End of central directory: scan back for 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip/xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    files.set(name, { method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return {
    has: (name) => files.has(name),
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      if (f.usize > MAX_PART) throw new Error('xlsx part too large: ' + name);
      const lp = f.local;
      if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error('corrupt zip local header');
      const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
      const data = buf.subarray(start, start + f.csize);
      if (f.method === 0) return data.toString('utf8');
      if (f.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_PART }).toString('utf8');
      throw new Error('unsupported zip compression method ' + f.method);
    }
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] || m;
  });
}
// all <t> text inside a fragment (rich text runs concatenate)
const textOf = (frag) => { let out = ''; frag.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => { out += unescapeXml(t); return ''; }); return out; };

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf) {
  const z = unzip(buf);
  const shared = [];
  const ss = z.read('xl/sharedStrings.xml');
  if (ss) ss.replace(/<si>([\s\S]*?)<\/si>/g, (_, frag) => { shared.push(textOf(frag)); return ''; });

  const wb = z.read('xl/workbook.xml');
  if (!wb) throw new Error('not an xlsx workbook');
  const rels = z.read('xl/_rels/workbook.xml.rels') || '';
  const target = {};
  rels.replace(/<Relationship\b([^>]*)\/?>/g, (_, attrs) => {
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1], t = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && t) target[id] = t.replace(/^\/?xl\//, '').replace(/^\//, '');
    return '';
  });
  const sheets = [];
  wb.replace(/<sheet\b([^>]*)\/?>/g, (_, attrs) => {
    const name = unescapeXml((attrs.match(/\bname="([^"]*)"/) || [])[1] || '');
    const rid = (attrs.match(/\br:id="([^"]+)"/) || [])[1];
    sheets.push({ name, path: 'xl/' + (target[rid] || '') });
    return '';
  });
  return sheets.map(({ name, path }) => {
    const xml = z.read(path) || '';
    const rows = [];
    xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, body) => {
      const row = [];
      body.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, attrs, inner) => {
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
        let val = '';
        if (inner) {
          if (type === 'inlineStr') val = textOf(inner);
          else {
            const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
            if (v != null) val = type === 's' ? (shared[Number(v)] || '') : unescapeXml(v);
          }
        }
        const idx = ref ? colIndex(ref) : row.length;
        while (row.length < idx) row.push('');
        row[idx] = val;
        return '';
      });
      rows.push(row);
      return '';
    });
    return { name, rows };
  });
}

module.exports = { readXlsx, _internals: { unzip, colIndex, unescapeXml } };
