"""Data model. LLM output schemas avoid numeric/length constraints so they work with
Claude structured outputs; we validate ranges ourselves where it matters."""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

# ---------- LLM output schemas ----------


class NicheCandidate(BaseModel):
    name: str = Field(description="Short niche name, e.g. 'Cozy cottagecore kitchens for adults'")
    audience: Literal["adult", "teen", "kids"]
    angle: str = Field(description="What makes this book different from what's already selling")
    demand_signals: list[str] = Field(description="Evidence of buyer demand, with sources where possible")
    competition_notes: str
    risks: list[str] = Field(description="Trademark/IP issues, saturation, seasonality, etc.")
    score: int = Field(description="Overall opportunity 1-10")


class NicheReport(BaseModel):
    seed: str
    summary: str
    candidates: list[NicheCandidate]


class PageConcept(BaseModel):
    n: int = Field(description="1-based page number")
    title: str = Field(description="Short internal name for the design")
    scene: str = Field(description="Concrete visual description of one coloring page for an image model")


class BookPlan(BaseModel):
    title: str
    subtitle: str
    audience: Literal["adult", "teen", "kids"]
    theme: str
    complexity: Literal["simple", "medium", "intricate"]
    style_prompt: str = Field(description="One shared art-direction paragraph applied to every page")
    cover_scene: str = Field(description="Full-color cover illustration description, no text in the image")
    back_blurb: str = Field(description="2-4 sentence back-cover pitch")
    pages: list[PageConcept]


class VisionVerdict(BaseModel):
    passes: bool
    matches_concept: bool
    has_text_or_signature: bool
    has_shading_or_gray_fill: bool
    has_anatomy_or_object_errors: bool
    issues: list[str]
    score: int = Field(description="Print-readiness 1-10")


class Listing(BaseModel):
    title: str
    subtitle: str
    description_html: str = Field(description="Amazon description; simple HTML (<p>, <b>, <ul>, <li>) only")
    keywords: list[str] = Field(description="Exactly 7 backend keyword phrases, each 50 characters or fewer")
    category_suggestions: list[str]
    suggested_price_usd: float
    pricing_rationale: str


# ---------- Persistent book state ----------

PageStatus = Literal["pending", "generated", "approved", "rejected"]


class Variant(BaseModel):
    file: str
    prompt: str
    metrics: dict[str, float] = {}
    flags: list[str] = []
    vision: Optional[VisionVerdict] = None
    score: Optional[float] = None


class PageState(BaseModel):
    n: int
    status: PageStatus = "pending"
    variants: list[Variant] = []
    chosen: Optional[str] = None
    notes: list[str] = []


class Usage(BaseModel):
    image_calls: int = 0
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    web_searches: int = 0


class Book(BaseModel):
    slug: str
    author: str = ""  # pen name shown on copyright page
    created: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    plan: BookPlan
    pages: list[PageState]
    cover_art: Optional[str] = None
    listing: Optional[Listing] = None
    research_file: Optional[str] = None
    usage: Usage = Usage()

    def page(self, n: int) -> PageState:
        for p in self.pages:
            if p.n == n:
                return p
        raise KeyError(f"No page {n}")

    def concept(self, n: int) -> PageConcept:
        for c in self.plan.pages:
            if c.n == n:
                return c
        raise KeyError(f"No concept {n}")


class BookStore:
    """One directory per book: book.json + raw/ + print/ + build/."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def dir(self, slug: str) -> Path:
        return self.root / slug

    def exists(self, slug: str) -> bool:
        return (self.dir(slug) / "book.json").exists()

    def create(self, slug: str, plan: BookPlan) -> Book:
        d = self.dir(slug)
        for sub in ("raw", "print", "build"):
            (d / sub).mkdir(parents=True, exist_ok=True)
        book = Book(slug=slug, plan=plan, pages=[PageState(n=c.n) for c in plan.pages])
        self.save(book)
        return book

    def load(self, slug: str) -> Book:
        return Book.model_validate_json((self.dir(slug) / "book.json").read_text())

    def save(self, book: Book) -> None:
        d = self.dir(book.slug)
        d.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            f.write(book.model_dump_json(indent=2))
        os.replace(tmp, d / "book.json")  # atomic


def dump_json(model: BaseModel, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model.model_dump(), indent=2))
