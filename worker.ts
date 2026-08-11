export interface Env {}
export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const reqUrl = new URL(request.url);
      let target =
        reqUrl.searchParams.get("url") ||
        decodeURIComponent(reqUrl.pathname.slice(1));
      if (!target) {
        return new Response("Usage: /<https://example.com> or ?url=<https://example.com>", { status: 400 });
      }
      if (!/^https?:\/\//i.test(target)) target = "https://" + target;
      const proxyOrigin = reqUrl.origin;
      const cache = caches.default;
      const cacheKey = new Request(target, request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      let currentUrl = target;
      let maxRedirects = 8;
      let resp: Response | null = null;
      while (maxRedirects-- > 0) {
        resp = await fetch(currentUrl, {
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
        break;
      }
      if (!resp) return new Response("Too many redirects", { status: 500 });
      const ct = resp.headers.get("content-type") || "";
      const outHeaders = new Headers(resp.headers);
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-security-policy");
      outHeaders.delete("content-security-policy-report-only");
      outHeaders.delete("content-length");
      outHeaders.set("Access-Control-Allow-Origin", "*");
      let body: BodyInit | null = resp.body;
      if (ct.includes("text/html")) {
        const html = await resp.text();
        body = rewriteHtml(html, currentUrl, proxyOrigin);
        outHeaders.set("content-type", "text/html; charset=utf-8");
      } else if (ct.includes("text/css")) {
        const css = await resp.text();
        body = rewriteCssUrls(css, currentUrl, proxyOrigin);
        outHeaders.set("content-type", "text/css; charset=utf-8");
      }
      const response = new Response(body, { status: resp.status, headers: outHeaders });
      if (resp.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (e) {
      return new Response("Error: " + (e as Error).message, { status: 500 });
    }
  },
};
function buildHeaders(request: Request, targetUrl: string): Headers {
  const headers = new Headers();
  headers.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
  headers.set("Accept", "*/*");
  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  try {
    headers.set("Referer", new URL(targetUrl).origin);
  } catch {}
  return headers;
}
function proxyUrl(link: string, baseUrl: string, proxyOrigin: string): string {
  if (!link) return link;
  if (/^(data:|javascript:|mailto:|tel:|blob:|about:|#)/i.test(link)) return link;
  if (link.startsWith(proxyOrigin)) return link;
  let abs: string;
  try { abs = new URL(link, baseUrl).toString(); } catch { return link; }
  if (!/^https?:\/\//i.test(abs)) return link;
  return proxyOrigin + "/" + encodeURIComponent(abs);
}
function rewriteCssUrls(css: string, baseUrl: string, proxyOrigin: string): string {
  return css.replace(/url\(\s*(['\"]?)(.*?)\1\s*\)/gi, (_m, q: string, u: string) => {
    const val = proxyUrl(u.trim(), baseUrl, proxyOrigin);
    return "url(" + q + val + q + ")";
  });
}
function rewriteAttr(html: string, attr: string, baseUrl: string, proxyOrigin: string): string {
  const re = new RegExp(attr + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "gi");
  return html.replace(re, (m, _g1: string, dq?: string, sq?: string, uq?: string) => {
    const raw = (dq ?? sq ?? uq ?? "").trim();
    const encoded = proxyUrl(raw, baseUrl, proxyOrigin);
    if (dq !== undefined) return attr + '="' + encoded + '"';
    if (sq !== undefined) return attr + "='" + encoded + "'";
    return attr + "=" + encoded;
  });
}
function rewriteHtml(html: string, baseUrl: string, proxyOrigin: string): string {
  // standard resource attrs
  for (const attr of ["href", "src", "action", "poster", "data-src", "data-url", "data-href", "data-original", "data-link"]) {
    html = rewriteAttr(html, attr, baseUrl, proxyOrigin);
  }
  // srcset: comma-separated url descriptors
  html = html.replace(/srcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, qv: string, dq?: string, sq?: string) => {
    const inner = dq ?? sq ?? "";
    const val = inner.split(",").map((p: string) => {
      const parts = p.trim().split(/\s+/);
      const u = parts.shift() || "";
      return proxyUrl(u, baseUrl, proxyOrigin) + (parts.length ? " " + parts.join(" ") : "");
    }).join(", ");
    const q = qv[0];
    return "srcset=" + q + val + q;
  });
  // inline css + style blocks
  html = rewriteCssUrls(html, baseUrl, proxyOrigin);
  html = html.replace(/style\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, qv: string, dq?: string, sq?: string) => {
    const inner = dq ?? sq ?? "";
    const q = qv[0];
    return "style=" + q + rewriteCssUrls(inner, baseUrl, proxyOrigin) + q;
  });
  // meta property=og:url / og:image / twitter:image (content holds url)
  html = html.replace(/<meta\s+[^>]*content\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (m, _qv: string, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? "";
    if (/^https?:\/\//i.test(raw.trim())) {
      const q = dq !== undefined ? '"' : "'";
      return m.replace(raw, proxyUrl(raw, baseUrl, proxyOrigin));
    }
    return m;
  });
  // meta refresh url=
  html = html.replace(/content\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _qv: string, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? "";
    if (/url\s*=/.test(raw)) {
      const fixed = raw.replace(/(url\s*=\s*)("?)([^'"\s]+)\2/i, (_mm, p: string, q: string, u: string) => p + q + proxyUrl(u, baseUrl, proxyOrigin) + q);
      const q = dq !== undefined ? '"' : "'";
      return "content=" + q + fixed + q;
    }
    return m;
  });
  return html;
}
