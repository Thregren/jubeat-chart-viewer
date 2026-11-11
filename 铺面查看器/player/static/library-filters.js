/* Persistent library filters; controls retain their existing IDs and behavior. */
(() => {
  'use strict';
  const A = window.JubeatApp;
  const panel = document.getElementById('libraryFilters');
  if (!panel) return;
  const controls = [A.els.versionFilter, A.els.sortSelect, A.els.holdFilter];
  const reset = document.getElementById('resetLibraryFilters');
  const version = A.els.versionFilter;
  const versionLabel = document.createElement('span');
  versionLabel.className = 'version-filter-display';
  versionLabel.setAttribute('aria-hidden', 'true');
  version.parentElement.classList.add('version-filter-with-label');
  version.after(versionLabel);
  function sync() {
    const fullName = window.JubeatVersions.display[version.value] || version.selectedOptions[0]?.textContent || '';
    const shortName = version.value === 'jubeat' ? fullName : fullName.replace(/^jubeat\s+/i, '');
    versionLabel.textContent = shortName;
    versionLabel.title = fullName;
    controls.forEach((el, i) => el.classList.toggle('filter-active', el.value !== (i === 1 ? 'title' : '')));
    reset.disabled = !A.els.search.value && (controls.every(el => el.disabled) || (!A.isPopularMode?.() && controls.every((el, i) => el.value === (i === 1 ? 'title' : ''))));
  }
  for (const control of controls) control.addEventListener('change', sync);
  A.els.search.addEventListener('input', sync);
  reset.addEventListener('click', () => {
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
