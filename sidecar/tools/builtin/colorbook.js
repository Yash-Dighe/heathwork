/* sidecar/tools/builtin/colorbook.js — the COLORING BOOK PRESS capability (a placed `press` object grants these).

   The press drives the colorbook pipeline (ventures/coloring-books, a Python CLI) inside the venture's working
   folder (<workspaces>/ventures/<id>/), so everything an agent makes lands where the WORKSHOP reads it.

     • press_status — read the venture: books, stages, pages awaiting review, quests, level. Local, free, no consent.
     • press_make   — LOCAL steps that cost nothing: qc (pixel checks), build (interior + cover PDFs), review (contact
                      sheet). No network, no consent.
     • press_spend  — steps that SPEND API money: research (Claude + web search), plan, generate (GPT Image pages),
                      cover (cover art), vision (Claude page inspection), listing. Consent-gated: the Commander sees
                      the cost estimate in the call before it runs.

   What an agent can NEVER do here: approve or reject pages, or mark a book live. Approving art and publishing on
   Amazon are the Commander's decisions (WORKSHOP window), so the tools simply do not offer them.

   The child gets a sanitized environment (sanitizeChildEnv strips every inherited secret) plus exactly two keys
   from the station's own provider store: ANTHROPIC_API_KEY and OPENAI_API_KEY. argv only — never a shell.

   makeColorbookTools({ spawn, fs, pathMod, ventureDir, ventureView, envFor, keyFor, python, redact })
     ventureDir()   -> absolute folder of the coloring-book venture (created on first use)
     ventureView()  -> { metrics, game } for press_status (sidecar/ventures ledger + progress)
     envFor()       -> sanitized base env;   keyFor(provider) -> the station's key or '' */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).colorbook = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
  const PAGES = /^\d{1,3}(-\d{1,3})?(,\d{1,3}(-\d{1,3})?)*$/;
  const OUT_MAX = 6000;
  const str = v => String(v == null ? '' : v).trim();

  // op -> argv builder. Each validates its own inputs; anything unexpected is refused, never passed through.
  const SPEND = {
    research: a => { const seed = str(a.seed).slice(0, 200); if (!seed) throw new Error('research needs a seed idea'); return ['research', seed]; },
    plan: a => {
      const argv = ['plan'];
      if (a.fromResearch) { if (!SLUG.test(str(a.fromResearch))) throw new Error('bad research id'); argv.push('--from-research', str(a.fromResearch), '--pick', String(Math.max(1, Math.min(10, Number(a.pick) || 1)))); }
      else { const niche = str(a.niche).slice(0, 400); if (!niche) throw new Error('plan needs a niche or fromResearch'); argv.push('--niche', niche); }
      if (a.audience) { if (!['adult', 'teen', 'kids'].includes(a.audience)) throw new Error('audience is adult|teen|kids'); argv.push('--audience', a.audience); }
      if (a.complexity) { if (!['simple', 'medium', 'intricate'].includes(a.complexity)) throw new Error('complexity is simple|medium|intricate'); argv.push('--complexity', a.complexity); }
      argv.push('--pages', String(Math.max(8, Math.min(60, Number(a.pages) || 40))));
      return argv;
    },
    generate: a => {
      const argv = ['generate', book(a)];
      if (a.pages != null && str(a.pages)) { if (!PAGES.test(str(a.pages))) throw new Error('pages looks like "1-3,5"'); argv.push('--pages', str(a.pages)); }
      argv.push('--variants', String(Math.max(1, Math.min(3, Number(a.variants) || 2))));
      return argv;
    },
    cover: a => ['generate', book(a), '--cover'],
    vision: a => ['qc', book(a), '--vision'],
    listing: a => ['listing', book(a)],
  };
  const MAKE = {
    qc: a => ['qc', book(a)],
    build: a => ['build', book(a)],
    review: a => ['review', book(a)],
  };
  function book(a) { const b = str(a.book); if (!SLUG.test(b)) throw new Error('name the book by its id (e.g. "cozy-cottage-kitchens")'); return b; }

  function makeColorbookTools(deps) {
    const { spawn, ventureDir, ventureView, envFor, keyFor } = deps;
    const python = deps.python || (process.platform === 'win32' ? 'python' : 'python3');
    const redact = deps.redact || (s => s);

    function run(argv, ctx, needsKeys) {
      const cwd = ventureDir();
      const env = Object.assign({}, envFor(), { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' });
      if (needsKeys) {
        const a = keyFor('anthropic'), o = keyFor('openai');
        if (needsKeys.includes('anthropic') && !a) return Promise.resolve({ ok: false, text: 'No Anthropic key is saved in the station (SETTINGS → PROVIDERS). The press uses Claude for research, plans, vision checks and listings.' });
        if (needsKeys.includes('openai') && !o) return Promise.resolve({ ok: false, text: 'No OpenAI key is saved in the station (SETTINGS → PROVIDERS). The press draws pages with GPT Image.' });
        if (a) env.ANTHROPIC_API_KEY = a;
        if (o) env.OPENAI_API_KEY = o;
      }
      return new Promise(resolve => {
        let out = '', done = false;
        let child;
        try { child = spawn(python, ['-m', 'colorbook.cli'].concat(argv), { cwd, env, windowsHide: true }); }
        catch (e) { return resolve({ ok: false, text: 'could not start Python (' + ((e && e.message) || e) + ')' }); }
        const add = d => { out += String(d); if (out.length > 200000) out = out.slice(-100000); };
        child.stdout && child.stdout.on('data', add);
        child.stderr && child.stderr.on('data', add);
        const finish = (ok, extra) => { if (done) return; done = true; resolve({ ok, text: redact((extra ? extra + '\n' : '') + out.trim()).slice(-OUT_MAX) }); };
        child.on('error', e => finish(false, /ENOENT/.test(String(e && e.code)) ? 'Python was not found. Install Python 3.11+ and the pipeline: pip install -e ventures/coloring-books' : String((e && e.message) || e)));
        child.on('close', code => {
          if (code !== 0 && /No module named ['"]?colorbook/.test(out)) return finish(false, 'The colorbook pipeline is not installed for ' + python + ': pip install -e ventures/coloring-books');
          finish(code === 0, code === 0 ? '' : 'colorbook exited with code ' + code);
        });
        if (ctx && ctx.signal) ctx.signal.addEventListener('abort', () => { try { child.kill(); } catch (_) {} finish(false, 'cancelled'); }, { once: true });
      });
    }

    const pressStatus = {
      name: 'press_status', capability: 'press', scope: 'read', requiresConsent: false, timeoutMs: 15000,
      description: 'Read the Coloring Book Press: every book with its stage (planned → drawing → review → approved → '
        + 'print-ready → listed → live), pages awaiting the Commander\'s review, sales, the venture level, and the open '
        + 'quests in priority order. Call this first to decide what to work on.',
      schema: { type: 'object', properties: {} },
      async run() {
        const v = ventureView();
        const lines = ['Venture level ' + v.game.level + ' (' + v.game.title + '), ' + v.game.xp + ' XP, royalties $' + v.game.coins.usd];
        for (const b of v.metrics.books) lines.push('- ' + b.slug + ': "' + b.title + '" — ' + b.stage + ', ' + b.pagesApproved + '/' + b.pagesTotal + ' approved'
          + (b.pagesAwaiting ? ', ' + b.pagesAwaiting + ' awaiting review' : '') + (b.stage === 'live' ? ', ' + b.unitsSold + ' sold' : ''));
        if (!v.metrics.books.length) lines.push('(no books yet)');
        lines.push('Quests:'); for (const q of v.game.quests.slice(0, 6)) lines.push('  * ' + q.text);
        return { content: lines.join('\n'), summary: v.metrics.books.length + ' books, Lv ' + v.game.level };
      },
    };

    const pressMake = {
      name: 'press_make', capability: 'press', scope: 'write', requiresConsent: false, timeoutMs: 10 * 60000,
      description: 'Run a FREE local step of the coloring-book pipeline on one book: op "qc" scores every generated page '
        + '(shading, solid fills, edge crops, too few/many colorable areas, near-duplicates) and picks the best variant; '
        + '"build" makes the KDP interior + wraparound cover PDFs from APPROVED pages; "review" writes the review sheet. '
        + 'Approving pages is the Commander\'s job in the WORKSHOP — never claim pages are approved.',
      schema: { type: 'object', required: ['op', 'book'], properties: { op: { type: 'string', enum: Object.keys(MAKE) }, book: { type: 'string' } } },
      async run(args, ctx) {
        const argv = MAKE[args.op](args);                      // throws on bad input → the dispatcher reports it
        const r = await run(argv, ctx, null);
        if (!r.ok) throw new Error(r.text || ('press ' + args.op + ' failed'));
        return { content: r.text || '(no output)', summary: 'press ' + args.op + ' ' + args.book };
      },
    };

    const pressSpend = {
      name: 'press_spend', capability: 'press', scope: 'execute', requiresConsent: true, timeoutMs: 45 * 60000,
      description: 'Run a step of the coloring-book pipeline that SPENDS API money (the Commander approves each call): '
        + 'op "research" (seed) researches niches with web search; "plan" (niche or fromResearch+pick, audience, complexity, pages) '
        + 'plans a book: title, shared art style and one scene per page; "generate" (book, optional pages like "1-3", variants 1-3) '
        + 'draws line-art pages with GPT Image (~$0.17–0.25 per image at high quality); "cover" draws the color cover art; '
        + '"vision" has Claude inspect every page for text artifacts and malformed anatomy; "listing" writes the Amazon '
        + 'title, description, 7 keywords and price. Generate a 3-page pilot first and let the Commander check the style '
        + 'before drawing a whole book. Never use trademarked characters or brands.',
      schema: { type: 'object', required: ['op'], properties: {
        op: { type: 'string', enum: Object.keys(SPEND) },
        book: { type: 'string' }, seed: { type: 'string' }, niche: { type: 'string' }, fromResearch: { type: 'string' },
        pick: { type: 'number' }, audience: { type: 'string' }, complexity: { type: 'string' }, pages: { type: 'string' },
        variants: { type: 'number' } } },
      async run(args, ctx) {
        const argv = SPEND[args.op](args);                     // throws on bad input → the dispatcher reports it
        const keys = { research: ['anthropic'], plan: ['anthropic'], generate: ['openai'], cover: ['openai'], vision: ['anthropic'], listing: ['anthropic'] }[args.op];
        const r = await run(argv, ctx, keys);
        if (!r.ok) throw new Error(r.text || ('press ' + args.op + ' failed'));
        return { content: r.text || '(no output)', summary: 'press ' + args.op + (args.book ? ' ' + args.book : '') };
      },
    };

    return {
      tools: [pressStatus, pressMake, pressSpend],
      register(reg) { reg.register(pressStatus); reg.register(pressMake); reg.register(pressSpend); },
      _internals: { SPEND, MAKE, run },
    };
  }

  return { makeColorbookTools };
});
