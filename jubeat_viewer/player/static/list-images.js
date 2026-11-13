/* Bounded image loading for recycled list rows. The virtual list owns visibility. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JubeatListImages = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  function attach(img, {source, fallback = '', active = () => img.isConnected,
                        setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
                        lazy = false} = {}) {
    let disposed = false, timer = null, state = 'idle', retries = 0, failedAt = 0;
    let url = source;
    img.loading = lazy ? 'lazy' : 'eager';
    img.decoding = 'async';
    const placeholder = on => {
      img.hidden = on;
      img.parentElement?.classList.toggle('ph', on);
    };
    function request() {
      if (disposed || !active()) { state = 'idle'; return; }
      state = 'loading';
      if (retries || url !== source) img.loading = 'eager';
      img.src = retries ? url + (url.includes('?') ? '&' : '?') + 'listRetry=' + retries : url;
    }
    function loaded() {
      if (disposed || !img.naturalWidth) return;
      state = 'loaded'; placeholder(false);
    }
    function failed() {
      if (disposed) return;
      placeholder(true);
      if (!active()) { state = 'idle'; return; }
      if (fallback && url !== fallback) { url = fallback; request(); return; }
      if (retries < 2) {
        state = 'waiting';
        timer = setTimer(() => { timer = null; request(); }, [300, 1200][retries++]);
      } else { state = 'failed'; failedAt = now(); }
    }
    img.addEventListener('load', loaded);
    img.addEventListener('error', failed);
    return {
      start() {
        if (disposed || !url || !active()) return;
        if (state === 'failed' && now() - failedAt >= 30000) { state = 'idle'; retries = 0; }
        if (state === 'idle') request();
      },
      dispose() {
        disposed = true; clearTimer(timer);
        img.removeEventListener('load', loaded); img.removeEventListener('error', failed);
      },
    };
  }
  return {attach};
});
