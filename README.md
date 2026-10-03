<div align="center">

<img src="frontend/assets/brand/logo.svg" alt="Hearthwork" width="420">

**A cozy pixel village where real AI agents run your small businesses.**

</div>

Hearthwork is a local-first desktop app. You create AI agents, give them rooms and tools in a
pixel-art village, and they do real work with real models: research, writing, image generation,
publishing prep. Your business progress (books shipped, copies sold, royalties earned) drives the
game: levels, quests and milestones come from real numbers, never invented ones.

The first venture is **coloring books for Amazon KDP** (`ventures/coloring-books/`): niche research →
book plan → AI line art → QC → your approval → print-ready interior + cover PDFs → listing copy.

## Run from source

Requirements: Node.js 22, Git. Python 3.11+ for the coloring-book pipeline. Rust + the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) only for the desktop build.

```bash
npm ci
node sidecar/index.js          # then open http://localhost:8787
```

Bring your own model key (OpenRouter, Anthropic, OpenAI, Gemini…) or run a local model with Ollama.

## Run free with a local model

No key, no account, no bill: install [Ollama](https://ollama.com), pull a model that supports tools
(`ollama pull qwen3:8b`), and pick **OLLAMA** on the first-run screen or later in
**SETTINGS → PROVIDERS**. Local models are smaller than the cloud ones, so expect slower and rougher
work on long tasks, and a model needs a large context window to be useful.

## The coloring-book pipeline

```bash
cd ventures/coloring-books
pip install -e ".[dev]"
colorbook --help
```

## Brand and services

Everything that names the app or points at a server lives in `brand.json`. After editing it:

```bash
node scripts/rebrand.mjs       # renames display text, desktop identity, wordmark, service URLs
```

Service URLs left empty switch that feature off: the phone relay, the skill catalog, the update
server, pricing/privacy links. Hearthwork makes no calls to any server you haven't configured.

## Layout

| Path | What it is |
| --- | --- |
| `frontend/` | The village UI (vanilla JS, no build step) |
| `sidecar/` | Local Node agent runtime: providers, tools, permissions, budgets, persistence |
| `shared/` | Event/schema contracts between the two, plus `brand.json` for the runtime |
| `ventures/` | Business pipelines the agents operate (coloring books first) |
| `relay/` | Self-hostable phone relay |
| `src-tauri/` | Desktop shell |
| `test/` | `npm run test:fast` is the merge gate |

## Credits and license

Hearthwork is a fork of [StarNet](https://github.com/androoAGI/starnet) by Andrew Sims, used under
the MIT License. StarNet's name, logo and artwork are not part of this project. See `NOTICE.md`
for all third-party credits. Hearthwork is MIT-licensed (`LICENSE`).
