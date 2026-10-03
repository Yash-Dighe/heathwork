"""Automated QC for line art: cheap pixel heuristics first, optional Claude vision second."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage


@dataclass(frozen=True)
class Thresholds:
    max_gray_ratio: float = 0.06      # mid-tone pixels beyond anti-aliasing => shading
    min_ink: float = 0.03             # almost empty page
    max_ink: float = 0.35             # heavy black fills / too dense to color
    max_edge_ink: float = 0.02        # ink in the outer 3% band => cropped subject or frame
    min_regions: int = 12             # too little to color
    max_regions: dict = None          # by complexity

    def regions_cap(self, complexity: str) -> int:
        caps = self.max_regions or {"simple": 250, "medium": 700, "intricate": 2500}
        return caps[complexity]


DEFAULT = Thresholds()
ANALYSIS_PX = 1024  # analyze at a fixed size so metrics are comparable across resolutions


def _gray(im: Image.Image) -> np.ndarray:
    g = im.convert("L")
    g.thumbnail((ANALYSIS_PX, ANALYSIS_PX), Image.LANCZOS)
    return np.asarray(g, dtype=np.float32) / 255.0


def line_art_metrics(im: Image.Image) -> dict[str, float]:
    g = _gray(im)
    h, w = g.shape
    ink = g < 0.5
    gray = (g > 0.2) & (g < 0.8)
    # anti-aliasing sits right next to ink; only count mid-tones that are NOT adjacent to lines
    near_ink = ndimage.binary_dilation(ink, iterations=2)
    stray_gray = gray & ~near_ink

    band = max(2, int(min(h, w) * 0.03))
    edge = np.zeros_like(ink)
    edge[:band, :] = edge[-band:, :] = True
    edge[:, :band] = edge[:, -band:] = True

    labels, count = ndimage.label(~ink)
    sizes = np.bincount(labels.ravel())[1:] if count else np.array([])
    min_area = h * w * 0.0002
    colorable = int((sizes >= min_area).sum())
    tiny = int(((sizes > 0) & (sizes < min_area)).sum())

    # largest solid-black blob as a share of the page (big fills are bad for coloring)
    ink_labels, n_ink = ndimage.label(ndimage.binary_erosion(ink, iterations=3))
    biggest_fill = float(np.bincount(ink_labels.ravel())[1:].max() / (h * w)) if n_ink else 0.0

    return {
        "ink_ratio": float(ink.mean()),
        "gray_ratio": float(stray_gray.mean()),
        "edge_ink": float(ink[edge].mean()),
        "regions": float(colorable),
        "tiny_regions": float(tiny),
        "biggest_fill": biggest_fill,
    }


def flags_for(m: dict[str, float], complexity: str, t: Thresholds = DEFAULT) -> list[str]:
    f = []
    if m["gray_ratio"] > t.max_gray_ratio:
        f.append("shading/gray tones")
    if m["ink_ratio"] < t.min_ink:
        f.append("nearly empty")
    if m["ink_ratio"] > t.max_ink:
        f.append("too much black")
    if m["biggest_fill"] > 0.02:
        f.append("large solid black fill")
    if m["edge_ink"] > t.max_edge_ink:
        f.append("touches page edge / frame")
    if m["regions"] < t.min_regions:
        f.append("too few colorable areas")
    if m["regions"] > t.regions_cap(complexity):
        f.append("too intricate for audience")
    return f


def heuristic_score(m: dict[str, float], flags: list[str]) -> float:
    """0-10. Penalize flags; mild preference for healthy ink coverage."""
    s = 10.0 - 2.5 * len(flags)
    s -= abs(m["ink_ratio"] - 0.12) * 10
    return round(max(0.0, s), 2)


def dhash(im: Image.Image, size: int = 16) -> int:
    g = im.convert("L").resize((size + 1, size), Image.LANCZOS)
    a = np.asarray(g, dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).ravel()
    return int("".join("1" if b else "0" for b in bits), 2)


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def near_duplicates(hashes: dict[int, int], max_dist: int = 20) -> list[tuple[int, int, int]]:
    """Pairs of pages whose chosen images look nearly identical (256-bit dHash)."""
    items = sorted(hashes.items())
    out = []
    for i, (pa, ha) in enumerate(items):
        for pb, hb in items[i + 1:]:
            d = hamming(ha, hb)
            if d <= max_dist:
                out.append((pa, pb, d))
    return out
