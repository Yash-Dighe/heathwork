# Hearthwork handoff — context from the founding session (2026-10-03)

This is the context from the conversation that started Hearthwork, so a new Claude Code session can
pick up where it left off. `CLAUDE.md` holds the rules; this holds the story, decisions and next steps.

## How it started

1. An Instagram reel by @androo.agi showed "ULTRON-OS": a pixel-art station of AI-agent "businesses"
   (Etsy print-on-demand, a Fiverr thumbnail studio, a competitor lab) with revenue counters. Its
   engine is **StarNet** (github.com/androoAGI/starnet), MIT-licensed code; name/art/sprites are not.
2. Feasibility of AI coloring books / print-on-demand (researched Oct 2026):
   - KDP paperback royalty: 60% at $9.99+ (50% below), minus print cost (~$2.84 for an 8.5×11 coloring
     book) → about **$3.15 at $9.99, $4.95 at $12.99** per sale.
   - Etsy POD shirt at $25 via Printify: about $9 kept (Etsy 6.5% + 3% + $0.25 + $0.20 listing).
   - KDP requires an AI-content disclosure (not shown to buyers). Etsy requires AI disclosure and listing
     production partners; enforcement is inconsistent. Low-effort AI books get called out in reviews:
     niche, quality and series matter.
   - Verdict: cheap to try, real but slow; start with KDP coloring books in 2–3 specific niches.
3. Built the `colorbook` pipeline, then forked StarNet into Hearthwork and built the business layer.

## Decisions

| Topic | Decision |
|---|---|
| Name | **Hearthwork** (working name; GitHub repo is `Yash-Dighe/heathwork`, missing an "r" — renaming is fine, then update `brand.json` "github" and rerun rebrand) |
| Approach | Fork + reskin. Keep the agent runtime; replace name, UI theme and all art |
| Theme | Cozy village / farm. "Lantern-lit cottage at dusk": walnut panels, cream text, honey + moss, Pixelify Sans (OFL), no CRT effects, MEADOW backdrop, brighter rooms |
| Art | AI pixel-art tools (PixelLab) through the existing manifest slots — **not started** |
| Services | Self-host everything (relay, signed skill catalog, auto-updates via GitHub Releases + own key). **No** credits/billing service; everyone uses their own API key |
| Repo | Owner's GitHub, fresh history (no StarNet art in history), Yash as sole author |
| Scope | Start small: coloring books first, add ventures as a building each |
| Models | Owner has **Gemini Pro** (Google AI Pro → $10/month Cloud credits via Google Developer Program "My Benefits"). Using the **paid** Gemini API tier (paid tier: content not used to improve Google products). Gemini 3.8 Flash for text, `gemini-3.1-flash-image` (Nano Banana 2) at 2K ≈ $0.101/image. Anthropic/OpenAI keys optional |

## What exists (all on `main`)

- **Fork foundation**: StarNet art, sprites, logos, website, SFX removed; third-party provider logos kept
  (Simple Icons CC0, LobeHub MIT). `brand.json` + `scripts/rebrand.mjs` (display names, desktop identifier
  `app.hearthwork.desktop`, keychain service, wordmark via `scripts/make-wordmark.mjs`, service URLs,
  updater endpoint). Env namespace `STARNET_*` and header `X-StarNet-Token` intentionally kept (protocol).
- **Theme**: `theme-hearth`, MEADOW backdrop (`frontend/app/spacebg.js`), cozy defaults in `stationui.js`.
- **Venture engine** (`sidecar/ventures/`): reads book stages from colorbook files (planned → drawing →
  review → approved → print-ready → listed → live), imports KDP royalty reports (.xlsx/.csv, header-matched,
  de-duplicated), XP = formula over real outcomes + milestone bonuses, levels/titles, quests ordered by
  closeness to money. Coins = reported USD royalties; other currencies kept separately, never converted.
