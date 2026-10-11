package world.thregren.jubeatviewer;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Range 解析 + 路径穿越防护 —— 和另外几份「发文件」的实现共用同一套语义。
 *
 * 同一个站点一共有四套后端会发文件，语义必须一模一样，否则同一首音频在不同部署下
 * 的 Seek 表现会不一样：
 *
 *   * Python 开发服务器  {@code 铺面查看器/player/media.py}      parse_range / safe_join
 *   * Electron 静态服务  {@code electron/site-server.js}          parseRange / resolveSafe
 *   * PHP 单文件入口     {@code deploy/php/index.php}             jubeat_parse_range
 *   * 安卓内置服务       本文件
 *
 * 这张用例表（{@code tools/test_range.py}）把它们钉在一起；安卓这份由
 * {@code android/test/HttpRangeTest.java} 在同一个脚本里跑。
 *
 * 特意不引任何 {@code android.*} —— 桌面 JVM 就能直接编译它跑测试台。
 */
public final class HttpRange {
    private HttpRange() {
    }

    /** Range 值的形状：恰好一个短横线，两侧要么是纯数字要么是空。 */
    private static final Pattern SPEC = Pattern.compile("(\\d*)-(\\d*)");

    /**
     * 解析单段 Range，返回闭区间 {start, end}；不支持 / 非法返回 null（调用方回整文件 200）。
     */
    public static long[] parseRange(String header, long size) {
        String h = header == null ? "" : header.trim();
        if (!h.startsWith("bytes=") || size <= 0) return null;
        Matcher m = SPEC.matcher(h.substring(6).trim());
        if (!m.matches()) return null;
        String startS = m.group(1);
        String endS = m.group(2);
        if (startS.isEmpty() && endS.isEmpty()) return null;
        long start;
        long end;
        if (startS.isEmpty()) {
            long n = num(endS);
            if (n <= 0) return null;
            start = Math.max(0, size - n);          // bytes=-N：最后 N 字节
            end = size - 1;
        } else {
            start = num(startS);
            end = endS.isEmpty() ? size - 1 : num(endS);
        }
        if (start < 0 || start >= size) return null;
        if (end > size - 1) end = size - 1;         // 尾端越界就夹到文件尾
        if (end < start) return null;
        return new long[] {start, end};
    }

    /**
     * 把 URL 里的路径安全地拼到 root 下。
     *
     * 返回「相对 root 的 posix 路径」（root 本身是 {@code "."}），越界返回 null。
     * 纯词法比较，不碰文件系统 —— 和 Node 那份 {@code path.resolve} 口径一致，
     * 所以 root 不存在也能测。
     */
    public static String resolveSafe(String root, String urlPath) {
        if (root == null || urlPath == null) return null;
        Path rootPath = Paths.get(root).toAbsolutePath().normalize();
        String rel = urlPath.replace('\\', '/');
        int i = 0;
        while (i < rel.length() && rel.charAt(i) == '/') i++;
        rel = rel.substring(i);
        Path target = rootPath.resolve(rel).normalize();
        if (target.equals(rootPath)) return ".";
        if (!target.startsWith(rootPath)) return null;
        return rootPath.relativize(target).toString().replace('\\', '/');
    }

    /**
     * 数字串 → long。前导零先去掉；大到 long 装不下时当成「比文件还大」处理
     * （Python 那份是任意精度整数，这里用 MAX_VALUE 取得同样的判定结果）。
     */
    private static long num(String digits) {
        int i = 0;
        while (i < digits.length() - 1 && digits.charAt(i) == '0') i++;
        try {
            return Long.parseLong(digits.substring(i));
        } catch (NumberFormatException e) {
            return Long.MAX_VALUE;
        }
    }
}
