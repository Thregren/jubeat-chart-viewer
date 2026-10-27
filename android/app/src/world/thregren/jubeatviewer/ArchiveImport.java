package world.thregren.jubeatviewer;

import java.io.*;
import java.nio.channels.FileLock;
import java.util.*;
import java.util.zip.*;

/** Bounded, cancellable import with a durable rollback journal. No Android dependencies. */
public final class ArchiveImport {
    public interface Progress { void update(long bytes, String name); }
    public interface Validator { void validate(File stage) throws IOException; }
    static final long MAX_TOTAL = 8L << 30, MAX_FILE = 128L << 20, RESERVE = 32L << 20;
    static final int MAX_FILES = 100000;
    private ArchiveImport() {}

    public static File fileAt(File root, String name) throws IOException {
        if (name == null || name.isEmpty() || name.startsWith("/") || name.indexOf('\\') >= 0
                || name.indexOf('\n') >= 0 || name.indexOf('\r') >= 0 || name.indexOf('\0') >= 0)
            throw new IOException("非法资源路径");
        for (String part : name.split("/", -1)) if (part.isEmpty() || part.equals("..") || part.equals("."))
            throw new IOException("资源路径越界");
        File f = new File(root, name);
        String base = root.getCanonicalPath() + File.separator;
        if (!f.getCanonicalPath().startsWith(base)) throw new IOException("资源路径越界");
        return f;
    }

