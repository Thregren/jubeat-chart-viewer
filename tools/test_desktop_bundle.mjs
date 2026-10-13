import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('desktop architectures share canonical resources and retain preload files',{timeout:20000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-bundle-fixture-'));const old=process.env.NO_SITE;delete process.env.NO_SITE;let config;
 try{
  for(const dir of ['electron','tools','site/static','site/data','site/media/audio/_hashed'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.copyFileSync(new URL('../electron/electron-builder.config.js',import.meta.url),path.join(root,'electron/electron-builder.config.js'));
  for(const name of ['package_site.py','site_transaction.py'])fs.copyFileSync(new URL('./'+name,import.meta.url),path.join(root,'tools',name));
  const hash='0123456789abcdef0123',audio='media/audio/_hashed/'+hash+'.ogg';
  fs.writeFileSync(path.join(root,'site/media/audio/song.ogg'),'audio');fs.linkSync(path.join(root,'site/media/audio/song.ogg'),path.join(root,'site',audio));
  fs.writeFileSync(path.join(root,'site/static/app.js'),'fixture');fs.linkSync(path.join(root,'site/static/app.js'),path.join(root,'site/static/app.js.'+hash+'.js'));
  const html='<script src="static/app.js.'+hash+'.js"></script>';
  fs.writeFileSync(path.join(root,'site/index.html'),html);fs.writeFileSync(path.join(root,'site/data/library.json'),JSON.stringify({songs:[{id:'song.mcz',assets:{audio}}]}));
  config=require(path.join(root,'electron/electron-builder.config.js'));
  assert(config.files.includes('preload.js'));assert(config.files.includes('preferences.js'));
  await Promise.all([config.beforePack({arch:'arm64'}),config.beforePack({arch:'x64'})]);
  const staged=config.extraResources.find(r=>r.to==='site').from;
  assert.equal(fs.readFileSync(path.join(staged,'index.html'),'utf8'),'<script src="static/app.js"></script>');
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged,'data/library.json'))).songs[0].assets.audio,'media/audio/song.ogg');
  assert(!fs.existsSync(path.join(staged,audio)));assert.equal(fs.readFileSync(path.join(root,'site/index.html'),'utf8'),html);
  await config.afterAllArtifactBuild();assert(!fs.existsSync(staged));
 }finally{await config?.afterAllArtifactBuild();if(old===undefined)delete process.env.NO_SITE;else process.env.NO_SITE=old;fs.rmSync(root,{recursive:true,force:true});}
});
