package world.thregren.jubeatviewer;
import java.io.*;import java.net.*;import java.nio.file.*;
public final class LocalServerTest {
 static String response(URL url, String path, String headers) throws Exception {
  try(Socket client=new Socket("127.0.0.1",url.getPort())) {
   client.setSoTimeout(3000);client.getOutputStream().write(("GET "+path+" HTTP/1.1\r\n"+headers+"\r\n").getBytes("UTF-8"));
   InputStream input=client.getInputStream();ByteArrayOutputStream head=new ByteArrayOutputStream();int state=0,b;
   while((b=input.read())!=-1) {
    head.write(b);
    if(b=='\r')state=state==2?3:1;
    else if(b=='\n'&&state==1)state=2;
    else if(b=='\n'&&state==3)break;
    else state=0;
   }
   return new String(head.toByteArray(),"UTF-8");
  }
 }
 static String request(URL url, String headers) throws Exception {
  return response(url,"/",headers).split("\r\n",2)[0];
 }
 public static void main(String[] args) throws Exception {
  Path root=Files.createTempDirectory("jubeat-local-server-");Files.write(root.resolve("index.html"),"ok".getBytes("UTF-8"));
  Path markdown=root.resolve("data/background/story.md");Files.createDirectories(markdown.getParent());Files.write(markdown,"# story".getBytes("UTF-8"));
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
    String markdownResponse=response(url,"/data/background/story.md",host).toLowerCase(java.util.Locale.ROOT);
    if(!markdownResponse.contains("200 ok")||!markdownResponse.contains("content-type: text/markdown; charset=utf-8"))throw new AssertionError("markdown MIME");
    HttpURLConnection connection=(HttpURLConnection)url.openConnection();
    try(InputStream body=connection.getInputStream()){if(body.read()!='o')throw new AssertionError();}finally{connection.disconnect();}
    try(Socket idle=new Socket("127.0.0.1",url.getPort())){
     idle.setSoTimeout(2000);idle.getOutputStream().write("GET / HTTP/1.1\r\n".getBytes("UTF-8"));server.stop();
     try { if(idle.getInputStream().read()!=-1)throw new AssertionError("idle client not closed"); } catch(SocketException reset) { /* TCP reset also confirms closure. */ }
    }
   }
  }finally{
   server.stop();
   try(java.util.stream.Stream<Path> paths=Files.walk(root)){
    paths.sorted(java.util.Comparator.reverseOrder()).forEach(path->{try{Files.delete(path);}catch(IOException e){throw new RuntimeException(e);}});
   }
  }
  System.out.println("LocalServer markdown MIME, shutdown and repeated start passed");
 }
}
