(() => {
  'use strict';
  const parserUrl = document.querySelector('#match-replay-parser').content.querySelector('script').getAttribute('src');
  const query = new URLSearchParams(location.search);
  if (query.get('replay') === 'wonder-walker-ext') {
    location.replace('/?import=oft');
    return;
  }
  const importRequested = query.get('import') === 'oft';
  const A = window.JubeatApp;
  const row = document.querySelector('#match-replay');
  const dialog = document.querySelector('#match-replay-dialog');
  const entries = dialog.querySelector('tbody');
  const open = row.querySelector('button');
  const status = row.querySelector('#match-replay-status');
  const exit = row.querySelector('#match-replay-exit');
  const exportButton = row.querySelector('#match-replay-export');
  const exportMessage = row.querySelector('#match-replay-export-message');
  const importDialog = document.querySelector('#match-replay-import-dialog');
  const fileInput = importDialog.querySelector('#match-replay-file');
  const importMessage = importDialog.querySelector('#match-replay-import-message');
  const importMatches = importDialog.querySelector('#match-replay-import-matches');
  const score = row.querySelector('#match-replay-score');
  const progress = row.querySelector('#match-replay-progress');
  const currentScore = progress.querySelector('#match-replay-current-score');
  const currentCombo = progress.querySelector('#match-replay-current-combo');
  const scoreFormat = new Intl.NumberFormat('en-US');
  const theme = getComputedStyle(document.documentElement);
  const panelColors = {
    late: theme.getPropertyValue('--match-replay-late').trim(),
    early: theme.getPropertyValue('--match-replay-early').trim(),
    neutral: '#f1f5fa',
  };
  const tiers = { PERFECT: 4, GREAT: 3, GOOD: 2, POOR: 1 };
  const labelDuration = 0.56;
  const offsets = new Intl.NumberFormat('en', {
    signDisplay: 'exceptZero', minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
  let sample;
  let selection;
  let nativeNotes;
  let records;
  let panels;
  let focused;
  let densityCache;
  let progressIndex = -1;
  let parserPromise;
  let search;

  function offsetLabel(note) {
    return note.deltaMs == null ? '—' : offsets.format(note.deltaMs).replace('-', '−') + ' ms';
  }

  function offsetDirection(note) {
    return note.deltaMs > 0 ? 'late' : note.deltaMs < 0 ? 'early' : 'neutral';
  }

  function formatTime(timeMs) {
    const ms = Math.round(timeMs);
    return Math.floor(ms / 60000) + ':' + ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  }

  function renderTable(notes) {
    const fragment = document.createDocumentFragment();
    for (const note of notes) {
      const tr = document.createElement('tr');
      const link = document.createElement('button');
      link.type = 'button';
      link.textContent = formatTime(note.timeMs);
      link.setAttribute('aria-label', '跳到 ' + link.textContent + '，第 ' + note.panel + ' 格');
      link.addEventListener('click', () => {
        if (!forChart()) return;
        A.pause();
        A.seekTo(note.eventTime + 0.001);
        focused = note;
        dialog.close();
        A.requestPaint();
      });
      tr.insertCell().append(link);
      tr.insertCell().textContent = note.panel;
      tr.insertCell().textContent = note.grade;
      const offset = tr.insertCell();
      offset.textContent = offsetLabel(note);
      offset.dataset.offset = offsetDirection(note);
      fragment.append(tr);
    }
    entries.replaceChildren(fragment);
  }

  function matchNotes(data, notes) {
    if (!notes.length || notes.length !== data.notes.length || notes.some(note => note.kind !== 'tap')) return null;
    const byPanel = Array.from({ length: 16 }, () => []);
    for (const nativeNote of notes) byPanel[nativeNote.index].push(nativeNote);
    const positions = new Array(16).fill(0);
    const paired = [];
    for (const note of data.notes) {
      const index = note.panel;
      const nativeNote = byPanel[index][positions[index]++];
      if (!nativeNote || Math.abs(nativeNote.t * 1000 - note.timeMs) > 4) return null;
      paired.push(nativeNote);
    }
    return paired;
  }

  function mapReplay(data, notes) {
    const paired = matchNotes(data, notes);
    if (!paired) return null;
    const mapping = new WeakMap();
    let maxShift = 0;
    const grouped = Array.from({ length: 16 }, () => []);
    for (const [index, nativeNote] of paired.entries()) {
      const note = data.notes[index];
      note.eventTime = note.hitMs != null ? nativeNote.t + note.deltaMs / 1000 : note.judgmentMs / 1000;
      maxShift = Math.max(maxShift, Math.abs(note.eventTime - nativeNote.t));
      note.tier = tiers[note.grade] || 0;
      mapping.set(nativeNote, note);
      grouped[note.panel].push(note);
    }
    for (const group of grouped) group.sort((left, right) => left.eventTime - right.eventTime);
    return { maxShift, panels: grouped, records: mapping };
  }

  function forChart() {
    const chartReady = A.state.notes.length > 0 && !A.mode?.ownsFrame;
    const selected = selection?.song === A.state.song?.id && selection?.code === A.state.chartMeta?.code;
    if (chartReady && selected && sample && nativeNotes !== A.state.notes) {
      nativeNotes = A.state.notes;
      applyMapping(mapReplay(sample, nativeNotes));
    }
    const active = chartReady && selected && Boolean(records);
    const hidden = !chartReady;
    const label = active ? '游玩回看（试验）'
      : chartReady && selected && sample ? '此谱面与游玩记录无法对齐' : '';
    if (status.textContent !== label) status.textContent = label;
    if (status.hidden === Boolean(label)) status.hidden = !label;
    if (open.disabled === active) {
      open.disabled = !active;
      exportButton.disabled = !active;
      score.hidden = !active;
      progress.hidden = !active;
      exit.hidden = !active;
      if (!active) exportMessage.textContent = '';
    }
    if (row.hidden !== hidden) {
      row.hidden = hidden;
      A.refreshCanvas?.();
    }
    if (!active && dialog.open) dialog.close();
    return active ? replay : null;
  }

  function applyMapping(mapping) {
    records = mapping?.records;
    panels = mapping?.panels;
    replay.maxShift = mapping?.maxShift ?? 0;
    focused = null;
  }

  function setReplay(data, chart, mapping) {
    sample = data;
    selection = chart;
    nativeNotes = A.state.notes;
    applyMapping(mapping);
    progressIndex = -2;
    exportMessage.textContent = '';
    entries.replaceChildren();
    const total = scoreFormat.format(data.summary.score);
    score.querySelector('strong').textContent = total;
    dialog.querySelector('.match-replay-summary').textContent =
      total + ' 分 · 最大连击 ' + data.summary.maxCombo;
    dialog.querySelector('h2').textContent = chart.title + ' · ' + chart.code;
    A.requestPaint();
  }

  function record(note) {
    return records.get(note);
  }

  function updateProgress(chartT) {
    // During a seek, show the selected position without subtracting audio output latency.
    const atPosition = A.forcedMediaTime == null && (!A.state.playing || A.state.scrubbing);
    const elapsed = (atPosition ? A.currentMediaTime() : chartT) * 1000;
    const scoreTimeline = sample.progress;
    let low = 0;
    let high = scoreTimeline.length;
    // The replay can contain several judgments in one frame. Use the last
    // snapshot at that timestamp so the score and combo stay in sync.
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (scoreTimeline[mid][0] <= elapsed) low = mid + 1;
      else high = mid;
    }
    const index = low - 1;
    const snapshot = scoreTimeline[index];
    const combo = snapshot?.[2] ?? 0;
    if (index !== progressIndex) {
      progressIndex = index;
      currentScore.textContent = scoreFormat.format(snapshot?.[1] ?? 0);
      currentCombo.textContent = String(combo);
    }
    return combo;
  }

  function densityColumns({ cols, dur }) {
    if (!cols || !dur) return null;
    const exact = A.state.arcadeDensity;
    if (densityCache?.records === records && densityCache.cols === cols &&
        densityCache.dur === dur && densityCache.exact === exact) {
      return densityCache.columns;
    }
    const endTick = exact ? Math.round(dur * 300) : 0;
    const columns = Array.from({ length: cols }, () => ({
      grade: 'PERFECT', last: -Infinity, miss: Infinity, revealAt: Infinity,
    }));
    for (const nativeNote of nativeNotes) {
      const note = record(nativeNote);
      const bucket = endTick ? Math.floor(Math.round(note.timeMs * 0.3) * cols / endTick)
        : Math.floor(nativeNote.t * cols / dur);
      const column = columns[Math.min(cols - 1, Math.max(0, bucket))];
      column.last = Math.max(column.last, note.eventTime);
      if (note.grade === 'MISS') {
        column.grade = 'MISS';
        column.miss = Math.min(column.miss, note.eventTime);
      } else if (note.grade !== 'PERFECT' && column.grade !== 'MISS') {
        column.grade = 'NON_PERFECT';
      }
    }
    for (const column of columns) {
      if (column.last !== -Infinity) {
        column.revealAt = column.grade === 'MISS' ? column.miss : column.last;
      }
    }
    densityCache = { records, cols, dur, exact, columns };
    return columns;
  }

  function latestBefore(notes, time) {
    let low = 0;
    let high = notes.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (notes[mid].eventTime <= time) low = mid + 1;
      else high = mid;
    }
    return notes[low - 1];
  }

  function paint(chartT, ctx) {
    if (focused && (A.state.playing || Math.abs(focused.eventTime - chartT) > 0.04)) focused = null;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let index = 0; index < panels.length; index++) {
      const hit = index === focused?.panel ? focused : latestBefore(panels[index], chartT);
      const rect = A.state.padRects[index];
      if (!rect || !hit || chartT - hit.eventTime > labelDuration) continue;
      const size = Math.max(8, Math.min(rect.w * 0.18, 18));
      ctx.font = '700 ' + size + 'px system-ui, sans-serif';
      const label = hit.deltaMs == null ? 'MISS · —' : offsetLabel(hit);
      const width = Math.min(rect.w - 2, ctx.measureText(label).width + 8);
      if (width <= 0) continue;
      const x = rect.x + rect.w / 2;
      const y = rect.y + rect.h - size * 0.95;
      ctx.fillStyle = 'rgba(13, 19, 30, .92)';
      ctx.beginPath();
      ctx.roundRect(x - width / 2, y - size * 0.7, width, size * 1.4, 4);
      ctx.fill();
      ctx.fillStyle = panelColors[offsetDirection(hit)];
      ctx.fillText(label, x, y, Math.max(1, width - 4));
    }
    ctx.restore();
  }

  const replay = { record, paint, densityColumns, updateProgress };
  A.matchReplay = { forChart };
  open.addEventListener('click', () => {
    if (!forChart()) return;
    A.pause();
    if (!entries.rows.length) renderTable(sample.notes);
    dialog.showModal();
  });
  dialog.querySelector('.match-replay-close').addEventListener('click', () => dialog.close());
  // Keep this modal's keyboard input out of the viewer's playback shortcuts.
  dialog.addEventListener('keydown', event => event.stopPropagation());

  function selectedChart() {
    const { song, chartMeta, notes } = A.state;
    if (!song || !chartMeta?.code || !notes.length || A.mode?.ownsFrame) return null;
    return { song: song.id, title: song.title, code: chartMeta.code, notes };
  }

  function showImporter() {
    if (A.state.playing) A.pause();
    importMessage.textContent = '';
    importMatches.replaceChildren();
    fileInput.disabled = false;
    importDialog.showModal();
  }

  function loadParser() {
    if (!parserPromise) {
      parserPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = parserUrl;
        script.onload = () => resolve(window.parseOftReplay);
        script.onerror = () => reject(new Error('OFT 解析器载入失败，请重试。'));
        document.head.append(script);
      }).catch(error => {
        parserPromise = null;
        throw error;
      });
    }
    return parserPromise;
  }

  exportButton.addEventListener('click', async () => {
    if (!forChart() || exportButton.hasAttribute('aria-busy')) return;
    const data = sample;
    const { title, code } = selection;
    exportMessage.textContent = '';
    exportButton.setAttribute('aria-busy', 'true');
    try {
      const { blob, suffix } = await window.encodeCompactReplay(data);
      const name = (title + ' - ' + code).replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name + suffix;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch {
      if (sample === data) exportMessage.textContent = '导出失败，请重试。';
    } finally {
      exportButton.removeAttribute('aria-busy');
    }
  });

  document.querySelector('#welcome-import-oft').addEventListener('click', showImporter);
  document.querySelector('#match-replay-import').addEventListener('click', showImporter);
  importDialog.querySelector('.match-replay-close').addEventListener('click', () => importDialog.close());
  importDialog.addEventListener('keydown', event => event.stopPropagation());
  importDialog.addEventListener('close', () => {
    if (!importDialog.open) search?.abort();
  });

  async function findMatches(data, signal) {
    const library = await window.__player.ready;
    signal.throwIfAborted();
    if (!library) throw new Error('曲库载入失败，请刷新页面后重试。');
    const candidates = [];
    for (const song of A.state.songs) {
      if (song.resourceOnly || !A.audioUrl(song)) continue;
      for (const chart of song.charts) {
        if (chart.playable === false || chart.notesKnown === false ||
            chart.notes !== data.notes.length || chart.holds > 0) continue;
        candidates.push({ song, chart });
      }
    }
    const matched = [];
    let next = 0;
    let complete = 0;
    let failed = 0;
    const count = candidates.length;
    if (!count) return matched;
    importMessage.textContent = `正在核对候选谱面（0 / ${count}）…`;
    async function checkCandidate() {
      while (!signal.aborted && next < count) {
        const candidate = candidates[next++];
        const { song, chart } = candidate;
        try {
          const payload = await A.readChartPayload(song, chart, signal);
          if (matchNotes(data, A.parseNotes(payload.chart).notes)) matched.push(candidate);
        } catch (error) {
          if (signal.aborted) return;
          failed++;
        }
        if (!signal.aborted) importMessage.textContent = `正在核对候选谱面（${++complete} / ${count}）…`;
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, count) }, checkCandidate));
    signal.throwIfAborted();
    if (failed) throw new Error(`${failed} 张候选谱面读取失败，暂时无法确认匹配，请重试。`);
    return matched;
  }

  async function openMatch(data, match, signal) {
    importMatches.replaceChildren();
    importMessage.textContent = `正在打开 ${match.song.title} · ${match.chart.code}…`;
    A.pause();
    await A.selectSong(match.song, match.chart.code);
    signal.throwIfAborted();
    if (!importDialog.open) return;
    const chart = selectedChart();
    const mapping = chart?.song === match.song.id && chart.code === match.chart.code
      ? mapReplay(data, chart.notes) : null;
    if (!mapping) throw new Error('匹配的谱面未能打开，请重试。');
    setReplay(data, chart, mapping);
    A.seekTo(0);
    importDialog.close();
  }

  function showMatches(data, matches, signal) {
    importMessage.textContent = '有多张谱面的落点完全匹配，请选择要打开的版本。';
    const sorted = [...matches].sort((left, right) =>
      left.song.title.localeCompare(right.song.title) || left.song.id.localeCompare(right.song.id)
      || left.chart.code.localeCompare(right.chart.code));
    for (const match of sorted) {
      const button = document.createElement('button');
      button.type = 'button';
      const version = A.versionLabel(match.song.version);
      button.textContent = [match.song.title, match.chart.code, version].join(' · ');
      button.addEventListener('click', async () => {
        fileInput.disabled = true;
        try {
          await openMatch(data, match, signal);
        } catch (error) {
          if (!signal.aborted) importMessage.textContent = error.message;
        } finally {
          if (!signal.aborted) fileInput.disabled = false;
        }
      });
      importMatches.append(button);
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    search?.abort();
    search = new AbortController();
    const { signal } = search;
    importMatches.replaceChildren();
    importMessage.textContent = '正在解析回放…';
    fileInput.disabled = true;
    try {
      const parse = await loadParser();
      const data = await parse(file);
      signal.throwIfAborted();
      if (!importDialog.open) return;
      importMessage.textContent = '正在从曲库查找谱面…';
      const matches = await findMatches(data, signal);
      if (!importDialog.open) return;
      if (!matches.length) throw new Error('曲库中没有与这份回放的落点和时间一致的谱面。');
      if (matches.length === 1) await openMatch(data, matches[0], signal);
      else showMatches(data, matches, signal);
    } catch (error) {
      if (!signal.aborted && importDialog.open) {
        importMessage.textContent = error.message || '文件解析失败。';
      }
    } finally {
      if (!signal.aborted) fileInput.disabled = false;
    }
  });
  exit.addEventListener('click', () => {
    sample = null;
    selection = null;
    nativeNotes = null;
    applyMapping(null);
    A.requestPaint();
  });

  if (importRequested) showImporter();

})();
