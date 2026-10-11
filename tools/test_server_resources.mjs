import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const {serve}=createRequire(import.meta.url)('../electron/site-server.js');
test('static server rejects symlink escape, cancels streams and closes idle sockets',{timeout:10000},async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'jubeat-server-')),root=path.join(tmp,'site');fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'index.html'),'ok');fs.writeFileSync(path.join(tmp,'secret'),'private');fs.symlinkSync(path.join(tmp,'secret'),path.join(root,'outside'));
 const large=path.join(root,'large.bin');fs.closeSync(fs.openSync(large,'w'));fs.truncateSync(large,64*1024*1024);
 const server=await serve(root);const original=fs.createReadStream;let stream;
 try{
  assert.equal((await fetch(server.url+'outside')).status,403);
  fs.createReadStream=(...args)=>{const s=original(...args);if(args[0]===fs.realpathSync(large))stream=s;return s;};
  await new Promise((resolve,reject)=>{const req=http.get(server.url+'large.bin',res=>res.once('data',()=>{res.destroy();resolve();}));req.on('error',reject);});
  if(!stream.closed)await new Promise(resolve=>stream.once('close',resolve));assert.equal(stream.destroyed,true);
  const socket=net.connect(Number(new URL(server.url).port),'127.0.0.1');await once(socket,'connect');let socketError;socket.on('error',e=>{socketError=e;});const closed=new Promise(resolve=>socket.once('close',resolve));
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');await server.close();await closed;assert.equal(socket.destroyed,true);assert([undefined,'ECONNRESET'].includes(socketError?.code));
 }finally{fs.createReadStream=original;await server.close();fs.rmSync(tmp,{recursive:true,force:true});}
});


test('a cancelled request cannot open a file after delayed stat completes', {timeout:10000}, async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'jubeat-cancel-before-send-'));
 const target=path.join(fs.realpathSync(tmp),'index.html');fs.writeFileSync(target,'cancelled response');
 const originalStat=fs.stat,originalRead=fs.createReadStream;let release,opened=0;
 const statPending=new Promise(resolve=>{
  fs.stat=(file,...args)=>{
   const callback=args.pop();
   return originalStat(file,...args,(error,value)=>{
    if(file===target){release=()=>callback(error,value);resolve();}
    else callback(error,value);
   });
  };
 });
 fs.createReadStream=(...args)=>{opened++;return originalRead(...args);};
 const server=await serve(tmp);let req;
 try{
  req=http.get(server.url);req.on('error',()=>{});
  await statPending;req.destroy();await server.close();
  assert.doesNotThrow(()=>release());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opened,0,'do not open files for a response that has already closed');
 }finally{
  req?.destroy();fs.stat=originalStat;fs.createReadStream=originalRead;
  await server.close();fs.rmSync(tmp,{recursive:true,force:true});
 }
});
