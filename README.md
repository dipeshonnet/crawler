# Crawler

A Python web crawler that extracts page content with Crawl4AI and exports it to a PDF using Chromium. Bundled Noto fonts support multilingual output.

## Setup

Requires Python 3.12 or a compatible version.

```sh
python -m venv .venv
```

Activate the environment, then install dependencies and Chromium:

```sh
python -m pip install -r requirements.txt
python -m playwright install chromium
```

## Run

Set the target URL in `crawler.py`, then run:

```sh
python crawler.py
```

The current example crawls `https://www.example.com` and writes `extracted_content.pdf`. Generated PDFs, extracted lead data, local browser installations, and dependencies are excluded from Git.

`run-crawler.ps1` is an optional launcher for the original local Codex runtime and project-local dependencies.

## Tests

```sh
python -m pip install -r requirements-test.txt
python -m unittest test_security.py
```

The regression suite checks browser isolation, TLS verification, failure handling, and PDF generation. See `fonts/README.md` for font details and licenses.

## Hosting

The `public/` web interface and `web/worker.js` run on Cloudflare Workers. The hosted app uses Cloudflare Browser Run to extract Markdown and create PDFs; the original Python CLI remains available for local use. Cloudflare's fonts and extraction behavior can differ from the local Crawl4AI renderer.

Install Node.js and project dependencies with `pnpm install`. Run web checks with `pnpm test`, and deploy with `pnpm deploy` after signing into Cloudflare. `wrangler.jsonc` declares the browser service, a per-IP request limit, static assets, and the custom domain `crawler.everydayai.work`.

For automatic deployment, connect this repository's `main` branch in Cloudflare Workers Builds. Use `pnpm test` as the build command and `pnpm deploy` as the deploy command. Cloudflare supplies deployment credentials through its Git integration; do not commit API tokens.

The hosted app accepts public HTTP(S) URLs, displays extracted Markdown, and downloads Markdown or PDFs. Requests are limited to five per minute per IP; Cloudflare's account-level browser allowance also applies. Extracted content is not stored on the server.
