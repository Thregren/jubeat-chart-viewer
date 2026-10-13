import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createRequire} from 'node:module';
const {serve}=createRequire(import.meta.url)('../electron/site-server.js');
test('desktop host/origin/method checks preserve media HEAD and range',{timeout:10000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-http-'));fs.writeFileSync(path.join(dir,'index.html'),'fixture');const server=await serve(dir),u=new URL(server.url);
 const request=(method='GET',headers={})=>new Promise((resolve,reject)=>{http.request(server.url,{method,headers},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({code:res.statusCode,headers:res.headers,body}));}).on('error',reject).end();});
 try{
  assert.equal((await request()).body,'fixture');assert.equal((await request('HEAD')).body,'');
  assert.equal((await request('GET',{Range:'bytes=1-2'})).body,'ix');
  assert.equal((await request('GET',{Host:'untrusted.example:'+u.port})).code,403);
  assert.equal((await request('GET',{Origin:'http://untrusted.example'})).code,403);
  assert.equal((await request('GET',{Origin:u.origin})).code,200);
  assert.equal((await request('GET',{Host:'127.0.0.1:1'})).code,403);
  assert.equal((await request('POST')).code,405);
 }finally{await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
