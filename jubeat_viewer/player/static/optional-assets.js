(() => {
  'use strict';
  const pending = new Map();
  const asset = id => document.getElementById(id).content.firstElementChild;
  window.JubeatLoadScript = id => {
    if (!pending.has(id)) {
      const script = document.createElement('script');
      script.src = asset(id).getAttribute('src');
      const loaded = new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => {
          pending.delete(id);
          script.remove();
          reject(new Error('Optional asset unavailable: ' + id));
        };
      });
      pending.set(id, loaded);
      document.head.append(script);
    }
    return pending.get(id);
  };
  if (new URLSearchParams(location.search).get('rec') === '1') {
    document.head.append(asset('record-style').cloneNode());
    // Replay a fixed template tag synchronously so presets precede app-base.
    document.write(asset('record-code').outerHTML);
  }
})();
