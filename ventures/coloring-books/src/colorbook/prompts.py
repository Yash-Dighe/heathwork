"""All prompt text lives here so it can be tuned in one place."""
from __future__ import annotations

from typing import Optional

from .models import BookPlan, PageConcept

LINE_ART_RULES = (
    "A single coloring book page. Pure black ink outlines on a pure white background. "
    "No shading, no gray tones, no hatching, no gradients, no solid black fills, no color. "
    "No text, letters, numbers, logos, watermarks or signatures. No border or frame around the page. "
    "Every shape is a closed outline so it can be colored in. Clean, continuous, confident lines. "
    "Portrait composition; the subject fills the page with a comfortable white margin on all sides."
)

COMPLEXITY = {
    "simple": "Thick bold outlines, large open areas, few small details. Easy to color with crayons.",
    "medium": "Medium line weight, balanced detail, a mix of large and small areas.",
    "intricate": "Fine but solid lines, rich decorative detail and patterns, many small areas, "
                 "for adults who like detailed coloring. Keep lines crisp, never sketchy.",
}


def page_prompt(plan: BookPlan, page: PageConcept, revision_note: Optional[str] = None) -> str:
    parts = [
        LINE_ART_RULES,
        f"Detail level: {COMPLEXITY[plan.complexity]}",
        f"Art direction: {plan.style_prompt}",
        f"Subject: {page.scene}",
    ]
    if revision_note:
        parts.append(f"Important correction from the previous attempt: {revision_note}")
    return "\n\n".join(parts)


def cover_prompt(plan: BookPlan) -> str:
    return "\n\n".join([
        "A full-color illustration for the front cover of a coloring book.",
        f"Scene: {plan.cover_scene}",
        f"Art direction: {plan.style_prompt} Rendered in full color, vibrant and inviting, "
        "showing what the colored pages could look like.",
        "Keep the top 30% of the image calm and uncluttered (simple background) because a title "
        "will be placed there. No text, letters, logos or watermarks anywhere in the image.",
    ])


RESEARCH_SYSTEM = (
    "You are a careful market researcher for Amazon KDP coloring books. Use web search to find "
    "real evidence: Amazon best-seller lists and category pages, search suggestions, Etsy/Pinterest "
    "trends, seasonal events, and seller communities. Distinguish evidence from guesses and cite URLs. "
    "Flag trademarked characters/brands (never recommend them) and oversaturated niches."
)

RESEARCH_PROMPT = """Seed idea: {seed}

Research coloring-book niches around this seed. For 5-8 candidate niches report:
- target audience (adult / teen / kids) and the specific buyer
- demand signals you actually found (with URLs)
- what the competition looks like (number/quality of existing books, typical prices, review complaints)
- a differentiation angle a new book could take
- risks (IP/trademarks, saturation, seasonality)
Finish with your top 3 picks and why."""

NICHE_SYSTEM = "Convert research notes into a structured niche report. Do not invent evidence."

PLAN_SYSTEM = (
    "You plan coloring books for Amazon KDP. Each page must be a distinct, concrete, drawable scene "
    "(no near-duplicates), appropriate for the audience, free of trademarked characters, brands, "
    "or text. Scenes describe composition and objects, not colors. The style_prompt is shared by all "
    "pages so the book looks consistent. The cover_scene shows the theme at its most appealing."
)

PLAN_PROMPT = """Niche: {niche}
Audience: {audience}
Complexity: {complexity}
Number of designs: {n}
{extra}
Plan the book. Number pages 1..{n}. Vary composition (close-ups, full scenes, patterns) across the book."""

VISION_SYSTEM = (
    "You are a strict print-quality reviewer for coloring book pages. Judge only what is visible."
)

VISION_PROMPT = """Intended design: {scene}

Check this page for print readiness as a coloring page:
- Is it clean black line art on white with no gray shading or large solid black fills?
- Any text, letters, pseudo-letters, signatures or watermarks?
- Any malformed anatomy (hands, faces, animals) or broken/impossible objects?
- Are shapes closed and colorable, with nothing important cut off at the edges?
- Does it match the intended design?
passes = true only if it could go in a paid book with no edits."""

LISTING_SYSTEM = (
    "You write Amazon KDP listings for coloring books. Be accurate and specific; never claim "
    "things the book doesn't contain, never mention other brands/authors/trademarks, no "
    "'bestseller' claims, no keyword stuffing in the title. Title + subtitle together under 200 "
    "characters. Exactly 7 backend keyword phrases, each 50 characters or fewer, not repeating "
    "words already in the title. Prices are USD; $9.99+ earns the 60% royalty tier."
)

LISTING_PROMPT = """Book plan:
Title: {title}
Subtitle: {subtitle}
Audience: {audience}
Theme: {theme}
Complexity: {complexity}
Designs ({n}): {designs}
Format: 8.5 x 11 in paperback, single-sided pages (blank back) to limit bleed-through.
{research}
Write the listing."""
