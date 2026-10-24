import {buildKnowledgeBase, discoverLinks, normalizeUrl} from '../public/knowledge.js';

export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete https:// website URL.'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
      /^[\d.]+$/.test(host) || host.includes(':') ||
      /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host)) {
    throw new Error('Use a public website URL without credentials or a custom port.');
  }
  return normalizeUrl(url.href);
}

export function crawlOptions(body) {
  const maxDepth = body.maxDepth ?? 0, maxPages = body.maxPages ?? 10;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4) throw new Error('Crawl depth must be from 0 to 4.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 30) throw new Error('Page limit must be from 1 to 30.');
  if (body.scope !== undefined && !['site', 'path'].includes(body.scope)) throw new Error('Choose site or path scope.');
  return {maxDepth, maxPages, scope: body.scope || 'site'};
}

export function inScope(url, root, scope) {
  const target = new URL(url), start = new URL(root);
  const path = start.pathname.replace(/\/$/, '');
  return target.origin === start.origin && (scope !== 'path' || !path || target.pathname === path || target.pathname.startsWith(path + '/')) &&
    !/\.(pdf|zip|gz|png|jpe?g|gif|svg|webp|ico|mp[34]|woff2?|ttf|css|js|xml|json|csv|docx?|xlsx?)(?:$)/i.test(target.pathname);
}

export async function crawl(root, options, browser, now = Date.now) {
  const started = now(), pages = [], failures = [], queue = [{url:root, depth:0, parent_url:null}];
  const seen = new Set([root]);
  let characters = 0, attempted = 0, stopReason = null, pageLimitReached = false;
  while (queue.length) {
    if (attempted >= options.maxPages) { stopReason = 'page_limit'; break; }
    if (now() - started >= 90000) { stopReason = 'time_limit'; break; }
    const entry = queue.shift(); attempted++;
    try {
      const response = await browser.quickAction('markdown', {url:entry.url, gotoOptions:{waitUntil:'networkidle2',timeout:15000}});
      if (!response.ok) throw new Error(`Extraction failed (HTTP ${response.status}).`);
      const result = (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text();
      const markdown = typeof result === 'string' ? result : result?.result;
      if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('No readable content was found.');
      if (markdown.length > 200000) throw new Error('Page exceeds the 200,000 character limit.');
      if (characters + markdown.length > 1000000) { stopReason = 'content_limit'; queue.unshift(entry); break; }
      characters += markdown.length;
      const links = discoverLinks(markdown, entry.url).filter(link => {
        try { return inScope(publicUrl(link), root, options.scope); } catch { return false; }
      });
      pages.push({...entry, markdown, links, retrieved_at:new Date(now()).toISOString()});
      if (entry.depth < options.maxDepth) for (const link of links) {
        if (seen.has(link)) continue;
        // Bound the frontier as well as requests, even for link-heavy pages.
        if (seen.size >= options.maxPages) { pageLimitReached = true; continue; }
        seen.add(link); queue.push({url:link, depth:entry.depth + 1, parent_url:entry.url});
      }
    } catch (error) {
      failures.push({...entry, error:error.message || 'Browser service unavailable.'});
    }
  }
  if (!pages.length) throw new Error(failures[0]?.error || 'No readable content was found.');
  const report = {root_url:root, started_at:new Date(started).toISOString(), finished_at:new Date(now()).toISOString(),
    options, attempted, downloaded:pages.length, failures, pending:queue, truncated:!!stopReason || pageLimitReached,
    stop_reason:stopReason || (pageLimitReached ? 'page_limit' : 'completed'),
    discovery:'Links in extracted Markdown; same origin only. Depth 0 is the starting page. Page limit counts attempts, including failures.'};
  return buildKnowledgeBase(pages, report);
}
