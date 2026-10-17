// Generates the Markdown twins (about, contact, privacy) from their HTML pages.
// index.md is hand-written because the homepage is a marketing layout; tests keep its facts in sync.
// Usage: node scripts/build-markdown.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://www.fralencrm.in";
const PAGES = ["about", "contact", "privacy"];

const decode = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&middot;/g, "·").replace(/&copy;/g, "©")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function inline(html) {
  return decode(
    html
      .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs, (_, href, text) => {
        const abs = href.startsWith("/") ? SITE + href : href;
        return `[${text.replace(/<[^>]+>/g, "")}](${abs})`;
      })
      .replace(/<strong>(.*?)<\/strong>/gs, "**$1**")
      .replace(/<br\s*\/?>/g, " ")
      .replace(/<[^>]+>/g, "")
  ).replace(/\s+/g, " ").trim();
}

export function htmlToMarkdown(html) {
  const h1 = inline((html.match(/<h1>(.*?)<\/h1>/s) || [, ""])[1]);
  const main = (html.match(/<main>(.*?)<\/main>/s) || [, ""])[1];
  const out = [`# ${h1}`, ""];
  const tokens = main.matchAll(/<h2>(.*?)<\/h2>|<p>(.*?)<\/p>|<ul>(.*?)<\/ul>/gs);
  for (const [, h2, p, ul] of tokens) {
    if (h2 !== undefined) out.push(`## ${inline(h2)}`, "");
    else if (p !== undefined) out.push(inline(p), "");
    else if (ul !== undefined) {
      for (const li of ul.matchAll(/<li>(.*?)<\/li>/gs)) out.push(`- ${inline(li[1])}`);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function outputs() {
  return PAGES.map((name) => {
    const html = readFileSync(join(root, name, "index.html"), "utf8");
    return { file: join(root, name, "index.md"), text: htmlToMarkdown(html) };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const { file, text } of outputs()) {
    if (check) {
      let cur = "";
      try { cur = readFileSync(file, "utf8"); } catch {}
      if (cur !== text) { console.error("stale:", file); stale = true; }
    } else writeFileSync(file, text);
  }
  if (check && stale) process.exit(1);
}
