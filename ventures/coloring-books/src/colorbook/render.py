"""Print preparation: line-art cleanup, interior PDF, wrap-around cover PDF."""
from __future__ import annotations

import textwrap
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageStat
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from . import kdp
from .config import Settings, find_font
from .models import Book

INCH = 72.0
PAGE_MARGIN = 0.5  # generous safe margin on every side, above KDP minimums


# ---------- line art ----------

def prepare_line_art(raw: Image.Image, box_in: tuple[float, float]) -> Image.Image:
    """Upscale to 300 DPI for the target box and push near-white to white / near-black to black.

    Keeps a thin anti-aliased edge so lines don't look jagged when printed.
    """
    bw, bh = (round(v * kdp.DPI) for v in box_in)
    g = raw.convert("L")
    g.thumbnail((10**6, 10**6))
    scale = min(bw / g.width, bh / g.height)
    g = g.resize((max(1, round(g.width * scale)), max(1, round(g.height * scale))), Image.LANCZOS)
    a = np.asarray(g, dtype=np.float32)
    lo, hi = 70.0, 200.0
    a = np.clip((a - lo) / (hi - lo), 0, 1) * 255
    return Image.fromarray(a.astype(np.uint8), "L")


# ---------- fonts ----------

def _register_fonts(settings: Settings) -> tuple[str, str]:
    reg, bold = find_font("regular", settings), find_font("bold", settings)
    if "CB-Regular" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("CB-Regular", reg))
        pdfmetrics.registerFont(TTFont("CB-Bold", bold))
    return reg, bold


# ---------- interior ----------

def interior_layout(n_designs: int) -> list[tuple[str, int | None]]:
    """Page sequence. Designs always sit on right-hand (odd) pages with a blank back,
    so markers can't bleed into the next design."""
    seq: list[tuple[str, int | None]] = [
        ("title", None), ("copyright", None),
        ("belongs", None), ("blank", None),
    ]
    for i in range(n_designs):
        seq += [("design", i), ("blank", None)]
    seq += [("thanks", None)]
    while len(seq) < kdp.MIN_PAGES or len(seq) % 2:
        seq.append(("blank", None))
    return seq


def build_interior(book: Book, book_dir: Path, settings: Settings) -> tuple[Path, int]:
    approved = [p for p in sorted(book.pages, key=lambda p: p.n) if p.status == "approved" and p.chosen]
    if not approved:
        raise RuntimeError("No approved pages. Run qc/review/approve first.")
    _register_fonts(settings)

    seq = interior_layout(len(approved))
    total = len(seq)
    gut = max(kdp.gutter(total), PAGE_MARGIN)
    out = book_dir / "build" / "interior.pdf"
    W, H = kdp.TRIM_W * INCH, kdp.TRIM_H * INCH
    c = canvas.Canvas(str(out), pagesize=(W, H))
    c.setTitle(book.plan.title)
    c.setAuthor("")
    plan = book.plan

    for idx, (kind, di) in enumerate(seq, start=1):
        recto = idx % 2 == 1
        left = gut if recto else PAGE_MARGIN
        right = PAGE_MARGIN if recto else gut
        box_w = kdp.TRIM_W - left - right
        box_h = kdp.TRIM_H - 2 * PAGE_MARGIN

        if kind == "design":
            page = approved[di]
            raw = Image.open(book_dir / page.chosen)
            art = prepare_line_art(raw, (box_w, box_h))
            pp = book_dir / "print" / f"p{page.n:03d}.png"
            art.save(pp, dpi=(kdp.DPI, kdp.DPI))
            iw, ih = art.width / kdp.DPI, art.height / kdp.DPI
            x = left + (box_w - iw) / 2
            y = PAGE_MARGIN + (box_h - ih) / 2
            c.drawImage(ImageReader(str(pp)), x * INCH, y * INCH, iw * INCH, ih * INCH)
        elif kind == "title":
            c.setFont("CB-Bold", 30)
            _centered_wrapped(c, plan.title, W / 2, H * 0.62, 28, "CB-Bold", 30)
            c.setFont("CB-Regular", 15)
            _centered_wrapped(c, plan.subtitle, W / 2, H * 0.48, 50, "CB-Regular", 15)
        elif kind == "copyright":
            c.setFont("CB-Regular", 9)
            year = book.created[:4]
            owner = f" {book.author}" if book.author else ""
            lines = [plan.title, "", f"Copyright © {year}{owner}. All rights reserved.",
                     "No part of this book may be reproduced without permission,",
                     "except that the buyer may copy pages for personal coloring use."]
            for i, line in enumerate(lines):
                c.drawCentredString(W / 2, PAGE_MARGIN * INCH + 1.6 * INCH - i * 13, line)
        elif kind == "belongs":
            c.setFont("CB-Bold", 26)
            c.drawCentredString(W / 2, H * 0.62, "This Book Belongs To")
            c.setLineWidth(1)
            c.line(W * 0.2, H * 0.5, W * 0.8, H * 0.5)
        elif kind == "thanks":
            c.setFont("CB-Bold", 20)
            c.drawCentredString(W / 2, H * 0.6, "Thank you for coloring with us!")
            c.setFont("CB-Regular", 12)
            c.drawCentredString(W / 2, H * 0.55, "If you enjoyed this book, a review helps a lot.")
        c.showPage()
    c.save()
    return out, total


