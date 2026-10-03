"""Thin wrapper over the Anthropic SDK: web-search research, structured output, vision."""
from __future__ import annotations

import base64
import io
from typing import Optional, TypeVar

from PIL import Image
from pydantic import BaseModel

from .config import Settings
from .models import Usage

T = TypeVar("T", bound=BaseModel)


class LLM:
    def __init__(self, settings: Settings, usage: Optional[Usage] = None, client=None):
        if client is None:
            import anthropic

            client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
        self.client = client
        self.s = settings
        self.usage = usage or Usage()

    def _track(self, resp) -> None:
        u = getattr(resp, "usage", None)
        if u is None:
            return
        self.usage.llm_input_tokens += getattr(u, "input_tokens", 0) or 0
        self.usage.llm_output_tokens += getattr(u, "output_tokens", 0) or 0
        stu = getattr(u, "server_tool_use", None)
        if stu is not None:
            self.usage.web_searches += getattr(stu, "web_search_requests", 0) or 0

    def research(self, system: str, prompt: str, max_tokens: int = 8000) -> str:
        """Free-form research using Claude's server-side web search. Returns the final text."""
        messages = [{"role": "user", "content": prompt}]
        tools = [{"type": "web_search_20250305", "name": "web_search",
                  "max_uses": self.s.research_max_searches}]
        texts: list[str] = []
        for _ in range(5):  # handle pause_turn continuations on long searches
            resp = self.client.messages.create(
                model=self.s.text_model, max_tokens=max_tokens, system=system,
                messages=messages, tools=tools,
            )
            self._track(resp)
            for block in resp.content:
                if getattr(block, "type", None) == "text":
                    texts.append(block.text)
            if resp.stop_reason != "pause_turn":
                break
            messages.append({"role": "assistant", "content": resp.content})
        return "".join(texts).strip()

    def parse(self, system: str, content, schema: type[T], max_tokens: int = 16000) -> T:
        """Structured output: the response is guaranteed to match `schema`."""
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        resp = self.client.messages.parse(
            model=self.s.text_model, max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": content}],
            output_format=schema,
        )
        self._track(resp)
        if resp.parsed_output is None:
            raise RuntimeError(f"Claude returned no parseable output (stop_reason={resp.stop_reason})")
        return resp.parsed_output

    def parse_with_image(self, system: str, text: str, image: Image.Image, schema: type[T],
                         max_px: int = 1024) -> T:
        im = image.convert("RGB")
        im.thumbnail((max_px, max_px))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=88)
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": base64.b64encode(buf.getvalue()).decode()}},
            {"type": "text", "text": text},
        ]
        saved = self.s.text_model
        self.s.text_model = self.s.vision_model
        try:
            return self.parse(system, content, schema, max_tokens=2000)
        finally:
            self.s.text_model = saved
