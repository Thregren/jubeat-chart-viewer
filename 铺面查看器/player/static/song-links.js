/* Song-only share URLs. Never carry playback, recording or tuning parameters. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.JubeatSongLinks=factory();
})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  function songKey(id){
    let hash=0xcbf29ce484222325n;
    for(const byte of new TextEncoder().encode(id))hash=BigInt.asUintN(64,(hash^BigInt(byte))*0x100000001b3n);
    return hash.toString(16).padStart(16,'0');
  }
  function build(id,code,base){
    if(typeof id!=='string'||!id||id.length>4096)throw new Error('曲目标识无效');
    let url=new URL(base);
    const local=/^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname);
    if(!/^https?:$/.test(url.protocol)||local)url=new URL('https://ub.thregren.world/');
    url.username='';url.password='';url.hash='';url.search='';
    url.pathname=url.pathname.replace(/[^/]*$/,'')+'share/'+songKey(id)+'.html';
    url.searchParams.set('song',id);
    if(typeof code==='string'&&/^[A-Za-z0-9_-]{1,8}$/.test(code))url.searchParams.set('chart',code);
    return url.href;
  }
  function install(A){
    const button=A.els.btnShare;button.hidden=!!window.__recActive;
    let dialog=null;
    function manual(url){
      if(!dialog){
        dialog=document.createElement('dialog');dialog.className='share-dialog';
        const title=document.createElement('h3');title.textContent='分享歌曲';
        const text=document.createElement('p');text.textContent='长按或选中链接即可复制，打开后从头开始。';
        const input=document.createElement('textarea');input.readOnly=true;input.rows=4;input.setAttribute('aria-label','歌曲分享链接');
        const close=document.createElement('button');close.type='button';close.textContent='关闭';close.addEventListener('click',()=>{if(dialog.close)dialog.close();else dialog.removeAttribute('open');});
        dialog.append(title,text,input,close);document.body.append(dialog);
      }
      dialog.querySelector('textarea').value=url;if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');dialog.querySelector('textarea').select();
    }
    async function share(){
      const song=A.state.song;if(!song?.id)return;
      const url=build(song.id,button.dataset.chart||null,document.baseURI);
      if(navigator.share){
        try{await navigator.share({title:song.title+' · 谱面确认',text:song.artist||'查看歌曲谱面',url});return;}
        catch(error){if(error.name==='AbortError')return;}
      }
      try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(url);A.toast('歌曲分享链接已复制，打开后从头开始');}
      catch(_){manual(url);}
    }
    button.addEventListener('click',share);A.shareSong=share;
  }
  return {songKey,build,install};
});
