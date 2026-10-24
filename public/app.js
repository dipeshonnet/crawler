import {knowledgeFiles, zipFiles} from './knowledge.js';
const $ = id => document.getElementById(id);
let extract = null;
const selected = () => extract?.documents[Number($('page-select').value)];
function status(message, error = false) { $('status').textContent = message; $('status').className = error ? 'error' : ''; }
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function post(path, body) {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Something went wrong. Please try again.'); }
  return response;
}
$('crawl-form').addEventListener('submit', async event => {
  event.preventDefault(); $('extract').disabled = true; $('result').hidden = true; extract = null;
  status('Collecting pages and organizing the knowledge base. This may take about two minutes…');
  try {
    extract = await (await post('/api/crawl',{url:$('url').value.trim(), maxDepth:Number($('depth').value), maxPages:Number($('max-pages').value), scope:$('scope').value})).json();
    $('page-select').replaceChildren(...extract.documents.map((doc, index) => new Option(`${doc.title} · depth ${doc.depth}`, String(index))));
    showPage();
    const report = extract.report;
    $('crawl-summary').textContent = `${report.downloaded} ${report.downloaded === 1 ? 'page' : 'pages'} · ${extract.chunks.length} chunks · ${report.failures.length} failed ${report.failures.length === 1 ? 'attempt' : 'attempts'}${report.truncated ? ' · Stopped at ' + report.stop_reason.replaceAll('_', ' ') : ''}`;
    $('failures').replaceChildren(...report.failures.map(item => { const li = document.createElement('li'); li.textContent = `${item.url}: ${item.error}`; return li; }));
    $('result').hidden = false;
    status(report.truncated ? 'Page collection reached a limit. Download the report with your knowledge base to review coverage.' : report.failures.length ? 'Collected available pages. Some pages failed; review the details below.' : 'Ready. Download your knowledge base or browse individual pages.');
  } catch(error) { status(error.message, true); }
  finally { $('extract').disabled = false; }
});
function showPage() {
  const page = selected();
  if (!page) return;
  $('content').textContent = page.markdown; $('source').textContent = page.url;
}
$('page-select').addEventListener('change', showPage);
$('bundle').addEventListener('click', () => { if(extract) download(zipFiles(knowledgeFiles(extract)), 'knowledge-base.zip'); });
$('chunks').addEventListener('click', () => { if(extract) download(new Blob([extract.chunks.map(chunk => JSON.stringify(chunk)).join('\n') + '\n'],{type:'application/x-ndjson;charset=utf-8'}),'chunks.jsonl'); });
$('markdown').addEventListener('click', () => { const page = selected(); if(page) download(new Blob([knowledgeFiles(extract)[page.document_path]],{type:'text/markdown;charset=utf-8'}),page.document_path.split('/').at(-1)); });
$('pdf').addEventListener('click', async () => {
  const page = selected();
  if(!page) return;
  $('pdf').disabled = true; status('Preparing your PDF…');
  try { const response = await post('/api/pdf',{markdown:page.markdown}); download(await response.blob(),'extracted-content.pdf'); status('Your PDF is ready.'); }
  catch(error) { status(error.message,true); }
  finally { $('pdf').disabled = false; }
});
