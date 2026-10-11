import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Random;

import world.thregren.jubeatviewer.LocalServer;

/**
 * 拿真 HTTP 请求打一遍 {@link LocalServer}（纯 Java，桌面 JVM 就能跑）。
 *
 * 安卓壳里最容易出问题的就是这一层：WebView 靠 Range 拖进度条、靠 Content-Type
 * 认音频、靠路径校验挡穿越。这里在 /tmp 临时铺一个假站点，用裸 socket 发请求，
 * 逐条比对状态码 / 响应头 / 字节内容。
 *
 *   java ServerSmoke
 */
public final class ServerSmoke {
    private static int failures = 0;
    private static int checks = 0;

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("jv-server-smoke");
        byte[] ogg = new byte[10000];
        new Random(42).nextBytes(ogg);
        byte[] html = "<!DOCTYPE html><html><body>hi</body></html>".getBytes(StandardCharsets.UTF_8);
        write(root.resolve("index.html"), html);
        write(root.resolve("static/app.js"), "console.log(1);\n".getBytes(StandardCharsets.UTF_8));
        write(root.resolve("data/library.json"), "{\"songs\":[]}".getBytes(StandardCharsets.UTF_8));
        write(root.resolve("media/audio/test.ogg"), ogg);
        write(root.resolve("media/audio/スペース 入り.ogg"), ogg);
        write(root.resolve("media/audio/plus+name.ogg"), ogg);

        LocalServer srv = new LocalServer(root.toFile());
        String url = srv.start();
        int port = Integer.parseInt(url.replaceAll(".*:(\\d+)/.*", "$1"));
        try {
            // 首页
            Resp r = get(port, "GET / HTTP/1.1", null);
            check("GET / → 200", r.status == 200);
            check("GET / 命中 index.html",
                    new String(r.body, StandardCharsets.UTF_8).startsWith("<!DOCTYPE html>"));
            check("GET / 是 text/html", r.header("content-type").startsWith("text/html"));
            check("带 ?v= 的查询串被忽略", get(port, "GET /index.html?v=0.6.19 HTTP/1.1", null).status == 200);
            check("有 Accept-Ranges", "bytes".equals(r.header("accept-ranges")));

            // 静态 js
            r = get(port, "GET /static/app.js HTTP/1.1", null);
            check("/static/app.js → 200", r.status == 200);
            check("js 是 text/javascript", r.header("content-type").startsWith("text/javascript"));
            check("js 是 no-cache", "no-cache".equals(r.header("cache-control")));

            // HEAD
            r = get(port, "HEAD /index.html HTTP/1.1", null);
            check("HEAD → 200", r.status == 200);
            check("HEAD 无正文", r.body.length == 0);
            check("HEAD 的 Content-Length = 真实文件长度",
                    Long.parseLong(r.header("content-length")) == html.length);

            // Range：正常区间
            r = get(port, "GET /media/audio/test.ogg HTTP/1.1", "Range: bytes=100-199");
            check("Range 100-199 → 206", r.status == 206);
            check("Range 100-199 的 Content-Range", ("bytes 100-199/10000").equals(r.header("content-range")));
            check("Range 100-199 长度 100", r.body.length == 100);
            check("Range 100-199 内容对得上", sliceEquals(r.body, ogg, 100));
            check("media 是 audio/ogg", "audio/ogg".equals(r.header("content-type")));
            check("media 可长缓存", r.header("cache-control").startsWith("public"));

            // Range：后缀语法
            r = get(port, "GET /media/audio/test.ogg HTTP/1.1", "Range: bytes=-100");
            check("Range -100 → 206", r.status == 206);
            check("Range -100 的 Content-Range", ("bytes 9900-9999/10000").equals(r.header("content-range")));
            check("Range -100 内容对得上", sliceEquals(r.body, ogg, 9900));

            // Range：尾端越界 → 夹到文件尾
            r = get(port, "GET /media/audio/test.ogg HTTP/1.1", "Range: bytes=9000-99999");
            check("Range 越界尾端被夹住", ("bytes 9000-9999/10000").equals(r.header("content-range")));

            // Range：非法值 → 整文件 200（和 Python / Node / PHP 三份实现口径一致）
            for (String bad : new String[] {"bytes=500", "bytes=10000-10001", "bytes=50-40",
                                            "bytes=0-99,200-299", "items=0-99", "bytes=0 - 99"}) {
                Resp br = get(port, "GET /media/audio/test.ogg HTTP/1.1", "Range: " + bad);
                check("非法 Range " + bad + " → 200 整文件", br.status == 200 && br.body.length == 10000);
            }

            // 百分号编码 + 非 ASCII 文件名
            r = get(port, "GET /media/audio/%E3%82%B9%E3%83%9A%E3%83%BC%E3%82%B9%20%E5%85%A5%E3%82%8A.ogg HTTP/1.1", null);
            check("UTF-8 文件名 + %20 → 200", r.status == 200 && r.body.length == 10000);
            r = get(port, "GET /media/audio/plus+name.ogg HTTP/1.1", null);
            check("路径里的 '+' 不当空格", r.status == 200);
            r = get(port, "GET /media/audio/plus%2Bname.ogg HTTP/1.1", null);
            check("%2B 解成 '+'", r.status == 200);

            // 路径穿越 + 其它
            for (String bad : new String[] {"/../etc/passwd", "/a/../../etc/passwd", "/static/../../evil/x"}) {
                check("穿越 " + bad + " → 403", get(port, "GET " + bad + " HTTP/1.1", null).status == 403);
            }
            check("不存在的文件 → 404", get(port, "GET /nope.png HTTP/1.1", null).status == 404);
            check("目录 → 404", get(port, "GET /static/ HTTP/1.1", null).status == 404);
            check("POST → 405", get(port, "POST /index.html HTTP/1.1", null).status == 405);
            check("坏百分号 → 400", get(port, "GET /a%zz HTTP/1.1", null).status == 400);
            check("截断的百分号 → 400", get(port, "GET /a%2 HTTP/1.1", null).status == 400);
            check("响应都带 nosniff", "nosniff".equals(r.header("x-content-type-options")));
            check("Connection: close", "close".equals(r.header("connection")));
        } finally {
            srv.stop();
            deleteTree(root);
        }

