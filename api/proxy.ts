/**
 * Shinra Proxy - Vercel Edge Runtime
 *
 * Runs at Vercel's Edge (CDN layer) — does NOT count toward Origin Transfer.
 * All fetch() calls go directly from the edge node to the target server,
 * bypassing Vercel's origin entirely.
 *
 * Key bandwidth savings:
 *  1. Edge Runtime = zero origin transfer for proxied bytes
 *  2. Cache-Control headers = Vercel CDN caches media segments at edge
 *  3. 301/302 redirects passed through = no double-fetch
 */

export const config = { runtime: 'edge' };

// ---------------------------------------------------------------------------
// Config / helpers
// ---------------------------------------------------------------------------

const PROXY_BASE = '/proxy';
const MAX_URL_LENGTH = 8192;

/** Extensions / patterns that should get aggressive CDN caching */
const MEDIA_EXTENSIONS = ['.ts', '.m4s', '.mp4', '.mp3', '.aac', '.webm', '.m4a'];
const TEXT_EXTENSIONS = ['.m3u8', '.vtt', '.srt', '.ass', '.sub'];

/** Headers we strip from the incoming request before forwarding */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-vercel-id',
  'x-vercel-deployment-url',
  'x-vercel-forwarded-for',
]);

/** Headers we strip from upstream responses before forwarding to the client */
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
]);

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Requested-With, Range, Origin',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Content-Type, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonError(status: number, message: string, extra?: object): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message }, success: false, ...extra }),
    {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    }
  );
}

/**
 * Decide Cache-Control value based on content type / URL extension.
 *
 * - Media segments (.ts, .m4s, .mp4 …): immutable, cache 1 year at edge
 * - Playlists (.m3u8): short TTL (segments change every few seconds)
 * - Text (vtt, srt): moderate cache
 * - Everything else: let upstream headers through, add s-maxage fallback
 */
function cacheControlForUrl(url: string, contentType: string | null): string {
  const lower = url.toLowerCase().split('?')[0];

  if (MEDIA_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    // These are immutable media chunks — cache aggressively at the CDN edge
    return 'public, max-age=31536000, s-maxage=31536000, immutable';
  }

  if (lower.endsWith('.m3u8') || contentType?.includes('mpegurl')) {
    // Playlists update frequently — short CDN cache, no browser cache
    return 'public, max-age=0, s-maxage=3, must-revalidate';
  }

  if (TEXT_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    return 'public, max-age=60, s-maxage=300';
  }

  // Default: allow the CDN to cache for 60s, browser for 30s
  return 'public, max-age=30, s-maxage=60';
}

// ---------------------------------------------------------------------------
// M3U8 URL rewriting
// ---------------------------------------------------------------------------

function proxyUrl(targetUrl: string, baseProxyUrl: string): string {
  return `${baseProxyUrl}?url=${encodeURIComponent(targetUrl)}`;
}

function rewriteM3u8(content: string, targetUrl: string, baseProxyUrl: string): string {
  let basePath = targetUrl;
  if (targetUrl.endsWith('.m3u8')) {
    basePath = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
  } else if (!basePath.endsWith('/')) {
    basePath += '/';
  }
  const targetUrlObj = new URL(targetUrl);

  return content
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Comment lines — look for URI="..." attributes
      if (trimmed.startsWith('#')) {
        if (line.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/, (_match, uri: string) => {
            const abs = /^https?:\/\//.test(uri)
              ? uri
              : new URL(uri, basePath).toString();
            return `URI="${proxyUrl(abs, baseProxyUrl)}"`;
          });
        }
        return line;
      }

      // Already proxied
      if (trimmed.startsWith(baseProxyUrl)) return line;

      // Segment URL
      let abs: string;
      if (/^https?:\/\//.test(trimmed)) {
        abs = trimmed;
      } else if (trimmed.startsWith('//')) {
        abs = `${targetUrlObj.protocol}${trimmed}`;
      } else {
        abs = new URL(trimmed, basePath).toString();
      }
      return proxyUrl(abs, baseProxyUrl);
    })
    .join('\n');
}

