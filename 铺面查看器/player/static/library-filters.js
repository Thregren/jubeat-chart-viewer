/* Compact library filters; controls retain their existing IDs and behavior. */
(() => {
  'use strict';
  const A=window.JubeatApp, panel=document.getElementById('libraryFilters');
  if (!panel) return;
  const badge=document.getElementById('libraryFilterCount');
  const controls=[A.els.versionFilter,A.els.sortSelect,A.els.holdFilter];
  function sync() {
    const count=controls.filter((el,i)=>el.value!==(i===1?'title':'')).length;
    panel.querySelector('summary').setAttribute('aria-disabled',String(controls.every(el=>el.disabled)));
    badge.textContent=String(count);badge.hidden=!count;panel.classList.toggle('has-filters',!!count);
  }
  const outside=event=>{if(panel.open&&!panel.contains(event.target))panel.open=false;};
  const escape=event=>{if(event.key==='Escape'&&panel.open){panel.open=false;panel.querySelector('summary').focus();event.stopPropagation();}};
  panel.querySelector('summary').addEventListener('click',event=>{if(controls.every(el=>el.disabled))event.preventDefault();});
  document.addEventListener('pointerdown',outside);
  panel.addEventListener('keydown',escape);
  for(const control of controls)control.addEventListener('change',sync);
  document.getElementById('closeLibraryFilters').addEventListener('click',()=>{panel.open=false;panel.querySelector('summary').focus();});
  document.getElementById('resetLibraryFilters').addEventListener('click',()=>{
    controls.forEach((el,i)=>{el.value=i===1?'title':'';});
    A.store(A.STORAGE.sort,'title');A.store(A.STORAGE.holdFilter,'');sync();A.renderList();
  });
  A.libraryFilters={sync,close(){panel.open=false;}};
  A.services.register('libraryFilters',{dispose(){document.removeEventListener('pointerdown',outside);}});
  sync();
})();
