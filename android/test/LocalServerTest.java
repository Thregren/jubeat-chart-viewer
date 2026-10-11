package world.thregren.jubeatviewer;
import java.io.*;import java.net.*;import java.nio.file.*;
public final class LocalServerTest {
 public static void main(String[] args) throws Exception {
  Path root=Files.createTempDirectory("jubeat-local-server-");Files.write(root.resolve("index.html"),"ok".getBytes("UTF-8"));
  LocalServer server=new LocalServer(root.toFile());
  try{
   for(int i=0;i<3;i++){
    URL url=new URL(server.start());
    HttpURLConnection connection=(HttpURLConnection)url.openConnection();
    try(InputStream body=connection.getInputStream()){if(body.read()!='o')throw new AssertionError();}finally{connection.disconnect();}
    try(Socket idle=new Socket("127.0.0.1",url.getPort())){
     idle.setSoTimeout(2000);idle.getOutputStream().write("GET / HTTP/1.1\r\n".getBytes("UTF-8"));server.stop();
     try { if(idle.getInputStream().read()!=-1)throw new AssertionError("idle client not closed"); } catch(SocketException reset) { /* TCP reset also confirms closure. */ }
    }
   }
  }finally{server.stop();Files.delete(root.resolve("index.html"));Files.delete(root);}
  System.out.println("LocalServer shutdown and repeated start passed");
 }
}
