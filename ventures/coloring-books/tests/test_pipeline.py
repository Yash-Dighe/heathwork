import io
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from pypdf import PdfReader

from colorbook import kdp, pipeline, qc, render
from colorbook.config import Settings
from colorbook.images import MockImages
from colorbook.models import BookPlan, BookStore

EXAMPLE = Path(__file__).parent.parent / "examples" / "sample_plan.json"


def test_kdp_math():
    assert kdp.gutter(24) == 0.375
    assert kdp.gutter(151) == 0.5
    g = kdp.cover_geometry(100)
    assert g.spine == pytest.approx(0.2252)
    assert g.width == pytest.approx(0.25 + 17 + 0.2252)
    assert g.height == pytest.approx(11.25)
    assert g.spine_text_allowed
    assert not kdp.cover_geometry(60).spine_text_allowed
    assert kdp.royalty(9.99, 2.84) == pytest.approx(3.15, abs=0.01)
    assert kdp.royalty(8.99, 2.84) == pytest.approx(1.66, abs=0.01)


def test_parse_pages():
    assert pipeline.parse_pages("1-3,5", range(1, 10)) == [1, 2, 3, 5]
    assert pipeline.parse_pages(None, [3, 1, 2]) == [1, 2, 3]


def test_layout_even_and_min_pages():
    for n in (1, 5, 10, 40):
        seq = render.interior_layout(n)
        assert len(seq) % 2 == 0 and len(seq) >= kdp.MIN_PAGES
        # designs on right-hand (odd) pages, each followed by a blank
        for i, (kind, _) in enumerate(seq, start=1):
            if kind == "design":
                assert i % 2 == 1 and seq[i][0] == "blank"


def _img(draw_fn, size=(800, 1000)):
    im = Image.new("L", size, 255)
    draw_fn(ImageDraw.Draw(im))
    return im


def test_qc_flags_clean_line_art_ok():
    def f(d):
        for r in range(40, 360, 20):
            d.ellipse([400 - r, 500 - r, 400 + r, 500 + r], outline=0, width=4)
            d.line([400 - r, 500, 400 + r, 500], fill=0, width=4)
    m = qc.line_art_metrics(_img(f))
    assert qc.flags_for(m, "medium") == []


def test_qc_flags_shading_fill_and_edges():
    shaded = _img(lambda d: d.rectangle([100, 100, 700, 900], fill=128))
    assert "shading/gray tones" in qc.flags_for(qc.line_art_metrics(shaded), "medium")
    filled = _img(lambda d: d.rectangle([200, 200, 600, 800], fill=0))
    assert "large solid black fill" in qc.flags_for(qc.line_art_metrics(filled), "medium")
    framed = _img(lambda d: d.rectangle([0, 0, 799, 999], outline=0, width=12))
    assert "touches page edge / frame" in qc.flags_for(qc.line_art_metrics(framed), "medium")


def test_dhash_detects_duplicates():
    a = _img(lambda d: d.ellipse([100, 100, 700, 900], outline=0, width=6))
    b = a.copy()
    c = _img(lambda d: d.rectangle([50, 300, 750, 500], outline=0, width=6))
    assert qc.hamming(qc.dhash(a), qc.dhash(b)) == 0
    assert qc.hamming(qc.dhash(a), qc.dhash(c)) > 20


def test_end_to_end_mock(tmp_path):
    s = Settings(books_dir=tmp_path, image_size="768x1024", cover_image_size="768x1024")
    store = BookStore(tmp_path)
    plan = BookPlan.model_validate_json(EXAMPLE.read_text())
    book = store.create("cozy", plan)
    logs = []
    pipeline.generate_pages(book, store, MockImages(), s, [1, 2, 3, 4, 5, 6, 7, 8], 2, logs.append)
    assert all(len(p.variants) == 2 for p in book.pages)
    pipeline.run_qc(book, store, list(range(1, 9)), None, logs.append)
    pipeline.reject(book, store, 3, "make the loaves larger")
    pipeline.generate_pages(book, store, MockImages(), s, [3], 1, logs.append)
    assert len(book.page(3).variants) == 3
    assert "make the loaves larger" in book.page(3).variants[-1].prompt
    pipeline.run_qc(book, store, [3], None, logs.append)
    for p in book.pages:
        p.status = "approved"
    pipeline.generate_cover(book, store, MockImages(), s, logs.append)

    interior, n = render.build_interior(book, store.dir("cozy"), s)
    r = PdfReader(str(interior))
    assert len(r.pages) == n and n >= 24 and n % 2 == 0
    box = r.pages[0].mediabox
    assert (float(box.width), float(box.height)) == (612.0, 792.0)

    cover = render.build_cover(book, store.dir("cozy"), n, s)
    cb = PdfReader(str(cover)).pages[0].mediabox
    g = kdp.cover_geometry(n)
    assert float(cb.width) == pytest.approx(g.width * 72, abs=0.5)
    assert float(cb.height) == pytest.approx(g.height * 72, abs=0.5)

    reloaded = store.load("cozy")
    assert reloaded.usage.image_calls == 8 * 2 + 1 + 1
    assert pipeline.review_sheet(reloaded, store).exists()
