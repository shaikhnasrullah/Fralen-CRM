// End to end: GitHub-Pages-like origin + Worker, driven with real HTTP requests that mirror the
// curl commands from the audit.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { startOrigin, startFronted } from "./helpers/static-server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let origin, fronted, base;
before(async () => {
  origin = await startOrigin(root);
  fronted = await startFronted(origin.address().port);
  base = `http://127.0.0.1:${fronted.address().port}`;
});
after(() => { origin.close(); fronted.close(); });
const get = (path, accept) => fetch(base + path, { headers: accept ? { accept } : {}, redirect: "follow" });

test("curl -H 'Accept: text/markdown' /  -> Markdown + Vary: Accept", async () => {
  const res = await get("/", "text/markdown");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  assert.match(res.headers.get("vary"), /Accept/);
  const body = await res.text();
  assert.match(body, /^# FRALEN CRM/);
  assert.ok(body.length > 500);
});

test("curl -H 'Accept: text/html' /  -> the real HTML page", async () => {
  const res = await get("/", "text/html");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(res.headers.get("vary"), /Accept/);
  assert.match(await res.text(), /<h1>Manage Your/);
});

test("trust pages negotiate both ways, including the slash-less redirect", async () => {
  for (const p of ["/about", "/about/", "/contact/", "/privacy/"]) {
    const md = await get(p, "text/markdown");
    assert.equal(md.status, 200, p);
    assert.match(md.headers.get("content-type"), /^text\/markdown/, p);
    assert.match(md.headers.get("vary"), /Accept/, p);
    const html = await get(p, "text/html");
    assert.equal(html.status, 200, p);
    assert.match(html.headers.get("content-type"), /^text\/html/, p);
  }
});

test("curl -H 'Accept: text/markdown' on a missing path -> final 404 with Markdown body", async () => {
  const res = await get("/__ora-404-probe-xdmuj1pf", "text/markdown");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /^text\/markdown/);
  const body = await res.text();
  assert.ok(body.length >= 20);
  assert.match(body, /llms\.txt/);
});

test("missing path for HTML clients -> the branded 404.html with status 404", async () => {
  const res = await get("/__ora-404-probe-xdmuj1pf", "text/html");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(await res.text(), /404: Page not found/);
});

test("machine-readable files are served as-is", async () => {
  const llms = await get("/llms.txt", "text/markdown");
  assert.equal(llms.status, 200);
  assert.match(await llms.text(), /## When to use FRALEN CRM/);
  const sm = await get("/sitemap.xml");
  assert.equal(sm.status, 200);
  assert.match(await sm.text(), /<urlset/);
  assert.equal((await get("/favicon/web-app-manifest-512x512.png")).status, 200);
});
