// 极小的静态文件服务：给 Electron 里的页面提供 http:// 环境。
// 必须是 http（而不是 file://），否则 fetch 读 data/*.json 会失败、音频也没法 Range 拖动。
const http = require("node:http");
const { pipeline } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");

// 和安卓 LocalServer.MIME 是同一张表：两端各自内联（不想为它引入构建期代码生成），
// 但键集合必须完全一致，否则同一个文件在两端 Content-Type 不同。
// 以前桌面多 .caf/.webm、安卓多 .txt，现在并集：22 个键。
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".caf": "audio/x-caf",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * 解析单段 Range，返回闭区间 [start, end]；不支持 / 非法返回 null（调用方回整文件 200）。
 *
 * 三份实现（这里 / Python 开发服务器 media.parse_range / PHP deploy/php）必须是同一套
 * 语义，否则同一个音频文件在三种部署下对 Seek 的表现会不一样。以前这里有三个漏洞：
 *   - `bytes=500`（没有短横线）被当成 `500-`：Python / PHP 都判非法，只有这里放行
 *   - `bytes=10-x`（结束位置不是数字）被当成「到文件尾」：parseInt 得到 NaN，
 *     又被 `Number.isFinite` 兜回 size-1，于是把脏请求当合法请求发了 206
 * 现在统一成：必须恰好一个 `-`、两侧要么是纯数字要么为空，且 `start <= end`。
 * 一致性由 tools/test_range.py 用同一张用例表跑三份实现来守。
 */
function parseRange(header, size) {
  const raw = typeof header === "string" ? header.trim() : "";
  if (!raw.startsWith("bytes=") || size <= 0) return null;
  const spec = raw.slice(6).trim();
  if (spec.includes(",")) return null;          // 多段区间不支持
  const dash = spec.indexOf("-");
  if (dash < 0) return null;
  const a = spec.slice(0, dash);
  const b = spec.slice(dash + 1);
  const NUM = /^\d+$/;
  let start;
  let end;
  if (a === "") {
    if (!NUM.test(b)) return null;
    const n = Number(b);
    if (n <= 0) return null;
    start = Math.max(0, size - n);              // bytes=-N：最后 N 字节
    end = size - 1;
  } else {
    if (!NUM.test(a)) return null;
    start = Number(a);
    if (b === "") {
      end = size - 1;
    } else {
      if (!NUM.test(b)) return null;
      end = Number(b);
    }
  }
  if (start < 0 || start >= size) return null;
  end = Math.min(end, size - 1);                // 末尾越界就夹到文件尾
  return end < start ? null : [start, end];
}

/**
 * 每个响应都带的头（和 Python 开发服务器 / nginx 那份配置保持一致的口径）。
 *
 * CSP 与 deploy/security-headers.conf 逐条同序，只去掉 upgrade-insecure-requests
 * （这里就是明文回环，升级没意义）并保留 media-src 的 blob: —— 前端
 * app-player.js 把已下载音源包成 blob 复用（保音调变速），少了它播放会哑。
 * 别顺手加 img-src 的 data:：前端没有任何 data: 图片，多放开一条就是白送的注入面。
 * index.html 本身零内联 script / 零 style 属性，所以不需要 'unsafe-inline'。
 * 这条串被 tools/test_cache_headers.py 钉住，改一端就得改四方。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'none'",
].join("; ");

const BASE_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
};

/** 错误响应也要带全公共头（以前 400/403/404 有几条是裸奔的）。 */
function fail(res, code, body, extra = null) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, {
    ...BASE_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    ...(extra || {}),
  }).end(body);
}

/**
 * 缓存策略按资源类型对齐 Python 开发服务器 server.py，四类资源在四端必须一致
 * （由 tools/test_cache_headers.py 静态守着）：
 *   audio / data/charts / se → 1 天，cover / thumb → 7 天，markers → 300 秒，
 *   其余（入口、索引、静态脚本）→ no-cache 每次回来校验。
 */
