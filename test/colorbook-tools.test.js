/* node test/colorbook-tools.test.js — the COLORING BOOK PRESS tools (sidecar/tools/builtin/colorbook.js).
   argv is built from validated fields only (never a shell, never pass-through); spending steps demand the right
   station key and hand the child exactly ANTHROPIC_API_KEY / OPENAI_API_KEY on top of the sanitized env; the
   agent has no way to approve pages or mark a book live. When the Python pipeline is installed, a real
   plan → generate (mock) → qc → build run goes through the tools end to end. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { makeColorbookTools } = require('../sidecar/tools/builtin/colorbook.js');

function fakeSpawn(calls, exitCode, out) {
  return (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    const ch = new EventEmitter(); ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter(); ch.kill = () => {};
    setImmediate(() => { if (out) ch.stdout.emit('data', out); ch.emit('close', exitCode); });
    return ch;
  };
}
const view = { metrics: { books: [{ slug: 'b1', title: 'Book One', stage: 'review', pagesApproved: 2, pagesTotal: 8, pagesAwaiting: 3, unitsSold: 0 }] },
  game: { level: 2, title: 'Doodler', xp: 90, coins: { usd: 0 }, quests: [{ text: 'Review 3 pages of “Book One”' }] } };

(async () => {
  const calls = [];
  const keys = { anthropic: 'sk-ant-TEST', openai: '' };
  const T = makeColorbookTools({ spawn: fakeSpawn(calls, 0, 'done'), ventureDir: () => '/v', ventureView: () => view,
    envFor: () => ({ PATH: '/bin' }), keyFor: p => keys[p] || '', python: 'py' });
  const [status, make, spendTool] = T.tools;

  A.eq(T.tools.map(t => [t.name, t.capability, t.requiresConsent]), [['press_status', 'press', false], ['press_make', 'press', false], ['press_spend', 'press', true]],
    'three tools on the press capability; only the money-spending one asks for consent');
  const names = T.tools.map(t => t.name).join(' ');
  A.ok(!/approve|publish|live/.test(names), 'no tool can approve pages or mark a book live');

  const s = await status.run({});
  A.ok(/Lv|level 2/.test(s.content) && /b1: "Book One" — review/.test(s.content) && /Review 3 pages/.test(s.content), 'press_status reports books, stages and quests');

  await make.run({ op: 'build', book: 'b1' });
  A.eq([calls[0].cmd, calls[0].argv, calls[0].opts.cwd], ['py', ['-m', 'colorbook.cli', 'build', 'b1'], '/v'], 'a free step runs the CLI module in the venture folder');
  A.ok(!('ANTHROPIC_API_KEY' in calls[0].opts.env) && !('OPENAI_API_KEY' in calls[0].opts.env), 'free steps receive no API keys at all');

  await spendTool.run({ op: 'plan', niche: 'cozy autumn kitchens', audience: 'adult', complexity: 'medium', pages: 99 });
  A.eq(calls[1].argv.slice(2), ['plan', '--niche', 'cozy autumn kitchens', '--audience', 'adult', '--complexity', 'medium', '--pages', '60'], 'plan argv is built from fields; page count is clamped');
  A.eq(calls[1].opts.env.ANTHROPIC_API_KEY, 'sk-ant-TEST', 'a Claude step receives the station Anthropic key');
  A.eq(calls[1].opts.env.PATH, '/bin', 'on top of the sanitized env');

  let err = null;
  try { await spendTool.run({ op: 'generate', book: 'b1', pages: '1-3' }); } catch (e) { err = e; }
  A.ok(err && /No OpenAI key/.test(err.message), 'drawing pages without an OpenAI key fails with a fix, before spawning anything');
  A.eq(calls.length, 2, 'nothing was spawned for the refused call');

  for (const bad of [{ op: 'generate', book: '../../etc' }, { op: 'generate', book: 'b1', pages: '1;rm -rf /' }, { op: 'plan' }, { op: 'plan', niche: 'x', audience: 'aliens' }]) {
    let e = null; try { await spendTool.run(bad); } catch (x) { e = x; }
    A.ok(!!e, 'refused: ' + JSON.stringify(bad));
  }
  A.eq(calls.length, 2, 'refused inputs never reach a process');

  const failing = makeColorbookTools({ spawn: fakeSpawn([], 1, "No module named 'colorbook'"), ventureDir: () => '/v', ventureView: () => view, envFor: () => ({}), keyFor: () => 'k' });
  err = null; try { await failing.tools[1].run({ op: 'qc', book: 'b1' }); } catch (e) { err = e; }
  A.ok(err && /pip install -e ventures\/coloring-books/.test(err.message), 'a missing pipeline explains how to install it');

  /* ---- the real pipeline, end to end, when installed ---- */
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const has = spawnSync(py, ['-c', 'import colorbook.cli'], { encoding: 'utf8' }).status === 0;
  if (!has) { console.log('colorbook-tools: python pipeline not installed — skipping the live run'); }
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'press-'));
    const env = Object.assign({}, process.env, { COLORBOOK_IMAGE_SIZE: '512x672', COLORBOOK_COVER_IMAGE_SIZE: '512x672' });
    const sample = path.join(__dirname, '..', 'ventures', 'coloring-books', 'examples', 'sample_plan.json');
    const sh = (args) => spawnSync(py, ['-m', 'colorbook.cli'].concat(args), { cwd: dir, env, encoding: 'utf8' });
    A.eq(sh(['plan', '--from-json', sample]).status, 0, 'live: a plan is created');
    A.eq(sh(['generate', 'cozy-cottage-kitchens', '--mock', '--variants', '1']).status, 0, 'live: mock pages generated');
    const live = makeColorbookTools({ spawn, ventureDir: () => dir, ventureView: () => view, envFor: () => env, keyFor: () => '', python: py });
    const qc = await live.tools[1].run({ op: 'qc', book: 'cozy-cottage-kitchens' });
    A.ok(/page 1/.test(qc.content), 'live: press_make qc scored the pages');
    sh(['approve', 'cozy-cottage-kitchens', '--all-passing']); sh(['generate', 'cozy-cottage-kitchens', '--cover', '--mock']);
    const built = await live.tools[1].run({ op: 'build', book: 'cozy-cottage-kitchens' });
    A.ok(/Interior:/.test(built.content) && fs.existsSync(path.join(dir, 'books', 'cozy-cottage-kitchens', 'build', 'cover.pdf')), 'live: press_make build wrote the KDP PDFs');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  A.report('colorbook-tools');
})().catch(e => { console.error(e); process.exit(1); });
