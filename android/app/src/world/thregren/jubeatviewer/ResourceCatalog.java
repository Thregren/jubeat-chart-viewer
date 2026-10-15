package world.thregren.jubeatviewer;
import java.io.*;
import java.util.*;
import org.json.*;

/** Validate a complete directory resource ZIP before ArchiveImport commits it. */
public final class ResourceCatalog {
    private ResourceCatalog() {}
    private static JSONObject read(File root, String name) throws IOException, JSONException {
        File f=ArchiveImport.fileAt(root,name);
        if(!f.isFile()||f.length()>8L*1024*1024)throw new IOException("索引缺失或过大："+name);
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try(InputStream in=new FileInputStream(f)) {
            byte[] block=new byte[16384];int n;
            while((n=in.read(block))!=-1){if(bytes.size()+n>8*1024*1024)throw new IOException("索引过大");bytes.write(block,0,n);}
        }
        return new JSONObject(new String(bytes.toByteArray(),"UTF-8"));
    }
    public static void validate(File root) throws IOException {
        try {
            JSONObject main=read(root,"data/library.json");
            if(!"jubeat-directory-v1".equals(main.optString("format")))throw new IOException("请选择新版完整曲库 ZIP");
            ArrayList<JSONObject> catalogs=new ArrayList<JSONObject>();catalogs.add(main);
            JSONArray indexes=main.optJSONArray("versionIndexes");
            if(indexes==null||indexes.length()>256)throw new IOException("版本索引无效");
            for(int i=0;i<indexes.length();i++){
                String name=indexes.getString(i);
                if(!name.startsWith("data/versions/")||!name.endsWith(".json"))throw new IOException("版本索引路径无效");
                catalogs.add(read(root,name));
            }
            HashSet<String> ids=new HashSet<String>();
            for(JSONObject catalog:catalogs){
                if(!"jubeat-directory-v1".equals(catalog.optString("format")))throw new IOException("版本格式无效");
                JSONArray songs=catalog.getJSONArray("songs");
                for(int i=0;i<songs.length();i++){
                    JSONObject song=songs.getJSONObject(i);String id=song.getString("id");ArchiveImport.fileAt(root,id);
                    if(!ids.add(id)||ids.size()>50000)throw new IOException("曲目重复或过多");
                    JSONObject assets=song.getJSONObject("assets");Iterator<String> keys=assets.keys();
                    while(keys.hasNext()){
                        String name=assets.getString(keys.next());
                        if(!ArchiveImport.fileAt(root,name).isFile())throw new IOException("资源缺失："+name);
                    }
                    JSONArray charts=song.getJSONArray("charts");if(charts.length()>32)throw new IOException("谱面清单过大");
                    for(int n=0;n<charts.length();n++)if(!assets.has("chart:"+charts.getJSONObject(n).getString("code")))throw new IOException("缺少谱面资源");
                }
            }
            if(ids.isEmpty())throw new IOException("资源包没有歌曲");
        }catch(JSONException e){throw new IOException("曲库索引格式错误",e);}
    }
}