def _centered_wrapped(c, text, cx, top_y, width_chars, font, size):
    for i, line in enumerate(textwrap.wrap(text, width_chars)):
        c.setFont(font, size)
        c.drawCentredString(cx, top_y - i * size * 1.25, line)


# ---------- cover ----------

def _fit_font(draw, text, path, max_w, start, min_size=18):
    size = start
    while size > min_size:
        f = ImageFont.truetype(path, size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 4
    return ImageFont.truetype(path, min_size)


def _wrap_px(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = f"{cur} {w}".strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def build_cover(book: Book, book_dir: Path, page_count: int, settings: Settings) -> Path:
    if not book.cover_art:
        raise RuntimeError("No cover art. Run `colorbook generate <book> --cover` first.")
    reg, bold = _register_fonts(settings)
    geo = kdp.cover_geometry(page_count)
    D = kdp.DPI
    Wpx, Hpx = geo.px
    plan = book.plan

    art = Image.open(book_dir / book.cover_art).convert("RGB")
    fx0, fx1 = (round(v * D) for v in geo.front_x)
    fw = fx1 - fx0
    # cover-crop art to the front panel (incl. bleed)
    s = max(fw / art.width, Hpx / art.height)
    art = art.resize((round(art.width * s), round(art.height * s)), Image.LANCZOS)
    ox, oy = (art.width - fw) // 2, (art.height - Hpx) // 2
    art = art.crop((ox, oy, ox + fw, oy + Hpx))

    base = tuple(int(v * 0.35) for v in ImageStat.Stat(art).mean)  # dark tone from the art
    cover = Image.new("RGB", (Wpx, Hpx), base)
    cover.paste(art, (fx0, 0))
    d = ImageDraw.Draw(cover)
    bleed = round(kdp.COVER_BLEED * D)
    safe = round(0.375 * D)  # keep text well inside the trim

    # front title band
    band_h = round(Hpx * 0.27)
    band = cover.crop((fx0, 0, fx1, band_h)).filter(ImageFilter.GaussianBlur(18))
    overlay = Image.new("RGB", band.size, (255, 255, 255))
    cover.paste(Image.blend(band, overlay, 0.72), (fx0, 0))
    tx0, tx1 = fx0 + safe, fx1 - bleed - safe
    tw = tx1 - tx0
    y = bleed + safe
    tfont = ImageFont.truetype(bold, 150)
    lines = _wrap_px(d, plan.title, tfont, tw)
    while len(lines) > 3 or any(d.textlength(l, font=tfont) > tw for l in lines):
        tfont = ImageFont.truetype(bold, tfont.size - 8)
        lines = _wrap_px(d, plan.title, tfont, tw)
    for line in lines:
        lw = d.textlength(line, font=tfont)
        d.text((tx0 + (tw - lw) / 2, y), line, font=tfont, fill=(25, 25, 25))
        y += round(tfont.size * 1.12)
    sfont = _fit_font(d, plan.subtitle, reg, tw, 64, 30)
    for line in _wrap_px(d, plan.subtitle, sfont, tw)[:3]:
        lw = d.textlength(line, font=sfont)
        d.text((tx0 + (tw - lw) / 2, y + 10), line, font=sfont, fill=(50, 50, 50))
        y += round(sfont.size * 1.25)

    # back cover blurb, avoiding the barcode area (lower right)
    bx0 = bleed + safe
    bx1 = round(geo.back_x[1] * D) - safe
    bfont = ImageFont.truetype(reg, 52)
    by = bleed + round(1.2 * D)
    for para in plan.back_blurb.split("\n"):
        for line in _wrap_px(d, para, bfont, bx1 - bx0):
            d.text((bx0, by), line, font=bfont, fill=(245, 245, 245))
            by += round(bfont.size * 1.4)
        by += round(bfont.size * 0.6)
    # thumbnails of interior pages on the back cover
    thumbs = [book_dir / p.chosen for p in sorted(book.pages, key=lambda p: p.n)
              if p.status == "approved" and p.chosen][:3]
    if thumbs:
        tw_px = round(1.9 * D)
        gap = round(0.25 * D)
        tyy = by + gap
        for i, t in enumerate(thumbs):
            im = Image.open(t).convert("RGB")
            im.thumbnail((tw_px, round(tw_px * 4 / 3)))
            x = bx0 + i * (tw_px + gap)
            if tyy + im.height < Hpx - bleed - round((kdp.BARCODE_H + 0.6) * D):
                d.rectangle([x - 6, tyy - 6, x + im.width + 6, tyy + im.height + 6], fill="white")
                cover.paste(im, (x, tyy))

    # barcode keep-clear zone (white box where KDP prints the barcode)
    bc_w, bc_h, ins = (round(v * D) for v in (kdp.BARCODE_W, kdp.BARCODE_H, kdp.BARCODE_INSET))
    bc_x1 = round(geo.back_x[1] * D) - ins
    bc_y1 = Hpx - bleed - ins
    d.rectangle([bc_x1 - bc_w, bc_y1 - bc_h, bc_x1, bc_y1], fill="white")

    # spine
    sx0, sx1 = (round(v * D) for v in geo.spine_x)
    if geo.spine_text_allowed:
        avail = (sx1 - sx0) - 2 * round((kdp.SPINE_TEXT_CLEARANCE + 0.03) * D)
        sfont = ImageFont.truetype(bold, max(14, min(60, int(avail * 0.8))))
        text = plan.title
        tl = int(d.textlength(text, font=sfont))
        max_len = Hpx - 2 * (bleed + safe)
        while tl > max_len and sfont.size > 14:
            sfont = ImageFont.truetype(bold, sfont.size - 2)
            tl = int(d.textlength(text, font=sfont))
        strip = Image.new("RGB", (tl + 20, sfont.size + 20), base)
        ImageDraw.Draw(strip).text((10, 5), text, font=sfont, fill=(245, 245, 245))
        strip = strip.rotate(-90, expand=True)
        cover.paste(strip, (sx0 + (sx1 - sx0 - strip.width) // 2, (Hpx - strip.height) // 2))

    preview = book_dir / "build" / "cover.png"
    cover.save(preview, dpi=(D, D))
    out = book_dir / "build" / "cover.pdf"
    c = canvas.Canvas(str(out), pagesize=(geo.width * INCH, geo.height * INCH))
    c.drawImage(ImageReader(str(preview)), 0, 0, geo.width * INCH, geo.height * INCH)
    c.showPage()
    c.save()
    return out
