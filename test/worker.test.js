import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker, {publicUrl} from '../web/worker.js';
test('only public HTTP URLs without embedded credentials are accepted', () => {
  assert.equal(publicUrl('https://example.com/page#heading'),'https://example.com/page');
  for (const url of ['file:///etc/passwd','http://localhost','http://127.0.0.1','http://[::1]','https://user:pass@example.com','http://2130706433','https://example.com:8080','http://host.internal']) assert.throws(()=>publicUrl(url));
});
function request(path, body, origin = 'https://crawler.everydayai.work') {
  return new Request('https://crawler.everydayai.work'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
}
const env = {CRAWL_LIMITER:{limit:async()=>({success:true})}};
test('cross-origin requests cannot start a browser',async()=> {
  assert.equal((await worker.fetch(request('/api/crawl',{url:'https://example.com'},'https://other.com'),env)).status,403);
});
test('extracts markdown and reports upstream failures', async()=> {
  let called;
  const browser = {quickAction:async(action,options)=>{called={action,options};return Response.json({success:true,result:'# Example'});}};
  const response = await worker.fetch(request('/api/crawl',{url:'https://example.com'}),{...env,BROWSER:browser});
  assert.equal((await response.json()).markdown,'# Example'); assert.equal(called.action,'markdown');
  const failed = await worker.fetch(request('/api/crawl',{url:'https://example.com'}),{...env,BROWSER:{quickAction:async()=>new Response('',{status:429})}});
  assert.equal(failed.status,502);
});
test('PDF escapes extracted HTML and returns a downloadable PDF',async()=> {
  let options;
  const response = await worker.fetch(request('/api/pdf',{markdown:'<script>alert(1)</script>'}),{...env,BROWSER:{quickAction:async(_,args)=>{options=args;return new Response('%PDF-1.7',{headers:{'Content-Type':'application/octet-stream'}});}}});
  assert.equal(response.status,200); assert.match(response.headers.get('Content-Disposition'),/attachment/);
  assert.equal(options.pdfOptions.format,'a4');
  assert.ok(options.html.includes('&lt;script&gt;')); assert.ok(!options.html.includes('<script>'));
});
test('throttles requests before opening a browser',async()=> {
  const response = await worker.fetch(request('/api/crawl',{url:'https://example.com'}),{CRAWL_LIMITER:{limit:async()=>({success:false})}});
  assert.equal(response.status,429);
});
