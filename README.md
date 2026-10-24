# Crawler

Collect a starting webpage and linked pages into a source-preserving knowledge base for RAG or a curated Markdown wiki. Available as a Cloudflare-hosted website and a local Python CLI.

## Website

Enter a starting URL, choose **link depth** (0–4) and a **page limit** (1–30), then collect content. Depth 0 means the starting page, depth 1 adds its links, and depth 2 adds links from those pages. Pages are visited breadth first. The UI defaults to depth 1; API and CLI defaults remain depth 0.

**Same website** follows URLs on the exact same origin (scheme, hostname and port). **Starting URL path** also requires the same path or a descendant: `/docs` includes `/docs/setup`, but excludes `/docs-other`. For a single article, choose same website to follow sibling articles. External websites, fragments, images and common binary file links are excluded. Tracking parameters (`utm_*`, `gclid`, `fbclid`) are removed and query keys sorted to avoid duplicate URL visits. Other query parameters remain significant. Distinct URLs with identical text remain separate sources.

Browse each downloaded page and save its Markdown or PDF. **Download knowledge base** creates a ZIP in the browser. **Save RAG chunks** exports JSONL directly. Partial results remain downloadable when child pages fail or limits are reached; failures and stop reasons appear beside the results and in the report. If every page fails, the API returns an error.

### Download layout

```text
knowledge-base/
  README.md
  index.md                         # linked source index
  raw/<host>/<path>-<id>.md         # exact extractor Markdown
  documents/<host>/<path>-<id>.md   # Markdown + provenance + crawled references
  chunks/chunks.jsonl              # one retrieval chunk per line
  manifest.json                    # document IDs, URLs, hashes and file paths
  crawl-report.json                # options, attempts, failures, pending pages, limits
  wiki/README.md                   # space for reviewed concept pages
```

`raw/` preserves Markdown returned by the extractor, not original HTML. Each document includes its source URL, retrieval time, depth, discovery parent, outgoing crawlable links and SHA-256 content hash. Stable URL-derived document IDs and content hashes support downstream change detection and upserts. Each download is a fresh snapshot; the crawler does not merge earlier downloads or maintain a vector index.

Chunks follow Markdown heading sections and retain the heading hierarchy. Each chunk has an ID, document ID, content hash, source URL, retrieval time, section, chunk index, text and `retrieval_text`. Embed `retrieval_text` and retain metadata for filtering and citations. Chunk IDs change when source content changes, so an importer should replace old chunks for an updated document ID. The maximum is 2,400 characters with up to 200 characters overlap within a section. Paragraph, line and word boundaries are preferred; oversized code blocks, tables or tokens may split. These are character limits, not tokenizer-specific limits. Evaluate retrieval quality with your own questions.

The title/source/section prefix provides deterministic context; it is not an LLM-generated contextual summary. No AI summaries, embeddings, vector database, compiled concept pages, or downloaded images are included. Treat crawled content as untrusted source material when passing it to an agent.

### Design references

The raw-source / index / curated-wiki separation follows the workflow described in [DAIR.AI's LLM Knowledge Bases article](https://academy.dair.ai/blog/llm-knowledge-bases-karpathy). Preserving structure and provenance follows [Microsoft's RAG chunking guidance](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-chunking-phase). The source and section context is motivated by the context-loss problem in [Anthropic's Contextual Retrieval article](https://www.anthropic.com/research/contextual-retrieval); this crawler does not implement Anthropic's LLM-generated contextual embeddings or BM25 pipeline.

### Limits and coverage

Each crawl has a 30-page-attempt maximum (failed attempts count), 200,000 characters per page, 1,000,000 characters total and a 90-second scheduling budget. An in-flight page may finish after that budget. The frontier is bounded by the page limit; `truncated` flags omitted eligible links, and `pending` lists queued but unprocessed pages, not every omitted link. Crawling is sequential to limit load. The hosted app limits requests to five per minute per IP, in addition to Cloudflare's browser allowance. Each crawled page uses a browser action.

The hosted crawler discovers links in Markdown returned by Browser Run. The Python crawler also uses Crawl4AI's extracted internal links. Links hidden behind interaction, omitted by the extractor, or protected by login cannot be traversed. Depth is measured from requested URLs; redirect destinations and canonical link tags are not currently resolved into crawl identity. Same-origin scope applies to queued URLs, not resources or redirects loaded by the browser. Choose only public pages you are permitted to collect. Robots.txt policies are not automatically enforced. The app does not persist extracted content on the server.

## Python setup and usage

Requires Python 3.12 or a compatible version.

```sh
python -m venv .venv
# Activate the environment, then:
python -m pip install -r requirements.txt
python -m playwright install chromium
python crawler.py https://example.com/docs --depth 2 --max-pages 20 --scope path --output knowledge-base-docs
```

The output directory must be new so earlier sources are never silently overwritten or mixed into a fresh report. Without `--output`, a unique `knowledge-base-<timestamp>` directory is created. Add `--pdf extracted_content.pdf` to also export the starting page to PDF. Bundled Noto fonts support multilingual PDFs; see `fonts/README.md` for licenses. The default invocation still visits `https://www.example.com`, now exporting a knowledge-base directory. The PDF is optional.

`run-crawler.ps1` is an optional launcher for the original local Codex runtime and project-local dependencies. Standard Python use does not require it.

## Tests

```sh
pnpm test
python -m unittest test_knowledge_base.py
python -m pip install -r requirements-test.txt
python -m unittest test_security.py
```

The web and dependency-free Python suites cover traversal, scope, normalization, limits, partial failures, chunk context, provenance, stable IDs, exports and archive integrity. The original Python security suite exercises a real local browser and PDF generation and requires the Python browser dependencies. Node.js 22 or later is required for the test runner's `--test-isolation=none` option.

## Hosting

`public/` and `web/worker.js` run on Cloudflare Workers with Browser Run. Install Node.js and dependencies with `pnpm install`. Use `pnpm run dev` locally and `pnpm run deploy` after signing into Cloudflare. Cloudflare's extraction and fonts may differ from local Crawl4AI.

`wrangler.jsonc` declares the browser service, rate limiter, assets and custom domain `crawler.everydayai.work`. For automatic deployment, connect the repository's `main` branch in Cloudflare Workers Builds, use `pnpm test` as the build command and `npx wrangler deploy` as the deploy command. Cloudflare supplies deployment credentials through its Git integration; do not commit API tokens.

POST `/api/crawl` with `{ "url": "https://example.com/docs", "maxDepth": 2, "maxPages": 20, "scope": "path" }`. The response includes `schema_version`, `documents`, `chunks` and `report`, plus the legacy `url` and starting-page `markdown` fields. POST `/api/pdf` with a single page's `markdown` to generate its PDF. API requests require the same-origin website and JSON content type.
