/* Persistent library filters; controls retain their existing IDs and behavior. */
(() => {
  'use strict';
  const A = window.JubeatApp;
  const panel = document.getElementById('libraryFilters');
  if (!panel) return;
  const controls = [A.els.versionFilter, A.els.sortSelect, A.els.holdFilter];
  const reset = document.getElementById('resetLibraryFilters');
  function sync() {
    reset.disabled = controls.every(el => el.disabled) || controls.every((el, i) => el.value === (i === 1 ? 'title' : ''));
  }
  for (const control of controls) control.addEventListener('change', sync);
  reset.addEventListener('click', () => {
    controls.forEach((el, i) => { el.value = i === 1 ? 'title' : ''; });
    A.store(A.STORAGE.sort, 'title');
    A.store(A.STORAGE.holdFilter, '');
    sync();
    A.renderList();
  });
  A.libraryFilters = {sync};
  sync();
})();