- **WORKSHOP window** (WORK dock): level/XP bar, coins, stat tiles, next-up quests, bookshelf with stage
  tracks + MARK LIVE, milestone badges, monthly chart, report drop zone, fanfare on new milestones, and
  **page review** (approve / choose variant / send back with a note — the note feeds the next redraw).
- **COLORING BOOK PRESS**: placeable capability prop (code-drawn pixel art) granting `press_status`,
  `press_make` (qc/build/review, free) and `press_spend` (research/plan/generate/cover/vision/listing,
  consent-gated). Python runs argv-only with a sanitized env plus the station's Anthropic/OpenAI/Gemini keys.
- **colorbook pipeline**: Claude or Gemini text, OpenAI or Gemini images (auto from keys), pixel QC +
  optional vision QC, KDP interior/cover PDFs (gutter by page count, blank backs, spine text ≥ 80 pages,
  barcode zone), listing (7 keywords ≤ 50 chars, title+subtitle < 200), `publish` records ASIN/price.
- **Workflows**: StarNet's 15-minute source mirror and tag-triggered release train disabled; fast-gate on
  PRs + manual.
- **Tests**: new tests pass (`ventures`, `ventures.http`, `colorbook-tools` incl. a live pipeline run,
  Python `tests/test_gemini.py` through the real google-genai SDK with mocked HTTP). Remaining fast-gate
  failures are categorized in `test/fork-skip.list`; Chrome-driven e2e tests need a real Chrome.

## Not yet verified

- **No run against real models yet.** Everything was tested with mock images and mocked HTTP. The first
  real run is the owner's 3-page Gemini pilot. Watch Gemini line-art quality (clean black outlines, no gray
  shading); if it's weak, tune `prompts.py LINE_ART_RULES` for Gemini or add an OpenAI key for drawing.
- KDP report column names were matched by meaning; confirm against a real KDP download.

## Owner's current step

On Windows, in `C:\Users\yashd\money\heathwork`: `git pull`, `pip install -e ".[dev]"` in
`ventures\coloring-books`, restart `node sidecar/index.js`, set up Gemini paid tier (link billing, activate
Pro credits, budget alert, key from aistudio.google.com/apikey in the billed project), paste the key in
SETTINGS → PROVIDERS → Gemini, place the COLORING BOOK PRESS in BUILD MODE, ask the agent for a 3-page pilot.

## Next steps (in order)

1. Support the first real pilot run; fix whatever breaks.
2. Auto-updates: owner runs `node scripts/updater-keys.mjs`, adds `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`
   GitHub secrets → write a Hearthwork release workflow (replace StarNet's release train); re-enable the
   updater tests in `test/fork-skip.list`.
3. Village art (PixelLab): cottage shell/walls/floors replacing the octagon space hull, workshop props,
   villager sprites (144×144, 8 rotations, walk 6 frames × 8 dirs, sit ×4, type-north ×4). Replace the
   upstream skin catalog in `frontend/app/data-shim.js`, which includes trademarked characters and real
   people. Re-enable art tests as assets land.
4. Self-hosted skill catalog (own signing key, GitHub Pages) and phone relay (`relay/`, Fly.io/Docker).
5. More ventures (Etsy stickers / POD) as new buildings; in-world Workshop visuals that fill up as the
   business grows.

## Side research (owner asked about a "vibecoding setup")

Verdicts from a research pass (Oct 2026): **OmniRoute — skip** (intermediates Claude subscription OAuth
tokens, against Anthropic's terms; installs a MITM CA). **claude-mem — caution** (telemetry on by default
per its docs, reads the Claude Code OAuth token, upsells). **Headroom — optional** (local
context-compression proxy via `ANTHROPIC_BASE_URL`; turn its beacon off). Prefer built-ins: CLAUDE.md +
auto memory, permissions + sandbox, hooks, subagents, statusline, checkpoints, agent view (`claude agents`,
`--bg`). "Task observer" was ambiguous (rebelytics task-observer skill, or simple10/agents-observe).