        System.out.println();
        if (failures == 0) {
            System.out.println("✓ 全部通过（" + checks + " 项）");
            return;
        }
        System.out.println("✗ 失败 " + failures + " / " + checks);
        System.exit(1);
    }

    // ---------------------------------------------------------------- 工具

    private static void check(String name, boolean ok) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("  ✗ " + name);
        } else {
            System.out.println("  ✓ " + name);
        }
    }

    private static boolean sliceEquals(byte[] got, byte[] whole, int start) {
        if (got.length == 0 || start + got.length > whole.length) return false;
        for (int i = 0; i < got.length; i++) {
            if (got[i] != whole[start + i]) return false;
        }
        return true;
    }

    private static void write(Path p, byte[] data) throws IOException {
        Files.createDirectories(p.getParent());
        Files.write(p, data);
        // Files.write 之后立刻 stat 能拿到长度，不用额外同步
        if (!Files.isReadable(p)) throw new IOException("写不进去：" + p);
    }

    private static void deleteTree(Path p) {
        try {
            Files.walk(p)
                 .sorted((a, b) -> b.getNameCount() - a.getNameCount())
                 .forEach(q -> { try { Files.deleteIfExists(q); } catch (IOException ignored) { } });
        } catch (IOException ignored) {
            // 临时目录清不掉不影响结论
        }
    }

    private static final class Resp {
        int status;
        String headers;
        byte[] body;

        String header(String name) {
            for (String line : headers.split("\r\n")) {
                int c = line.indexOf(':');
                if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase(name)) {
                    return line.substring(c + 1).trim();
                }
            }
            return "";
        }
    }

    private static Resp get(int port, String first, String extraHeader) throws IOException {
        StringBuilder req = new StringBuilder();
        req.append(first).append("\r\n");
        req.append("Host: 127.0.0.1:").append(port).append("\r\n");
        if (extraHeader != null) req.append(extraHeader).append("\r\n");
        req.append("\r\n");
        Socket s = new Socket("127.0.0.1", port);
        s.setSoTimeout(15000);
        try {
            OutputStream o = s.getOutputStream();
            o.write(req.toString().getBytes(StandardCharsets.ISO_8859_1));
            o.flush();
            InputStream in = s.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            byte[] all = buf.toByteArray();
            int split = indexOf(all, "\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
            Resp r = new Resp();
            String head = new String(all, 0, split < 0 ? all.length : split, StandardCharsets.ISO_8859_1);
            r.status = Integer.parseInt(head.split(" ")[1]);
            r.headers = head;
            int bodyAt = split < 0 ? all.length : split + 4;
            r.body = new byte[all.length - bodyAt];
            System.arraycopy(all, bodyAt, r.body, 0, r.body.length);
            return r;
        } finally {
            s.close();
        }
    }

    private static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hay.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    private ServerSmoke() {
    }
}
