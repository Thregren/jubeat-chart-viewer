/* Silent welcome illustration: reuse the installed FLOWER EXT chart, without
 * selecting a song, touching playback state, or requesting any audio assets. */
(() => {
  'use strict';
  const A = window.JubeatApp;
  const stage = document.querySelector('.stage');
  const mark = document.querySelector('.welcome-mark');
  if (!A || !stage || !mark || window.__recActive) return;
  const pads = [...mark.children];
  if (pads.length !== 16) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const controller = new AbortController();
  const lastHit = new Float64Array(16).fill(-Infinity);
  const levels = new Int16Array(16).fill(-1);
  let notes = [], period = 0, cursor = 0, elapsed = 0, started = null;
  let frame = 0, disposed = false, timeout = 0, attempted = false;
  const visible = () => stage.classList.contains('is-welcome') && !document.hidden && !reduced.matches;

  function draw(time) {
    while (cursor < notes.length && notes[cursor].t <= time) {
      const note = notes[cursor++];
      lastHit[note.index] = note.t;
    }
    for (let i = 0; i < 16; i++) {
      const level = Math.round(Math.max(0, 1 - (time - lastHit[i]) / .16) * 100);
      if (levels[i] === level) continue;
      levels[i] = level;
      pads[i].style.setProperty('--welcome-flash', String(level / 100));
    }
  }
  function tick(now) {
    frame = 0;
    if (disposed) return;
    if (!visible()) { sync(); return; }
    if (started === null) started = now;
    const time = (elapsed + now - started) / 1000;
    if (time >= period) {
      elapsed = (time % period) * 1000;
      started = now; cursor = 0; lastHit.fill(-Infinity);
      draw(elapsed / 1000);
    } else draw(time);
    frame = requestAnimationFrame(tick);
  }
  function pause() {
    if (started !== null) elapsed += performance.now() - started;
    started = null;
    cancelAnimationFrame(frame); frame = 0;
  }
  function sync() {
    if (!stage.classList.contains('is-welcome')) { dispose(); return; }
    if (!notes.length && !reduced.matches && !attempted) void load();
    if (!notes.length || !visible()) {
      pause();
      if (reduced.matches) mark.classList.remove('is-playing');
      return;
    }
    mark.classList.add('is-playing');
    if (!frame) frame = requestAnimationFrame(tick);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; pause(); clearTimeout(timeout); controller.abort();
    observer.disconnect();
    document.removeEventListener('visibilitychange', sync);
    reduced.removeEventListener('change', sync);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', sync);
    mark.classList.remove('is-playing');
    for (const pad of pads) pad.style.removeProperty('--welcome-flash');
    notes = [];
  }
  function onPageHide(event) { if (event.persisted) pause(); else dispose(); }
  const observer = new MutationObserver(sync);
  observer.observe(stage, {attributes: true, attributeFilter: ['class']});
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', sync);
  A.services.register('welcome', {dispose});

  async function load() {
    await window.__player?.ready;
    if (attempted || disposed || !stage.classList.contains('is-welcome') || reduced.matches) return;
    attempted = true;
    const candidates = A.state.songs.filter(song => song.title.toUpperCase() === 'FLOWER'
      && song.charts.some(chart => chart.code === 'EXT'));
    const song = candidates.find(song => song.version === 'jubeat-knit') || candidates[0];
    if (!song) return;
    timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(A.chartPath(song, {code: 'EXT'}), {signal: controller.signal});
      if (!response.ok) return;
      const bytes = await window.JubeatRuntime.readBytes(response, 8 * 1024 * 1024);
      const chart = window.JubeatRuntime.validateChart(JSON.parse(new TextDecoder().decode(bytes)));
      const parsed = A.Core.parseNotes(chart).notes;
      if (disposed || !parsed.length) return;
      const first = parsed[0].t;
      notes = parsed.map(note => ({t: note.t - first + .4, index: note.index}));
      period = notes[notes.length - 1].t + 1.2;
      sync();
    } catch (_) { /* Missing or offline chart keeps the static illustration. */ }
    finally { clearTimeout(timeout); timeout = 0; }
  }
  void load();
})();
