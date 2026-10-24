"""Offline regression checks; run with the project's Python dependencies."""

import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import ssl
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from crawl4ai import BrowserConfig, CacheMode, CrawlerRunConfig
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pypdf import PdfReader
import psutil
from playwright.sync_api import sync_playwright

from crawler import SecureBrowserManager, create_crawler, main, write_to_pdf


class PageHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            b"<html><body><h1>Legitimate local page</h1><p>"
            + b"This page contains ordinary public text for the crawler regression check. " * 20
            + b"</p></body></html>"
        )

    def log_message(self, *args):
        pass


@contextmanager
def local_server(tls=False):
    with tempfile.TemporaryDirectory(dir=os.environ.get("SECURITY_TEST_TMP")) as directory:
        server = ThreadingHTTPServer(("127.0.0.1", 0), PageHandler)
        if tls:
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
            now = datetime.now(timezone.utc)
            cert = (
                x509.CertificateBuilder().subject_name(name).issuer_name(name)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(minutes=1))
                .not_valid_after(now + timedelta(days=1))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), False)
                .sign(key, hashes.SHA256())
            )
            cert_path, key_path = Path(directory) / "cert.pem", Path(directory) / "key.pem"
            cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            key_path.write_bytes(key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ))
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert_path, key_path)
            server.socket = context.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"{'https' if tls else 'http'}://localhost:{server.server_port}"
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


class SecurityTests(unittest.TestCase):
    def test_main_exports_linked_sources_and_optional_starting_page_pdf(self):
        fake = AsyncMock()
        fake.__aenter__.return_value = fake
        fake.arun.side_effect = [
            SimpleNamespace(success=True, markdown=SimpleNamespace(raw_markdown="# Start"),
                            links={"internal": [{"href": "/child"}]}),
            SimpleNamespace(success=True, markdown="# Child\n\nEvidence", links={}),
        ]
        with tempfile.TemporaryDirectory(dir=os.environ.get("SECURITY_TEST_TMP")) as directory:
            output = Path(directory) / "knowledge"
            with patch("crawler.create_crawler", return_value=fake), patch("crawler.write_to_pdf") as pdf:
                kb = asyncio.run(main("https://example.com", max_depth=1, output=output, pdf="test.pdf"))
                self.assertEqual([doc["depth"] for doc in kb["documents"]], [0, 1])
                self.assertTrue((output / "chunks/chunks.jsonl").is_file())
                self.assertEqual((output / kb["documents"][1]["raw_path"]).read_text(encoding="utf-8"), "# Child\n\nEvidence")
                pdf.assert_called_once_with("# Start", "test.pdf")
                with self.assertRaises(FileExistsError):
                    asyncio.run(main(output=output))

    def test_failed_crawl_does_not_write_pdf(self):
        fake = AsyncMock()
        fake.__aenter__.return_value = fake
        fake.arun.return_value = SimpleNamespace(success=False, error_message="invalid certificate")
        with patch("crawler.create_crawler", return_value=fake), patch("crawler.write_to_pdf") as pdf:
            with self.assertRaisesRegex(RuntimeError, "invalid certificate"):
                asyncio.run(main())
            pdf.assert_not_called()

    def test_launch_filters_unsafe_flag_variants(self):
        config = BrowserConfig(extra_args=[
            "--no-sandbox", "--ignore-certificate-errors=true",
            "--ignore-certificate-errors-spki-list=anything", "--disable-setuid-sandbox",
        ])
        manager = SecureBrowserManager(config)
        args = manager._build_browser_args()
        self.assertFalse(config.ignore_https_errors)
        self.assertTrue(args["chromium_sandbox"])
        for flag in args["args"]:
            self.assertNotIn(flag.split("=", 1)[0], {
                "--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors",
                "--ignore-certificate-errors-spki-list", "--disable-ipc-flooding-protection",
            })

    def test_alternate_launch_modes_fail_closed(self):
        for options in [
            {"use_managed_browser": True}, {"use_persistent_context": True},
            {"cdp_url": "http://localhost:9222"}, {"browser_type": "firefox"},
        ]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                SecureBrowserManager(BrowserConfig(**options))

    def test_actual_crawl_and_certificate_rejection(self):
        async def check(http_url, https_url):
            async with create_crawler() as crawler:
                manager = crawler.crawler_strategy.browser_manager
                session = await manager.browser.new_browser_cdp_session()
                try:
                    processes = (await session.send("SystemInfo.getProcessInfo"))["processInfo"]
                    pid = next(item["id"] for item in processes if item["type"] == "browser")
                    flags = psutil.Process(pid).cmdline()
                    self.assertNotIn("--no-sandbox", flags)
                    self.assertFalse(any(arg.startswith("--ignore-certificate-errors") for arg in flags))
                finally:
                    await session.detach()
                config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS, page_timeout=10000)
                good = await crawler.arun(http_url, config=config)
                self.assertTrue(good.success, good.error_message)
                self.assertIn("Legitimate local page", good.markdown)
                bad = await crawler.arun(https_url, config=config)
                self.assertFalse(bad.success)
                self.assertIn("ERR_CERT_AUTHORITY_INVALID", bad.error_message)

        with local_server() as http_url, local_server(tls=True) as https_url:
            asyncio.run(check(http_url, https_url))

    def test_pdf_keeps_markup_literal_and_embeds_unicode(self):
        text = '<script>throw new Error("injected")</script>\n<img src="http://localhost:9/leak">\nHello café — नमस्ते العربية 中文'
        with tempfile.TemporaryDirectory(dir=os.environ.get("SECURITY_TEST_TMP")) as directory:
            output = Path(directory) / "content.pdf"
            # Inspect the actual PDF browser's flags as well as its output.
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, chromium_sandbox=True)
                try:
                    session = browser.new_browser_cdp_session()
                    processes = session.send("SystemInfo.getProcessInfo")["processInfo"]
                    pid = next(item["id"] for item in processes if item["type"] == "browser")
                    flags = psutil.Process(pid).cmdline()
                    self.assertNotIn("--no-sandbox", flags)
                    session.detach()
                finally:
                    browser.close()
            write_to_pdf(text, output)
            rendered = "\n".join(page.extract_text() for page in PdfReader(output).pages)
            self.assertIn("<script>", rendered)
            self.assertIn('<img src="http://localhost:9/leak">', rendered)
            self.assertIn("café", rendered)
            self.assertGreater(output.stat().st_size, 1000)


if __name__ == "__main__":
    unittest.main()
