/*
 * SAHAB TV Cloudflare Worker — deploy separately from GitHub Pages.
 * Required Worker variable: ALLOWED_HOSTS = comma-separated provider hostnames
 * Example: provider.example.com,media.example.net
 * Never use this as an unrestricted public proxy. Do not publish credentials or allow arbitrary hosts.
 */
const ALLOWED_METHODS = 'GET,HEAD,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type,Range,Accept';
const EXPOSE_HEADERS = 'Accept-Ranges,Content-Length,Content-Range,Content-Type,ETag,Last-Modified';
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 30000;

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function errorResponse(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function hostAllowed(hostname, env) {
  const hosts = String(env.ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return hosts.includes(hostname.toLowerCase());
}
function validTarget(target, env) {
  if (!['http:', 'https:'].includes(target.protocol)) return false;
  if (target.username || target.password) return false;
  if (!hostAllowed(target.hostname, env)) return false;
  // Only proxy the Xtream endpoints required by this app, not arbitrary paths on an approved host.
  return /^\/player_api\.php$/i.test(target.pathname) || /^\/(movie|series|live)\//i.test(target.pathname);
}
function targetFromRequest(request) {
  const current = new URL(request.url);
  const raw = current.searchParams.get('url');
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
}
function proxyUrlFor(workerUrl, upstreamUrl) {
  const wrapped = new URL(workerUrl);
  wrapped.search = '';
  wrapped.hash = '';
  wrapped.searchParams.set('url', upstreamUrl);
  return wrapped.href;
}
function rewritePlaylist(text, baseUrl, workerUrl) {
  const rewrite = (value) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('#')) return value;
    try { return proxyUrlFor(workerUrl, new URL(trimmed, baseUrl).href); } catch { return value; }
  };
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (!line.trim().startsWith('#')) return rewrite(line);
    // HLS EXT-X-KEY and EXT-X-MAP can carry URI attributes inside tag lines.
    return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
  }).join('\n');
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (!['GET', 'HEAD'].includes(request.method)) return errorResponse('Only GET and HEAD are supported.', 405, origin);
    if (!env.ALLOWED_HOSTS) return errorResponse('Worker is not configured: set ALLOWED_HOSTS to your provider hostnames.', 503, origin);

    let target = targetFromRequest(request);
    if (!target || !validTarget(target, env)) return errorResponse('Target is invalid or its hostname/path is not allowlisted.', 403, origin);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('Upstream request timed out'), FETCH_TIMEOUT_MS);
    const forwardedHeaders = new Headers();
    forwardedHeaders.set('User-Agent', 'IPTVSmartersPro');
    const accept = request.headers.get('Accept');
    if (accept) forwardedHeaders.set('Accept', accept);
    const range = request.headers.get('Range');
    if (range) forwardedHeaders.set('Range', range);

    let upstream;
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        upstream = await fetch(target.href, {
          method: request.method,
          headers: forwardedHeaders,
          redirect: 'manual',
          signal: controller.signal,
          cf: { cacheTtl: 0, cacheEverything: false }
        });
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
        const location = upstream.headers.get('Location');
        if (!location || redirects === MAX_REDIRECTS) {
          clearTimeout(timer);
          return errorResponse('Upstream redirect limit reached.', 502, origin);
        }
        const next = new URL(location, target.href);
        if (!validTarget(next, env)) {
          clearTimeout(timer);
          return errorResponse('Upstream redirected to a host or path that is not allowlisted.', 502, origin);
        }
        target = next;
      }
    } catch (error) {
      clearTimeout(timer);
      const message = error?.name === 'AbortError' ? 'Upstream timed out after 30 seconds.' : 'Could not fetch the upstream resource.';
      return errorResponse(message, 502, origin);
    }
    clearTimeout(timer);

    const headers = new Headers(corsHeaders(origin));
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Content-Disposition']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('Cache-Control', 'no-store');
    headers.delete('Content-Length'); // playlist text may be rewritten; streaming body length is not guaranteed.

    const contentType = (upstream.headers.get('Content-Type') || '').toLowerCase();
    const isPlaylist = /mpegurl/.test(contentType) || /\.m3u8$/i.test(target.pathname);
    if (isPlaylist && request.method === 'GET' && upstream.ok) {
      try {
        const body = await upstream.text();
        headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        return new Response(rewritePlaylist(body, target.href, request.url), { status: upstream.status, headers });
      } catch {
        return errorResponse('Could not read the HLS playlist.', 502, origin);
      }
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
  }
};
