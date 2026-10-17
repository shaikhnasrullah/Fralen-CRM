import test from "node:test";
import assert from "node:assert/strict";
import { prefersMarkdown, isNegotiable, markdownPathFor, handle, notFoundMarkdown } from "../worker/markdown-negotiation.mjs";

const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

test("Accept parsing: who gets Markdown", () => {
  assert.equal(prefersMarkdown("text/markdown"), true);
  assert.equal(prefersMarkdown("text/markdown, text/html;q=0.9"), true);
  assert.equal(prefersMarkdown("text/html;q=0.5, text/markdown;q=0.9"), true);
  assert.equal(prefersMarkdown("text/markdown, */*;q=0.1"), true);
  assert.equal(prefersMarkdown("text/markdown;q=0"), false);
  assert.equal(prefersMarkdown("text/html"), false);
  assert.equal(prefersMarkdown("*/*"), false, "curl default must stay HTML");
  assert.equal(prefersMarkdown("text/*"), false);
  assert.equal(prefersMarkdown(BROWSER), false, "browsers must stay HTML");
  assert.equal(prefersMarkdown(""), false);
  assert.equal(prefersMarkdown(null), false);
  assert.equal(prefersMarkdown("text/html, text/markdown"), false, "tie goes to HTML when html is listed first");
  assert.equal(prefersMarkdown("text/markdown, text/html"), true, "tie goes to Markdown when listed first");
  assert.equal(prefersMarkdown("text/html;q=0.5, */*"), false, "wildcard alone never selects Markdown");
});

test("path rules", () => {
  assert.equal(isNegotiable("/"), true);
  assert.equal(isNegotiable("/about"), true);
  assert.equal(isNegotiable("/about/"), true);
  assert.equal(isNegotiable("/__probe-404"), true);
  assert.equal(isNegotiable("/privacy/privacy-policy.html"), true);
  for (const p of ["/llms.txt", "/sitemap.xml", "/index.md", "/favicon/favicon.ico", "/app.js"]) assert.equal(isNegotiable(p), false, p);
  assert.equal(markdownPathFor("/"), "/index.md");
  assert.equal(markdownPathFor("/about"), "/about/index.md");
  assert.equal(markdownPathFor("/about/"), "/about/index.md");
  assert.equal(markdownPathFor("/privacy/privacy-policy.html"), "/privacy/privacy-policy.md");
});

// --- handler with a fake origin ---
function origin(routes) {
  const calls = [];
  const fn = async (req) => {
    const u = new URL(req.url);
    calls.push({ path: u.pathname, accept: req.headers.get("accept") });
    const r = routes[u.pathname];
    if (!r) return new Response("<h1>nope</h1>", { status: 404, headers: { "content-type": "text/html", vary: "Accept-Encoding" } });
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers ?? { "content-type": r.type ?? "text/html", vary: "Accept-Encoding" } });
  };
  fn.calls = calls;
  return fn;
}
const req = (path, accept, init = {}) => new Request("https://www.fralencrm.in" + path, { ...init, headers: { ...(accept ? { accept } : {}), ...(init.headers || {}) } });
const SITE = { "/": { body: "<h1>Home</h1>" }, "/index.md": { body: "# Home\n\nHello", type: "text/markdown" } };

test("Accept: text/markdown -> Markdown body, Content-Type text/markdown, Vary: Accept", async () => {
  const res = await handle(req("/", "text/markdown"), origin(SITE));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  assert.match(res.headers.get("vary"), /(^|, )Accept($|,)/);
  assert.equal(await res.text(), "# Home\n\nHello");
});

test("Accept: text/html and browsers -> HTML unchanged, Vary gains Accept and keeps Accept-Encoding", async () => {
  for (const accept of ["text/html", BROWSER, "*/*", undefined]) {
    const res = await handle(req("/", accept), origin(SITE));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.equal(res.headers.get("vary"), "Accept-Encoding, Accept");
    assert.equal(await res.text(), "<h1>Home</h1>");
  }
});

test("Vary is not duplicated or clobbered", async () => {
  const o = origin({ "/": { body: "x", headers: { "content-type": "text/html", vary: "Accept, Origin" } } });
  assert.equal((await handle(req("/", "text/html"), o)).headers.get("vary"), "Accept, Origin");
  const star = origin({ "/": { body: "x", headers: { "content-type": "text/html", vary: "*" } } });
  assert.equal((await handle(req("/", "text/html"), star)).headers.get("vary"), "*");
});

test("404 + Accept: text/markdown -> real 404 with Markdown error body and links", async () => {
  const res = await handle(req("/__ora-404-probe-xdmuj1pf", "text/markdown"), origin(SITE));
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  assert.match(res.headers.get("vary"), /Accept/);
  const body = await res.text();
  assert.ok(body.length >= 20);
  assert.match(body, /^# 404 Not Found/);
  assert.match(body, /__ora-404-probe-xdmuj1pf/);
  assert.match(body, /\]\(https:\/\/www\.fralencrm\.in\/llms\.txt\)/);
  assert.match(body, /\]\(https:\/\/www\.fralencrm\.in\/sitemap\.xml\)/);
});

test("404 + HTML request stays the origin's HTML 404", async () => {
  const res = await handle(req("/nope", "text/html"), origin(SITE));
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.equal(await res.text(), "<h1>nope</h1>");
});

test("404 markdown body cannot be injected through the path", () => {
  const body = notFoundMarkdown(new URL("https://www.fralencrm.in/a%60%0A%23%20evil"));
  assert.ok(!/\n# evil/.test(body));
  assert.equal((body.match(/^# /gm) || []).length, 1);
});

test("redirects pass through untouched (apex -> www, /about -> /about/)", async () => {
  const o = origin({ "/about": { body: "", status: 301, headers: { location: "/about/", vary: "Accept-Encoding" } } });
  const res = await handle(req("/about", "text/markdown"), o);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/about/");
});

test("page without a Markdown twin falls back to its HTML", async () => {
  const o = origin({ "/Login-page.html": { body: "<h1>Login</h1>" } });
  const res = await handle(req("/Login-page.html", "text/markdown"), o);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
});

test("assets, non-GET and subrequests are passed through without negotiation", async () => {
  const o = origin({ "/llms.txt": { body: "# x", type: "text/plain" } });
  const asset = await handle(req("/llms.txt", "text/markdown"), o);
  assert.equal(asset.headers.get("vary"), "Accept-Encoding");
  const post = await handle(req("/", "text/markdown", { method: "POST", body: "a" }), o);
  assert.equal(post.status, 404); // origin's answer, untouched
  const sub = origin(SITE);
  await handle(req("/", "text/markdown", { headers: { "x-markdown-subrequest": "1" } }), sub);
  assert.equal(sub.calls.length, 1);
});

test("HEAD requests get headers without a body", async () => {
  const res = await handle(req("/", "text/markdown", { method: "HEAD" }), origin(SITE));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  assert.equal(await res.text(), "");
});