    private static void mkdir(File f) throws IOException {
        if (!f.isDirectory() && !f.mkdirs()) throw new IOException("无法创建目录：" + f);
    }
    private static void move(File from, File to) throws IOException {
        mkdir(to.getParentFile());
        // The import lock serializes our writers; never overwrite an earlier backup.
        if (to.exists()) throw new IOException("提交目标已存在，保留恢复材料：" + to);
        if (!from.renameTo(to)) throw new IOException("无法提交文件：" + to);
    }
    private static void remove(File f) throws IOException {
        if (!f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children == null) throw new IOException("无法读取目录：" + f);
            for (File child : children) remove(child);
        }
        if (!f.delete()) throw new IOException("无法清理文件：" + f);
    }
    private static void cancelled() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("导入已取消");
    }
    private static List<String> journal(File work, List<Boolean> existed) throws IOException {
        List<String> names = new ArrayList<String>();
        File file = new File(work, "journal");
        if (!file.exists()) return names;
        try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
            int n = in.readInt();
            if (n < 0 || n > MAX_FILES) throw new IOException("导入恢复记录损坏");
            Set<String> unique = new HashSet<String>();
            for (int i = 0; i < n; i++) {
                String name = in.readUTF(); boolean wasPresent = in.readBoolean();
                // Validate the entire journal before restoring or removing any file.
                String identity = fileAt(new File(work, "backup"), name).getCanonicalPath();
                if (!unique.add(identity)) throw new IOException("导入恢复记录路径冲突，保留恢复材料");
                names.add(name); existed.add(wasPresent);
            }
            if (in.read() != -1) throw new IOException("导入恢复记录损坏");
        }
        return names;
    }
    static void recover(File root, File work) throws IOException {
        if (new File(work, "committed").exists()) { remove(work); return; }
        List<Boolean> existed = new ArrayList<Boolean>();
        List<String> names = journal(work, existed);
        Set<String> destinations = new HashSet<String>();
        for (String name : names) if (!destinations.add(fileAt(root, name).getCanonicalPath()))
            throw new IOException("导入恢复目标冲突，保留恢复材料");
        for (int i = names.size() - 1; i >= 0; i--) {
            File dest = fileAt(root, names.get(i)), old = fileAt(new File(work, "backup"), names.get(i));
            if (old.exists()) { remove(dest); move(old, dest); }
            else if (!existed.get(i)) remove(dest);
        }
        remove(work);
    }

    public static void recoverPending(File root) throws IOException {
        File work = new File(root.getParentFile(), "." + root.getName() + "-import");
        if (!work.exists()) return;
        File lockPath = new File(root.getParentFile(), "." + root.getName() + "-import.lock");
        try (RandomAccessFile file = new RandomAccessFile(lockPath, "rw")) {
            FileLock lock = file.getChannel().tryLock();
            if (lock == null) throw new IOException("导入仍在运行，请稍后重试");
            try { recover(root, work); } finally { lock.release(); }
        }
    }

    public static int extract(InputStream raw, File root, Progress progress) throws IOException {
        return extract(raw, root, progress, null);
    }

    public static int extract(InputStream raw, File root, Progress progress, Validator validator) throws IOException {
        mkdir(root);
        File work = new File(root.getParentFile(), "." + root.getName() + "-import");
        File lockPath = new File(root.getParentFile(), "." + root.getName() + "-import.lock");
        try (InputStream input = raw; RandomAccessFile lockFile = new RandomAccessFile(lockPath, "rw")) {
            FileLock lock = lockFile.getChannel().tryLock();
            if (lock == null) throw new IOException("另一个导入正在运行");
            try {
                if (work.exists()) recover(root, work);
                File stage = new File(work, "stage"); mkdir(stage);
                List<String> names = new ArrayList<String>(); Set<String> unique = new HashSet<String>();
                long total = 0, reportAt = 0; int entries = 0;
                byte[] buf = new byte[256 * 1024];
                try {
                    try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(input))) {
                        ZipEntry entry;
                        while ((entry = zip.getNextEntry()) != null) {
                            cancelled();
                            if (++entries > MAX_FILES) throw new IOException("资源文件过多");
                            String name = entry.getName();
                            if (entry.isDirectory() && name.endsWith("/")) name = name.substring(0, name.length() - 1);
                            File dest = fileAt(stage, name);
                            if (!(name.startsWith("data/") || name.startsWith("media/") || name.startsWith("songs/") || name.startsWith("markers/") || (entry.isDirectory() && (name.equals("data") || name.equals("media") || name.equals("songs") || name.equals("markers")))))
                                throw new IOException("资源包含非曲库文件：" + name);
                            if (entry.isDirectory()) continue;
                            // Resource imports cannot introduce HTML, JavaScript or other active files.
                            if (!name.toLowerCase(Locale.ROOT).matches(".*\\.(json|ogg|png|jpe?g|webp|gif)"))
                                throw new IOException("资源包含非曲库文件：" + name);
                            if (!unique.add(fileAt(root, name).getCanonicalPath())) throw new IOException("资源路径重复：" + name);
                            if (entry.getSize() > MAX_FILE) throw new IOException("单个资源过大");
                            mkdir(dest.getParentFile()); long size = 0;
                            try (OutputStream out = new BufferedOutputStream(new FileOutputStream(dest))) {
                                int n;
                                while ((n = zip.read(buf)) != -1) {
                                    cancelled(); size += n; total += n;
                                    if (size > MAX_FILE || total > MAX_TOTAL) throw new IOException("解压大小超出限制");
                                    if (root.getUsableSpace() < RESERVE + n) throw new IOException("存储空间不足");
                                    out.write(buf, 0, n);
                                    long now = System.currentTimeMillis();
                                    if (progress != null && now - reportAt >= 150) { reportAt = now; progress.update(total, name); }
                                }
                            }
                            zip.closeEntry(); // validates CRC before any existing file is changed
                            names.add(name);
                        }
                    }
                    if (names.isEmpty()) throw new IOException("资源包为空");
                    if (validator != null) validator.validate(stage);
                    // Entry points are committed last. Existing files stay in backup until completion.
                    Collections.sort(names, new Comparator<String>() { public int compare(String a, String b) {
                        int pa = a.equals("data/library.json") ? 1 : 0, pb = b.equals("data/library.json") ? 1 : 0;
                        return pa != pb ? pa - pb : a.compareTo(b);
                    }});
                    File pending = new File(work, "journal.tmp");
                    try (FileOutputStream file = new FileOutputStream(pending); DataOutputStream out = new DataOutputStream(file)) {
                        out.writeInt(names.size());
                        for (String name : names) {
                            File dest = fileAt(root, name);
                            if (dest.exists() && !dest.isFile()) throw new IOException("目标不是普通文件：" + name);
                            out.writeUTF(name); out.writeBoolean(dest.exists());
                        }
                        out.flush(); file.getFD().sync();
                    }
                    move(pending, new File(work, "journal"));
                    for (String name : names) {
                        cancelled(); File dest = fileAt(root, name);
                        if (dest.exists()) move(dest, fileAt(new File(work, "backup"), name));
                        move(fileAt(stage, name), dest);
                    }
                    try (FileOutputStream committed = new FileOutputStream(new File(work, "committed"))) {
                        committed.write(1); committed.getFD().sync();
                    }
                    remove(work);
                    if (progress != null) progress.update(total, "完成");
                    return names.size();
                } catch (IOException | RuntimeException failure) {
                    try { recover(root, work); } catch (IOException rollback) { failure.addSuppressed(rollback); }
                    throw failure;
                }
            } finally { lock.release(); }
        }
    }
}
