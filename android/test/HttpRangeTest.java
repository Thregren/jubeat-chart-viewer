import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

import world.thregren.jubeatviewer.HttpRange;

/**
 * 把 {@link HttpRange} 挂到 tools/test_range.py 那张用例表上。
 *
 * 只要标准库、不碰 Android，所以桌面 JVM 直接 javac + java 就能跑：
 *
 *   java HttpRangeTest            # stdin 每行 "size\theader" → stdout "start\tend" 或 "-"
 *   java HttpRangeTest safe <root>  # stdin 每行一个路径      → stdout 相对路径 或 "-"
 */
public final class HttpRangeTest {
    public static void main(String[] args) throws Exception {
        boolean safe = args.length > 0 && args[0].equals("safe");
        String root = args.length > 1 ? args[1] : null;
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        String line;
        while ((line = in.readLine()) != null) {
            if (safe) {
                String rel = HttpRange.resolveSafe(root, line);
                out.append(rel == null ? "-" : rel).append('\n');
                continue;
            }
            int tab = line.indexOf('\t');
            if (tab < 0) {
                out.append("-\n");
                continue;
            }
            long size = Long.parseLong(line.substring(0, tab).trim());
            String header = line.substring(tab + 1);
            long[] rng = HttpRange.parseRange(header, size);
            out.append(rng == null ? "-" : (rng[0] + "\t" + rng[1])).append('\n');
        }
        System.out.print(out);
    }
}
