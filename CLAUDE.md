# Hearthwork — project instructions for Claude Code

Hearthwork is a cozy pixel-art village where real AI agents run small online businesses. Business
progress (books shipped, copies sold, royalties) drives the game: levels, quests and milestones come
only from real numbers. Owner: Yash Dighe. Full background, decisions and status: `docs/HANDOFF.md`.

## Hard rules

- **Commits are authored by Yash only.** No `Co-Authored-By`, no "Generated with Claude Code", no
  session links in commits or PRs (`.claude/settings.json` sets `attribution` off — keep it that way).
- **Never use StarNet's name, logo, artwork, sprites or brand.** Hearthwork is an MIT fork of StarNet
  v0.13.0 (androoAGI/starnet, Andrew Sims); only the *code* is licensed. Keep `LICENSE`'s copyright line.
  No trademarked characters or real people in art, sprites, prompts or books.
- **The UI never asserts state the files can't prove** (inherited product law). Venture XP, levels,
  coins and quests are recomputed from disk (`sidecar/ventures/`); never store or invent a score.
- **Agents never approve pages or mark a book live.** Those are the owner's actions in the WORKSHOP.
  Anything that spends API money stays consent-gated.
- **Secrets never enter the repo or a chat.** Keys live in the app's provider settings / OS keychain.
  The updater private key lives in `~/.hearthwork/updater.key` only.
- Don't call or depend on StarNet's servers (starnetos.com, his relay, his releases). Service URLs come
  from `brand.json`; empty = feature off.

## Commands

The owner is on **Windows / PowerShell 5**: chain with `;` or separate lines, never `&&`.

```powershell
npm ci
node sidecar/index.js                 # app at http://localhost:8787
node dev/seed.js                      # dev: pre-onboarded scratch workspace (dev/.env.dev for keys)
npm run test:fast                     # the merge gate (~1,000 steps; skips listed in test/fork-skip.list)
node test/<name>.test.js              # one test
node scripts/rebrand.mjs              # apply brand.json (name, identity, wordmark, service URLs)
node scripts/updater-keys.mjs         # create the auto-update signing key (run on the owner's machine)

cd ventures\coloring-books
pip install -e ".[dev]"               # the colorbook pipeline (Python 3.11+)
python -m pytest -q
colorbook --help
```

If the press can't find Python on Windows, set `SKYNET_PYTHON` (e.g. `py`) before starting the app.

## Map

| Path | What |
|---|---|
| `sidecar/` | Node agent runtime (providers, tools, permissions, budgets, persistence). `index.js` is the hot file; routes are in the `ROUTES` table. |
| `sidecar/ventures/` | Venture ledger (`ledger.js`), game layer (`progress.js`), KDP report import (`kdp-report.js`, `xlsx.js`), API (`routes.js`) |
| `sidecar/tools/builtin/colorbook.js` | COLORING BOOK PRESS tools: `press_status`, `press_make` (free local steps), `press_spend` (paid, consent) |
| `sidecar/capability/` | object → capability grants. A new placeable power touches: `registry.js`, `toolsets.js`, `capsummary.js`, `office.js`, frontend `worldmodel.js` CAP_PROP_MAP + `propsprites.js` CATALOG/painter + `toolprops.js`, and the lock tests (`capdrift`, `capprop-map.contract`, `toolprops`) |
| `frontend/` | Village UI, vanilla JS, no build step. `app/windows/workshop.js` + `css/workshop.css` = WORKSHOP; `app/spacebg.js` MEADOW backdrop; `css/style.css` `theme-hearth` |
| `ventures/coloring-books/` | `colorbook` Python CLI: research → plan → generate → qc → review → build (KDP PDFs) → listing → publish. Providers auto-picked from keys: Claude or Gemini (text), OpenAI or Gemini (images). |
| `brand.json` | Name, identifier, GitHub repo, updater pubkey, service URLs → `node scripts/rebrand.mjs` |
| `test/fork-skip.list` | Upstream tests skipped in the fork, by category (removed art, StarNet release train, his website) |

## Conventions

- Match the surrounding style: long explanatory header comments, pure node-testable engines with an
  injected clock, atomic writes (tmp + rename), `failNote()` instead of empty catches in `sidecar/`.
- Every behavior change gets a test; register new tests in `test/fast.list` (or `test/http.list` for
  tests that boot a sidecar).
- Workflows in `.github/workflows` are manual / PR-only on purpose (private repo minutes). Don't re-enable
  `sync-source-release` or tag-triggered `release-train` — those are StarNet's.
