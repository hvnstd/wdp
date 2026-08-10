export interface Env {}
export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      let target =
        url.searchParams.get("url") ||
        decodeURIComponent(url.pathname.slice(1));
      if (!target) {
        return new Response("Usage: /<https://example.com/file> or ?url=<https://example.com/file>", { status: 400 });
      }
      if (!/^https?:\/\//i.test(target)) target = "https://" + target;
      const cache = caches.default;
      const cacheKey = new Request(target, request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      let currentUrl = target;
      let maxRedirects = 8;
      while (maxRedirects-- > 0) {
        const resp = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: buildHeaders(request, currentUrl),
        });
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get("Location");
          if (!loc) break;
          currentUrl = new URL(loc, currentUrl).toString();
          continue;
        }
        const headers = new Headers(resp.headers);
        headers.delete("content-encoding");
        headers.set("Access-Control-Allow-Origin", "*");
        const response = new Response(resp.body, { status: resp.status, headers });
        if (resp.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }
      return new Response("Too many redirects", { status: 500 });
    } catch (e) {
      return new Response("Error: " + (e as Error).message, { status: 500 });
    }
  },
};
function buildHeaders(request: Request, targetUrl: string): Headers {
  const headers = new Headers();
  headers.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  headers.set("Accept", "*/*");
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  try {
    headers.set("Referer", new URL(targetUrl).origin);
  } catch {}
  return headers;
}
