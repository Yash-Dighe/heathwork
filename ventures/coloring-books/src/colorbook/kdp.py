"""Amazon KDP paperback spec math (US, black-and-white interior, white paper, no bleed).

Sources: KDP help "Set trim size, bleed, and margins" and "Create a paperback cover".
Re-check against KDP's own cover calculator before your first upload.
"""
from __future__ import annotations

from dataclasses import dataclass

DPI = 300
TRIM_W = 8.5
TRIM_H = 11.0
COVER_BLEED = 0.125
MIN_PAGES = 24
SPINE_PER_PAGE = {"white": 0.002252, "cream": 0.0025}
SPINE_TEXT_MIN_PAGES = 80  # KDP: spine text only for books with more than 79 pages
SPINE_TEXT_CLEARANCE = 0.0625
OUTSIDE_MARGIN_MIN = 0.25
# KDP auto-places the ISBN barcode on the back cover, lower right: keep 2" x 1.2" clear.
BARCODE_W, BARCODE_H, BARCODE_INSET = 2.0, 1.2, 0.25


def gutter(page_count: int) -> float:
    """Minimum inside margin (inches) for a given page count."""
    for limit, g in ((150, 0.375), (300, 0.5), (500, 0.625), (700, 0.75), (828, 0.875)):
        if page_count <= limit:
            return g
    raise ValueError("KDP paperbacks max out at 828 pages")


def spine_width(page_count: int, paper: str = "white") -> float:
    return page_count * SPINE_PER_PAGE[paper]


@dataclass(frozen=True)
class CoverGeometry:
    pages: int
    spine: float
    width: float   # full wrap incl. bleed, inches
    height: float

    @property
    def px(self) -> tuple[int, int]:
        return round(self.width * DPI), round(self.height * DPI)

    @property
    def spine_text_allowed(self) -> bool:
        return self.pages >= SPINE_TEXT_MIN_PAGES

    # x-ranges in inches from the left edge of the full wrap (bleed included)
    @property
    def back_x(self) -> tuple[float, float]:
        return 0.0, COVER_BLEED + TRIM_W

    @property
    def spine_x(self) -> tuple[float, float]:
        a = COVER_BLEED + TRIM_W
        return a, a + self.spine

    @property
    def front_x(self) -> tuple[float, float]:
        a = COVER_BLEED + TRIM_W + self.spine
        return a, self.width


def cover_geometry(page_count: int, paper: str = "white") -> CoverGeometry:
    s = spine_width(page_count, paper)
    return CoverGeometry(
        pages=page_count,
        spine=s,
        width=COVER_BLEED * 2 + TRIM_W * 2 + s,
        height=COVER_BLEED * 2 + TRIM_H,
    )


def royalty(list_price: float, print_cost: float) -> float:
    """Amazon.com paperback royalty: 60% at $9.99+, 50% below (since June 2025), minus print cost.

    Get print_cost from KDP's pricing page for your exact page count.
    """
    rate = 0.60 if list_price >= 9.99 else 0.50
    return round(list_price * rate - print_cost, 2)
