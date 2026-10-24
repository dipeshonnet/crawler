export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete https:// website URL.'); }
  const host = url.hostname.toLowerCase();
  // Only DNS hostnames; Cloudflare's browser service handles network isolation.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
      /^[\d.]+$/.test(host) || host.includes(':') ||
      /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host)) {
    throw new Error('Use a public website URL without credentials or a custom port.');
  }
  url.hash = '';
  return url.href;
}

const escape = text => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function json(data, status = 200) {
  return Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!['/api/crawl', '/api/pdf'].includes(url.pathname)) return json({error:'Not found.'},404);
    if (request.method !== 'POST') return json({error:'Use POST.'},405);
    if (request.headers.get('Origin') !== url.origin) return json({error:'Please use the crawler website.'},403);
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({error:'Expected JSON.'},415);
    if (Number(request.headers.get('Content-Length')) > 600000) return json({error:'Request too large.'},413);
    const limit = await env.CRAWL_LIMITER.limit({key:request.headers.get('CF-Connecting-IP') || 'unknown'});
    if (!limit.success) return json({error:'Please wait a minute before trying again.'},429);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 600000) return json({error:'Request too large.'},413);
      body = JSON.parse(raw);
    } catch { return json({error:'Invalid request.'},400); }
    if (!body || typeof body !== 'object') return json({error:'Invalid request.'},400);
    if (url.pathname === '/api/crawl') {
      let target;
      try { target = publicUrl(body.url); } catch (error) { return json({error:error.message},400); }
      try {
        const response = await env.BROWSER.quickAction('markdown', {
          url:target, gotoOptions:{waitUntil:'networkidle2',timeout:30000}
        });
        if (!response.ok) return json({error:'The website could not be extracted. It may block automated browsers, or the daily browser allowance may be reached.'},502);
        const contentType = response.headers.get('content-type') || '';
        let markdown;
        if (contentType.includes('json')) {
          const result = await response.json();
          markdown = typeof result === 'string' ? result : result.result;
        } else markdown = await response.text();
        if (typeof markdown !== 'string' || !markdown.trim()) return json({error:'No readable content was found.'},422);
        if (markdown.length > 200000) return json({error:'This page is too large. Try a smaller page.'},422);
        return json({url:target,markdown});
      } catch { return json({error:'The browser service is unavailable. Please try again shortly.'},502); }
    }
    if (typeof body.markdown !== 'string' || !body.markdown.trim() || body.markdown.length > 200000) return json({error:'Extract a page before downloading its PDF.'},400);
    try {
      const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:"Noto Sans",sans-serif;font-size:11pt;line-height:1.6}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><pre dir="auto">'+escape(body.markdown)+'</pre></body></html>';
      const pdf = await env.BROWSER.quickAction('pdf', {html,pdfOptions:{format:'a4',printBackground:true,margin:{top:'15mm',right:'15mm',bottom:'15mm',left:'15mm'}}});
      if (!pdf.ok) return json({error:'PDF generation failed. Please try again shortly.'},502);
      const bytes = await pdf.arrayBuffer();
      // Browser Run can return binary data with a generic content type.
      if (new TextDecoder().decode(bytes.slice(0,5)) !== '%PDF-') return json({error:'The browser did not return a valid PDF. Please try again shortly.'},502);
      return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="extracted-content.pdf"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    } catch { return json({error:'PDF generation is temporarily unavailable.'},502); }
  }
};
