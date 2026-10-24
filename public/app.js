const $ = id => document.getElementById(id);
let extract = null;
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
  status('Opening the page and extracting its content. This can take up to a minute…');
  try {
    extract = await (await post('/api/crawl',{url:$('url').value.trim()})).json();
    $('content').textContent = extract.markdown; $('source').textContent = extract.url;
    $('result').hidden = false; status('Ready. Save your extract as Markdown or PDF.');
  } catch(error) { status(error.message, true); }
  finally { $('extract').disabled = false; }
});
$('markdown').addEventListener('click', () => { if(extract) download(new Blob([extract.markdown],{type:'text/markdown;charset=utf-8'}),'extracted-content.md'); });
$('pdf').addEventListener('click', async () => {
  if(!extract) return;
  $('pdf').disabled = true; status('Preparing your PDF…');
  try { const response = await post('/api/pdf',{markdown:extract.markdown}); download(await response.blob(),'extracted-content.pdf'); status('Your PDF is ready.'); }
  catch(error) { status(error.message,true); }
  finally { $('pdf').disabled = false; }
});
