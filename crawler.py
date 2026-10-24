import asyncio
import argparse
import base64
from collections import deque
from html import escape
from pathlib import Path
import time

from knowledge_base import collect_pages, write_knowledge_base

from crawl4ai import AsyncWebCrawler, BrowserConfig
from crawl4ai.async_crawler_strategy import AsyncPlaywrightCrawlerStrategy
from crawl4ai.browser_manager import BrowserManager
from playwright.sync_api import sync_playwright

FONT_DIRECTORY = Path(__file__).resolve().parent / "fonts"
PDF_FONTS = {
    "NotoSans": "NotoSans-Regular.ttf",
    "NotoArabic": "NotoSansArabic-Regular.ttf",
    "NotoDevanagari": "NotoSansDevanagari-Regular.ttf",
    "NotoCJK": "NotoSansCJKsc-Regular.otf",
}


class SecureBrowserManager(BrowserManager):
    """Keep TLS verification and Chromium isolation on for this CLI."""

    def __init__(self, browser_config, **kwargs):
        # These modes use other launch paths and would bypass our argument filter.
        if (
            browser_config.browser_type != "chromium"
            or browser_config.use_managed_browser
            or browser_config.use_persistent_context
            or browser_config.cdp_url
        ):
            raise ValueError("Secure crawling requires a standalone Chromium browser")
        browser_config.ignore_https_errors = False
        super().__init__(browser_config=browser_config, **kwargs)

    def _build_browser_args(self):
        options = super()._build_browser_args()
        unsafe_switches = {
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
            "--ignore-certificate-errors-spki-list",
            "--disable-ipc-flooding-protection",
        }
        options["args"] = [
            arg for arg in options["args"]
            if arg.split("=", 1)[0] not in unsafe_switches
        ]
        options["chromium_sandbox"] = True
        return options


def create_crawler():
    config = BrowserConfig(ignore_https_errors=False)
    strategy = AsyncPlaywrightCrawlerStrategy(browser_config=config)
    strategy.browser_manager = SecureBrowserManager(
        browser_config=config, logger=strategy.logger
    )
    return AsyncWebCrawler(config=config, crawler_strategy=strategy)


def write_to_pdf(text, output_path="extracted_content.pdf"):
    font_rules = []
    for family, filename in PDF_FONTS.items():
        font_path = FONT_DIRECTORY / filename
        if not font_path.is_file():
            raise FileNotFoundError(f"Required PDF font is missing: {font_path}")
        font_format = "opentype" if font_path.suffix == ".otf" else "truetype"
        encoded_font = base64.b64encode(font_path.read_bytes()).decode("ascii")
        font_rules.append(
            f"@font-face {{ font-family: '{family}'; "
            f"src: url('data:font/{font_path.suffix[1:]};base64,{encoded_font}') "
            f"format('{font_format}'); }}"
        )
    paragraphs = "".join(
        f'<div dir="auto">{escape(line) if line else "<br>"}</div>'
        for line in text.split('\n')
    )
    html = (
        '<!doctype html><html><head><meta charset="utf-8"><style>'
        + "".join(font_rules)
        + "body { margin: 0; font-family: NotoSans, NotoArabic, NotoDevanagari, "
        "NotoCJK, sans-serif; font-size: 12pt; line-height: 1.6; } "
        "div { white-space: pre-wrap; overflow-wrap: anywhere; }"
        + f"</style></head><body>{paragraphs}</body></html>"
    )
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, chromium_sandbox=True)
        try:
            page = browser.new_page()
            page.set_content(html)
            page.evaluate("() => document.fonts.ready")
            page.pdf(
                path=str(output_path),
                format="A4",
                margin={side: "15mm" for side in ("top", "right", "bottom", "left")},
                print_background=True,
            )
        finally:
            browser.close()
    print(f"PDF saved as '{output_path}'")

async def main(url="https://www.example.com", max_depth=0, max_pages=10, scope="site", output=None, pdf=None):
    if output is not None and Path(output).exists():
        raise FileExistsError(f"Choose a new output directory: {output}")
    async with create_crawler() as crawler:
        async def extract_page(target):
            result = await crawler.arun(url=target)
            if not result.success:
                raise RuntimeError(f"Crawl failed: {result.error_message}")
            markdown = getattr(result.markdown, "raw_markdown", result.markdown)
            hrefs = [link.get("href", "") for link in (getattr(result, "links", None) or {}).get("internal", [])]
            return markdown, hrefs
        knowledge = await collect_pages(extract_page, url, max_depth, max_pages, scope)
    pages, report = knowledge["documents"], knowledge["report"]
    failures = report["failures"]
    output = output or f"knowledge-base-{time.time_ns()}"
    directory = write_knowledge_base(knowledge, output)
    print(f"Saved {len(pages)} pages and {len(knowledge['chunks'])} chunks to {directory}")
    if failures or report["truncated"]:
        print(f"Coverage is partial: {len(failures)} failed attempts; stop reason: {report['stop_reason']}. See crawl-report.json.")
    if pdf:
        await asyncio.to_thread(write_to_pdf, pages[0]["markdown"], pdf)
    return knowledge


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Collect linked webpages into a RAG-ready knowledge base.")
    parser.add_argument("url", nargs="?", default="https://www.example.com")
    parser.add_argument("--depth", type=int, choices=range(5), default=0, help="Link hops from the starting page (0–4)")
    parser.add_argument("--max-pages", type=int, choices=range(1, 31), default=10, help="Maximum page attempts, including failures")
    parser.add_argument("--scope", choices=("site", "path"), default="site")
    parser.add_argument("--output", help="New directory for this crawl; must not already exist")
    parser.add_argument("--pdf", help="Optional PDF filename for the starting page")
    args = parser.parse_args()
    asyncio.run(main(args.url, args.depth, args.max_pages, args.scope, args.output, args.pdf))
