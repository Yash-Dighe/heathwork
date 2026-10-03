"""Image providers. OpenAI GPT Image 2 for real runs, a procedural mock for offline testing."""
from __future__ import annotations

import base64
import hashlib
import io
import math
import random
import time
from typing import Protocol

from PIL import Image, ImageDraw

from .config import Settings


class ImageProvider(Protocol):
    def generate(self, prompt: str, size: str) -> bytes: ...


class OpenAIImages:
    def __init__(self, settings: Settings, client=None):
        if client is None:
            import openai

            client = openai.OpenAI()  # reads OPENAI_API_KEY
        self.client = client
        self.s = settings

    def generate(self, prompt: str, size: str) -> bytes:
        import openai

        delay = 4.0
        for attempt in range(5):
            try:
                resp = self.client.images.generate(
                    model=self.s.image_model, prompt=prompt, size=size,
                    quality=self.s.image_quality, n=1,
                    output_format="png", background="opaque",
                )
                return base64.b64decode(resp.data[0].b64_json)
            except (openai.RateLimitError, openai.APIConnectionError,
                    openai.InternalServerError, openai.APITimeoutError):
                if attempt == 4:
                    raise
                time.sleep(delay)
                delay *= 2
        raise RuntimeError("unreachable")


class MockImages:
    """Deterministic fake line art (or a color blob for cover prompts). No network."""

    def generate(self, prompt: str, size: str) -> bytes:
        w, h = (int(x) for x in size.split("x"))
        rng = random.Random(hashlib.sha256(prompt.encode()).digest())
        color = "full-color" in prompt.lower()
        im = Image.new("RGB", (w, h), "white")
        d = ImageDraw.Draw(im)
        if color:
            for _ in range(40):
                x, y, r = rng.randint(0, w), rng.randint(0, h), rng.randint(60, 400)
                d.ellipse([x - r, y - r, x + r, y + r],
                          fill=tuple(rng.randint(60, 255) for _ in range(3)))
        else:
            lw = max(3, w // 300)
            cx, cy = w // 2, h // 2
            petals = rng.randint(6, 14)
            for ring in range(1, 5):
                R = ring * min(w, h) // 10
                d.ellipse([cx - R, cy - R, cx + R, cy + R], outline="black", width=lw)
                for k in range(petals):
                    a = 2 * math.pi * k / petals + ring
                    px, py = cx + R * math.cos(a), cy + R * math.sin(a)
                    pr = R // 4
                    d.ellipse([px - pr, py - pr, px + pr, py + pr], outline="black", width=lw)
            for _ in range(12):
                x, y, r = rng.randint(100, w - 100), rng.randint(100, h - 100), rng.randint(20, 70)
                d.ellipse([x - r, y - r, x + r, y + r], outline="black", width=lw)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()


def make_provider(settings: Settings, mock: bool) -> ImageProvider:
    return MockImages() if mock else OpenAIImages(settings)
