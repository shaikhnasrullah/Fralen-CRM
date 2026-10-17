// Cloudflare Worker: Markdown content negotiation (https://acceptmarkdown.com) in front of the
// GitHub Pages origin, which cannot vary a response by the Accept header on its own.
//
//   Accept: text/markdown  ->  200, Content-Type: text/markdown, Vary: Accept   (page's .md twin)
//   Accept: text/html / */* / browsers -> unchanged HTML, with Vary: Accept added
//   Missing page + markdown preferred -> 404 with a Markdown error body and links
//
// Markdown twins live in the repo: /index.md, /about/index.md, /contact/index.md, /privacy/index.md.

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
const SUBREQUEST_HEADER = "x-markdown-subrequest";

/** Parse an Accept header into [{type, subtype, q, index}]. */
export function parseAccept(header) {
  if (!header) return [];
  return header.split(",").map((part, index) => {
    const [range, ...params] = part.trim().split(";").map((s) => s.trim());
    const [type = "", subtype = ""] = range.toLowerCase().split("/");
    let q = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(p);
      if (m) q = Math.min(1, Math.max(0, Number.parseFloat(m[1]) || 0));
    }
    return { type, subtype, q, index };
  }).filter((e) => e.type && e.subtype);
}

function match(entries, type, subtype) {
  // Most specific range wins: type/subtype > type/* > */*
  const exact = entries.find((e) => e.type === type && e.subtype === subtype);
  if (exact) return exact;
  const partial = entries.find((e) => e.type === type && e.subtype === "*");
  if (partial) return partial;
  return entries.find((e) => e.type === "*" && e.subtype === "*") || null;
}

/** True when the client prefers Markdown over HTML. Wildcards alone never select Markdown. */
export function prefersMarkdown(header) {
  const entries = parseAccept(header);
  const md = match(entries, "text", "markdown");
  const html = match(entries, "text", "html");
  const mdQ = md ? md.q : 0;
  const htmlQ = html ? html.q : 0;
  if (mdQ <= 0) return false;
  if (mdQ > htmlQ) return !(md.type === "*"); // */* with html excluded still must not pick markdown
  if (mdQ < htmlQ) return false;
  // Tie: Markdown only if the client named it explicitly and listed it before text/html.
  const explicitMd = entries.find((e) => e.type === "text" && e.subtype === "markdown");
  const explicitHtml = entries.find((e) => e.type === "text" && e.subtype === "html");
  return Boolean(explicitMd && (!explicitHtml || explicitMd.index < explicitHtml.index));
}

/** Only page-like paths negotiate; assets, feeds and files pass through untouched. */
export function isNegotiable(pathname) {
  if (pathname.endsWith("/")) return true;
  const last = pathname.split("/").pop();
  return !last.includes(".") || last.endsWith(".html");
}

export function markdownPathFor(pathname) {
  if (pathname.endsWith(".html")) return pathname.replace(/\.html$/, ".md");
  return (pathname.endsWith("/") ? pathname : pathname + "/") + "index.md";
}

function withVaryAccept(headers) {
  const vary = headers.get("vary");
  if (!vary) headers.set("vary", "Accept");
  else if (vary.trim() !== "*" && !/(^|,)\s*accept\s*(,|$)/i.test(vary)) headers.set("vary", `${vary}, Accept`);
  return headers;
}

function rebuild(res, { status = res.status, headers = new Headers(res.headers), body = res.body } = {}) {
  const nullBody = [101, 204, 205, 304].includes(status);
  return new Response(nullBody ? null : body, { status, statusText: status === res.status ? res.statusText : "", headers });
}

export function notFoundMarkdown(url) {
  const shown = decodeURIComponent(url.pathname).replace(/[`\r\n]/g, "");
  const o = url.origin;
  return `# 404 Not Found

The page \`${shown}\` does not exist on FRALEN CRM, optical shop management software. Check the address, or use one of the links below to find what you need.

## Where to go next

- [FRALEN CRM homepage](${o}/): features, pricing and contact details
- [About FRALEN CRM](${o}/about/): what the product does
- [Contact](${o}/contact/): phone and email
- [llms.txt](${o}/llms.txt): guidance for AI agents, including when to use FRALEN CRM
- [Sitemap](${o}/sitemap.xml): every public page
`;
}

/**
 * @param {Request} request
 * @param {(req: Request) => Promise<Response>} fetchOrigin
 */
export async function handle(request, fetchOrigin) {
  const url = new URL(request.url);
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (!readOnly || request.headers.has(SUBREQUEST_HEADER) || !isNegotiable(url.pathname)) {
    return fetchOrigin(request);
  }

  const htmlRes = await fetchOrigin(request);
  if (!prefersMarkdown(request.headers.get("accept"))) {
    return rebuild(htmlRes, { headers: withVaryAccept(new Headers(htmlRes.headers)) });
  }

  const head = request.method === "HEAD";
  const mdHeaders = (extra = {}) => {
    const h = new Headers({ "content-type": MARKDOWN_TYPE, "x-content-type-options": "nosniff" });
    const cc = htmlRes.headers.get("cache-control");
    if (cc) h.set("cache-control", cc);
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return withVaryAccept(h);
  };

  if (htmlRes.status === 404) {
    const body = notFoundMarkdown(url);
    return new Response(head ? null : body, { status: 404, headers: mdHeaders() });
  }
  if (htmlRes.status !== 200) {
    // redirects, errors: pass through, only add Vary
    return rebuild(htmlRes, { headers: withVaryAccept(new Headers(htmlRes.headers)) });
  }

  const mdReq = new Request(new URL(markdownPathFor(url.pathname), url), {
    method: "GET",
    headers: { accept: "text/markdown", [SUBREQUEST_HEADER]: "1" },
  });
  const mdRes = await fetchOrigin(mdReq);
  if (mdRes.status === 200) {
    const text = await mdRes.text();
    if (text.trim()) return new Response(head ? null : text, { status: 200, headers: mdHeaders() });
  }
  // No Markdown twin for this page: fall back to its HTML.
  return rebuild(htmlRes, { headers: withVaryAccept(new Headers(htmlRes.headers)) });
}

export default {
  fetch(request) {
    return handle(request, (req) => fetch(req));
  },
};