function rewriteVtt(content: string, targetUrl: string, baseProxyUrl: string): string {
  let basePath = targetUrl;
  if (!basePath.endsWith('/')) basePath = basePath.substring(0, basePath.lastIndexOf('/') + 1);

  return content.replace(/https?:\/\/[^\s"']+/g, match => {
    if (match.startsWith(baseProxyUrl)) return match;
    return proxyUrl(match, baseProxyUrl);
  }).replace(/(?:^|\n)([^#\r\n][^\r\n]*)(?=\r?\n)/g, (match, p1) => {
    const trimmed = p1.trim();
    if (!trimmed || trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) return match;
    if (/^https?:\/\//.test(trimmed)) return match.replace(p1, proxyUrl(trimmed, baseProxyUrl));
    if (!trimmed.includes('.')) return match;
    try {
      return match.replace(p1, proxyUrl(new URL(trimmed, basePath).toString(), baseProxyUrl));
    } catch { return match; }
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url);

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── Determine target URL ──────────────────────────────────────────────────
  let targetUrl: string | null = null;

  const queryUrl = reqUrl.searchParams.get('url');
  if (queryUrl) {
    targetUrl = queryUrl;
  } else {
    // Path-based: /proxy/https://example.com/...  or  /proxy/base64/<b64>
    const pathPart = reqUrl.pathname.replace(/^\/proxy\/?/, '');
    if (pathPart.startsWith('base64/')) {
      try {
        targetUrl = atob(pathPart.slice(7));
      } catch {
        return jsonError(400, 'Invalid base64 encoded URL');
      }
    } else if (pathPart) {
      targetUrl = /^https?:\/\//i.test(pathPart) ? pathPart : `https://${pathPart}`;
    }
  }

  // ── Status / info routes ──────────────────────────────────────────────────
  if (!targetUrl || reqUrl.pathname === '/proxy/status') {
    if (reqUrl.pathname === '/' || reqUrl.pathname === '') {
      return new Response(
        JSON.stringify({
          name: 'Shinra Proxy (Edge)',
          version: '1.0.0',
          runtime: 'edge',
          usage: {
            queryParam: `${PROXY_BASE}?url=https://example.com`,
            pathParam: `${PROXY_BASE}/https://example.com`,
            base64: `${PROXY_BASE}/base64/<base64url>`,
          },
          status: `${PROXY_BASE}/status`,
        }),
        { headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }
    if (reqUrl.pathname.endsWith('/status')) {
      return new Response(
        JSON.stringify({ status: 'ok', runtime: 'edge', timestamp: new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }
    return jsonError(400, 'Missing URL parameter. Use ?url=https://example.com');
  }

  // ── Validate target URL ───────────────────────────────────────────────────
  if (targetUrl.length > MAX_URL_LENGTH) {
    return jsonError(400, 'URL too long');
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return jsonError(400, 'Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
    return jsonError(400, 'Only http and https URLs are supported');
  }

  // Block SSRF — disallow private / loopback ranges
  const hostname = parsedTarget.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('172.') ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local')
  ) {
    return jsonError(403, 'Private/loopback URLs are not allowed');
  }

  // ── Build upstream request headers ────────────────────────────────────────
  const upstreamHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }
  upstreamHeaders.set('host', parsedTarget.host);

  // ── Proxy the request ─────────────────────────────────────────────────────
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: 'follow',
    });
  } catch (err: any) {
    return jsonError(502, `Upstream fetch failed: ${err?.message ?? 'unknown error'}`);
  }

  const contentType = upstreamResponse.headers.get('content-type');
  const isM3u8 =
    targetUrl.toLowerCase().includes('.m3u8') ||
    contentType?.includes('mpegurl') ||
    false;
  const isVtt = contentType?.includes('text/vtt') || targetUrl.toLowerCase().endsWith('.vtt');

  // ── Build response headers ────────────────────────────────────────────────
  const responseHeaders = new Headers(corsHeaders());

  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  // Always set CORS (overrides upstream CORS if any)
  for (const [k, v] of Object.entries(corsHeaders())) {
    responseHeaders.set(k, v);
  }

  // Set smart Cache-Control
  const cacheControl = cacheControlForUrl(targetUrl, contentType);
  responseHeaders.set('Cache-Control', cacheControl);

  // Vercel CDN cache tag — lets you purge by type later
  const lower = targetUrl.toLowerCase().split('?')[0];
  if (MEDIA_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    responseHeaders.set('Vercel-CDN-Cache-Control', 'max-age=31536000');
    responseHeaders.set('CDN-Cache-Control', 'max-age=31536000');
  } else if (isM3u8) {
    responseHeaders.set('Vercel-CDN-Cache-Control', 'max-age=3');
    responseHeaders.set('CDN-Cache-Control', 'max-age=3');
  }

  // ── Special content processing ────────────────────────────────────────────
  const baseProxyUrl = `${reqUrl.origin}${PROXY_BASE}`;

  if (isM3u8 && upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    const rewritten = rewriteM3u8(text, targetUrl, baseProxyUrl);
    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
    responseHeaders.delete('content-encoding'); // already decoded as text
    return new Response(rewritten, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  if (isVtt && upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    const rewritten = rewriteVtt(text, targetUrl, baseProxyUrl);
    responseHeaders.set('Content-Type', 'text/vtt');
    responseHeaders.delete('content-encoding');
    return new Response(rewritten, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  // ── Default: stream body straight through ────────────────────────────────
  // The body is a ReadableStream — Edge Functions can pipe it zero-copy.
  // No buffering in memory, no origin transfer.
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
