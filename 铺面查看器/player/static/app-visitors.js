/* First-party statistics; detailed records are never returned to the browser. */
(() => {
  'use strict';
  const A = window.JubeatApp, badge = document.getElementById('visitorCount');
  if (!A || !badge || window.__recActive || location.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  const value = document.getElementById('visitorCountValue');
  let tail = Promise.resolve(), lastSong = '', pending = 0;
  function send(event) {
    if (pending >= 8) return;
    pending++;
    tail = tail.then(async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch('/api/visitors', {method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(event),signal:controller.signal});
        if (!response.ok) return;
        const data = await response.json();
        if (Number.isSafeInteger(data.visitors) && data.visitors >= 0) { value.textContent = data.visitors.toLocaleString('zh-CN'); badge.hidden = false; }
      } catch (_) { /* Statistics never block browsing or playback. */ }
      finally { clearTimeout(timer); pending--; }
    });
  }
  A.visitors = Object.freeze({song(song, chart) {
    if (typeof song !== 'string' || typeof chart !== 'string') return;
    const key = song + '\0' + chart;
    if (lastSong === key) return;
    lastSong = key; send({event:'song',song,chart});
  }});
  send({event:'page'});
})();
