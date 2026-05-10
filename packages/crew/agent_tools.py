"""
Built-in CrewAI tools for Agent Factory.

The tools are intentionally small and dependency-free so they work in local
development without external service setup. Network tools use stdlib urllib and
image generation emits an SVG asset into the current workspace.
"""
from __future__ import annotations

import functools
import html
import inspect
import json
import os
import re
import textwrap
import time
import urllib.parse
import urllib.request
import uuid
from html.parser import HTMLParser
from typing import Callable, Dict, List, Optional, Tuple

try:
    from crewai.tools import tool
except Exception:  # pragma: no cover - CrewAI should provide this in runtime
    tool = None


MAX_FETCH_BYTES = 512_000
DEFAULT_TIMEOUT = 12


def _safe_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Only absolute http/https URLs are allowed")
    return parsed.geturl()


def _fetch_text(url: str) -> str:
    req = urllib.request.Request(
        _safe_url(url),
        headers={
            "User-Agent": "AgentFactoryBot/0.1 (+https://github.com/agent-factory)",
            "Accept": "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
        raw = resp.read(MAX_FETCH_BYTES + 1)
        charset = resp.headers.get_content_charset() or "utf-8"
        text = raw[:MAX_FETCH_BYTES].decode(charset, errors="replace")
        return text


def _compact_text(value: str, limit: int = 6000) -> str:
    text = re.sub(r"\s+", " ", value).strip()
    return text[:limit]


def _json_safe(value, limit: int = 1200):
    try:
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return json.loads(json.dumps(value, ensure_ascii=False, default=str)[:limit])
    except Exception:
        return str(value)[:limit]


def _bind_tool_input(fn: Callable, *args, **kwargs) -> Dict[str, object]:
    try:
        bound = inspect.signature(fn).bind_partial(*args, **kwargs)
        return {key: _json_safe(value) for key, value in bound.arguments.items()}
    except Exception:
        return {"args": _json_safe(args), "kwargs": _json_safe(kwargs)}


def _emit_tool_event(event: Dict[str, object]) -> None:
    event.setdefault("executionId", os.getenv("AGENT_FACTORY_EXECUTION_ID"))
    event.setdefault("taskId", os.getenv("AGENT_FACTORY_TASK_ID"))
    event.setdefault("agentId", os.getenv("AGENT_FACTORY_AGENT_ID"))
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _instrument_tool(name: str, fn: Callable) -> Callable:
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        tool_execution_id = f"tool_{uuid.uuid4().hex[:8]}"
        started = time.time()
        started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
        tool_input = _bind_tool_input(fn, *args, **kwargs)
        _emit_tool_event({
            "type": "tool_use",
            "toolExecutionId": tool_execution_id,
            "toolName": name,
            "input": tool_input,
            "startedAt": started_at,
        })
        try:
            result = fn(*args, **kwargs)
            duration_ms = int((time.time() - started) * 1000)
            _emit_tool_event({
                "type": "tool_result",
                "toolExecutionId": tool_execution_id,
                "toolName": name,
                "status": "done",
                "outputSummary": _compact_text(str(result), 1200),
                "durationMs": duration_ms,
                "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            return result
        except Exception as exc:
            duration_ms = int((time.time() - started) * 1000)
            _emit_tool_event({
                "type": "tool_result",
                "toolExecutionId": tool_execution_id,
                "toolName": name,
                "status": "failed",
                "error": str(exc),
                "durationMs": duration_ms,
                "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            raise

    return wrapped


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: List[Dict[str, str]] = []
        self._current_href: Optional[str] = None
        self._current_text: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag != "a":
            return
        attrs_map = dict(attrs)
        href = attrs_map.get("href")
        if href:
            self._current_href = href
            self._current_text = []

    def handle_data(self, data: str) -> None:
        if self._current_href:
            self._current_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._current_href:
            title = _compact_text(" ".join(self._current_text), 160)
            if title:
                self.links.append({"title": title, "url": self._current_href})
            self._current_href = None
            self._current_text = []


def _tool(name: str) -> Callable:
    def decorator(fn: Callable) -> Callable:
        instrumented = _instrument_tool(name, fn)
        if tool is None:
            return instrumented
        return tool(name)(instrumented)
    return decorator


@_tool("web.fetch")
def web_fetch(url: str) -> str:
    """Fetch an http/https URL and return compact text for research."""
    try:
        return _compact_text(_fetch_text(url))
    except Exception as exc:
        return json.dumps({"error": str(exc), "url": url}, ensure_ascii=False)


@_tool("web.search")
def web_search(query: str) -> str:
    """Search the web through DuckDuckGo HTML and return top result titles/URLs."""
    search_url = "https://duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    try:
        page = _fetch_text(search_url)
        parser = LinkParser()
        parser.feed(page)
        results = []
        seen = set()
        for link in parser.links:
            href = link["url"]
            if "uddg=" in href:
                parsed = urllib.parse.urlparse(href)
                params = urllib.parse.parse_qs(parsed.query)
                href = params.get("uddg", [href])[0]
            if href.startswith("//"):
                href = "https:" + href
            if not href.startswith("http") or href in seen:
                continue
            seen.add(href)
            results.append({"title": link["title"], "url": href})
            if len(results) >= 8:
                break
        return json.dumps(results, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"error": str(exc), "query": query}, ensure_ascii=False)


@_tool("crawler.extract_links")
def crawler_extract_links(url: str) -> str:
    """Fetch a page and extract visible links for lightweight crawling."""
    try:
        page = _fetch_text(url)
        parser = LinkParser()
        parser.feed(page)
        base = _safe_url(url)
        links = []
        seen = set()
        for link in parser.links:
            absolute = urllib.parse.urljoin(base, link["url"])
            if absolute in seen:
                continue
            seen.add(absolute)
            links.append({"title": link["title"], "url": absolute})
            if len(links) >= 50:
                break
        return json.dumps(links, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"error": str(exc), "url": url}, ensure_ascii=False)


@_tool("content.wechat_layout")
def content_wechat_layout(markdown: str) -> str:
    """Convert a WeChat article draft into a clean layout plan and HTML blocks."""
    escaped = html.escape(markdown.strip())
    paragraphs = [p.strip() for p in escaped.split("\n") if p.strip()]
    blocks = []
    for p in paragraphs:
        if p.startswith("#"):
            level = min(len(p) - len(p.lstrip("#")), 3)
            text = p.lstrip("#").strip()
            blocks.append(f'<h{level} style="margin:24px 0 12px;font-weight:700;line-height:1.35;">{text}</h{level}>')
        else:
            blocks.append(f'<p style="margin:14px 0;line-height:1.9;color:#2b2b2b;font-size:16px;">{p}</p>')
    result = {
        "layout": "公众号图文排版",
        "recommendations": [
            "首屏使用标题 + 摘要 + 封面图，正文每 3-5 段设置一个小标题",
            "重点句用加粗或引用块，不要整段高亮",
            "末尾加入总结、互动问题和关注引导",
        ],
        "html": "\n".join(blocks),
    }
    return json.dumps(result, ensure_ascii=False)


@_tool("content.hashtag_plan")
def content_hashtag_plan(topic: str) -> str:
    """Generate platform-specific hashtags and keyword clusters for Chinese content."""
    clean = _compact_text(topic, 120)
    keywords = [clean, f"{clean}教程", f"{clean}经验", f"{clean}避坑", f"{clean}工具"]
    return json.dumps({
        "topic": clean,
        "wechat_keywords": keywords[:4],
        "xiaohongshu_tags": [f"#{k}" for k in keywords],
        "search_intent": ["入门了解", "方案对比", "实操教程", "避坑清单"],
    }, ensure_ascii=False)


@_tool("image.generate_svg")
def image_generate_svg(spec: str) -> str:
    """Generate a simple SVG cover image asset from a JSON or text specification."""
    title = spec
    subtitle = "Agent Factory"
    palette = ["#111827", "#2563eb", "#f8fafc"]
    try:
        parsed = json.loads(spec)
        if isinstance(parsed, dict):
            title = str(parsed.get("title") or title)
            subtitle = str(parsed.get("subtitle") or subtitle)
            if isinstance(parsed.get("palette"), list) and len(parsed["palette"]) >= 3:
                palette = [str(v) for v in parsed["palette"][:3]]
    except Exception:
        pass

    safe_title = html.escape(_compact_text(title, 80))
    safe_subtitle = html.escape(_compact_text(subtitle, 80))
    wrapped = textwrap.wrap(safe_title, width=18)[:3] or ["Untitled"]
    title_spans = "\n".join(
        f'<text x="72" y="{220 + i * 64}" fill="{palette[2]}" font-size="52" font-family="Arial, sans-serif" font-weight="700">{line}</text>'
        for i, line in enumerate(wrapped)
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="{html.escape(palette[0])}"/>
      <stop offset="100%" stop-color="{html.escape(palette[1])}"/>
    </linearGradient>
  </defs>
  <rect width="900" height="500" fill="url(#g)"/>
  <circle cx="760" cy="110" r="120" fill="{html.escape(palette[2])}" opacity="0.14"/>
  <rect x="56" y="56" width="788" height="388" rx="32" fill="#ffffff" opacity="0.08"/>
  <text x="72" y="128" fill="{html.escape(palette[2])}" font-size="26" font-family="Arial, sans-serif" opacity="0.82">{safe_subtitle}</text>
  {title_spans}
</svg>'''
    out_dir = os.path.join(os.getcwd(), "generated-assets")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "cover.svg")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(svg)
    return json.dumps({"path": out_path, "format": "svg", "preview": svg[:1000]}, ensure_ascii=False)


TOOL_REGISTRY = {
    "web.fetch": web_fetch,
    "web.search": web_search,
    "crawler.extract_links": crawler_extract_links,
    "content.wechat_layout": content_wechat_layout,
    "content.hashtag_plan": content_hashtag_plan,
    "image.generate_svg": image_generate_svg,
}


def build_tools(allowed_tools: Optional[List[str]] = None, disallowed_tools: Optional[List[str]] = None) -> List[Callable]:
    if tool is None:
        return []
    if not allowed_tools:
        return []
    blocked = set(disallowed_tools or [])
    result = []
    for name in allowed_tools:
        if name in blocked:
            continue
        tool_fn = TOOL_REGISTRY.get(name)
        if tool_fn:
            result.append(tool_fn)
    return result
