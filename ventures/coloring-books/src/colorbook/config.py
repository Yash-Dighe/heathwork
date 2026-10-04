"""Runtime settings. Every field can be overridden with a COLORBOOK_<FIELD> env var."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path


@dataclass
class Settings:
    # Which services do the work. "auto" picks from the keys present:
    #   text  (research, plans, vision QC, listings): ANTHROPIC_API_KEY → claude, else GEMINI_API_KEY → gemini
    #   images (pages, cover):                        OPENAI_API_KEY → openai,  else GEMINI_API_KEY → gemini
    text_provider: str = "auto"    # auto | anthropic | gemini
    image_provider: str = "auto"   # auto | openai | gemini

    # Gemini (one key covers text + images; the API has a free tier — on it, Google may use your prompts and
    # outputs to improve its products)
    gemini_text_model: str = "gemini-3.8-flash"
    gemini_image_model: str = "gemini-3.1-flash-image"
    gemini_image_size: str = "2K"  # ImageConfig.image_size; pages are upscaled to 300 DPI either way
    gemini_est_cost_per_image: float = 0.0  # free tier; set your paid rate if you upgrade

    # Claude: planning, research, listing copy, vision QC
    text_model: str = "claude-sonnet-5-5"
    vision_model: str = "claude-sonnet-5-5"
    research_max_searches: int = 8

    # OpenAI image generation. gpt-image-2 accepts any WxH divisible by 16 (aspect 1:3..3:1).
    # 1536x2048 is exactly 3:4, matching the 7.5x10in printable area of an 8.5x11 page.
    image_model: str = "gpt-image-2"
    image_size: str = "1536x2048"
    image_quality: str = "high"
    cover_image_size: str = "1536x2048"
    est_cost_per_image: float = 0.25  # USD, for the spend estimate only; check current pricing

    concurrency: int = 4
    books_dir: Path = field(default_factory=lambda: Path("books"))
    font_regular: str = ""  # optional explicit .ttf paths; otherwise auto-detected
    font_bold: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        s = cls()
        for f in fields(cls):
            raw = os.environ.get(f"COLORBOOK_{f.name.upper()}")
            if raw is None:
                continue
            cur = getattr(s, f.name)
            if isinstance(cur, bool):
                val = raw.lower() in ("1", "true", "yes")
            elif isinstance(cur, int):
                val = int(raw)
            elif isinstance(cur, float):
                val = float(raw)
            elif isinstance(cur, Path):
                val = Path(raw)
            else:
                val = raw
            setattr(s, f.name, val)
        return s


_FONT_CANDIDATES = {
    "regular": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    "bold": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "C:/Windows/Fonts/georgiab.ttf",
    ],
}


def gemini_key() -> str:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""


def image_cost(s: "Settings") -> float:
    """Estimated USD per generated image for the active image provider (spend estimates only)."""
    try:
        return s.gemini_est_cost_per_image if resolve_image_provider(s) == "gemini" else s.est_cost_per_image
    except RuntimeError:
        return s.est_cost_per_image


def resolve_text_provider(s: "Settings") -> str:
    if s.text_provider in ("anthropic", "gemini"):
        return s.text_provider
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if gemini_key():
        return "gemini"
    raise RuntimeError("No text model key: set ANTHROPIC_API_KEY or GEMINI_API_KEY (Gemini has a free tier).")


def resolve_image_provider(s: "Settings") -> str:
    if s.image_provider in ("openai", "gemini"):
        return s.image_provider
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    if gemini_key():
        return "gemini"
    raise RuntimeError("No image model key: set OPENAI_API_KEY or GEMINI_API_KEY (Gemini has a free tier).")


def find_font(kind: str, settings: Settings) -> str:
    """KDP requires embedded fonts, so we always use a real TTF (never PDF base-14 fonts)."""
    explicit = settings.font_bold if kind == "bold" else settings.font_regular
    for p in ([explicit] if explicit else []) + _FONT_CANDIDATES[kind]:
        if p and Path(p).exists():
            return p
    raise FileNotFoundError(
        f"No {kind} TTF font found. Set COLORBOOK_FONT_{kind.upper()} to a .ttf path."
    )
