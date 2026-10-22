/* Shared request lifetimes, bounded reads and input validation. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JubeatRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  class RequestScope {
    constructor() { this.active = null; }
    start(timeoutMs = 30000) {
      this.cancel();
      const request = { controller: new AbortController(), timer: null };
      request.signal = request.controller.signal;
      request.timer = setTimeout(() => request.controller.abort(new DOMException("加载超时，请重试", "TimeoutError")), timeoutMs);
      this.active = request;
      return request;
    }
    current(request) { return this.active === request && !request.signal.aborted; }
    finish(request) { clearTimeout(request.timer); }
    cancel() {
      if (this.active) { this.finish(this.active); this.active.controller.abort(); }
      this.active = null;
    }
  }
  // Owns asynchronous transport work, independently of DOM and AudioContext.
  // Decode results belong to callers; the serialization tail only retains completion.
  class AudioSession {
    constructor(timers = { setTimeout: (...args) => setTimeout(...args), clearTimeout: id => clearTimeout(id) }) {
      this.timers = timers; this.generation = 0; this.recovery = null;
      this.decodeTail = Promise.resolve();
    }
    invalidate() { this.cancelRecovery(); return ++this.generation; }
    current(token) { return token === this.generation; }
    decode(job) {
      const result = this.decodeTail.then(job);
      this.decodeTail = result.then(() => undefined, () => undefined);
      return result;
    }
    cancelRecovery() {
      if (this.recovery) this.timers.clearTimeout(this.recovery.timer);
      this.recovery = null;
    }
    recover({ running, resume, restore, current = () => true }, tries = 12) {
      const nudge = () => { try { Promise.resolve(resume()).catch(() => {}); } catch (_) {} };
      // A fresh gesture must still unlock audio, but must not add another retry loop.
      if (this.recovery) { nudge(); return; }
      const task = { generation: this.generation, timer: null };
      this.recovery = task;
      const tick = () => {
        if (this.recovery !== task) return;
        if (!this.current(task.generation) || !current()) { this.cancelRecovery(); return; }
        if (running() || tries-- <= 0) { this.cancelRecovery(); restore(); return; }
        nudge(); task.timer = this.timers.setTimeout(tick, 120);
      };
      tick();
    }
  }
  class ByteBudget {
    constructor(limit) { this.limit = limit; this.used = 0; this.exceeded = false; }
    add(bytes) {
      this.used += bytes;
      if (this.exceeded || this.used > this.limit) { this.exceeded = true; throw Error('曲库累计资源超过允许大小'); }
    }
  }
  async function readBytes(res, maxBytes, onProgress = () => {}, budget = null) {
    if (!res.ok) throw new Error(`读取失败（${res.status}）`);
    const total = Number(res.headers.get("Content-Length")) || 0;
    if (total > maxBytes) { await res.body?.cancel().catch(() => {}); throw new Error("资源超过允许大小"); }
    if (!res.body || !res.body.getReader) {
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > maxBytes) throw new Error("资源超过允许大小");
      budget?.add(bytes.byteLength);
      onProgress(bytes.byteLength, total || bytes.byteLength);
      return bytes;
    }
    const reader = res.body.getReader();
    const chunks = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw new Error("资源超过允许大小");
        budget?.add(value.byteLength);
        chunks.push(value); onProgress(length, total);
      }
    } catch (err) { await reader.cancel().catch(() => {}); throw err; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes.buffer;
  }
  async function readJSON(res, {budget = null, maxBytes = 8 * 1024 * 1024} = {}) {
    const bytes = await readBytes(res, maxBytes, () => {}, budget);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
  function safePath(value) {
    return typeof value === "string" && value.length > 0 && value.length < 2048
      && !/[\\:\x00-\x1f]/.test(value) && !value.startsWith("/")
      && value.split("/").every((part) => part !== "." && part !== ".." && part !== "");
  }
  function validateLibrary(data) {
    if (!object(data) || !Array.isArray(data.songs) || data.songs.length > 50000
      || !Array.isArray(data.versions) || data.versions.length > 512
      || data.versions.some(v => typeof v !== "string" || v.length > 256)) throw new Error("曲库索引格式无效");
    const seen = new Set();
    for (const song of data.songs) {
      if (!object(song) || !safePath(song.id) || seen.has(song.id)
        || typeof song.title !== "string" || song.title.length > 4096 || typeof song.version !== "string" || song.version.length > 256
        || !Array.isArray(song.charts) || (!song.charts.length && song.resourceOnly !== true) || song.charts.length > 32
        || song.charts.some((c) => !object(c) || !safePath(c.code) || c.code.includes("/")))
        throw new Error("曲库中存在无效或重复曲目");
      if (song.assets && (!object(song.assets) || Object.values(song.assets).some((value) => !safePath(value))))
        throw new Error("曲目资源路径无效");
      if (song.missing && (!Array.isArray(song.missing) || song.missing.some(x => typeof x !== 'string')))
        throw new Error('缺失素材清单无效');
      seen.add(song.id);
    }
    return data;
  }
  function validateChart(data) {
    if (!object(data) || !object(data.meta) || !Array.isArray(data.note) || !Array.isArray(data.time)
      || data.note.length > 200000 || data.time.length > 20000) throw new Error("谱面格式无效");
    const validBeat = (beat) => Array.isArray(beat) && beat.length === 3
      && beat.every(Number.isFinite) && beat[2] > 0 && Number.isFinite(beat[0] + beat[1] / beat[2]);
    for (const events of [data.time, data.note]) {
      for (const event of events) {
        if (!object(event) || !validBeat(event.beat)
          || (event.endbeat != null && !validBeat(event.endbeat))
          || (event.bpm != null && (!Number.isFinite(event.bpm) || event.bpm <= 0))
          || (event.offset != null && (!Number.isFinite(event.offset) || Math.abs(event.offset) > 21600 * 1000))
          || (event.index != null && (!Number.isInteger(event.index) || event.index < 0 || event.index > 15)))
          throw new Error("谱面拍点、速度或按键无效");
      }
    }
    return data;
  }
  function pngSize(bytes) {
    const view = new DataView(bytes);
    if (bytes.byteLength < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
        || view.getUint32(12) !== 0x49484452) throw Error('无效 marker PNG');
    const width=view.getUint32(16),height=view.getUint32(20);
    if (!width || !height || width>4096 || height>4096 || width*height>4*1024*1024) throw Error('Marker 图片超过像素预算');
    return {width,height};
  }
  function validateMarkers(data) {
    if(!object(data) || !Array.isArray(data.designs) || data.designs.length>128)throw Error('无效 marker 清单');
    const seen=new Set();
    for(const design of data.designs) {
      if(!object(design)||!safePath(design.dir)||!safePath(design.prefix)||design.prefix.includes('/')
          ||typeof design.id!=='string'||design.id.length>128||seen.has(design.id)||!object(design.h))throw Error('无效 marker 路径');
      seen.add(design.id);
      const counts=[design.ma??0,design.fr??0,...Object.values(design.h)];
      if(counts.some(n=>!Number.isInteger(n)||n<0||n>256)||counts.reduce((a,b)=>a+b,0)>512)throw Error('Marker 帧数超出限制');
      if (design.timing != null) {
        const t=design.timing;
        if(!object(t)||!Number.isFinite(t.approach_ms)||t.approach_ms<50||t.approach_ms>3000
            ||!Number.isFinite(t.burst_ms)||t.burst_ms<50||t.burst_ms>3000
            ||!Number.isInteger(t.ma_hit_frame)||t.ma_hit_frame<0||t.ma_hit_frame>=design.ma)
          throw Error('无效 marker 独立时间参数');
      }
      for(const [channel,atlas] of Object.entries(design.atlases||{})) {
        const count=channel==='MA'?design.ma:design.h[channel.slice(1)];
        if(!/^(MA|H[1-4])$/.test(channel)||!object(atlas)||!safePath(atlas.file)||!atlas.file.startsWith(design.dir+'/')
            ||!Number.isInteger(atlas.width)||!Number.isInteger(atlas.height)||atlas.width<1||atlas.height<1
            ||atlas.width>4096||atlas.height>4096||atlas.width*atlas.height>4*1024*1024
            ||!Array.isArray(atlas.rects)||atlas.rects.length!==count)throw Error('无效 marker 图集');
        let pixels=0;
        for(const rect of atlas.rects) {
          if(!Array.isArray(rect)||rect.length!==5||!rect.every(Number.isFinite)
              ||rect.slice(0,4).some(x=>!Number.isInteger(x))||rect[0]<0||rect[1]<0||rect[2]<1||rect[3]<1
              ||rect[2]>512||rect[3]>512||rect[0]+rect[2]>atlas.width||rect[1]+rect[3]>atlas.height
              ||rect[4]<0||rect[4]>1)throw Error('无效 marker 图集帧');
          pixels+=rect[2]*rect[3];if(pixels>4*1024*1024)throw Error('Marker 图集帧超过累计预算');
        }
      }
    }
    for(const [value,min,max] of [[data.unit_ms??3.3333,.1,100],[data.units_per_frame??10,1,120],
      [data.hit_window_units?.early??-155,-4096,-1],[data.hit_window_units?.late??160,1,4096]])
      if(!Number.isFinite(value)||value<min||value>max)throw Error('Marker 时间参数超出限制');
    return data;
  }
  class Semaphore {
    constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
    run(job) { return new Promise((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.drain(); }); }
    drain() {
      while (this.active < this.limit && this.queue.length) {
        const item = this.queue.shift(); this.active++;
        Promise.resolve().then(item.job).then(item.resolve, item.reject).finally(() => { this.active--; this.drain(); });
      }
    }
  }
  function markerRate(rate, normal) {
    return normal && Number.isFinite(rate) && rate > 0 ? rate : 1;
  }
  function markerTiming(design, config = {}) {
    const custom=design?.timing;
    if(custom) return {earlyMs:-custom.approach_ms, lateMs:custom.burst_ms,
      maFrameMs:custom.approach_ms/(custom.ma_hit_frame+.5), burstMs:custom.burst_ms,
      hitFrame:custom.ma_hit_frame};
    const unit=Number(config.unitMs)>0?Number(config.unitMs):3.3333;
    const per=Number(config.unitsPerFrame)>0?Number(config.unitsPerFrame):10;
    const early=Number.isFinite(config.window?.early)?config.window.early:-155;
    const late=Number.isFinite(config.window?.late)?config.window.late:160;
    return {earlyMs:early*unit, lateMs:late*unit, maFrameMs:per*unit,
      hFrameMs:per*unit, hitFrame:Math.floor(-early/per)};
  }
  return { ByteBudget, pngSize, validateMarkers, markerRate, markerTiming, RequestScope, AudioSession, readBytes, readJSON, validateLibrary, validateChart, safePath, Semaphore };
});
