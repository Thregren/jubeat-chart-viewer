package world.thregren.jubeatviewer;
import java.io.*;import java.net.*;import java.nio.file.*;
public final class LocalServerTest {
 static String request(URL url, String headers) throws Exception {
  try(Socket client=new Socket("127.0.0.1",url.getPort())) {
   client.setSoTimeout(3000);client.getOutputStream().write(("GET / HTTP/1.1\r\n"+headers+"\r\n").getBytes("UTF-8"));
   BufferedReader reader=new BufferedReader(new InputStreamReader(client.getInputStream(),"UTF-8"));return reader.readLine();
  }
 }
 public static void main(String[] args) throws Exception {
  Path root=Files.createTempDirectory("jubeat-local-server-");Files.write(root.resolve("index.html"),"ok".getBytes("UTF-8"));
  LocalServer server=new LocalServer(root.toFile());
  try{
   for(int i=0;i<3;i++){
    URL url=new URL(server.start());
    String host="Host: 127.0.0.1:"+url.getPort()+"\r\n";
    if(!request(url,host).contains("200"))throw new AssertionError("valid host");
    if(!request(url,"Host: untrusted.example:"+url.getPort()+"\r\n").contains("403"))throw new AssertionError("foreign host");
    if(!request(url,host+"Origin: http://untrusted.example\r\n").contains("403"))throw new AssertionError("foreign origin");
    if(!request(url,host+"Origin: http://127.0.0.1:"+url.getPort()+"\r\n").contains("200"))throw new AssertionError("same origin");
    if(!request(url,host+host).contains("400"))throw new AssertionError("duplicate host");
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
