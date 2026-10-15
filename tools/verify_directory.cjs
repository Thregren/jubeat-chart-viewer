#!/usr/bin/env node
/* 验证开放目录库：与实际网页共用谱面解析器，只读本地JSON和显式资源。 */
const fs=require('node:fs'),path=require('node:path');
const R=require('../铺面查看器/player/static/runtime.js');
const D=require('../铺面查看器/player/static/directory.js');
const Core=require('../铺面查看器/player/static/core.js');
async function verify(root,reportFile){
 root=fs.realpathSync(root);
 function file(name){
  if(!R.safePath(name))throw Error('Invalid relative path: '+name);
  const result=fs.realpathSync(path.join(root,name));
  if(!result.startsWith(root+path.sep))throw Error('Escaped library path: '+name);
  return result;
 }
 function json(name){const p=file(name);if(fs.statSync(p).size>8*1024*1024)throw Error('Oversized JSON: '+name);return JSON.parse(fs.readFileSync(p,'utf8'));}
 const main=json('data/library.json');
 if(main.format!=='jubeat-directory-v1')throw Error('Expected jubeat-directory-v1');
 const data=R.validateLibrary(await D.loadCatalog(main,async name=>{
  try{return json(name);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 },R.safePath));
 const errors=[],missing={};let charts=0,zero=0,holds=0,audio=0,previews=0,covers=0;
 for(const song of data.songs){
  for(const key of song.missing||[])missing[key]=(missing[key]||0)+1;
  audio+=!!song.assets.audio;previews+=!!song.assets.preview;covers+=!!song.assets.cover;
  for(const value of Object.values(song.assets)){
   try{if(!fs.statSync(file(value)).isFile())throw Error('Not a file');}
   catch(error){errors.push({id:song.id,asset:value,error:error.message});}
  }
  for(const info of song.charts){
   try{
    const parsed=Core.parseNotes(R.validateChart(json(song.assets['chart:'+info.code])));
    charts++;holds+=parsed.nHold;if(!parsed.nTotal)zero++;
    if(parsed.nTotal!==info.notes||parsed.nHold!==info.holds)
     errors.push({id:song.id,code:info.code,error:'Note/hold count mismatch',expected:[info.notes,info.holds],actual:[parsed.nTotal,parsed.nHold]});
    if(song.assets['exact:'+info.code]){
     const exact=json(song.assets['exact:'+info.code]);
     if(!Number.isFinite(exact.tick_hz)||exact.tick_hz<=0||!Array.isArray(exact.events))throw Error('Invalid exact-event schema');
    }
   }catch(error){errors.push({id:song.id,code:info.code,error:error.message});}
  }
 }
 const report={status:errors.length?'failed':'passed',songs:data.songs.length,versions:data.versions.length,
  installedVersionIndexes:data.installedVersions?.length||0,charts,holds,zeroNoteCharts:zero,
  resourceOnly:data.songs.filter(s=>s.resourceOnly).length,audio,previews,covers,missing,errors};
 if(reportFile){fs.mkdirSync(path.dirname(path.resolve(reportFile)),{recursive:true});fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));return report;
}
if(require.main===module){
 if(!process.argv[2]){console.error('Usage: node tools/verify_directory.cjs DIRECTORY [REPORT.json]');process.exitCode=2;}
 else verify(process.argv[2],process.argv[3]).then(r=>{if(r.errors.length)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=2;});
}
module.exports={verify};
