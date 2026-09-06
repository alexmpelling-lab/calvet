export interface Env {
  ASSETS: Fetcher
}

// Hugging Face's CDN was returning a bare 404 with no CORS headers
// specifically for cross-origin fetch()/XHR requests carrying an Origin
// header from this app's *.workers.dev domain, while the exact same URL
// loaded fine as a normal browser navigation — consistent with CDN-level
// bot mitigation that's suspicious of the workers.dev suffix, not an
// actual missing file. Routing the browser's request through this Worker
// instead means the request to huggingface.co happens server-to-server
// (no Origin header, no CORS involved at all), and we add our own
// permissive CORS headers on the way back so the browser is happy with it.
const PROXY_PREFIX = '/hf-proxy/'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
}

async function handleHfProxy(request: Request, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const targetPath = url.pathname.slice(PROXY_PREFIX.length)
  const targetUrl = `https://huggingface.co/${targetPath}${url.search}`

  const forwardedHeaders: Record<string, string> = {}
  const accept = request.headers.get('Accept')
  if (accept) forwardedHeaders.Accept = accept
  const range = request.headers.get('Range')
  if (range) forwardedHeaders.Range = range

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers: forwardedHeaders,
    redirect: 'follow',
  })

  const headers = new Headers(upstream.headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(PROXY_PREFIX)) {
      return handleHfProxy(request, url)
    }
    return env.ASSETS.fetch(request)
  },
}
