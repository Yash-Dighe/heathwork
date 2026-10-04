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


# ---------------------------------------------------------------------------------------------------------------
# Gemini — the same three calls on Google's API (one key covers text + images; there is a free tier).
# ---------------------------------------------------------------------------------------------------------------

def _retrying(call, attempts: int = 5, delay: float = 4.0):
    """Retry rate limits (429) and transient 5xx — the free tier rate-limits aggressively."""
    import time

    for i in range(attempts):
        try:
            return call()
        except Exception as e:  # google.genai.errors.APIError carries .code
            code = getattr(e, "code", None) or getattr(e, "status_code", None)
            if code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
            time.sleep(delay)
            delay *= 2


class GeminiLLM:
    def __init__(self, settings: Settings, usage: Optional[Usage] = None, client=None):
        if client is None:
            from google import genai

            from .config import gemini_key

            client = genai.Client(api_key=gemini_key())
        self.client = client
        self.s = settings
        self.usage = usage or Usage()

    def _track(self, resp) -> None:
        u = getattr(resp, "usage_metadata", None)
        if u is None:
            return
        self.usage.llm_input_tokens += getattr(u, "prompt_token_count", 0) or 0
        self.usage.llm_output_tokens += getattr(u, "candidates_token_count", 0) or 0

    def _generate(self, contents, config):
        from google.genai import types

        # no automatic function calling: the press never hands Gemini Python callables (and it silences the SDK warning)
        config.automatic_function_calling = types.AutomaticFunctionCallingConfig(disable=True)
        resp = _retrying(lambda: self.client.models.generate_content(
            model=self.s.gemini_text_model, contents=contents, config=config))
        self._track(resp)
        return resp

    def research(self, system: str, prompt: str, max_tokens: int = 8000) -> str:
        """Research grounded in Google Search. Returns the text (sources are cited inline by the model)."""
        from google.genai import types

        resp = self._generate(prompt, types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=max_tokens,
            tools=[types.Tool(google_search=types.GoogleSearch())]))
        meta = None
        try:
            meta = resp.candidates[0].grounding_metadata
        except (AttributeError, IndexError, TypeError):
            meta = None
        if meta is not None:
            queries = getattr(meta, "web_search_queries", None) or []
            self.usage.web_searches += len(queries)
        text = (getattr(resp, "text", None) or "").strip()
        # append the grounding sources, so the research notes keep their URLs like the Claude path does
        try:
            chunks = (meta.grounding_chunks or []) if meta is not None else []
            urls = [(c.web.title or c.web.uri, c.web.uri) for c in chunks if getattr(c, "web", None)]
            if urls:
                text += "\n\nSources:\n" + "\n".join(f"- [{t}]({u})" for t, u in dict.fromkeys(urls))
        except AttributeError:
            pass
        return text

    def parse(self, system: str, content, schema: type[T], max_tokens: int = 16000) -> T:
        from google.genai import types

        if not isinstance(content, str):  # Anthropic-style blocks → plain text (only text blocks reach here)
            content = "\n".join(b.get("text", "") for b in content if isinstance(b, dict))
        resp = self._generate(content, types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=max_tokens,
            response_mime_type="application/json", response_schema=schema))
        parsed = getattr(resp, "parsed", None)
        if isinstance(parsed, schema):
            return parsed
        text = getattr(resp, "text", None)
        if not text:
            raise RuntimeError("Gemini returned no structured output")
        return schema.model_validate_json(text)

    def parse_with_image(self, system: str, text: str, image: Image.Image, schema: type[T],
                         max_px: int = 1024) -> T:
        from google.genai import types

        im = image.convert("RGB")
        im.thumbnail((max_px, max_px))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=88)
        contents = [types.Part.from_bytes(data=buf.getvalue(), mime_type="image/jpeg"), text]
        resp = self._generate(contents, types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=2000,
            response_mime_type="application/json", response_schema=schema))
        parsed = getattr(resp, "parsed", None)
        return parsed if isinstance(parsed, schema) else schema.model_validate_json(resp.text)


def make_llm(settings: Settings, usage: Optional[Usage] = None):
    """The text model for whichever key is configured (see config.resolve_text_provider)."""
    from .config import resolve_text_provider

    if resolve_text_provider(settings) == "gemini":
        return GeminiLLM(settings, usage)
    return LLM(settings, usage)
