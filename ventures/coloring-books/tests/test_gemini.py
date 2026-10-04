"""Gemini providers, exercised through the REAL google-genai SDK with a mocked HTTP transport: the request
bodies the SDK actually sends, and the responses it actually parses."""
import base64
import io
import json

import httpx
import pytest
from PIL import Image

genai = pytest.importorskip("google.genai")
from google.genai import types  # noqa: E402

from colorbook import config as cfg  # noqa: E402
from colorbook.config import Settings  # noqa: E402
from colorbook.images import GeminiImages, nearest_ratio  # noqa: E402
from colorbook.llm import GeminiLLM, make_llm  # noqa: E402
from colorbook.models import BookPlan, VisionVerdict  # noqa: E402


def client_with(responses, seen):
    """A genai.Client whose HTTP calls return `responses` in order and record each request body."""
    it = iter(responses)

    def handler(request: httpx.Request):
        seen.append({"url": str(request.url), "body": json.loads(request.content or b"{}")})
        status, body = next(it)
        return httpx.Response(status, json=body)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    return genai.Client(api_key="test-key", http_options=types.HttpOptions(httpx_client=http))


def text_response(text, **extra):
    cand = {"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}
    cand.update(extra)
    return {"candidates": [cand], "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 7}}


PLAN = {"title": "Owl Forest", "subtitle": "Calm owls", "audience": "adult", "theme": "owls", "complexity": "medium",
        "style_prompt": "storybook", "cover_scene": "owls", "back_blurb": "hoot",
        "pages": [{"n": 1, "title": "owl", "scene": "an owl on a branch"}]}


def test_parse_sends_schema_and_returns_model():
    seen = []
    llm = GeminiLLM(Settings(), client=client_with([(200, text_response(json.dumps(PLAN)))], seen))
    plan = llm.parse("you plan books", "plan an owl book", BookPlan)
    assert isinstance(plan, BookPlan) and plan.title == "Owl Forest"
    body = seen[0]["body"]
    assert "gemini-3.8-flash:generateContent" in seen[0]["url"]
    gc = body["generationConfig"]
    assert gc["responseMimeType"] == "application/json" and ("responseSchema" in gc or "responseJsonSchema" in gc)
    assert body["systemInstruction"]["parts"][0]["text"] == "you plan books"
    assert llm.usage.llm_input_tokens == 11 and llm.usage.llm_output_tokens == 7


def test_research_uses_google_search_and_keeps_sources():
    seen = []
    grounding = {"groundingMetadata": {"webSearchQueries": ["owl coloring books", "kdp owls"],
                                       "groundingChunks": [{"web": {"uri": "https://example.com/a", "title": "A"}}]}}
    llm = GeminiLLM(Settings(), client=client_with([(200, text_response("owls sell well", **grounding))], seen))
    out = llm.research("researcher", "owls?")
    assert "owls sell well" in out and "[A](https://example.com/a)" in out
    assert any("googleSearch" in t or "google_search" in t for t in seen[0]["body"]["tools"])
    assert llm.usage.web_searches == 2


def test_rate_limit_is_retried(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    seen = []
    err = {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}}
    llm = GeminiLLM(Settings(), client=client_with([(429, err), (200, text_response(json.dumps(PLAN)))], seen))
    assert llm.parse("s", "x", BookPlan).title == "Owl Forest"
    assert len(seen) == 2


def test_vision_sends_the_image():
    seen = []
    verdict = {"passes": True, "matches_concept": True, "has_text_or_signature": False,
               "has_shading_or_gray_fill": False, "has_anatomy_or_object_errors": False, "issues": [], "score": 9}
    llm = GeminiLLM(Settings(), client=client_with([(200, text_response(json.dumps(verdict)))], seen))
    v = llm.parse_with_image("strict", "check", Image.new("RGB", (40, 50), "white"), VisionVerdict)
    assert v.passes and v.score == 9
    parts = seen[0]["body"]["contents"][0]["parts"]
    blob = parts[0]["inlineData"]
    assert (blob.get("mimeType") or blob.get("mime_type")) == "image/jpeg" and parts[1]["text"] == "check"


def png_b64(mode="RGB", fmt="PNG"):
    buf = io.BytesIO()
    Image.new(mode, (30, 40), "white").save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


@pytest.mark.parametrize("mime,fmt", [("image/png", "PNG"), ("image/jpeg", "JPEG")])
def test_image_generation_returns_png(mime, fmt):
    seen = []
    body = {"candidates": [{"content": {"role": "model", "parts": [
        {"text": "here you go"}, {"inlineData": {"mimeType": mime, "data": png_b64(fmt=fmt)}}]}, "finishReason": "STOP"}]}
    img = GeminiImages(Settings(), client=client_with([(200, body)], seen)).generate("an owl, line art", "1536x2048")
    assert img[:8] == b"\x89PNG\r\n\x1a\n", "always normalised to PNG"
    gc = seen[0]["body"]["generationConfig"]
    assert gc["responseModalities"] == ["IMAGE"] and gc["imageConfig"]["aspectRatio"] == "3:4"
    assert "gemini-3.1-flash-image:generateContent" in seen[0]["url"]


def test_blocked_image_explains_itself():
    body = {"candidates": [{"content": {"role": "model", "parts": [{"text": "cannot"}]}, "finishReason": "SAFETY"}]}
    with pytest.raises(RuntimeError, match="no image"):
        GeminiImages(Settings(), client=client_with([(200, body)], [])).generate("x", "1024x1024")


def test_ratio_mapping():
    assert nearest_ratio("1536x2048") == "3:4" and nearest_ratio("1024x1024") == "1:1" and nearest_ratio("2048x1152") == "16:9"


def test_auto_provider_selection(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    s = Settings()
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        cfg.resolve_text_provider(s)
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    assert cfg.resolve_text_provider(s) == "gemini" and cfg.resolve_image_provider(s) == "gemini"
    assert isinstance(make_llm(s), GeminiLLM)
    assert cfg.image_cost(s) == 0.0
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    assert cfg.resolve_text_provider(s) == "anthropic" and cfg.resolve_image_provider(s) == "openai"
    s.image_provider = "gemini"
    assert cfg.resolve_image_provider(s) == "gemini", "an explicit choice wins over auto"
