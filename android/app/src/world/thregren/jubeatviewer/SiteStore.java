package world.thregren.jubeatviewer;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * 站点文件放哪：{@code /storage/emulated/0/Android/media/<包名>/site}。
 *
 * 选这里是因为：① 插上 USB 在电脑上直接看得到、能拷能删；② Android 10 及以上
 * 往这个目录写不需要任何权限；③ 卸载 App 时系统会一并清掉，不留垃圾。
 *
 * 老系统（Android 6~9）这个位置可能还要 WRITE_EXTERNAL_STORAGE，所以先写一个
 * 探针文件试一下，写不动就退回 App 私有目录，至少保证能跑。
 */
public final class SiteStore {
    private SiteStore() {
    }

    public static final String DIR = "site";

    /** 曲库落在哪：优先外部媒体目录，写不动退回私有目录。 */
    public static File siteDir(Context ctx) {
        File base = writableBase(ctx);
        File d = new File(base, DIR);
        if (d.isDirectory() || d.mkdirs()) return d;
        File fallback = new File(ctx.getFilesDir(), DIR);
        fallback.mkdirs();
        return fallback;
    }

    /** 外部媒体目录（能写才给），否则给私有目录。 */
    public static File writableBase(Context ctx) {
        File ext = externalBase(ctx);
        if (ext != null && canWrite(ext)) return ext;
        return new File(ctx.getFilesDir(), "media");
    }

    /** Android/media/<包名>（拿不到返回 null）。 */
    public static File externalBase(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return null;
        try {
            File[] dirs = ctx.getExternalMediaDirs();
            if (dirs != null && dirs.length > 0 && dirs[0] != null) return dirs[0];
        } catch (Throwable ignored) {
            // 外置存储没挂载之类，直接放弃
        }
        return null;
    }

    /** 真的写一个探针文件，比只看 canWrite() 靠谱。 */
    public static boolean canWrite(File dir) {
        if (dir == null) return false;
        if (!dir.isDirectory() && !dir.mkdirs()) return false;
        File probe = new File(dir, ".write-probe");
        try {
            FileOutputStream os = new FileOutputStream(probe);
            try {
                os.write('x');
            } finally {
                os.close();
            }
            probe.delete();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** 曲库齐了没有：前端文件 + data/library.json 都在才算。 */
    public static boolean ready(File dir) {
        return new File(dir, "index.html").isFile() && new File(dir, "data/library.json").isFile();
    }

    public static long sizeOf(File dir) {
        if (dir == null || !dir.isDirectory()) return 0;
        File[] kids = dir.listFiles();
        if (kids == null) return 0;
        long n = 0;
        for (File f : kids) n += f.isDirectory() ? sizeOf(f) : f.length();
        return n;
    }

    public static String human(long n) {
        if (n < 1024) return n + " B";
        double v = n / 1024.0;
        String[] units = {"KB", "MB", "GB", "TB"};
        for (int i = 0; i < units.length; i++) {
            if (v < 1024 || i == units.length - 1) return String.format(java.util.Locale.US, "%.1f %s", v, units[i]);
            v /= 1024;
        }
        return n + " B";
    }
}
