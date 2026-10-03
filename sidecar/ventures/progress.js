'use strict';
/* sidecar/ventures/progress.js — the VENTURE GAME LAYER. Pure and deterministic: a function of the venture's real
   metrics (ledger.js) and nothing else. No clock, no randomness, no stored score that could drift from the truth.

   THE LAW (inherited from the harness): the UI never asserts what the files cannot prove. So:
     • XP is a FORMULA over real outcomes (pages approved, books print-ready, books live, copies sold, royalty
       dollars) plus one-time MILESTONE bonuses for real firsts. Recompute it from scratch any time; same answer.
     • COINS are royalty money actually reported by KDP, nothing else.
     • QUESTS are the next real actions the files say are open, ordered by how close they are to money.
     • A level never goes down unless the underlying facts do (e.g. a sales report is removed).

   summarize(metrics) -> { xp, level, title, nextLevelXp, levelFloorXp, coins, milestones, quests } */

const LEVEL_K = 40;                       // cumulative XP to REACH level n = LEVEL_K * n * (n-1)  (L2 80, L5 800, L10 3600)
const XP = { approvedPage: 2, printReady: 40, live: 100, unitSold: 10, royaltyDollar: 2 };

const TITLES = [                          // [minimum level, title]
  [1, 'Daydreamer'], [2, 'Doodler'], [3, 'Sketcher'], [4, 'Illustrator'], [5, 'Bookbinder'],
  [7, 'Shopkeeper'], [10, 'Publisher'], [15, 'Guild Master'], [20, 'Press Baron'], [30, 'Village Legend'],
];

// Real firsts. `value(m)` reads the metric; `goal` is the threshold; progress is shown honestly as value/goal.
const MILESTONES = [
  { id: 'first_plan',      label: 'Plan your first book',            xp: 30,   value: m => m.books.length, goal: 1 },
  { id: 'first_page',      label: 'Approve your first page',         xp: 20,   value: m => m.pagesApproved, goal: 1 },
  { id: 'pages_40',        label: 'Approve 40 pages',                xp: 60,   value: m => m.pagesApproved, goal: 40 },
  { id: 'first_print',     label: 'First book print-ready',          xp: 100,  value: m => m.booksPrintReady, goal: 1 },
  { id: 'first_live',      label: 'First book live on Amazon',       xp: 200,  value: m => m.booksLive, goal: 1 },
  { id: 'first_sale',      label: 'Your first sale',                 xp: 250,  value: m => m.unitsSold, goal: 1 },
  { id: 'units_10',        label: 'Sell 10 copies',                  xp: 150,  value: m => m.unitsSold, goal: 10 },
  { id: 'royalty_100',     label: 'Earn $100 in royalties',          xp: 300,  value: m => m.royaltyUSD, goal: 100 },
  { id: 'live_5',          label: '5 books live',                    xp: 300,  value: m => m.booksLive, goal: 5 },
  { id: 'month_100',       label: '$100 royalties in one month',     xp: 400,  value: m => m.bestMonthUSD, goal: 100 },
  { id: 'units_100',       label: 'Sell 100 copies',                 xp: 400,  value: m => m.unitsSold, goal: 100 },
  { id: 'live_10',         label: '10 books live',                   xp: 500,  value: m => m.booksLive, goal: 10 },
  { id: 'royalty_1000',    label: 'Earn $1,000 in royalties',        xp: 800,  value: m => m.royaltyUSD, goal: 1000 },
  { id: 'live_25',         label: '25 books live',                   xp: 1000, value: m => m.booksLive, goal: 25 },
  { id: 'royalty_10000',   label: 'Earn $10,000 in royalties',       xp: 2000, value: m => m.royaltyUSD, goal: 10000 },
];

function levelForXp(xp) {
  let n = 1;
  while (LEVEL_K * (n + 1) * n <= xp) n++;
  return n;
}
const xpToReach = n => LEVEL_K * n * (n - 1);
function titleFor(level) {
  let t = TITLES[0][1];
  for (const [min, name] of TITLES) if (level >= min) t = name;
  return t;
}

// Stage → the next real action, and how close that stage is to money (higher = sooner).
const NEXT = {
  planned:      { rank: 1, text: b => `Generate pages for “${b.title}”`, how: 'colorbook generate' },
  drawing:      { rank: 2, text: b => `Finish drawing “${b.title}” (${b.pagesGenerated}/${b.pagesTotal} pages)`, how: 'colorbook generate' },
  review:       { rank: 3, text: b => `Review ${b.pagesAwaiting} page${b.pagesAwaiting === 1 ? '' : 's'} of “${b.title}”`, how: 'review sheet' },
  approved:     { rank: 4, text: b => `Build the print files for “${b.title}”`, how: 'colorbook build' },
  'print-ready':{ rank: 5, text: b => `Write the Amazon listing for “${b.title}”`, how: 'colorbook listing' },
  listed:       { rank: 6, text: b => `Publish “${b.title}” on KDP, then mark it live`, how: 'kdp.amazon.com' },
};

function questsFor(m) {
  const q = [];
  if (!m.books.length) {
    q.push({ id: 'start', rank: 0, text: 'Pick a niche and plan your first coloring book', how: 'colorbook research → colorbook plan' });
  }
  for (const b of m.books) {
    const n = NEXT[b.stage];
    if (n) q.push({ id: 'book:' + b.slug + ':' + b.stage, rank: n.rank, book: b.slug, text: n.text(b), how: n.how });
  }
  if (m.booksLive > 0 && (!m.lastSaleDate || m.daysSinceImport == null || m.daysSinceImport > 31)) {
    q.push({ id: 'import', rank: 7, text: 'Import your latest KDP royalty report', how: 'KDP → Reports → download, then drop it in' });
  }
  return q.sort((a, b) => b.rank - a.rank || a.text.localeCompare(b.text));
}

function summarize(m) {
  const base = m.pagesApproved * XP.approvedPage + m.booksPrintReady * XP.printReady + m.booksLive * XP.live
    + m.unitsSold * XP.unitSold + Math.floor(Math.max(0, m.royaltyUSD)) * XP.royaltyDollar;
  const milestones = MILESTONES.map(ms => {
    const v = Math.max(0, Number(ms.value(m)) || 0);
    return { id: ms.id, label: ms.label, xp: ms.xp, value: v, goal: ms.goal, earned: v >= ms.goal };
  });
  const bonus = milestones.filter(x => x.earned).reduce((s, x) => s + x.xp, 0);
  const xp = base + bonus;
  const level = levelForXp(xp);
  return {
    xp, level, title: titleFor(level),
    levelFloorXp: xpToReach(level), nextLevelXp: xpToReach(level + 1),
    coins: { usd: Math.round(m.royaltyUSD * 100) / 100, other: m.royaltyOther },
    milestones,
    nextMilestone: milestones.find(x => !x.earned) || null,
    quests: questsFor(m),
  };
}

module.exports = { summarize, levelForXp, xpToReach, titleFor, MILESTONES, XP, LEVEL_K };
