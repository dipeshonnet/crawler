"""Offline ingestion/export checks; no browser dependencies required."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest

from knowledge_base import (build_knowledge_base, chunk_markdown, collect_pages,
                            discover_links, knowledge_files, normalize_url, write_knowledge_base)


ROOT = "https://example.com/docs"
PAGES = {
    ROOT: '# Guide\n\n[A](/docs/a?utm_source=nav#top) [A again](/docs/a) [B](/docs/b) [away](https://other.com/) [private](http://127.0.0.1/) [file](/docs/file.pdf) [outside](/other)',
    ROOT + "/a": '# Alpha\n\n[Root](/docs) [Deep](/docs/deep)',
    ROOT + "/b": '# Beta\n\n[Deep](/docs/deep)',
    ROOT + "/deep": '# Deep\n\nEvidence café नमस्ते العربية 中文',
}


class KnowledgeTests(unittest.TestCase):
    def crawl(self, depth=2, max_pages=20, pages=None, **kwargs):
        calls = []

        async def extract(url):
            calls.append(url)
            value = (pages or PAGES)[url]
            if isinstance(value, Exception):
                raise value
            return value, []

        return asyncio.run(collect_pages(extract, ROOT, depth, max_pages, "path", **kwargs)), calls

    def test_breadth_first_depth_scope_and_duplicate_urls(self):
        kb, calls = self.crawl()
        self.assertEqual(calls, list(PAGES))
        self.assertEqual([doc["depth"] for doc in kb["documents"]], [0, 1, 1, 2])
        self.assertEqual(kb["documents"][-1]["parent_url"], ROOT + "/a")
        self.assertFalse(kb["report"]["truncated"])
        for depth, count in [(0, 1), (1, 3)]:
            self.assertEqual(len(self.crawl(depth)[0]["documents"]), count)

    def test_partial_failures_and_limits(self):
        kb, calls = self.crawl(max_pages=3, pages={**PAGES, ROOT + "/a": RuntimeError("blocked")})
        self.assertEqual(len(calls), 3)
        self.assertEqual(kb["report"]["downloaded"], 2)
        self.assertEqual(kb["report"]["failures"][0]["error"], "blocked")
        self.assertEqual(kb["report"]["stop_reason"], "page_limit")
        self.assertTrue(kb["report"]["truncated"])
        with self.assertRaisesRegex(RuntimeError, "blocked"):
            self.crawl(pages={ROOT: RuntimeError("blocked")})
        with self.assertRaisesRegex(RuntimeError, "No readable"):
            self.crawl(pages={ROOT: None})
        clock = iter([0, 0, 91])
        kb, calls = self.crawl(clock=lambda: next(clock))
        self.assertEqual(len(calls), 1)
        self.assertEqual(kb["report"]["stop_reason"], "time_limit")
        self.assertTrue(kb["report"]["pending"])

    def test_invalid_options_and_targets_do_not_extract(self):
        async def extract(url):
            self.fail("Extraction should not start")
        for depth, count in [(5, 10), (-1, 10), (1, 31), (1, 0), (1.5, 10), (True, 10)]:
            with self.assertRaises(ValueError):
                asyncio.run(collect_pages(extract, ROOT, depth, count))
        for url in ['file:///tmp/a', 'http://127.0.0.1', 'https://user:pass@example.com', 'https://example.com:8080', 'https://host.internal']:
            with self.assertRaises(ValueError):
                normalize_url(url)

    def test_links_and_section_chunks(self):
        self.assertEqual(discover_links('[A](../article "title")\n[id]: /ref\n<https://example.com/auto>\n![image](/image.png)\n[anchor](#top)\n```md\n[false](/false)\n```', ROOT + '/start'),
                         ['https://example.com/article', 'https://example.com/ref', 'https://example.com/auto'])
        chunks = chunk_markdown('# Guide\n\nIntro\n\n## Setup\n\n' + 'café नमस्ते 中文 ' * 400 + '\n\n```python\n# not a heading\n```\n\n### Detail\n\nEvidence')
        self.assertEqual(chunks[-1]['section'], ['Guide', 'Setup', 'Detail'])
        self.assertTrue(all(len(chunk['text']) <= 2400 for chunk in chunks))
        self.assertTrue(any('# not a heading' in chunk['text'] for chunk in chunks))
        source = 'x' * 5000 + 'END'
        pieces = chunk_markdown(source)
        self.assertEqual(pieces[0]['text'] + ''.join(part['text'][200:] for part in pieces[1:]), source)

    def test_export_provenance_stable_ids_and_no_overwrites(self):
        kb, _ = self.crawl()
        files = knowledge_files(kb)
        self.assertEqual(files[kb['documents'][-1]['raw_path']], PAGES[ROOT + '/deep'])
        chunks = [json.loads(line) for line in files['chunks/chunks.jsonl'].splitlines()]
        self.assertTrue(all(chunk['source_url'] in chunk['retrieval_text'] and chunk['document_path'] in files for chunk in chunks))
        repeat = build_knowledge_base(kb['documents'], kb['report'])
        self.assertEqual([c['id'] for c in kb['chunks']], [c['id'] for c in repeat['chunks']])
        changed = build_knowledge_base([{**kb['documents'][0], 'markdown': '# Changed'}], kb['report'])
        self.assertEqual(changed['documents'][0]['id'], kb['documents'][0]['id'])
        self.assertNotEqual(changed['chunks'][0]['id'], kb['chunks'][0]['id'])
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'knowledge'
            write_knowledge_base(kb, directory)
            self.assertEqual((directory / 'index.md').read_text(encoding='utf-8'), files['index.md'])
            with self.assertRaises(FileExistsError):
                write_knowledge_base(kb, directory)


if __name__ == '__main__':
    unittest.main()
