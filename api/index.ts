export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  return new Response(
    JSON.stringify({
      name: 'Shinra Proxy',
      version: '1.0.0',
      runtime: 'edge',
      description: 'CORS proxy running on Vercel Edge — zero origin transfer',
      usage: {
        queryParam: `${url.origin}/proxy?url=https://example.com`,
        pathParam: `${url.origin}/proxy/https://example.com`,
        base64: `${url.origin}/proxy/base64/<base64encodedUrl>`,
      },
      status: `${url.origin}/proxy/status`,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}
