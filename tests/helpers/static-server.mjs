// Minimal GitHub-Pages-like origin: directory indexes, 301 for directories without a slash,
// 404.html served with status 404, plus a Worker-fronted server for end-to-end checks.
import http from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { handle } from "../../worker/markdown-negotiation.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml", ".png": "image/png", ".js": "text/javascript", ".json": "application/json" };

export function startOrigin(root) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let p = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, p);
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!u.pathname.endsWith("/")) { res.writeHead(301, { location: u.pathname + "/" }); return res.end(); }
      file = join(file, "index.html");
    }
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", vary: "Accept-Encoding" });
      return res.end(req.method === "HEAD" ? undefined : readFileSync(file));
    }
    res.writeHead(404, { "content-type": TYPES[".html"], vary: "Accept-Encoding" });
    res.end(readFileSync(join(root, "404.html")));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** HTTP server that runs the Worker in front of the origin. */
export function startFronted(originPort) {
  const server = http.createServer(async (req, res) => {
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers: req.headers });
    const response = await handle(request, (r) => {
      const u = new URL(r.url);
      return fetch(`http://127.0.0.1:${originPort}${u.pathname}${u.search}`, { method: r.method, headers: r.headers, redirect: "manual" });
    });
    const headers = Object.fromEntries(response.headers);
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