function cacheControl(rel) {
  if (rel.startsWith("/media/audio/") || rel.startsWith("/media/se/")) {
    return "public, max-age=86400";        // audio: 1 天
  }
  if (rel.startsWith("/media/cover/") || rel.startsWith("/media/thumb/")) {
    return "public, max-age=604800";       // cover-thumb: 7 天
  }
  if (rel.startsWith("/data/charts/")) {
    return "public, max-age=86400";        // data-charts: 1 天
  }
  if (rel.startsWith("/markers/")) {
    return "public, max-age=300";          // markers: 300 秒
  }
  return "no-cache";
}

/**
 * 把请求路径安全地拼到 root 下；越界返回 null。
 *
 * 这里以前是 `target.startsWith(root)`：看着像包含检查，其实是个字符串前缀比较，
 * 兄弟目录 `…/site-evil/…` 能通过（root = `…/site`）。改成 path.relative 后
 * 只有真正落在 root 里的相对路径才放行。
 */
function resolveSafe(root, urlPath) {
  const target = path.resolve(root, "." + urlPath);
  const rel = path.relative(root, target);
  if (rel === "" ) return target;               // 就是 root 本身（调用方再看是不是文件）
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

/**
 * 把文件发出去（200 整文件 / 206 一段）。
 *
 * createReadStream 的 'error' 必须接住：stat 与 open 之间文件被删掉、或读到一半
 * 磁盘出错时，没有监听器的 'error' 事件不是「这一个请求失败」，而是直接掀掉
 * Electron 主进程（整个应用退出）。此时响应头已经发出去了，补不了 404，
 * 只能 destroy 掉这条响应，让客户端自己重试。
 */
function sendFile(req, res, target, headers, code, opts = null) {
  // realpath/stat finish asynchronously; a cancelled request may have closed its
  // response by then. pipeline throws synchronously for an already closed target.
  if (res.destroyed || res.writableEnded || res.socket?.destroyed) return;
  res.writeHead(code, headers);
  if (req.method === "HEAD") return res.end();
  const stream = opts ? fs.createReadStream(target, opts) : fs.createReadStream(target);
  // pipeline closes both ends when a client cancels or a disk read fails.
  pipeline(stream, res, () => {});
}

/** 启动静态服务，返回 { url, close } */
function serve(rootDir) {
  const root = fs.realpathSync(rootDir);
  const connections = new Set();
  const server = http.createServer((req, res) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "host");
    if (hosts.length !== 1 || req.headers.host !== expectedHost ||
        (req.headers.origin != null && req.headers.origin !== `http://${expectedHost}`)) {
      return fail(res, 403, "forbidden", { "Connection": "close" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return fail(res, 405, "", { "Allow": "GET, HEAD" });
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      return fail(res, 400, "bad request");
    }
    // fs.realpath throws synchronously on NUL instead of reporting an error to
    // its callback; reject it before any filesystem operation.
    if (rel.includes("\0")) return fail(res, 400, "bad request");
    if (rel === "/" || rel === "") rel = "/index.html";
    const target = resolveSafe(root, rel);
    if (!target) return fail(res, 403, "forbidden");
    fs.realpath(target, (pathError, resolved) => {
      if (pathError) return fail(res, 404, "404");
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return fail(res, 403, "forbidden");
    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) return fail(res, 404, "404");
      const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
      const headers = {
        ...BASE_HEADERS,
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl(rel),
      };
      const range = parseRange(req.headers.range, stat.size);
      if (!range) {
        return sendFile(req, res, resolved, { ...headers, "Content-Length": stat.size }, 200);
      }
      const [start, end] = range;
      return sendFile(req, res, resolved, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      }, 206, { start, end });
    });
    });
  });
  server.maxConnections = 48;
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.timeout = 30000;
  server.on("connection", socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => {
          server.close(done);
          for (const socket of connections) socket.destroy();
        }),
      });
    });
  });
}

// parseRange / resolveSafe 也导出：它们是有单测的纯函数（tools/test_range.py
// 会把这里和 Python / PHP 两份实现放进同一张用例表里对比），require 本文件
// 不会起服务（serve 得由调用方主动调）。
module.exports = { serve, parseRange, resolveSafe };
