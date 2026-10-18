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
 const A={},source=fs.readFileSync(new URL('../铺面查看器/player/static/app-wiring.js',import.meta.url),'utf8');
 vm.runInNewContext(source,{window:{JubeatApp:A},URLSearchParams,location:{search},document:{querySelector:()=>shared?{content:shared}:null}});
 return A.urlState();
}
test('share pages always open their card song at the beginning without autoplay',()=>{
 const value=parse('?song=other&chart=ADV&t=99&play=1','音乐魔方/song');
 assert.equal(value.song,'音乐魔方/song');assert.equal(value.chart,'ADV');assert.equal(value.t,null);assert.equal(value.play,false);assert.equal(value.paused,true);
});
test('existing root deep links retain recording/automation time compatibility',()=>{
 const value=parse('?song=legacy&chart=EXT&t=45.25&play=1');assert.equal(value.song,'legacy');assert.equal(value.t,45.25);assert.equal(value.play,true);
});
