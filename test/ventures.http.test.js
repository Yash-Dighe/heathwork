/* node test/ventures.http.test.js — the WORKSHOP API through the real sidecar's routes: create a coloring-book
   venture, see a book the pipeline wrote, upload a KDP report, MARK LIVE, and read the game state back. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const fx = SidecarFixture.create({ prefix: 'sk-ventures-http-' });
  await fx.start();
  try {
    let r = await fx.json('GET', '/api/ventures');
    A.ok(r.status === 200 && r.body.ok && Array.isArray(r.body.ventures) && r.body.ventures.length === 0, 'a new station has no ventures');

    r = await fx.json('POST', '/api/ventures', { name: 'Coloring Books', kind: 'coloring-books' });
    A.eq(r.status, 200, 'POST /api/ventures creates one');
    const v = r.body.venture;
    A.eq([v.id, v.building, v.game.level], ['coloring-books', 'Coloring Book Press', 1], 'it starts at level 1 with its building');
    A.ok(fs.existsSync(path.join(v.dir, 'books')), 'its pipeline working directory exists');
    A.eq((await fx.json('POST', '/api/ventures', { kind: 'nonsense' })).status, 400, 'unknown kinds are refused');

    // the pipeline writes a finished book (what `colorbook build` + `colorbook listing` leave behind)
    const bdir = path.join(v.dir, 'books', 'cozy-cottage-kitchens');
    fs.mkdirSync(path.join(bdir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(bdir, 'raw'), { recursive: true });
    const pages = Array.from({ length: 24 }, (_, i) => ({ n: i + 1, status: 'approved', variants: [{ file: 'raw/p.png' }], chosen: 'raw/p.png' }));
    fs.writeFileSync(path.join(bdir, 'book.json'), JSON.stringify({ slug: 'cozy-cottage-kitchens', plan: { title: 'Cozy Cottage Kitchens', pages: pages.map(p => ({ n: p.n })) }, pages, listing: { suggested_price_usd: 9.99 }, cover_art: 'raw/cover.png' }));
    for (const f of ['build/interior.pdf', 'build/cover.pdf', 'listing.md']) fs.writeFileSync(path.join(bdir, f), 'x');
    fs.writeFileSync(path.join(bdir, 'raw', 'cover.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

    r = await fx.json('GET', '/api/ventures');
    const b0 = r.body.ventures[0].metrics.books[0];
    A.eq([b0.stage, b0.pagesApproved], ['listed', 24], 'the book the pipeline wrote shows up at its real stage');
    A.ok(/Publish/.test(r.body.ventures[0].game.quests[0].text), 'its top quest is to publish it');

    const art = await fx.request('/api/ventures/art?id=coloring-books&book=cozy-cottage-kitchens');
    A.ok(art.status === 200 && art.headers.get('content-type') === 'image/png', 'the shelf can show its cover art');
    A.eq((await fx.request('/api/ventures/art?id=coloring-books&book=..%2F..%2Fetc')).status, 404, 'art paths cannot escape the book');

    r = await fx.json('POST', '/api/ventures/publish', { id: 'coloring-books', book: 'cozy-cottage-kitchens', asin: 'B0TESTASIN1', price: 9.99, date: '2026-09-01' });
    A.ok(r.status === 200 && r.body.venture.metrics.booksLive === 1, 'MARK LIVE: the book is live');

    const report = fs.readFileSync(path.join(__dirname, 'fixtures', 'kdp-royalties-sample.xlsx'));
    const up = await fx.request('/api/ventures/sales?id=coloring-books', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': 'KDP.xlsx' }, body: report });
    const ub = await up.json();
    A.ok(up.status === 200 && ub.import.added === 4, 'a KDP xlsx report imports through the API: ' + JSON.stringify(ub).slice(0, 160));
    const g = ub.venture.game, m = ub.venture.metrics;
    A.eq([m.unitsSold, g.coins.usd], [9, 25.2], 'units and royalty coins come from the report');
    A.ok(g.milestones.find(x => x.id === 'first_sale').earned, 'the first-sale milestone is earned');
    const bad = await fx.request('/api/ventures/sales?id=coloring-books', { method: 'POST', headers: { 'x-filename': 'notes.csv' }, body: 'a,b\n1,2\n' });
    A.eq(bad.status, 422, 'a file with no sales rows is refused with a reason, not imported as zeros');
  } finally {
    await fx.stop();
  }
  A.report('ventures.http');
})().catch((e) => { console.error(e); process.exit(1); });
