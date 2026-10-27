package world.thregren.jubeatviewer;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
public final class ArchiveImportTest {
    static byte[] zip(String... names) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(bytes)) {
            for (String name : names) { z.putNextEntry(new ZipEntry(name)); z.write("new".getBytes("UTF-8")); z.closeEntry(); }
        }
        return bytes.toByteArray();
    }
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        Path temp = Files.createTempDirectory("jubeat-import-test-"); File root = temp.resolve("site").toFile();
        new File(root,"data").mkdirs(); Path old = new File(root,"data/library.json").toPath(); Files.write(old,"old".getBytes("UTF-8"));
        try { ArchiveImport.extract(new ByteArrayInputStream(zip("data/library.json","../escape")),root,null); throw new AssertionError(); }
        catch(IOException expected) { check(new String(Files.readAllBytes(old),"UTF-8").equals("old")); }
        try { ArchiveImport.extract(new ByteArrayInputStream(zip("static/app.js")),root,null); throw new AssertionError(); } catch(IOException expected) {}
        for (String active : new String[]{"songs/evil.js","songs/evil.html","markers/evil.svg","data/evil.php"}) {
            try { ArchiveImport.extract(new ByteArrayInputStream(zip("data/library.json",active)),root,null); throw new AssertionError("accepted active resource"); }
            catch(IOException expected) {
                check(new String(Files.readAllBytes(old),"UTF-8").equals("old"));
                check(!new File(root,active).exists());
            }
        }
        for (String[] paths : new String[][] {
            {"data/library.json", "data//library.json"}, {"data//library.json", "data/library.json"},
            {"data/library.json", "data///library.json"}, {"media/audio", "media//audio"},
            {"data/./library.json"}, {"data/library.json/"}
        }) {
            try { ArchiveImport.extract(new ByteArrayInputStream(zip(paths)),root,null); throw new AssertionError("accepted path alias"); }
            catch(IOException expected) { check(new String(Files.readAllBytes(old),"UTF-8").equals("old")); }
        }
        // A damaged old journal must be rejected before any restore/delete occurs.
        File badWork = temp.resolve(".site-import").toFile();
        File saved = new File(badWork,"backup/data/library.json"); saved.getParentFile().mkdirs();
        Files.write(saved.toPath(),"backup".getBytes("UTF-8"));
        try(DataOutputStream out=new DataOutputStream(new FileOutputStream(new File(badWork,"journal")))) {
            out.writeInt(2); out.writeUTF("data/library.json"); out.writeBoolean(true);
            out.writeUTF("data//library.json"); out.writeBoolean(true);
        }
        try { ArchiveImport.recoverPending(root); throw new AssertionError("accepted ambiguous journal"); }
        catch(IOException expected) {
            check(new String(Files.readAllBytes(old),"UTF-8").equals("old"));
            check(new String(Files.readAllBytes(saved.toPath()),"UTF-8").equals("backup"));
            check(new File(badWork,"journal").isFile());
        }
        Files.walk(badWork.toPath()).sorted(Comparator.reverseOrder()).forEach(p->{try{Files.delete(p);}catch(IOException e){throw new RuntimeException(e);}});
        // Even an unexpected earlier backup must never be overwritten by move().
        java.lang.reflect.Method move=ArchiveImport.class.getDeclaredMethod("move",File.class,File.class);move.setAccessible(true);
        File from=temp.resolve("from").toFile(),to=temp.resolve("backup").toFile();
        Files.write(from.toPath(),"replacement".getBytes("UTF-8"));Files.write(to.toPath(),"original backup".getBytes("UTF-8"));
        try { move.invoke(null,from,to); throw new AssertionError("clobbered backup"); }
        catch(java.lang.reflect.InvocationTargetException expected) {
            check(expected.getCause() instanceof IOException);
            check(new String(Files.readAllBytes(to.toPath()),"UTF-8").equals("original backup"));check(from.isFile());
        }
        Thread.currentThread().interrupt();
        try { ArchiveImport.extract(new ByteArrayInputStream(zip("data/library.json")),root,null); throw new AssertionError(); }
        catch(InterruptedIOException expected) { check(new String(Files.readAllBytes(old),"UTF-8").equals("old")); }
        finally { Thread.interrupted(); }
        byte[] corrupt = zip("data/library.json");
        for(int i=0;i<corrupt.length-4;i++) if(corrupt[i]==0x50 && corrupt[i+1]==0x4b && corrupt[i+2]==7 && corrupt[i+3]==8){corrupt[i+4]^=1;break;}
        try { ArchiveImport.extract(new ByteArrayInputStream(corrupt),root,null); throw new AssertionError(); }
        catch(IOException expected) { check(new String(Files.readAllBytes(old),"UTF-8").equals("old")); }
        ByteArrayOutputStream oversize=new ByteArrayOutputStream();
        try(ZipOutputStream z=new ZipOutputStream(oversize)){
            z.putNextEntry(new ZipEntry("media/huge.ogg"));byte[] block=new byte[1<<20];
            for(int i=0;i<129;i++)z.write(block);z.closeEntry();
        }
        try { ArchiveImport.extract(new ByteArrayInputStream(oversize.toByteArray()),root,null); throw new AssertionError(); }
        catch(IOException expected) { check(!new File(root,"media/huge.ogg").exists()); }
        check(ArchiveImport.extract(new ByteArrayInputStream(zip("data/library.json","media/a.ogg")),root,null)==2);
        check(new String(Files.readAllBytes(old),"UTF-8").equals("new"));
        File work = temp.resolve(".site-import").toFile(); File backup = new File(work,"backup/data/library.json"); backup.getParentFile().mkdirs();
        Files.write(backup.toPath(),"old".getBytes("UTF-8"));
        try(DataOutputStream out=new DataOutputStream(new FileOutputStream(new File(work,"journal")))) { out.writeInt(2); out.writeUTF("data/library.json");out.writeBoolean(true);out.writeUTF("media/a.ogg");out.writeBoolean(false); }
        ArchiveImport.recoverPending(root);
        check(new String(Files.readAllBytes(old),"UTF-8").equals("old")); check(!new File(root,"media/a.ogg").exists());
        Files.walk(temp).sorted(Comparator.reverseOrder()).forEach(p->{try{Files.delete(p);}catch(IOException e){throw new RuntimeException(e);}});
        System.out.println("Archive import: success, cancellation, CRC, size budget, invalid paths and crash rollback passed");
    }
}
