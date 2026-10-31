import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire}from'node:module';
const Links=createRequire(import.meta.url)('../铺面查看器/player/static/song-links.js');

test('song share URLs carry only song and difficulty, including unicode and punctuation',()=>{
 const id='音乐魔方/A&B #?/" <歌>',url=new URL(Links.build(id,'ADV','https://viewer.example/sub/index.html?t=72&play=1&rec=1#abc'));
 assert.equal(url.origin,'https://viewer.example');assert.equal(url.pathname,'/sub/share/'+Links.songKey(id)+'.html');
 assert.deepEqual([...url.searchParams], [['song',id],['chart','ADV']]);assert.equal(url.hash,'');
 assert.equal(Links.songKey(id),Links.songKey(id));assert.notEqual(Links.songKey('a'),Links.songKey('b'));
});
test('local desktop, android and file links share the public site, never a local port',()=>{
 for(const base of ['http://127.0.0.1:8124/','http://localhost:2233/','http://[::1]:321/','file:///home/viewer/index.html'])assert.equal(new URL(Links.build('v/song','EXT',base)).origin,'https://ub.thregren.world');
 assert.equal(new URL(Links.build('v/song','<invalid>','https://example.com/')).searchParams.has('chart'),false);
 assert.throws(()=>Links.build('','EXT','https://example.com/'));
});
function parse(search,shared){
 const A={services:{register(){}}},source=fs.readFileSync(new URL('../铺面查看器/player/static/app-wiring.js',import.meta.url),'utf8');
 vm.runInNewContext(source,{window:{JubeatApp:A,JubeatRuntime:{RequestScope:class{}}},URLSearchParams,location:{search},document:{querySelector:()=>shared?{content:shared}:null}});
 return A.urlState();
}
test('direct shared viewer ignores progress/autoplay and uses the page song',()=>{
 const value=parse('?song=wrong&chart=ADV&t=90&play=1','音乐魔方/song');
 assert.equal(value.song,'音乐魔方/song');assert.equal(value.chart,'ADV');assert.equal(value.t,null);assert.equal(value.play,false);assert.equal(value.paused,true);
});
test('existing root deep links retain recording/automation time compatibility',()=>{
 const value=parse('?song=legacy&chart=EXT&t=45.25&play=1');assert.equal(value.song,'legacy');assert.equal(value.t,45.25);assert.equal(value.play,true);
});

test('shared pages resolve all data/media assets from the configured same-origin site root',()=>{
 const full=fs.readFileSync(new URL('../铺面查看器/player/static/app-base.js',import.meta.url),'utf8');
 const code=full.slice(full.indexOf('  let shareBase ='),full.indexOf('  /**\n   * 同押光晕'));
 function resources(root,{canPlay=()=>'',userAgent='' }={}){return vm.runInNewContext(code+';({shareBase,resourcePath,PATHS,mediaCompatibility,mediaUrl,chartPath,audioUrl,coverUrl,thumbUrl})',{URL,navigator:{userAgent},location:{href:'https://example.com/view/share/key.html',origin:'https://example.com'},document:{baseURI:'https://example.com/view/share/key.html',querySelector:()=>root?{content:root}:null,createElement:()=>({canPlayType:canPlay})}});}
 const A=resources('https://example.com/view/'),song={assets:{audio:'songs/a.wav',cover:'songs/a.png',thumb:'songs/a.jpg','chart:EXT':'songs/a.json'}};
 assert.equal(A.PATHS.library,'/view/data/library.json');assert.equal(A.audioUrl(song),'/view/songs/a.wav');assert.equal(A.chartPath(song,{code:'EXT'}),'/view/songs/a.json');assert.equal(A.coverUrl(song),'/view/songs/a.png');assert.equal(A.thumbUrl(song),'/view/songs/a.jpg');assert.equal(A.resourcePath('media/se/clap.ogg'),'/view/media/se/clap.ogg');
 assert.equal(resources('https://evil.example/').PATHS.library,'data/library.json');assert.equal(resources(null).audioUrl(song),'songs/a.wav');
});
test('iOS 15 switches Ogg Opus media to native CAF',()=>{
 const full=fs.readFileSync(new URL('../铺面查看器/player/static/app-base.js',import.meta.url),'utf8');
 const code=full.slice(full.indexOf('  let shareBase ='),full.indexOf('  /**\n   * 同押光晕'));
 function resources(canPlay,userAgent=''){
  return vm.runInNewContext(code+';({mediaCompatibility,mediaUrl,audioUrl})',{URL,navigator:{userAgent},location:{href:'https://example.com/view/index.html',origin:'https://example.com'},document:{baseURI:'https://example.com/view/index.html',querySelector:()=>null,createElement:()=>({canPlayType:canPlay})}});
 }
 const canPlay=type=>type.includes('webm')?'probably':'';
 const ios=resources(canPlay,'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15');
 assert.deepEqual({...ios.mediaCompatibility},{oggOpus:false,webmOpus:true,legacyIOS:true,nativeFallback:true,nativeExtension:'.caf'});
 assert.equal(ios.mediaUrl('songs/a.ogg'),'songs/a.caf');
 assert.equal(ios.audioUrl({id:'v/song.mcz'}),'media/audio/v/song.caf');
 assert.equal(ios.audioUrl({assets:{audio:'songs/custom.ogg'}}),'songs/custom.caf');
 assert.equal(ios.audioUrl({assets:{audio:'songs/source.wav'}}),'songs/source.wav');
 const modern=resources(type=>type.includes('ogg')||type.includes('webm')?'probably':'','Mozilla/5.0');
 assert.equal(modern.mediaUrl('songs/a.ogg'),'songs/a.ogg');
});
