import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledgeBase, chunkMarkdown, discoverLinks, knowledgeFiles, normalizeUrl, zipFiles} from '../public/knowledge.js';
import {crawl, crawlOptions, inScope} from '../web/crawl.js';
import worker from '../web/worker.js';

const root = 'https://example.com/docs';
function browserFor(pages, calls = []) {
  return {quickAction: async (action, {url}) => {
    assert.equal(action, 'markdown'); calls.push(url);
    const content = pages[url];
    if (content instanceof Error) throw content;
    return content === undefined ? new Response('', {status:404}) : Response.json({result:content});
  }};
}
const fixture = {
  [root]: '# Guide\n\n[A](/docs/a?utm_source=nav#start) [again](/docs/a) [B](/docs/b) [away](https://elsewhere.com/) [file](/guide.pdf) [private](http://127.0.0.1/) [other](/other)',
  [root + '/a']: '# Alpha\n\n[Root](/docs) [Deep](/docs/deep)',
  [root + '/b']: '# Beta\n\n[Deep](/docs/deep)',
  [root + '/deep']: '# Deep\n\nEvidence café नमस्ते العربية 中文',
};

test('breadth-first crawl follows depth, path scope, cycles and normalized duplicates', async () => {
  const calls = [];
  const kb = await crawl(root, {maxDepth:2,maxPages:20,scope:'path'}, browserFor(fixture, calls));
  assert.deepEqual(calls, [root, root+'/a', root+'/b', root+'/deep']);
  assert.deepEqual(kb.documents.map(doc => doc.depth), [0,1,1,2]);
  assert.equal(kb.documents[3].parent_url, root+'/a');
  assert.equal(kb.report.truncated, false);
  assert.deepEqual(kb.report.failures, []);
  for (const depth of [0, 1]) {
    const shallow = await crawl(root, {maxDepth:depth,maxPages:20,scope:'path'}, browserFor(fixture));
    assert.equal(shallow.documents.length, depth === 0 ? 1 : 3);
  }
});

test('page limit counts failed attempts and reports partial results', async () => {
  const calls = [];
  const kb = await crawl(root, {maxDepth:2,maxPages:3,scope:'path'}, browserFor({...fixture, [root+'/a']:new Error('Blocked')}, calls));
  assert.equal(calls.length, 3);
  assert.equal(kb.report.failures[0].error, 'Blocked');
  assert.equal(kb.documents.length, 2);
  assert.equal(kb.report.stop_reason, 'page_limit');
  assert.equal(kb.report.truncated, true);
  await assert.rejects(crawl(root, {maxDepth:0,maxPages:1,scope:'site'}, browserFor({})), /404/);
});

test('time and content budgets stop further extraction and preserve downloaded sources', async () => {
  let clock = 0;
  const kb = await crawl(root, {maxDepth:2,maxPages:20,scope:'path'}, browserFor(fixture), () => { clock += 30000; return clock; });
  assert.equal(kb.report.stop_reason, 'time_limit');
  assert.ok(kb.report.pending.length > 0);
  const calls = [];
  const large = '# Large\n' + 'x'.repeat(199900) + '\n' + Array.from({length:6}, (_, i) => `[${i}](/${i})`).join(' ');
  const pages = {[root]:large};
  for (let i=0;i<6;i++) pages[`https://example.com/${i}`] = 'x'.repeat(199999);
  const capped = await crawl(root, {maxDepth:1,maxPages:10,scope:'site'}, browserFor(pages, calls));
  assert.equal(capped.report.stop_reason, 'content_limit');
  assert.equal(capped.report.downloaded, 5);
  assert.ok(capped.report.pending.length > 0);
});

test('validates options before browser use and rejects out-of-scope targets', async () => {
  for (const opts of [{maxDepth:-1},{maxDepth:5},{maxDepth:'2'},{maxPages:0},{maxPages:31},{maxPages:1.5},{scope:'anywhere'}]) assert.throws(() => crawlOptions(opts));
  assert.equal(inScope(root+'/child', root, 'path'), true);
  for (const link of ['https://example.com/docs-other','https://sub.example.com/docs','http://example.com/docs','https://example.com/docs/file.PDF']) assert.equal(inScope(link, root, 'path'), false);
  const response = await worker.fetch(new Request('https://crawler.example.com/api/crawl', {method:'POST', headers:{Origin:'https://crawler.example.com','Content-Type':'application/json'}, body:JSON.stringify({url:root,maxDepth:10})}), {CRAWL_LIMITER:{limit:async()=>({success:true})},BROWSER:{quickAction:()=>assert.fail('browser opened')}});
  assert.equal(response.status, 400);
});

