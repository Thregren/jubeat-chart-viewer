package world.thregren.jubeatviewer;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;

/**
 * 把「曲库资源包」（zip）解到站点目录。
 *
 * 包内路径就是站点根开始的相对路径（{@code media/…}、{@code markers/…}、
 * {@code data/…}），所以同一个包既能在这里导入，也能用文件管理器直接解压到
 * {@code Android/media/<包名>/site} 下 —— 两条路结果一样。
 *
 * 条目的落盘路径要再校验一遍：手打 / 第三方工具打的 zip 里可能有 {@code ../}
 * 或者绝对路径，直接拼就是「解压炸弹 + 任意写文件」。
 */
public final class ResImporter {
    private ResImporter() {
    }

    public interface Progress {
        void onStep(long done, long total, String name);
    }


    /** 从 ContentResolver 问一下 zip 有多大，问不到返回 0（进度条就退化成不确定态）。 */
    public static long sizeOf(Context ctx, Uri uri) {
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(uri, new String[] {OpenableColumns.SIZE}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.SIZE);
                if (i >= 0 && !c.isNull(i)) return c.getLong(i);
            }
        } catch (Exception ignored) {
            // 问不到就问不到，进度条自己将就
        } finally {
            if (c != null) c.close();
        }
        return 0;
    }

    /** 解一个 zip 到 siteDir，返回解出的文件数。 */
    public static int extract(Context ctx, Uri uri, File siteDir, final Progress cb) throws IOException {
        InputStream raw = ctx.getContentResolver().openInputStream(uri);
        if (raw == null) throw new IOException("打不开这个文件：" + uri);
        return ArchiveImport.extract(raw, siteDir, new ArchiveImport.Progress() { public void update(long bytes, String name) {
            // ZIP length is compressed bytes; never compare it to decompressed progress.
            if (cb != null) cb.onStep(bytes, 0, name);
        }}, new ArchiveImport.Validator() { public void validate(File stage) throws IOException {
            ResourceCatalog.validate(stage);
        }});
    }

    /** zip 里的条目名 → 站点目录下的 File；越界返回 null。 */
    static File fileAt(File root, String entry) {
        try { return ArchiveImport.fileAt(root, entry); }
        catch (IOException e) { return null; }
    }
}
