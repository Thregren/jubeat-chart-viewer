// 极小的静态文件服务：给 Electron 里的页面提供 http:// 环境。
// 必须是 http（而不是 file://），否则 fetch 读 data/*.json 会失败、音频也没法 Range 拖动。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function parseRange(header, size) {
  if (!header || !header.startsWith("bytes=") || size <= 0) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(",")) return null;
  const [a, b] = spec.split("-");
  const start = a === "" ? Math.max(0, size - parseInt(b, 10)) : parseInt(a, 10);
  const end = a === "" || !b ? size - 1 : parseInt(b, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  const e = Math.min(Number.isFinite(end) ? end : size - 1, size - 1);
  return e < start ? null : [start, e];
}

/** 启动静态服务，返回 { url, close } */
function serve(rootDir) {
  const root = path.resolve(rootDir);
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    if (rel === "/" || rel === "") rel = "/index.html";
    const target = path.join(root, rel);
    if (!target.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404");
        return;
      }
      const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
      const headers = {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Cache-Control": rel.startsWith("/media/") ? "public, max-age=604800" : "no-cache",
      };
      const range = parseRange(req.headers.range, stat.size);
      if (!range) {
        res.writeHead(200, { ...headers, "Content-Length": stat.size });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(target).pipe(res);
      }
      const [start, end] = range;
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(target, { start, end }).pipe(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { serve };