test('link discovery handles references, titles, relative links and autolinks', () => {
  const md = '[Page](../article "title")\n[Ref][id]\n[id]: /ref\n<https://example.com/auto>\n![image](/image.png)\n[anchor](#section)\n```md\n[example](/fake)\n```';
  assert.deepEqual(discoverLinks(md, root+'/start'), ['https://example.com/article', 'https://example.com/ref','https://example.com/auto']);
  assert.equal(normalizeUrl('https://example.com/?b=2&utm_source=x&a=1#section'), 'https://example.com/?a=1&b=2');
});

test('chunks retain heading hierarchy, respect fences, bound length and preserve Unicode', () => {
  const chunks = chunkMarkdown('# Guide\n\nIntro\n\n## Setup\n\n' + 'café नमस्ते 中文 '.repeat(400) + '\n\n```python\n# not a heading\n```\n\n### Detail\n\nFinal evidence');
  assert.deepEqual(chunks[0].section, ['Guide']);
  assert.deepEqual(chunks.at(-1).section, ['Guide','Setup','Detail']);
  assert.ok(chunks.every(chunk => chunk.text.length <= 2400));
  assert.ok(chunks.some(chunk => chunk.text.includes('# not a heading')));
  assert.ok(chunks.some(chunk => chunk.text.includes('नमस्ते')));
  const original = 'x'.repeat(5000) + 'END';
  const pieces = chunkMarkdown(original);
  assert.equal(pieces[0].text + pieces.slice(1).map(c => c.text.slice(200)).join(''), original);
  assert.throws(() => chunkMarkdown('text', 100, 100));
});

test('exports source-faithful files, resolvable references, provenance and stable IDs', async () => {
  const kb = await crawl(root, {maxDepth:2,maxPages:20,scope:'path'}, browserFor(fixture));
  const files = knowledgeFiles(kb);
  for (const doc of kb.documents) {
    assert.equal(files[doc.raw_path], fixture[doc.url]);
    assert.ok(files['index.md'].includes(doc.document_path));
    assert.ok(files[doc.document_path].includes('source') || files[doc.document_path].includes(doc.url));
  }
  assert.ok(files[kb.documents[0].document_path].includes('../../'+kb.documents[1].document_path));
  const parsed = files['chunks/chunks.jsonl'].trim().split('\n').map(line => JSON.parse(line));
  assert.equal(parsed.length, kb.chunks.length);
  assert.ok(parsed.every(chunk => chunk.retrieval_text.includes(chunk.source_url) && files[chunk.document_path]));
  const repeat = await buildKnowledgeBase(kb.documents, kb.report);
  assert.deepEqual(repeat.chunks.map(chunk => chunk.id), kb.chunks.map(chunk => chunk.id));
  const changed = await buildKnowledgeBase([{...kb.documents[0],markdown:'# Changed'}], kb.report);
  assert.equal(changed.documents[0].id, kb.documents[0].id);
  assert.notEqual(changed.chunks[0].id, kb.chunks[0].id);
});

test('ZIP entries have valid CRCs, offsets and UTF-8 content', async () => {
  const files = {'raw/example.com/a.md':'# café नमस्ते 中文', 'index.md':'[Page](raw/example.com/a.md)'};
  const zip = new Uint8Array(await zipFiles(files).arrayBuffer()), view = new DataView(zip.buffer);
  const decoder = new TextDecoder();
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    assert.equal(view.getUint32(offset,true),0x04034b50);
    const size = view.getUint32(offset+18,true), nameSize = view.getUint16(offset+26,true);
    assert.equal(decoder.decode(zip.slice(offset+30,offset+30+nameSize)),path);
    const data = zip.slice(offset+30+nameSize,offset+30+nameSize+size);
    assert.equal(decoder.decode(data),text);
    // Independent bit-by-bit CRC using polynomial long division.
    let crc = 0xffffffff;
    for (const b of data) for (let bit=0;bit<8;bit++) { const mix = (crc ^ (b >>> bit)) & 1; crc >>>= 1; if(mix) crc ^= 0xedb88320; }
    assert.equal(view.getUint32(offset+14,true),(crc ^ 0xffffffff) >>> 0);
    offset += 30+nameSize+size;
  }
  const end = zip.length - 22;
  assert.equal(view.getUint32(end,true),0x06054b50);
  assert.equal(view.getUint32(end+16,true),offset);
  assert.equal(view.getUint16(end+10,true),2);
});
