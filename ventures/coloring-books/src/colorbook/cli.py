"""colorbook CLI.

Typical flow:
  colorbook research "cozy autumn"            # Claude + web search -> research/<slug>.md/.json
  colorbook plan --from-research cozy-autumn --pick 1 --pages 40
  colorbook generate <book> --pages 1-3       # try a few first; check style before spending more
  colorbook qc <book> --vision
  colorbook review <book>                      # open books/<book>/review.html
  colorbook approve <book> --all-passing
  colorbook generate <book> --cover
  colorbook build <book>                       # interior.pdf + cover.pdf
  colorbook listing <book>
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer

from . import pipeline, render
from .config import Settings
from .images import make_provider
from .llm import LLM
from .models import BookPlan, BookStore, NicheReport

app = typer.Typer(add_completion=False, no_args_is_help=True, help=__doc__)


def _ctx():
    s = Settings.from_env()
    return s, BookStore(s.books_dir)


def _log(msg: str) -> None:
    typer.echo(msg)


def _load(store: BookStore, slug: str):
    if not store.exists(slug):
        raise typer.BadParameter(f"No book '{slug}' in {store.root}/")
    return store.load(slug)


@app.command()
def research(seed: str = typer.Argument(..., help="Theme or idea to research, e.g. 'cozy autumn'")):
    """Research niches around a seed idea (Claude with web search)."""
    s, _ = _ctx()
    llm = LLM(s)
    md, report = pipeline.research(llm, seed, Path("research"))
    typer.echo(f"Saved {md} and {md.with_suffix('.json')}\n")
    for i, c in enumerate(report.candidates, 1):
        typer.echo(f"{i}. [{c.score}/10] {c.name} ({c.audience}) — {c.angle}")
    typer.echo(f"\nNext: colorbook plan --from-research {md.stem} --pick 1")


@app.command()
def plan(
    niche: Optional[str] = typer.Option(None, help="Niche description (or use --from-research)"),
    from_research: Optional[str] = typer.Option(None, help="Research slug from `research`"),
    pick: int = typer.Option(1, help="Which candidate from the research report (1-based)"),
    audience: str = typer.Option("adult", help="adult | teen | kids"),
    complexity: str = typer.Option("medium", help="simple | medium | intricate"),
    pages: int = typer.Option(40, help="Number of designs"),
    slug: Optional[str] = typer.Option(None, help="Book id (default: from title)"),
    author: str = typer.Option("", help="Pen name for the copyright page"),
    from_json: Optional[Path] = typer.Option(None, help="Load a hand-written BookPlan JSON instead"),
):
    """Plan a book: title, shared art direction, and one concept per page."""
    s, store = _ctx()
    research_file = None
    llm = None
    if from_json:
        bp = BookPlan.model_validate_json(from_json.read_text())
    else:
        notes = ""
        if from_research:
            base = Path("research") / from_research
            rep = NicheReport.model_validate_json(base.with_suffix(".json").read_text())
            c = rep.candidates[pick - 1]
            niche = niche or f"{c.name}. Angle: {c.angle}"
            audience = c.audience
            notes = json.dumps(c.model_dump(), indent=2)
            research_file = str(base.with_suffix(".md"))
        if not niche:
            raise typer.BadParameter("Give --niche or --from-research")
        llm = LLM(s)
        bp = pipeline.plan_book(llm, niche, audience, complexity, pages, notes)
    slug = slug or pipeline.slugify(bp.title)
    if store.exists(slug):
        raise typer.BadParameter(f"Book '{slug}' exists; pass --slug to choose another id")
    book = store.create(slug, bp)
    book.author = author
    book.research_file = research_file
    if llm:
        book.usage = llm.usage
    store.save(book)
    typer.echo(f"Planned '{bp.title}' -> {store.dir(slug)}/book.json ({len(bp.pages)} designs)")
    for c in bp.pages[:5]:
        typer.echo(f"  {c.n}. {c.title}: {c.scene[:90]}")
    typer.echo(f"Edit book.json to tweak concepts, then: colorbook generate {slug} --pages 1-3")


@app.command()
def generate(
    book: str,
    pages: Optional[str] = typer.Option(None, help="e.g. '1-5,8' (default: all)"),
    variants: int = typer.Option(2, help="Images per page to choose from"),
    cover: bool = typer.Option(False, "--cover", help="Generate cover art instead of pages"),
    force: bool = typer.Option(False, help="Regenerate even if already generated/approved"),
    mock: bool = typer.Option(False, help="Offline fake images (for testing the pipeline)"),
):
    """Generate line art (or cover art) with the image model."""
    s, store = _ctx()
    b = _load(store, book)
    provider = make_provider(s, mock)
    if cover:
        pipeline.generate_cover(b, store, provider, s, _log)
        return
    sel = pipeline.parse_pages(pages, [p.n for p in b.pages])
    pipeline.generate_pages(b, store, provider, s, sel, variants, _log, force)
    typer.echo(f"Next: colorbook qc {book}")


@app.command(name="qc")
def qc_cmd(
    book: str,
    pages: Optional[str] = typer.Option(None),
    vision: bool = typer.Option(False, help="Also have Claude inspect each image"),
):
    """Score variants (pixel heuristics, optional Claude vision) and pick the best per page."""
    s, store = _ctx()
    b = _load(store, book)
    llm = LLM(s, usage=b.usage) if vision else None
    pipeline.run_qc(b, store, pipeline.parse_pages(pages, [p.n for p in b.pages]), llm, _log)
    store.save(b)
    typer.echo(f"Next: colorbook review {book}")


@app.command()
def review(book: str):
    """Write an HTML contact sheet of every page and variant."""
    _, store = _ctx()
    out = pipeline.review_sheet(_load(store, book), store)
    typer.echo(f"Open {out}")


@app.command(name="approve")
def approve_cmd(book: str, pages: list[int] = typer.Argument(None),
                all_passing: bool = typer.Option(False, help="Approve every page with no QC flags")):
    """Approve pages for the book."""
    _, store = _ctx()
    b = _load(store, book)
    pipeline.approve(b, store, pages or [], all_passing, _log)


@app.command(name="choose")
def choose_cmd(book: str, page: int, variant: int):
    """Use a different variant for a page (e.g. `choose mybook 4 2`)."""
    _, store = _ctx()
    pipeline.choose(_load(store, book), store, page, variant)
    typer.echo(f"page {page}: now using v{variant}")


@app.command(name="reject")
def reject_cmd(book: str, page: int,
               note: str = typer.Option("", help="Correction appended to the next prompt")):
    """Reject a page; the next `generate` redoes it with your note."""
    _, store = _ctx()
    pipeline.reject(_load(store, book), store, page, note)
    typer.echo(f"page {page}: rejected. Run: colorbook generate {book} --pages {page}")


@app.command()
def build(book: str):
    """Build build/interior.pdf and build/cover.pdf from approved pages."""
    s, store = _ctx()
    b = _load(store, book)
    pending = [p.n for p in b.pages if p.status != "approved"]
    if pending:
        typer.echo(f"Note: {len(pending)} pages not approved and will be left out: {pending}")
    interior, n_pages = render.build_interior(b, store.dir(book), s)
    typer.echo(f"Interior: {interior} ({n_pages} pages)")
    cover = render.build_cover(b, store.dir(book), n_pages, s)
    typer.echo(f"Cover:    {cover} (preview: {cover.with_suffix('.png')})")


@app.command()
def listing(book: str):
    """Write the Amazon listing (title, description, 7 keywords, price) to listing.md."""
    s, store = _ctx()
    b = _load(store, book)
    out = pipeline.write_listing(b, store, LLM(s, usage=b.usage))
    store.save(b)
    typer.echo(f"Listing: {out}")


@app.command()
def status(book: str):
    """Show progress and spend for a book."""
    s, store = _ctx()
    for line in pipeline.status_lines(_load(store, book), s):
        typer.echo(line)


if __name__ == "__main__":
    app()
