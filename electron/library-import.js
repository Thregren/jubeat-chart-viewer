'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { crc32 } = require('node:zlib');
const yauzl = require('yauzl');
const MAX_TOTAL=8*1024**3, MAX_FILE=128*1024**2, MAX_FILES=100000;
const TOPS=new Set(['data','media','songs','markers']);
function safeName(name) {
  if(typeof name!=='string'||!name||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('曲库资源路径无效');
  return name;
}
function location(root,name) {
  safeName(name);const dest=path.resolve(root,...name.split('/'));
  if(!dest.startsWith(path.resolve(root)+path.sep))throw Error('曲库资源越界');
  return dest;
}
async function json(root,name) {
  const file=location(root,name),st=await fsp.lstat(file);
  if(!st.isFile()||st.size>8*1024**2)throw Error('曲库索引无效或过大');
  return JSON.parse(await fsp.readFile(file,'utf8'));
}
async function validate(root) {
  root=await fsp.realpath(root);
  const main=await json(root,'data/library.json');
  if(main.format!=='jubeat-directory-v1'||!Array.isArray(main.songs)||!Array.isArray(main.versionIndexes)||main.versionIndexes.length>256)throw Error('请选择新版目录曲库资源包');
  const catalogs=[main];
  for(const name of main.versionIndexes){if(!name.startsWith('data/versions/')||!name.endsWith('.json'))throw Error('版本索引无效');catalogs.push(await json(root,name));}
  const seen=new Set();let charts=0;
  for(const catalog of catalogs){
    if(catalog.format!=='jubeat-directory-v1'||!Array.isArray(catalog.songs))throw Error('版本曲库无效');
    for(const song of catalog.songs){
      if(!song||typeof song.id!=='string'||seen.has(song.id)||!Array.isArray(song.charts)||song.charts.length>32||!song.assets||typeof song.assets!=='object')throw Error('曲目清单无效');
      safeName(song.id);seen.add(song.id);
      if(seen.size>50000)throw Error('曲目过多');
      for(const name of Object.values(song.assets)){
        const dest=location(root,name),actual=await fsp.realpath(dest);
        if(!actual.startsWith(path.resolve(root)+path.sep)||!(await fsp.stat(actual)).isFile())throw Error('曲库资源缺失或越界：'+name);
      }
      for(const c of song.charts){if(!c||!song.assets['chart:'+c.code])throw Error('缺少谱面资源');charts++;}
    }
  }
  if(!seen.size)throw Error('资源包没有可用歌曲');
  return {songs:seen.size,charts};
}
function extract(archive,root,onProgress=()=>{}) {
  return new Promise((resolve,reject)=>{
    yauzl.open(archive,{lazyEntries:true,strictFileNames:true},(error,zip)=>{
      if(error)return reject(error);
      let bytes=0,files=0,entries=0,failed=false;const names=new Set();
      const fail=e=>{if(failed)return;failed=true;zip.close();reject(e);};
      zip.on('error',fail);zip.on('end',()=>resolve({bytes,files}));
      zip.on('entry',entry=>{(async()=>{
        if(++entries>MAX_FILES)throw Error('曲库文件过多');
        const directory=entry.fileName.endsWith('/'),name=directory?entry.fileName.slice(0,-1):entry.fileName;
        safeName(name);
        if(!TOPS.has(name.split('/')[0])||(!directory&&!/\.(json|ogg|png|jpe?g|webp|gif)$/i.test(name)))throw Error('资源包包含非曲库文件：'+name);
        if(((entry.externalFileAttributes>>>16)&0o170000)===0o120000)throw Error('资源包不能包含符号链接');
        if(directory){zip.readEntry();return;}
        if(names.has(name))throw Error('资源路径重复');names.add(name);
        if(entry.uncompressedSize>MAX_FILE||bytes+entry.uncompressedSize>MAX_TOTAL)throw Error('曲库大小超过限制');
        const dest=location(root,name);await fsp.mkdir(path.dirname(dest),{recursive:true});
        const input=await new Promise((res,rej)=>zip.openReadStream(entry,(e,s)=>e?rej(e):res(s)));
        let sum=0,size=0;
        const check=new Transform({transform(chunk,_encoding,callback){
          size+=chunk.length;bytes+=chunk.length;sum=crc32(chunk,sum);
          if(size>MAX_FILE||bytes>MAX_TOTAL)return callback(Error('解压大小超过限制'));
          callback(null,chunk);
        }});
        await pipeline(input,check,fs.createWriteStream(dest,{flags:'wx'}));
        if(size!==entry.uncompressedSize||(sum>>>0)!==(entry.crc32>>>0))throw Error('资源 CRC 校验失败：'+name);
        files++;if(files%100===0)onProgress({bytes,files,name});zip.readEntry();
      })().catch(fail);});
      zip.readEntry();
    });
  });
}
async function recover(target) {
  target=path.resolve(target);
  const parent=path.dirname(target),journal=target+'.import.json';
  if(!fs.existsSync(journal))return;
  const j=JSON.parse(await fsp.readFile(journal,'utf8'));
  // Validate every path before any removal; a prefix check also accepts ../ escapes.
  const name=typeof j?.stage==='string'?path.basename(j.stage):'';
  if(!j||Array.isArray(j)||j.backup!==target+'.previous'||!['prepared','committed'].includes(j.status)
    ||typeof j.stage!=='string'||path.dirname(j.stage)!==parent||path.resolve(j.stage)!==j.stage
    ||name.length!==22||!/^\.library-import-[A-Za-z0-9]{6}$/.test(name))throw Error('导入恢复记录无效');
  if(j.status!=='committed'&&fs.existsSync(j.backup)){
    await fsp.rm(target,{recursive:true,force:true});await fsp.rename(j.backup,target);
  }
  await fsp.rm(j.stage,{recursive:true,force:true});await fsp.rm(j.backup,{recursive:true,force:true});await fsp.rm(journal,{force:true});
}
async function install(archive,target,{beforeCommit=async()=>{},progress=()=>{}}={}) {
  target=path.resolve(target);
  await fsp.mkdir(path.dirname(target),{recursive:true});await recover(target);
  const stage=await fsp.mkdtemp(path.join(path.dirname(target),'.library-import-'));
  const journal=target+'.import.json',backup=target+'.previous';
  try{
    await extract(archive,stage,progress);const result=await validate(stage);
    await beforeCommit();
    const record={stage,backup,status:'prepared'};await fsp.writeFile(journal,JSON.stringify(record));
    if(fs.existsSync(target))await fsp.rename(target,backup);
    await fsp.rename(stage,target);record.status='committed';await fsp.writeFile(journal,JSON.stringify(record));
    await recover(target);return result;
  }catch(error){await recover(target);await fsp.rm(stage,{recursive:true,force:true});throw error;}
}
module.exports={safeName,validate,extract,install,recover};
