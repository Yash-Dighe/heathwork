"""Stage implementations. Each stage reads/writes book.json, so any stage can be re-run."""
from __future__ import annotations

import html
import io
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Iterable, Optional

from PIL import Image

from . import prompts, qc
from .config import Settings
from .images import ImageProvider
from .llm import LLM
from .models import (Book, BookPlan, BookStore, Listing, NicheReport, Variant,
                     VisionVerdict, dump_json)

Log = Callable[[str], None]


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]


def parse_pages(spec: Optional[str], all_pages: Iterable[int]) -> list[int]:
    """'1-5,8,10-12' -> [1..5, 8, 10..12]. None -> all."""
    all_pages = sorted(all_pages)
    if not spec:
        return all_pages
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return [p for p in all_pages if p in out]


# ---------- research & plan ----------

def research(llm: LLM, seed: str, out_dir: Path) -> tuple[Path, NicheReport]:
    notes = llm.research(prompts.RESEARCH_SYSTEM, prompts.RESEARCH_PROMPT.format(seed=seed))
    report = llm.parse(prompts.NICHE_SYSTEM,
                       f"Seed: {seed}\n\nResearch notes:\n{notes}", NicheReport)
    report.candidates.sort(key=lambda c: c.score, reverse=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / slugify(seed)
    base.with_suffix(".md").write_text(f"# Research: {seed}\n\n{notes}\n")
    dump_json(report, base.with_suffix(".json"))
    return base.with_suffix(".md"), report


def plan_book(llm: LLM, niche: str, audience: str, complexity: str, n: int,
              notes: str = "") -> BookPlan:
    extra = f"Research context:\n{notes}\n" if notes else ""
    plan = llm.parse(prompts.PLAN_SYSTEM, prompts.PLAN_PROMPT.format(
        niche=niche, audience=audience, complexity=complexity, n=n, extra=extra), BookPlan)
    plan.pages = sorted(plan.pages, key=lambda p: p.n)
    for i, p in enumerate(plan.pages, start=1):  # renumber defensively
        p.n = i
    if len(plan.pages) != n:
        raise RuntimeError(f"Plan has {len(plan.pages)} pages, expected {n}; re-run plan.")
    return plan


# ---------- generation ----------

def generate_pages(book: Book, store: BookStore, provider: ImageProvider, settings: Settings,
                   pages: list[int], variants: int, log: Log, force: bool = False) -> None:
    bdir = store.dir(book.slug)
    lock = threading.Lock()
    jobs = []
    for n in pages:
        ps = book.page(n)
        if ps.status == "approved" and not force:
            continue
        if ps.status == "generated" and ps.variants and not force:
            continue
        note = ps.notes[-1] if ps.status == "rejected" and ps.notes else None
        prompt = prompts.page_prompt(book.plan, book.concept(n), note)
        start = len(ps.variants)
        for v in range(start + 1, start + variants + 1):
            jobs.append((n, v, prompt))
    if not jobs:
        log("Nothing to generate (pages already generated/approved; use --force to redo).")
        return
    log(f"Generating {len(jobs)} images ({settings.image_model}, {settings.image_size}, "
        f"~${len(jobs) * settings.est_cost_per_image:.2f} est.)")

    def work(job):
        n, v, prompt = job
        data = provider.generate(prompt, settings.image_size)
        rel = f"raw/p{n:03d}_v{v}.png"
        (bdir / rel).write_bytes(data)
        return n, Variant(file=rel, prompt=prompt)

    with ThreadPoolExecutor(max_workers=settings.concurrency) as ex:
        futs = {ex.submit(work, j): j for j in jobs}
        for fut in as_completed(futs):
            n = futs[fut][0]
            try:
                n, var = fut.result()
            except Exception as e:  # keep going; failed pages stay pending
                log(f"  page {n}: FAILED {type(e).__name__}: {e}")
                continue
            with lock:
                ps = book.page(n)
                ps.variants.append(var)
                ps.status = "generated"
                ps.chosen = None
                book.usage.image_calls += 1
                store.save(book)
            log(f"  page {n}: {var.file}")


def generate_cover(book: Book, store: BookStore, provider: ImageProvider,
                   settings: Settings, log: Log) -> None:
    data = provider.generate(prompts.cover_prompt(book.plan), settings.cover_image_size)
    k = sum(1 for _ in store.dir(book.slug).glob("raw/cover_v*.png")) + 1
    rel = f"raw/cover_v{k}.png"
    (store.dir(book.slug) / rel).write_bytes(data)
    book.cover_art = rel
    book.usage.image_calls += 1
    store.save(book)
    log(f"Cover art: {rel}")


# ---------- QC ----------

def run_qc(book: Book, store: BookStore, pages: list[int], llm: Optional[LLM], log: Log) -> None:
    bdir = store.dir(book.slug)
    for n in pages:
        ps = book.page(n)
        if not ps.variants or ps.status == "approved":
            continue
        for var in ps.variants:
            if var.score is not None and (llm is None or var.vision is not None):
                continue
            im = Image.open(bdir / var.file)
            var.metrics = qc.line_art_metrics(im)
            var.flags = qc.flags_for(var.metrics, book.plan.complexity)
            score = qc.heuristic_score(var.metrics, var.flags)
            if llm is not None and not any(f in var.flags for f in ("nearly empty",)):
                verdict = llm.parse_with_image(
                    prompts.VISION_SYSTEM,
                    prompts.VISION_PROMPT.format(scene=book.concept(n).scene),
                    im, VisionVerdict)
                var.vision = verdict
                if not verdict.passes:
                    var.flags.append("vision: " + "; ".join(verdict.issues[:3]) if verdict.issues
                                     else "vision: failed")
                score = 0.5 * score + 0.5 * verdict.score
            var.score = round(score, 2)
        best = max(ps.variants, key=lambda v: (not v.flags, v.score or 0))
        ps.chosen = best.file
        store.save(book)
        tag = "OK " if not best.flags else "!! "
        log(f"  {tag}page {n}: best={best.file} score={best.score} "
            f"{'flags=' + ', '.join(best.flags) if best.flags else ''}")

    hashes = {p.n: qc.dhash(Image.open(bdir / p.chosen)) for p in book.pages if p.chosen}
    for a, b, d in qc.near_duplicates(hashes):
        log(f"  !! pages {a} and {b} look nearly identical (distance {d})")


def approve(book: Book, store: BookStore, pages: list[int], all_passing: bool, log: Log) -> None:
    targets = pages
    if all_passing:
        targets = [p.n for p in book.pages
                   if p.status == "generated" and p.chosen and not _chosen(p).flags]
    for n in targets:
        ps = book.page(n)
        if not ps.chosen:
            log(f"  page {n}: nothing to approve (run generate + qc)")
            continue
        ps.status = "approved"
        log(f"  page {n}: approved ({ps.chosen})")
    store.save(book)


def choose(book: Book, store: BookStore, n: int, variant: int) -> None:
    ps = book.page(n)
    match = [v for v in ps.variants if v.file.endswith(f"_v{variant}.png")]
    if not match:
        raise KeyError(f"page {n} has no variant v{variant}")
    ps.chosen = match[0].file
    store.save(book)


def reject(book: Book, store: BookStore, n: int, note: str) -> None:
    ps = book.page(n)
    ps.status = "rejected"
    if ps.chosen:  # make sure QC won't pick the same image again
        v = _chosen(ps)
        if "rejected in review" not in v.flags:
            v.flags.append("rejected in review")
        ps.chosen = None
    if note:
        ps.notes.append(note)
    store.save(book)


def _chosen(ps) -> Variant:
    return next(v for v in ps.variants if v.file == ps.chosen)


# ---------- review sheet ----------

def review_sheet(book: Book, store: BookStore) -> Path:
    bdir = store.dir(book.slug)
    cards = []
    for ps in sorted(book.pages, key=lambda p: p.n):
        c = book.concept(ps.n)
        imgs = []
        for v in ps.variants:
            chosen = " chosen" if v.file == ps.chosen else ""
            flags = "<br>".join(html.escape(f) for f in v.flags) or "no flags"
            vnum = v.file.rsplit("_v", 1)[-1].split(".")[0]
            imgs.append(f'<figure class="v{chosen}"><a href="{v.file}" target="_blank">'
                        f'<img src="{v.file}" loading="lazy"></a><figcaption>v{vnum} · '
                        f'score {v.score}<br><span>{flags}</span></figcaption></figure>')
        cards.append(
            f'<section class="{ps.status}"><h2>Page {ps.n}: {html.escape(c.title)} '
            f'<em>{ps.status}</em></h2><p>{html.escape(c.scene)}</p>'
            f'<div class="row">{"".join(imgs) or "<i>not generated</i>"}</div></section>')
    cover = (f'<section><h2>Cover art</h2><img class="cover" src="{book.cover_art}"></section>'
             if book.cover_art else "")
    doc = f"""<!doctype html><meta charset="utf-8"><title>Review: {html.escape(book.plan.title)}</title>
<style>
body{{font:14px system-ui;margin:24px;background:#f6f6f4;color:#222}}
section{{background:#fff;border-radius:10px;padding:14px 18px;margin:0 0 16px;border-left:6px solid #bbb}}
section.approved{{border-color:#2a9d55}} section.rejected{{border-color:#d33}} section.generated{{border-color:#e0a800}}
h2{{font-size:16px;margin:0 0 4px}} h2 em{{font-weight:400;color:#777;font-size:13px}}
p{{margin:0 0 10px;color:#555}} .row{{display:flex;gap:12px;flex-wrap:wrap}}
figure{{margin:0;width:220px}} figure img{{width:100%;border:1px solid #ddd}}
figure.chosen img{{outline:3px solid #2a7de1}} figcaption{{font-size:12px;color:#444}}
figcaption span{{color:#b33}} img.cover{{max-width:360px}}
</style><h1>{html.escape(book.plan.title)}</h1>
<p>Approve: <code>colorbook approve {book.slug} 1 2 3</code> or <code>--all-passing</code> ·
Pick a variant: <code>colorbook choose {book.slug} PAGE VARIANT</code> ·
Redo: <code>colorbook reject {book.slug} PAGE --note "fix ..."</code></p>{cover}{"".join(cards)}"""
    out = bdir / "review.html"
    out.write_text(doc)
    return out


# ---------- listing ----------

def write_listing(book: Book, store: BookStore, llm: LLM) -> Path:
    p = book.plan
    research = ""
    if book.research_file and Path(book.research_file).exists():
        research = "Research notes:\n" + Path(book.research_file).read_text()[:12000]
    listing = llm.parse(prompts.LISTING_SYSTEM, prompts.LISTING_PROMPT.format(
        title=p.title, subtitle=p.subtitle, audience=p.audience, theme=p.theme,
        complexity=p.complexity, n=len(p.pages),
        designs="; ".join(c.title for c in p.pages), research=research), Listing)
    problems = []
    if len(listing.keywords) != 7:
        problems.append(f"{len(listing.keywords)} keywords (KDP allows 7)")
    problems += [f"keyword over 50 chars: {k!r}" for k in listing.keywords if len(k) > 50]
    if len(listing.title) + len(listing.subtitle) > 200:
        problems.append("title + subtitle over 200 characters")
    book.listing = listing
    store.save(book)

    md = [f"# KDP listing: {listing.title}", "",
          f"**Title:** {listing.title}", f"**Subtitle:** {listing.subtitle}",
          f"**Suggested price:** ${listing.suggested_price_usd:.2f} — {listing.pricing_rationale}", "",
          "## Keywords (7 slots)", *[f"{i}. {k}" for i, k in enumerate(listing.keywords, 1)], "",
          "## Category ideas", *[f"- {c}" for c in listing.category_suggestions], "",
          "## Description (paste into KDP)", "```html", listing.description_html, "```", "",
          "## Upload checklist",
          "- [ ] Interior: `build/interior.pdf` — 8.5 x 11 in, no bleed, black & white, white paper",
          "- [ ] Cover: `build/cover.pdf` — upload as a print-ready PDF; open the KDP previewer",
          "- [ ] AI content disclosure: answer **Yes** for AI-generated images (name the image "
          "model you used) and say whether the text was AI-assisted",
          "- [ ] Check print cost in KDP pricing and confirm royalty at your price",
          "- [ ] Order a proof copy before publishing"]
    if problems:
        md += ["", "## ⚠ Fix before uploading", *[f"- {x}" for x in problems]]
    out = store.dir(book.slug) / "listing.md"
    out.write_text("\n".join(md) + "\n")
    return out


def status_lines(book: Book, settings: Settings) -> list[str]:
    counts: dict[str, int] = {}
    for p in book.pages:
        counts[p.status] = counts.get(p.status, 0) + 1
    u = book.usage
    return [
        f"{book.plan.title} ({book.slug})",
        f"  pages: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())),
        f"  cover art: {book.cover_art or 'none'} · listing: {'yes' if book.listing else 'no'}",
        f"  usage: {u.image_calls} images (~${u.image_calls * settings.est_cost_per_image:.2f}), "
        f"{u.llm_input_tokens:,} in / {u.llm_output_tokens:,} out tokens, {u.web_searches} searches",
    ]
