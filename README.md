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

This repository currently contains a command-line application. A web interface and a hosting runtime supporting Python and Chromium are required before it can serve a website.
