/* Persistent library filters; controls retain their existing IDs and behavior. */
(() => {
  'use strict';
  const A = window.JubeatApp;
  const panel = document.getElementById('libraryFilters');
  if (!panel) return;
  const controls = [A.els.versionFilter, A.els.sortSelect, A.els.holdFilter];
  const reset = document.getElementById('resetLibraryFilters');
  const version = A.els.versionFilter;
  const versionButton = document.getElementById('btnVersionLibrary');
  function sync() {
    const fullName = window.JubeatVersions.display[version.value] || version.selectedOptions[0]?.textContent || '';
    const shortName = version.value === 'jubeat' ? fullName : fullName.replace(/^jubeat\s+/i, '');
    versionButton.textContent = shortName;
    versionButton.title = fullName;
    versionButton.disabled = version.disabled;
    versionButton.classList.toggle('filter-active', !!version.value);
    controls.forEach((el, i) => el.classList.toggle('filter-active', el.value !== (i === 1 ? 'title' : '')));
    reset.disabled = !A.els.search.value && (controls.every(el => el.disabled) || (!A.isPopularMode?.() && controls.every((el, i) => el.value === (i === 1 ? 'title' : ''))));
  }
  for (const control of controls) control.addEventListener('change', sync);
  A.els.search.addEventListener('input', sync);
  reset.addEventListener('click', () => {
    A.versionLibrary?.setActive(false);
    if (A.isPopularMode?.()) A.leavePopularMode();
    A.els.search.value = '';
    A.cancelLibrarySearch?.();
    controls.forEach((el, i) => { el.value = i === 1 ? 'title' : ''; });
    A.store(A.STORAGE.sort, 'title');
    A.store(A.STORAGE.holdFilter, '');
    sync();
    A.renderList();
  });
  A.libraryFilters = {sync};
  sync();
})();
