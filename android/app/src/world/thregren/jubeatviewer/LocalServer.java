package world.thregren.jubeatviewer;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.Collections;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 只服务 127.0.0.1 的极小静态服务。
 *
 * 为什么不用 file://：WebView 下 file:// 页面 fetch data/*.json 会被同源策略拦掉，
 * 音频也没法发 Range（拖动进度条、边播边取都会废）。所以起一个本地 http 源，
 * 口径和 Electron 桌面版那套 {@code electron/site-server.js} 保持一致。
 *
 * 每个响应都带 Connection: close —— 请求头只读、不做 keep-alive，少一堆状态。
 */
public final class LocalServer {
    private static final Map<String, String> MIME = new HashMap<String, String>();

    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "text/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("txt", "text/plain; charset=utf-8");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("ogg", "audio/ogg");
        MIME.put("oga", "audio/ogg");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("m4a", "audio/mp4");
        MIME.put("wav", "audio/wav");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
    }

    private static final int MAX_CONN = 48;          // 同时处理的连接上限（超了就关掉，别堆线程）
    private static final int IO_BUF = 64 * 1024;

    private final File root;
    private final AtomicInteger live = new AtomicInteger();
    private volatile ServerSocket socket;
    private final Set<Socket> connections = Collections.newSetFromMap(new ConcurrentHashMap<Socket, Boolean>());
    private Thread acceptor;
    private volatile boolean running;

    public LocalServer(File root) {
        this.root = root;
    }

    /** 起服务（随机端口，只听 127.0.0.1），返回给 WebView 用的首页地址。 */
    public synchronized String start() throws IOException {
        if (running) throw new IOException("Server already started");
        final ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 64);
        socket = ss;
        running = true;
        acceptor = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop(ss);
            }
        }, "jubeat-http");
        acceptor.setDaemon(true);
        acceptor.start();
        return "http://127.0.0.1:" + ss.getLocalPort() + "/";
    }

    public synchronized void stop() {
        running = false;
        ServerSocket ss = socket;
        socket = null;
        if (ss != null) {
            try {
                ss.close();
            } catch (IOException ignored) {
                // 关不掉就算了，进程退出时系统会收
            }
        }
        for (Socket conn : connections) closeQuietly(conn);
    }

    private void acceptLoop(ServerSocket listener) {
        while (running && socket == listener) {
            Socket s;
            try {
                s = listener.accept();
            } catch (IOException e) {
                return;                              // socket 被 stop() 关了
            }
            if (!running || socket != listener || live.get() >= MAX_CONN) {
                closeQuietly(s);
                continue;
            }
            live.incrementAndGet();
            connections.add(s);
            if (!running || socket != listener) { connections.remove(s); closeQuietly(s); live.decrementAndGet(); return; }
            final Socket conn = s;
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        handle(conn);
                    } catch (Throwable ignored) {
                        // 单个连接出错只影响这一个请求，不能掀掉服务
                    } finally {
                        connections.remove(conn);
                        closeQuietly(conn);
                        live.decrementAndGet();
                    }
                }
            }, "jubeat-http-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private static void closeQuietly(Socket s) {
        try {
            s.close();
        } catch (IOException ignored) {
            // ignore
        }
    }

    private void handle(Socket s) throws IOException {
        s.setSoTimeout(30000);
        InputStream in = s.getInputStream();
        OutputStream out = new BufferedOutputStream(s.getOutputStream(), 32 * 1024);
        String head = readHead(in);
        if (head == null) return;
        String[] lines = head.split("\r\n");
        String[] req = lines[0].split(" ");
        if (req.length < 2) {
            plain(out, 400, "Bad Request", "bad request");
            return;
        }
        String method = req[0];
        boolean headOnly = method.equals("HEAD");
        if (!headOnly && !method.equals("GET")) {
            Map<String, String> h = new LinkedHashMap<String, String>();
            h.put("Allow", "GET, HEAD");
            plainWith(out, 405, "Method Not Allowed", "method not allowed", h);
            return;
        }

        Map<String, String> headers = new LinkedHashMap<String, String>();
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT),
                        lines[i].substring(c + 1).trim());
        }

        String target = req[1];
        int cut = target.indexOf('?');
        if (cut >= 0) target = target.substring(0, cut);
        cut = target.indexOf('#');
        if (cut >= 0) target = target.substring(0, cut);
        String path = percentDecode(target);
        if (path == null) {
            plain(out, 400, "Bad Request", "bad request");
            return;
        }
        if (path.isEmpty() || path.equals("/")) path = "index.html";

        String rel = HttpRange.resolveSafe(root.getAbsolutePath(), path);
        if (rel == null) {
            plain(out, 403, "Forbidden", "forbidden");
            return;
        }
        File f = rel.equals(".") ? root : new File(root, rel);
        if (!f.isFile()) {
            plain(out, 404, "Not Found", "404");
            return;
        }
        sendFile(out, f, rel, headers.get("range"), headOnly);
    }

    /** 读到请求头结束（\r\n\r\n），超出上限或连不上就返回 null。 */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(1024);
        byte[] tail = new byte[4];
        int b;
        while ((b = in.read()) != -1) {
            buf.write(b);
            if (buf.size() > 65536) return null;
            tail[0] = tail[1];
            tail[1] = tail[2];
            tail[2] = tail[3];
            tail[3] = (byte) b;
            if (tail[0] == '\r' && tail[1] == '\n' && tail[2] == '\r' && tail[3] == '\n') {
                return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
            }
        }
        return null;
    }

    private void sendFile(OutputStream out, File f, String rel, String rangeHeader, boolean headOnly)
            throws IOException {
        long size = f.length();
        boolean media = rel.startsWith("media/");
        Map<String, String> h = new LinkedHashMap<String, String>();
        h.put("Content-Type", mime(rel));
        h.put("Accept-Ranges", "bytes");
        h.put("Cache-Control", media ? "public, max-age=604800" : "no-cache");
        h.put("X-Content-Type-Options", "nosniff");
        h.put("Referrer-Policy", "no-referrer");
        h.put("X-Frame-Options", "SAMEORIGIN");

        long[] rng = HttpRange.parseRange(rangeHeader, size);
        long start = 0;
        long end = size - 1;
        if (rng != null) {
            start = rng[0];
            end = rng[1];
            h.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        }
        long len = end - start + 1;
        h.put("Content-Length", Long.toString(len < 0 ? 0 : len));
        writeHead(out, rng != null ? 206 : 200, rng != null ? "Partial Content" : "OK", h);
        if (headOnly) {
            out.flush();
            return;
        }

        FileInputStream fin = new FileInputStream(f);
        try {
            long skip = start;
            while (skip > 0) {
                long n = fin.skip(skip);
                if (n <= 0) break;
                skip -= n;
            }
            byte[] buf = new byte[IO_BUF];
            long left = len;
            while (left > 0) {
                int got = fin.read(buf, 0, (int) Math.min(buf.length, left));
                if (got <= 0) break;
                out.write(buf, 0, got);
                left -= got;
            }
        } finally {
            fin.close();
        }
        out.flush();
    }

    private void plain(OutputStream out, int code, String reason, String body) throws IOException {
        plainWith(out, code, reason, body, null);
    }

    private void plainWith(OutputStream out, int code, String reason, String body,
                           Map<String, String> extra) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        Map<String, String> h = new LinkedHashMap<String, String>();
        if (extra != null) h.putAll(extra);
        h.put("Content-Type", "text/plain; charset=utf-8");
        h.put("Content-Length", Integer.toString(bytes.length));
        writeHead(out, code, reason, h);
        out.write(bytes);
        out.flush();
    }

    private static void writeHead(OutputStream out, int code, String reason, Map<String, String> headers)
            throws IOException {
        StringBuilder sb = new StringBuilder(256);
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
        for (Map.Entry<String, String> e : headers.entrySet()) {
            sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        }
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static String mime(String rel) {
        int dot = rel.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = rel.substring(dot + 1).toLowerCase(Locale.ROOT);
        String t = MIME.get(ext);
        return t == null ? "application/octet-stream" : t;
    }

    /**
     * 百分号解码。刻意不用 URLDecoder：它会把 '+' 解成空格，而路径里的 '+' 是字面量
     * （Node 那边的 decodeURIComponent 也不动 '+'）。解不出来（截断 / 非法十六进制 /
     * 混进 NUL）返回 null，让调用方回 400。
     */
    static String percentDecode(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%') {
                if (i + 2 >= s.length()) return null;
                int hi = hex(s.charAt(i + 1));
                int lo = hex(s.charAt(i + 2));
                if (hi < 0 || lo < 0) return null;
                int v = (hi << 4) | lo;
                if (v == 0) return null;             // NUL 不能出现在路径里
                out.write(v);
                i += 2;
            } else if (c < 0x80) {
                if (c == 0) return null;
                out.write(c);
            } else {
                byte[] bs = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(bs, 0, bs.length);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static int hex(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }
}
