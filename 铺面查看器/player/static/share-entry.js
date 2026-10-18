/* Static preview pages keep crawlable metadata and load the current viewer shell. */
(async()=>{
  'use strict';
  const landing=document.body.cloneNode(true);
  try{
    const base=new URL(document.baseURI),response=await fetch(new URL('index.html',base),{cache:'no-cache'});
    if(!response.ok)throw new Error('查看器暂时无法加载');
    const html=await response.text();if(html.length>1048576)throw new Error('查看器页面过大');
    const shell=new DOMParser().parseFromString(html,'text/html');
    if(!shell.getElementById('app'))throw new Error('查看器页面格式无效');
    function asset(raw){const url=new URL(raw,base);if(url.origin!==location.origin||!url.pathname.startsWith(base.pathname+'static/'))throw new Error('查看器资源地址无效');return url.href;}
    const scripts=[...shell.querySelectorAll('script')].map(script=>{
      if(!script.getAttribute('src'))throw new Error('查看器包含不支持的脚本');
      return asset(script.getAttribute('src'));
    });
    shell.querySelectorAll('script').forEach(script=>script.remove());
    await Promise.all([...shell.head.querySelectorAll('link[href]')].map(link=>new Promise((resolve,reject)=>{
      const copy=document.createElement('link');for(const attr of link.attributes)copy.setAttribute(attr.name,attr.value);
      copy.href=asset(link.getAttribute('href'));
      if(copy.rel==='stylesheet'){copy.onload=resolve;copy.onerror=()=>reject(new Error('查看器样式加载失败'));}else resolve();
      document.head.append(copy);
    })));
    document.body.replaceWith(document.importNode(shell.body,true));
    for(const src of scripts)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(new Error('查看器脚本加载失败'));document.body.append(script);});
  }catch(error){
    document.body.replaceWith(landing);const status=document.querySelector('[data-share-status]');if(status)status.textContent='打开失败，请点击下方按钮重试。';
    console.warn('[jubeat share]',error.message);
  }
})();
