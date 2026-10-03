# colorbook

A CLI pipeline that takes a coloring-book idea to KDP-ready files:
niche research → book plan → AI line art → automated QC → human review → interior PDF + wrap-around cover PDF → Amazon listing copy.

Claude does the thinking (research with web search, planning, vision QC, listing copy).
OpenAI GPT Image 2 draws the pages. You approve every page before it goes in a book.

## Architecture

```
research ──► plan ──► generate ──► qc ──► review/approve ──► build ──► listing
 Claude +     Claude    GPT Image 2   pixel     you (HTML       reportlab   Claude
 web search   (struct.  N variants    metrics + contact sheet)  + Pillow    (struct.
              output)   per page      Claude                               output)
                                      vision
                         ▲                         │
                         └──── reject --note ◄─────┘   (note is appended to the page's next prompt)
```

- **State:** one folder per book in `books/<slug>/` with `book.json` (plan, page status, variants, QC scores, usage), `raw/` (generated images), `print/` (300-DPI processed art), `build/` (PDFs), `review.html`, `listing.md`. Writes are atomic; every stage is re-runnable and skips work that's already done.
- **Page lifecycle:** `pending → generated → approved`, or `→ rejected → generated` with your correction note.
- **Consistency:** one shared `style_prompt` per book + fixed line-art rules (`prompts.py`), so pages look like one book rather than 40 random images.
- **QC (`qc.py`):** cheap checks on every image — stray gray/shading, ink coverage, large solid black fills, art touching the edge/frames, number of colorable regions vs. complexity, and near-duplicate detection (dHash) across pages. `--vision` adds a Claude pass for text artifacts, malformed anatomy, and concept match. The best variant per page is chosen automatically; you can override it.
- **Print (`render.py`, `kdp.py`):** 8.5×11 in, no bleed, designs on right-hand pages with blank backs (no marker bleed-through), gutter by page count, min 24 pages, even page count, embedded TTF fonts. Cover = back + spine + front + 0.125 in bleed, spine width = pages × 0.002252 in (white paper), spine text only at 80+ pages, barcode area kept clear.
- **Providers are swappable:** `images.ImageProvider` is a one-method protocol (`generate(prompt, size) -> png bytes`). `--mock` uses a procedural fake for offline testing.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env    # add your keys, then: set -a; source .env; set +a
pytest -q               # offline; no API calls
```

Needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Any setting in `config.py` can be overridden with `COLORBOOK_<NAME>` (e.g. `COLORBOOK_IMAGE_QUALITY=medium`, `COLORBOOK_TEXT_MODEL=claude-opus-5-5`).

## Workflow

```bash
colorbook research "cozy autumn"                        # -> research/cozy-autumn.md + .json, ranked niches
colorbook plan --from-research cozy-autumn --pick 1 --pages 40 --complexity medium --author "Your Pen Name"
#   (or: colorbook plan --niche "..." / --from-json examples/sample_plan.json)
#   edit books/<slug>/book.json now if you want to tweak titles/scenes

colorbook generate <slug> --pages 1-3                   # pilot: check the style before paying for 40 pages
colorbook qc <slug> --vision
colorbook review <slug>                                 # open books/<slug>/review.html
colorbook generate <slug>                               # the rest
colorbook qc <slug> --vision
colorbook approve <slug> --all-passing                  # or: approve <slug> 1 2 5
colorbook choose <slug> 7 2                             # use variant 2 for page 7
colorbook reject <slug> 12 --note "remove the extra paw" && colorbook generate <slug> --pages 12

colorbook generate <slug> --cover                       # full-color cover art
colorbook build <slug>                                  # build/interior.pdf, build/cover.pdf, build/cover.png
colorbook listing <slug>                                # listing.md: title, description, 7 keywords, price, checklist
colorbook status <slug>                                 # progress + spend
```

Try the whole thing offline first: `colorbook plan --from-json examples/sample_plan.json` then add `--mock` to each `generate`.

## Cost per book (rough)

40 designs × 2 variants at high quality ≈ 80 images ≈ $15–20 at ~$0.17–0.25 each, plus a few dollars of Claude usage (more with `--vision`). Use `COLORBOOK_IMAGE_QUALITY=medium` while iterating on style. `status` tracks image calls and tokens.

## Before you upload (things the code can't decide for you)

- **Calibrate QC on real output.** Thresholds in `qc.Thresholds` were set on synthetic art. Run a 3-page pilot, look at `review.html`, and adjust.
- **Cover art resolution.** GPT Image output is upscaled to 300 DPI for the front panel. Fine for soft illustration; if it looks soft in the KDP previewer, run the cover art through an upscaler first.
- **Verify specs in KDP's previewer** and with its cover calculator, and order a proof copy.
- **AI disclosure:** KDP requires you to declare AI-generated images when setting up the title.
- **No trademarks:** don't plan books around characters, brands, or franchises. The prompts tell Claude to avoid them; check anyway.

## Layout

```
src/colorbook/
  cli.py        Typer commands
  pipeline.py   stage logic (research, plan, generate, qc, approve/reject, review sheet, listing)
  prompts.py    every prompt in one place
  llm.py        Anthropic SDK: web search, structured output (messages.parse), vision
  images.py     OpenAI GPT Image 2 provider (+ retries), mock provider
  qc.py         line-art metrics, flags, scoring, duplicate detection
  render.py     line-art cleanup, interior PDF, cover PDF
  kdp.py        KDP spec math (gutter, spine, cover size, royalty)
  models.py     pydantic models + BookStore (book.json persistence)
```
