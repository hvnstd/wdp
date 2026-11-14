export interface Env {}
export default {
  async fetch(req: Request, _e: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const u = new URL(req.url);
      // `url` is also a legitimate upstream query parameter (Wayback CDX,
      // save/search forms, etc.). Use it as a proxy control only on the query-mode
      // entry point; path-mode URLs must keep their upstream query untouched.
      const viaParam = (u.pathname === "/" || u.pathname === "") && u.searchParams.has("url");
      let t = viaParam ? (u.searchParams.get("url") || "") : decodeURIComponent(u.pathname.slice(1));
      if (!t) return new Response("Usage: /<https://example.com> or ?url=<https://example.com>", { status: 400 });
      // Archive.org's frontend generates same-origin routes such as /details/texts
      // at runtime. Treat unqualified paths as Archive.org paths, not hostnames.
      if (!/^https?:\/\//i.test(t)) {
        if (t.startsWith("/")) {
          // Same-origin Archive.org SPA routes keep their real browser pathname.
          // Wayback's replay/CDX endpoints live on web.archive.org instead.
          const waybackPath = /^\/(?:web\/|cdx\/|save(?:\/|\?|$)|__wb\/)/i.test(t);
          t = (waybackPath ? "https://web.archive.org" : "https://archive.org") + t;
        }
        else if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(t)) t = "https://" + t;
        else t = "https://archive.org/" + t;
      }
      const target = new URL(t);
      // Preserve upstream query parameters; only the `url` key is proxy control data.
      for (const [k, v] of u.searchParams) if (!viaParam || k !== "url") target.searchParams.append(k, v);
      t = target.toString();
      const P = u.origin;
      // Archive.org and Wayback both build navigation from window.location.
      // Keep their homepages at the proxy root; otherwise relative search/form
      // submissions inherit the encoded upstream URL as a bogus path prefix.
      if (!viaParam && req.method === "GET" && /text\/html/i.test(req.headers.get("Accept") || "") && (target.hostname === "archive.org" || target.hostname === "web.archive.org")) {
        // Keep real upstream routes in window.location.pathname instead of
        // hiding the homepage inside an encoded URL.
        const waybackHome = target.hostname === "web.archive.org" && target.pathname === "/";
        const next = new URL(P + (waybackHome ? "/web/*/" : target.pathname));
        if (target.pathname === "/" && !waybackHome && !target.search) next.searchParams.set("url", target.href);
        else next.search = target.search;
        next.hash = target.hash;
        if (next.pathname !== u.pathname || next.search !== u.search || next.hash !== u.hash) {
          return Response.redirect(next.toString(), 302);
        }
      }
      const cache = caches.default;
      const cacheable = req.method === "GET";
      const cacheUrl = new URL(t);
      cacheUrl.searchParams.set("__wdp_cache", "12");
      const key = new Request(cacheUrl.toString(), { method: "GET" });
      if (cacheable) {
        const hit = await cache.match(key);
        if (hit) return hit;
      }
      let cur = t, method = req.method, redir = 8, resp: Response | null = null;
      const payload = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
      while (redir-- > 0) {
        const init: RequestInit = { method, redirect: "manual", headers: hdrs(req, cur) };
        if (payload && method !== "GET" && method !== "HEAD") init.body = payload;
        resp = await fetch(cur, init);
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get("Location");
          if (!loc) break;
          cur = new URL(loc, cur).toString();
          if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === "POST")) method = "GET";
          continue;
        }
        break;
      }
      if (!resp) return new Response("Too many redirects", { status: 500 });
      const ct = resp.headers.get("content-type") || "";
      const oh = new Headers(resp.headers);
      oh.delete("content-encoding"); oh.delete("content-security-policy"); oh.delete("content-security-policy-report-only"); oh.delete("content-length");
      oh.set("Access-Control-Allow-Origin", "*");
      let body: BodyInit | null = resp.body;
      if (ct.includes("text/html")) { body = rwHtml(await resp.text(), cur, P); oh.set("content-type", "text/html; charset=utf-8"); }
      else if (ct.includes("text/css")) { body = rwCss(await resp.text(), cur, P); oh.set("content-type", "text/css; charset=utf-8"); }
      else if (ct.includes("javascript") || ct.includes("application/json")) { body = rwJs(await resp.text(), P, cur); }
      const res = new Response(body, { status: resp.status, headers: oh });
      if (cacheable && resp.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) { return new Response("Error: " + (e as Error).message, { status: 500 }); }
  },
};
const GH = ["github.com","api.github.com","objects.githubusercontent.com","raw.githubusercontent.com","githubusercontent.com","githubassets.com","avatars.githubusercontent.com","camo.githubusercontent.com"];
function hdrs(req: Request, tu: string): Headers {
  const h = new Headers();
  h.set("User-Agent", req.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
  h.set("Accept", req.headers.get("Accept") || "*/*");
  for (const name of ["Content-Type", "Accept-Language", "Authorization", "Origin"]) {
    const value = req.headers.get(name); if (value) h.set(name, value);
  }
  const c = req.headers.get("Cookie"); if (c) h.set("Cookie", c);
  const r = req.headers.get("Range"); if (r) h.set("Range", r);
  try { h.set("Referer", new URL(tu).origin); } catch {}
  return h;
}
function pu(link: string, base: string, P: string): string {
  if (!link) return link;
  if (/^(data:|javascript:|mailto:|tel:|blob:|about:|#)/i.test(link)) return link;
  if (link.startsWith(P)) return link;
  let parsed: URL; try { parsed = new URL(link, base); } catch { return link; }
  if (!/^https?:$/i.test(parsed.protocol)) return link;
  // Same-origin URLs must remain ordinary paths so SPA routers see /search,
  // /details/... and other real routes in window.location.pathname.
  try {
    const upstream = new URL(base);
    // Archive.org's new frontend needs real same-origin SPA paths. Wayback
    // replay uses its own URL grammar (/web/<timestamp>/<original-url>), so
    // keep those URLs explicitly encoded instead of flattening them to /web/.
    if (upstream.hostname === "archive.org" && parsed.origin === upstream.origin) {
      return P + parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {}
  return P + "/" + encodeURIComponent(parsed.toString());
}
function rwCss(css: string, base: string, P: string): string {
  return css.replace(/url\(\s*(['\"]?)(.*?)\1\s*\)/gi, (_m, q: string, x: string) => "url(" + q + pu(x.trim(), base, P) + q + ")");
}
function rwJs(js: string, P: string, base: string): string {
  for (const h of GH) {
    const re = new RegExp("https://" + h.replace(/\./g, "\\.") + "([^\\s'\"`)}]+)", "gi");
    js = js.replace(re, (m) => P + "/" + encodeURIComponent(m));
  }
  // Archive.org uses many changing data-node subdomains (ia*.us.archive.org,
  // dn*.ca.archive.org, etc.); match the whole archive.org namespace.
  // The homepage bootstraps Apollo with a protocol-relative URL (//apollo.archive.org).
  // Rewrite both absolute and protocol-relative Archive.org URLs, including data-node hosts.
  js = js.replace(/(?:https?:)?\/\/(?:[a-z0-9-]+\.)*archive\.org(?::\d+)?[^\s'\"`)}]*/gi,
    (m) => P + "/" + encodeURIComponent(m.startsWith("//") ? "https:" + m : m));
  // Archive.org's current frontend builds API URLs from this bare-host setting
  // (https://${VITE_PUBLIC_ARCHIVE_API_URL}). Route that API base through this proxy.
  js = js.replace(/(VITE_PUBLIC_ARCHIVE_API_URL\s*:\s*`)archive\.org(`)/g,
    (_m, a: string, b: string) => a + new URL(P).host + "/" + encodeURIComponent("https://archive.org") + b);
  // Encoded slashes in the proxy URL are one URL path segment, so browser-relative
  // ES module imports (./chunk.js) incorrectly resolve at the proxy root. Resolve
  // those imports against the original upstream module URL before proxying them.
  js = js.replace(/(\bfrom\s*|\bimport\s*(?:\(\s*)?)(["'`])((?:\.{1,2}\/|\/)[^"'`]+)\2/g,
    (_m, prefix: string, q: string, path: string) => prefix + q + pu(path, base, P) + q);
  // Static assets embedded in component templates are often root-relative.
  js = js.replace(/(["'`])\/offshoot_assets\/([^"'`]+)\1/g,
    (_m, q: string, path: string) => q + pu("/offshoot_assets/" + path, base, P) + q);
  // Vite/Rolldown's module-preload helper converts dependency-map entries such as
  // "offshoot_assets/chunk.js" into root-relative URLs at runtime. Rewrite that
  // helper too; otherwise those generated requests escape the proxy prefix.
  js = js.replace(/(\b\w+\s*=\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*return)`\/`\s*\+\s*\2\s*\}/g,
    (_m, prefix: string, arg: string) => prefix + JSON.stringify(P + "/") + "+encodeURIComponent(new URL(\"/\"+" + arg + "," + JSON.stringify(base) + ").toString())}");
  return js;
}
function rwAttr(html: string, attr: string, base: string, P: string): string {
  const re = new RegExp(attr + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "gi");
  return html.replace(re, (m, _g1: string, dq?: string, sq?: string, uq?: string) => {
    const raw = (dq ?? sq ?? uq ?? "").trim();
    const enc = pu(raw, base, P);
    if (dq !== undefined) return attr + '="' + enc + '"';
    if (sq !== undefined) return attr + "='" + enc + "'";
    return attr + "=" + enc;
  });
}
function rwHtml(html: string, base: string, P: string): string {
  for (const a of ["href","src","action","poster","data-src","data-url","data-href","data-original","data-link"]) html = rwAttr(html, a, base, P);
  html = html.replace(/srcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, qv: string, dq?: string, sq?: string) => {
    const inner = dq ?? sq ?? "";
    const val = inner.split(",").map((p: string) => { const ps = p.trim().split(/\s+/); const x = ps.shift() || ""; return pu(x, base, P) + (ps.length ? " " + ps.join(" ") : ""); }).join(", ");
    return "srcset=" + qv[0] + val + qv[0];
  });
  html = rwCss(html, base, P);
  html = html.replace(/style\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, qv: string, dq?: string, sq?: string) => "style=" + qv[0] + rwCss(dq ?? sq ?? "", base, P) + qv[0]);
  html = html.replace(/<meta\s+[^>]*content\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (m, _qv: string, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? "";
    return /^https?:\/\//i.test(raw.trim()) ? m.replace(raw, pu(raw, base, P)) : m;
  });
  html = html.replace(/content\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _qv: string, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? "";
    if (/url\s*=/.test(raw)) {
      const fixed = raw.replace(/(url\s*=\s*)("?)([^'"\s]+)\2/i, (_mm, p: string, q: string, x: string) => p + q + pu(x, base, P) + q);
      return "content=" + (dq !== undefined ? '"' : "'") + fixed + (dq !== undefined ? '"' : "'");
    }
    return m;
  });
  return html;
}
