/* Song background reader. All research text is rendered with DOM text nodes. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(root);
  else root.JubeatBackgroundStories=factory(root);
})(typeof window==='undefined'?globalThis:window,function(root){
  'use strict';

  let app=null;
  let button=null;
  let dialog=null;
  let dialogBody=null;
  let activeSong=null;
  let restoreFocusOnClose=false;
  let catalogRequest=null;
  let externalCatalog=null;
  const builtinRecords=new Map();
  const builtinRequests=new Map();
  let catalogFailed=false;

  const index = {records: Object.fromEntries(Object.entries(root.JUBEAT_BACKGROUND_STORY_FILES||{})
    .map(([id,file])=>[id,{id,file,documents:[true]}]))};

  function recordFor(song,catalog=root.JUBEAT_BACKGROUND_STORIES){
    catalog=catalog||root.JUBEAT_BACKGROUND_STORIES;
    const id=typeof song==='string'?song:song?.id;
    if(typeof id!=='string'||!id)return null;
    const direct=catalog?.records?.[id];
    const segment=id.slice(id.lastIndexOf('/')+1);
    let stableId=direct?id:catalog?.records?.[segment]?segment:null;
    if(!stableId){
      const arcade=id.match(/arcade[:_]([A-Za-z0-9_-]+)/);
      const plus=id.match(/16_jubeat_plus[:_]([A-Za-z0-9_-]+)/);
      const china=id.match(/jubeatchina[:_]([A-Za-z0-9_-]+)/);
      const video=id.match(/(?:^|\/)C(\d+)(?:\s|$)/);
      stableId=arcade?`arcade_${arcade[1]}`:plus?`16_jubeat_plus_${plus[1]}`:
        china?`jubeatchina_${china[1]}`:video?`C${video[1]}`:segment;
    }
    const record=catalog?.records?.[stableId];
    return record&&Array.isArray(record.documents)&&record.documents.length?record:null;
  }

  function element(tag,className,text){
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!=null)node.textContent=text;
    return node;
  }

  function ensureDialog(){
    if(dialog)return dialog;
    dialog=element('dialog','story-dialog');
    dialog.setAttribute('aria-labelledby','storyTitle');

    const header=element('header','story-dialog-head');
    const headText=element('div','story-dialog-title');
    const title=element('h2','','背景故事');
    title.id='storyTitle';
    const subtitle=element('p','');
    headText.append(title,subtitle);

    const close=element('button','story-close','关闭');
    close.type='button';
    close.setAttribute('aria-label','关闭背景故事');
    close.addEventListener('click',()=>closeDialog(false));
    header.append(headText,close);

    dialogBody=element('div','story-dialog-body');
    dialog.append(header,dialogBody);
    dialog.addEventListener('close',()=>{
      button?.setAttribute('aria-expanded','false');
      if(restoreFocusOnClose&&!button?.hidden)button?.focus();
      restoreFocusOnClose=false;
    });
    dialog.addEventListener('click',event=>{
      if(event.target===dialog)closeDialog(false);
    });
    document.body.append(dialog);
    return dialog;
  }

  function renderFacts(documentData,currentTitle){
    const fields=Array.isArray(documentData.fields)?documentData.fields:[];
    const useful=fields.filter(item=>item&&item.label&&item.value&&!(item.label==='曲名'&&item.value===currentTitle));
    if(!useful.length)return null;
    const facts=element('dl','story-facts');
    for(const item of useful){
      facts.append(element('dt','',item.label),element('dd','',item.value));
    }
    return facts;
  }

  function renderDocument(documentData,index,total,currentTitle){
    const article=element('article','story-document');
    if(total>1){
      const label=element('div','story-version','资料版本 '+(index+1));
      article.appendChild(label);
    }
    if(documentData.title&&documentData.title!==currentTitle){
      article.appendChild(element('h3','',documentData.title));
    }
    const facts=renderFacts(documentData,currentTitle);
    if(facts)article.appendChild(facts);

    for(const section of Array.isArray(documentData.sections)?documentData.sections:[]){
      if(!section?.title||typeof section.text!=='string'||!section.text)continue;
      const block=element('section','story-section');
      block.append(element('h4','',section.title),element('p','story-copy',section.text));
      article.appendChild(block);
    }
    return article;
  }

  function render(record,song){
    ensureDialog();
    const subtitle=dialog.querySelector('.story-dialog-title p');
    subtitle.textContent=[song?.title||record.documents[0].title,song?.artist].filter(Boolean).join(' · ');
    dialogBody.replaceChildren();
    record.documents.forEach((item,index)=>{
      dialogBody.appendChild(renderDocument(item,index,record.documents.length,song?.title||item.title));
    });
  }

  function dialogIsOpen(){
    return !!(dialog?.open||dialog?.hasAttribute('open'));
  }

  function showDialog(){
    if(!dialog||dialogIsOpen())return;
    restoreFocusOnClose=true;
    button?.setAttribute('aria-expanded','true');
    if(typeof dialog.showModal==='function')dialog.showModal();
    else dialog.setAttribute('open','');
    dialogBody.scrollTop=0;
    dialog.scrollTop=0;
    dialog.querySelector('.story-close')?.focus({preventScroll:true});
  }

  function closeDialog(restoreFocus=false){
    if(!dialog)return;
    restoreFocusOnClose=restoreFocus;
    if(!dialogIsOpen())return;
    if(typeof dialog.close==='function')dialog.close();
    else{
      dialog.removeAttribute('open');
      button?.setAttribute('aria-expanded','false');
    }
  }

  function sync(song=activeSong){
    activeSong=song||null;
    if(!button)return;
    const available=!!(recordFor(activeSong)||recordFor(activeSong,index))&&!root.__recActive;
    button.hidden=!available;
    button.disabled=!available;
    button.setAttribute('aria-expanded',String(available&&dialogIsOpen()));
    if(!available)closeDialog(false);
  }

  function select(song){
    closeDialog(false);
    sync(song);
  }

  function loadBuiltinStory({id,file}){
    if(!builtinRequests.has(id)){
      const url=app.resourcePath('static/background-story-'+file+'.json');
      const request=root.fetch(url).then(response=>{
        if(!response.ok)throw new Error('background story unavailable');
        return response.json();
      }).then(record=>{
        if(!validRecord(id,record))throw new Error('background story invalid');
        builtinRecords.set(id,record);
      }).finally(()=>builtinRequests.delete(id));
      builtinRequests.set(id,request);
    }
    return builtinRequests.get(id);
  }

  async function open(){
    const song=app?.state?.song||activeSong;
    if(root.__recActive||dialogIsOpen())return;
    const entry=recordFor(song,index);
    const id=entry?.id;
    if(!recordFor(song)&&id&&!builtinRecords.has(id)){
      ensureDialog();
      dialog.querySelector('.story-dialog-title p').textContent=[song?.title,song?.artist].filter(Boolean).join(' · ');
      const status=element('p','story-copy story-loading','正在加载背景故事…');
      status.setAttribute('role','status');
      dialogBody.replaceChildren(status);
      showDialog();

      let loadFailed=false;
      try{
        await loadBuiltinStory(entry);
      }catch(_){
        loadFailed=true;
      }
      if(!dialogIsOpen()||dialogBody.querySelector('.story-loading')!==status||
        song!==(app?.state?.song||activeSong)||root.__recActive)return;
      if(loadFailed){
        status.textContent='背景故事加载失败，请关闭弹窗后重试。';
        return;
      }
    }
    const record=recordFor(song)||builtinRecords.get(id);
    if(!record)return;
    render(record,song);
    showDialog();
    app?.visitors?.event?.('background_story_open');
  }

  function install(nextApp,options={}){
    if(app&&button)return;
    app=nextApp;
    button=app?.els?.btnBackgroundStory||document.getElementById('btnBackgroundStory');
    if(!button)return;
    button.addEventListener('click',open);
    sync(app.state?.song||null);
    if(options.loadExternal??!root.JUBEAT_BACKGROUND_STORY_INDEX_COMPLETE)loadExternalCatalog();
  }

  function validRecord(id,record){
    return !!(id&&record&&record.id===id&&Array.isArray(record.documents)&&record.documents.length&&
      record.documents.every(item=>Array.isArray(item?.sections)&&
        item.sections.every(section=>typeof section?.title==='string'&&typeof section.text==='string')));
  }

  function validCatalog(catalog){
    if(!catalog||typeof catalog!=='object'||catalog.schemaVersion!==2)return false;
    if(!catalog.records||typeof catalog.records!=='object'||Array.isArray(catalog.records))return false;
    return Object.entries(catalog.records).every(([id,record])=>validRecord(id,record));
  }

  function mergeExternal(){
    if(!externalCatalog)return;
    const builtin=root.JUBEAT_BACKGROUND_STORIES||{};
    root.JUBEAT_BACKGROUND_STORIES=Object.freeze({
      ...builtin,
      schemaVersion:externalCatalog.schemaVersion,
      records:{...(builtin.records||{}),...externalCatalog.records},
    });
  }

  function loadExternalCatalog(force=false){
    if(force){catalogRequest=null;catalogFailed=false;}
    if(catalogRequest||catalogFailed||typeof root.fetch!=='function')return catalogRequest;
    // 走 app-base.js 的 resourcePath：/share/ 等子路径部署时会补上资源前缀，
    // 裸相对路径会从当前目录取，必然 404。辅助函数尚不可用时干脆不发这次必失败的请求。
    const resolve=app?.resourcePath||root.JubeatApp?.resourcePath;
    if(typeof resolve!=='function')return catalogRequest;
    catalogRequest=root.fetch(resolve('data/background-stories.json'),{cache:'no-cache'})
      .then(response=>{
        if(!response.ok)throw new Error('background catalog unavailable');
        return response.json();
      })
      .then(catalog=>{
        if(!validCatalog(catalog))throw new Error('background catalog invalid');
        externalCatalog=catalog;
        mergeExternal();
        sync(activeSong);
      })
      .catch(()=>{
        // 失败复位，避免后续调用被一个已失败的 promise 永久短路；
        // catalogFailed 做一次性退避（文件本就不存在，不必每次都重试），
        // 导出的 loadExternalCatalog(true) 即为强制重试入口。
        catalogRequest=null;
        catalogFailed=true;
      });
    return catalogRequest;
  }

  return {install,select,recordFor,loadExternalCatalog,validCatalog};
});
