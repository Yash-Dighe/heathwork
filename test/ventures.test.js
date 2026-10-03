'use strict';
/* ventures.test.js — the coloring-book venture ledger + game layer: KDP report parsing (xlsx + csv), book
   stages read off real pipeline files, de-duplicated sales import, MARK LIVE, and the XP/level/milestone/quest
   projection. Everything the Workshop shows must be derivable from these files and nothing else. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { parseReport, _internals: K } = require('../sidecar/ventures/kdp-report.js');
const { readVenture, importSales, markPublished } = require('../sidecar/ventures/ledger.js');
const P = require('../sidecar/ventures/progress.js');

/* ---- report parsing ---- */
const xlsx = fs.readFileSync(path.join(__dirname, 'fixtures', 'kdp-royalties-sample.xlsx'));
const rep = parseReport(xlsx, 'KDP_Royalties.xlsx');
A.eq(rep.rows.length, 4, 'xlsx: four sale rows; the Summary sheet, title rows and the Total row are not sales');
A.eq(rep.rows[0].date, '2026-09-03', 'xlsx: an Excel date serial becomes an ISO day');
A.eq(rep.rows[0].units, 3, 'xlsx: net units are read');
A.eq(rep.rows[0].royalty, 9.45, 'xlsx: the Royalty column (not Royalty Date / Royalty Type) is the money');
A.eq(rep.rows[2].currency, 'GBP', 'xlsx: currency per row is kept');

const csv = 'Royalty Date,Title,ASIN,Marketplace,Net Units Sold,Royalty,Currency\n2026-08-30,"Night Garden, Vol. 1",B0CSV00001,Amazon.com,2,"6.30",USD\nTotal,,,,,6.30,\n';
const rc = parseReport(Buffer.from(csv), 'report.csv');
A.eq(rc.rows.length, 1, 'csv: one sale; quoted commas stay inside the title; totals skipped');
A.eq(rc.rows[0].title, 'Night Garden, Vol. 1', 'csv: quoted title intact');
A.eq(parseReport(Buffer.from('a,b\n1,2\n'), 'x.csv').warnings.length, 1, 'an unrelated table yields a warning, not invented rows');
A.eq(K.num('(1.20)'), -1.2, 'accounting negatives (refunds) parse');
A.eq(K.num('1.234,56'), 1234.56, 'European thousands/decimal parse');

/* ---- a venture on disk ---- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venture-'));
function writeBook(slug, opts) {
  const d = path.join(dir, 'books', slug);
  fs.mkdirSync(path.join(d, 'build'), { recursive: true });
  const pages = [];
  for (let n = 1; n <= opts.total; n++) {
    pages.push({ n, status: n <= opts.approved ? 'approved' : (n <= opts.generated ? 'generated' : 'pending'),
      variants: n <= opts.generated ? [{ file: `raw/p${n}_v1.png` }] : [] });
  }
  const book = { slug, plan: { title: opts.title, subtitle: '', audience: 'adult', pages: pages.map(p => ({ n: p.n })) }, pages,
    usage: { image_calls: opts.generated * 2 } };
  if (opts.listing) book.listing = { suggested_price_usd: 9.99 };
  fs.writeFileSync(path.join(d, 'book.json'), JSON.stringify(book));
  if (opts.built) { fs.writeFileSync(path.join(d, 'build', 'interior.pdf'), 'x'); fs.writeFileSync(path.join(d, 'build', 'cover.pdf'), 'x'); }
  if (opts.listing) fs.writeFileSync(path.join(d, 'listing.md'), '# listing');
}
const NOW = Date.UTC(2026, 9, 3);

let m = readVenture(dir, { now: NOW });
A.eq(m.books.length, 0, 'an empty venture has no books');
let g = P.summarize(m);
A.eq([g.level, g.xp, g.title], [1, 0, 'Daydreamer'], 'a fresh venture starts at level 1 with zero XP');
A.eq(g.quests[0].id, 'start', 'the only quest of an empty venture is to start one');

writeBook('cozy-cottage-kitchens', { title: 'Cozy Cottage Kitchens', total: 40, generated: 40, approved: 40, built: true, listing: true });
writeBook('night-garden', { title: 'Night Garden', total: 40, generated: 12, approved: 6 });
m = readVenture(dir, { now: NOW });
A.eq(m.books.map(b => b.stage), ['listed', 'drawing'], 'stages come from the files: built + listing = listed; partial images = drawing');
A.eq(m.books[1].pagesAwaiting, 6, 'pages generated but not yet approved are awaiting review');
g = P.summarize(m);
A.eq(g.quests[0].text, 'Publish “Cozy Cottage Kitchens” on KDP, then mark it live', 'the quest closest to money comes first');
A.ok(g.milestones.find(x => x.id === 'first_print').earned, 'print-ready milestone earned from real build files');
A.ok(!g.milestones.find(x => x.id === 'first_live').earned, 'nothing is live until a published record exists');

markPublished(dir, 'cozy-cottage-kitchens', { asin: 'b0testasin1', price: 9.99, date: '2026-09-01' });
A.throws(() => markPublished(dir, '../escape', { asin: 'x' }), 'book ids are validated (no path escape)');
const first = importSales(dir, rep, { file: 'KDP_Royalties.xlsx', at: NOW });
A.eq([first.added, first.duplicates], [4, 0], 'first import adds every row');
const again = importSales(dir, rep, { file: 'KDP_Royalties.xlsx', at: NOW });
A.eq([again.added, again.duplicates], [0, 4], 're-importing the same report never double-counts');

m = readVenture(dir, { now: NOW });
const cozy = m.books[0];
A.eq(cozy.stage, 'live', 'MARK LIVE makes the book live');
A.eq([cozy.unitsSold, cozy.royaltyUSD], [8, 22.05], 'sales attach to the book by ASIN (all marketplaces count units; USD money only)');
A.eq(m.royaltyOther, { GBP: 3.15 }, 'non-USD royalties are kept per currency, never converted with an invented rate');
A.eq(m.unmatchedSales, 1, 'a sale for a book this venture does not know is counted as unmatched, not misattributed');
A.eq(m.months, [{ month: '2026-09', usd: 22.05 }, { month: '2026-10', usd: 3.15 }], 'USD royalties by month');

g = P.summarize(m);
const expectXp = (46 * 2) + (1 * 40) + (1 * 100) + (9 * 10) + (25 * 2)
  + 30 + 20 + 60 + 100 + 200 + 250;   // base + first_plan, first_page, pages_40, first_print, first_live, first_sale
A.eq(g.xp, expectXp, 'XP is exactly the formula over real outcomes plus earned milestone bonuses');
A.eq(g.level, P.levelForXp(expectXp), 'level follows from XP');
A.ok(g.xp >= g.levelFloorXp && g.xp < g.nextLevelXp, 'XP sits inside its level band');
A.eq(g.coins.usd, 25.2, 'coins are reported USD royalties');
A.eq(P.summarize(readVenture(dir, { now: NOW })), g, 'summarize is deterministic: same files, same game state');
A.eq(P.titleFor(10), 'Publisher', 'level titles');
A.eq([P.xpToReach(2), P.xpToReach(5)], [80, 800], 'level curve');

fs.rmSync(dir, { recursive: true, force: true });
A.report('ventures');
