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
  async function readBytes(res, maxBytes, onProgress = () => {}) {
    if (!res.ok) throw new Error(`读取失败（${res.status}）`);
    const total = Number(res.headers.get("Content-Length")) || 0;
    if (total > maxBytes) throw new Error("资源超过允许大小");
    if (!res.body || !res.body.getReader) {
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > maxBytes) throw new Error("资源超过允许大小");
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
        chunks.push(value); onProgress(length, total);
      }
    } catch (err) { await reader.cancel().catch(() => {}); throw err; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes.buffer;
  }
  async function readJSON(res) {
    const bytes = await readBytes(res, 8 * 1024 * 1024);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
  function safePath(value) {
    return typeof value === "string" && value.length > 0 && value.length < 2048
      && !/[\\\x00-\x1f]/.test(value) && !value.startsWith("/")
      && value.split("/").every((part) => part !== "." && part !== ".." && part !== "");
  }
  function validateLibrary(data) {
    if (!object(data) || !Array.isArray(data.songs) || data.songs.length > 50000
      || !Array.isArray(data.versions)) throw new Error("曲库索引格式无效");
    const seen = new Set();
    for (const song of data.songs) {
      if (!object(song) || !safePath(song.id) || seen.has(song.id)
        || typeof song.title !== "string" || typeof song.version !== "string"
        || !Array.isArray(song.charts) || !song.charts.length || song.charts.length > 32
        || song.charts.some((c) => !object(c) || !safePath(c.code) || c.code.includes("/")))
        throw new Error("曲库中存在无效或重复曲目");
      if (song.assets && (!object(song.assets) || Object.values(song.assets).some((value) => !safePath(value))))
        throw new Error("曲目资源路径无效");
      seen.add(song.id);
    }
    return data;
  }
  function validateChart(data) {
    if (!object(data) || !object(data.meta) || !Array.isArray(data.note) || !Array.isArray(data.time)
      || data.note.length > 200000 || data.time.length > 20000) throw new Error("谱面格式无效");
    const validBeat = (beat) => Array.isArray(beat) && beat.length === 3
      && beat.every(Number.isFinite) && beat[2] > 0;
    for (const events of [data.time, data.note]) {
      for (const event of events) {
        if (!object(event) || !validBeat(event.beat)
          || (event.endbeat != null && !validBeat(event.endbeat))
          || (event.bpm != null && (!Number.isFinite(event.bpm) || event.bpm <= 0))
          || (event.offset != null && !Number.isFinite(event.offset))
          || (event.index != null && (!Number.isInteger(event.index) || event.index < 0 || event.index > 15)))
          throw new Error("谱面拍点、速度或按键无效");
      }
    }
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
  return { markerRate, RequestScope, readBytes, readJSON, validateLibrary, validateChart, safePath, Semaphore };
});
