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


GEMINI_RATIOS = {"1:1": 1.0, "3:4": 0.75, "4:5": 0.8, "2:3": 0.6667, "4:3": 1.3333, "3:2": 1.5, "9:16": 0.5625, "16:9": 1.7778}


def nearest_ratio(size: str) -> str:
    w, h = (int(x) for x in size.lower().split("x"))
    r = w / h
    return min(GEMINI_RATIOS, key=lambda k: abs(GEMINI_RATIOS[k] - r))


class GeminiImages:
    """Gemini image models ("Nano Banana"). Size is honoured as an aspect ratio; resolution via image_size."""

    def __init__(self, settings: Settings, client=None):
        if client is None:
            from google import genai

            from .config import gemini_key

            client = genai.Client(api_key=gemini_key())
        self.client = client
        self.s = settings

    def generate(self, prompt: str, size: str) -> bytes:
        from google.genai import types

        from .llm import _retrying

        cfg = types.GenerateContentConfig(
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            response_modalities=["IMAGE"],
            image_config=types.ImageConfig(aspect_ratio=nearest_ratio(size), image_size=self.s.gemini_image_size),
        )
        resp = _retrying(lambda: self.client.models.generate_content(
            model=self.s.gemini_image_model, contents=prompt, config=cfg))
        for cand in getattr(resp, "candidates", None) or []:
            for part in getattr(getattr(cand, "content", None), "parts", None) or []:
                blob = getattr(part, "inline_data", None)
                if blob is not None and getattr(blob, "data", None):
                    data = blob.data if isinstance(blob.data, (bytes, bytearray)) else base64.b64decode(blob.data)
                    if (blob.mime_type or "").lower() != "image/png":   # normalise to PNG for the pipeline
                        im = Image.open(io.BytesIO(data))
                        out = io.BytesIO()
                        im.save(out, format="PNG")
                        data = out.getvalue()
                    return bytes(data)
        reason = ""
        try:
            reason = str(resp.candidates[0].finish_reason)
        except (AttributeError, IndexError, TypeError):
            reason = str(getattr(getattr(resp, "prompt_feedback", None), "block_reason", "") or "")
        raise RuntimeError("Gemini returned no image" + (f" ({reason})" if reason else ""))


def make_provider(settings: Settings, mock: bool) -> ImageProvider:
    if mock:
        return MockImages()
    from .config import resolve_image_provider

    return GeminiImages(settings) if resolve_image_provider(settings) == "gemini" else OpenAIImages(settings)
