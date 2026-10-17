import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { outputs } from "../scripts/build-markdown.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const visibleText = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const headingLevels = (html) => [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => Number(m[1]));
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

const index = read("index.html");

test("homepage: raw HTML has >=500 chars, one H1, and no skipped heading levels", () => {
  assert.ok(visibleText(index).length >= 500);
  const levels = headingLevels(index);
  assert.equal(levels.filter((l) => l === 1).length, 1);
  assert.equal(levels[0], 1);
  levels.forEach((l, i) => { if (i) assert.ok(l <= levels[i - 1] + 1, `h${levels[i - 1]} -> h${l} at heading #${i}`); });
});

test("homepage: dashboard mock-up keeps its look (classes styled, no stale tag selectors)", () => {
  assert.ok(index.includes(".dash-content .dash-title{") && index.includes(".dash-grid .dash-sub{"));
  assert.ok(!index.includes(".dash-content h3{") && !index.includes(".dash-grid h4{"));
  assert.equal((index.match(/class="dash-sub"/g) || []).length, 3);
});

test("homepage metadata: canonical, lang, og:image, og:type", () => {
  assert.match(index, /<html lang="en">/);
  assert.match(index, /<link rel="canonical" href="https:\/\/www\.fralencrm\.in\/">/);
  assert.match(index, /<meta property="og:type" content="website">/);
  const img = index.match(/<meta property="og:image" content="([^"]+)">/)[1];
  assert.match(img, /^https:\/\/www\.fralencrm\.in\//);
  assert.ok(existsSync(join(root, img.replace("https://www.fralencrm.in/", ""))), "og:image file exists");
});

test("homepage JSON-LD: Organization with contactPoint + PostalAddress, and SoftwareApplication", () => {
  const blocks = jsonLd(index);
  assert.equal(blocks.length, 1);
  const g = blocks[0]["@graph"];
  const org = g.find((n) => n["@type"] === "Organization");
  const app = g.find((n) => n["@type"] === "SoftwareApplication");
  assert.ok(org && app);
  assert.ok(org.name && org.url && org.logo);
  assert.equal(org.address["@type"], "PostalAddress");
  assert.ok(org.address.addressCountry);
  assert.ok(org.contactPoint.length >= 1);
  for (const cp of org.contactPoint) { assert.equal(cp["@type"], "ContactPoint"); assert.ok(cp.contactType); assert.ok(cp.email || cp.telephone); }
  assert.ok(app.name && app.description && app.url && app.applicationCategory);
  assert.deepEqual(app.offers.map((o) => o.price), ["1", "499", "4999", "699", "7999"]);
  assert.ok(app.offers.every((o) => o.priceCurrency === "INR"));
});

for (const [page, canon] of [["about", "/about/"], ["contact", "/contact/"], ["privacy", "/privacy/"]]) {
  test(`trust page /${page}/: >=500 chars, one H1, canonical, sequential headings`, () => {
    const html = read(`${page}/index.html`);
    assert.ok(visibleText(html).length >= 500, `${page} text length`);
    const levels = headingLevels(html);
    assert.equal(levels.filter((l) => l === 1).length, 1);
    levels.forEach((l, i) => { if (i) assert.ok(l <= levels[i - 1] + 1); });
    assert.ok(html.includes(`<link rel="canonical" href="https://www.fralencrm.in${canon}">`));
    assert.match(html, /<html lang="en">/);
  });
}

test("legacy privacy URL still exists and points to /privacy/", () => {
  assert.ok(read("privacy/privacy-policy.html").includes('<link rel="canonical" href="https://www.fralencrm.in/privacy/">'));
});

test("contact details agree across homepage, JSON-LD, contact page, llms.txt and index.md", () => {
  const facts = ["9304477821", "fralencrm@gmail.com", "customercare.fralen@gmail.com"];
  for (const f of ["index.html", "contact/index.html", "llms.txt", "index.md"]) for (const fact of facts) assert.ok(read(f).includes(fact), `${f} has ${fact}`);
});

test("index.md carries the homepage's pricing", () => {
  const md = read("index.md");
  for (const s of ["Rs 1 for 15 days", "Rs 499 per month", "Rs 4999 per year", "Rs 699 per month", "Rs 7999 per year"]) assert.ok(md.includes(s), s);
  for (const s of ["₹499", "₹4999", "₹699", "₹7999"]) assert.ok(index.includes(s), s);
  assert.match(md, /^# FRALEN CRM/);
});

test("generated Markdown twins are up to date with their HTML", () => {
  for (const { file, text } of outputs()) {
    assert.equal(readFileSync(file, "utf8"), text, `${file} is stale: run npm run build:md`);
    assert.ok(text.length >= 500 && text.startsWith("# "));
  }
});

test("llms.txt follows the llmstxt.org shape and has when-to-use guidance", () => {
  const t = read("llms.txt");
  const lines = t.split("\n");
  assert.match(lines[0], /^# \S/);
  assert.match(lines.find((l) => l.trim()), /^# /);
  assert.ok(lines.some((l) => l.startsWith("> ")), "blockquote summary");
  assert.match(t, /^## When to use FRALEN CRM$/m);
  const when = t.split(/^## /m).find((s) => s.startsWith("When to use"));
  assert.ok(when.length > 300 && (when.match(/^- /gm) || []).length >= 3);
  assert.match(t, /^## How an agent should use it$/m);
  for (const [, url] of t.matchAll(/\]\((https:\/\/www\.fralencrm\.in[^)]*)\)/g)) {
    const path = new URL(url).pathname;
    const file = path.endsWith("/") ? path + "index.html" : path;
    assert.ok(existsSync(join(root, file)), `llms.txt link target exists: ${url}`);
  }
});

test("sitemap lists the home and trust pages; robots points at it", () => {
  const sm = read("sitemap.xml");
  for (const p of ["/", "/about/", "/contact/", "/privacy/"]) assert.ok(sm.includes(`<loc>https://www.fralencrm.in${p}</loc>`), p);
  assert.match(read("robots.txt"), /Sitemap: https:\/\/www\.fralencrm\.in\/sitemap\.xml/);
});

test("404.html: noindex page with links to docs, sitemap and llms.txt", () => {
  const h = read("404.html");
  assert.match(h, /<meta name="robots" content="noindex">/);
  for (const href of ['href="/llms.txt"', 'href="/sitemap.xml"', 'href="/"']) assert.ok(h.includes(href));
  assert.ok(visibleText(h).length >= 200);
});
