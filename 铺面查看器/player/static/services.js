/* Resource owners shared by the web, desktop and Android adapters. */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./runtime.js') : root.JubeatRuntime);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JubeatServices = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function(Runtime) {
  'use strict';
  class Services {
    constructor() { this.owners = new Map(); }
    register(name, owner) {
      if (this.owners.has(name)) throw Error('Duplicate service: ' + name);
      this.owners.set(name, owner);
      Object.defineProperty(this, name, {value: owner, enumerable: true});
      return owner;
    }
    dispose() { for (const owner of [...this.owners.values()].reverse()) owner.dispose?.(); }
  }
  class SettingsStore {
    constructor(bridge, storage) { this.bridge = bridge; this.storage = storage; }
    access(key, value) {
      try {
        const bridge = this.bridge();
        if (bridge) {
          if (value === undefined) {
            const saved = bridge.getItem(key);
            if (saved != null) return saved;
            const legacy = this.storage().getItem(key);
            if (legacy != null) bridge.setItem(key, legacy);
            return legacy;
          }
          if (value === null) bridge.removeItem(key); else bridge.setItem(key, String(value));
        }
      } catch (_) { /* An unavailable native bridge falls back to web storage. */ }
      try {
        const storage = this.storage();
        if (value === undefined) return storage.getItem(key);
        if (value === null) storage.removeItem(key); else storage.setItem(key, String(value));
      } catch (_) { /* Storage may be disabled. */ }
      return null;
    }
  }
  class CatalogStore {
    constructor(cache = new Map()) {
      this.cache = cache; this.sizes = new Map(); this.bytes = 0;
      this.libraryRequests = new Runtime.RequestScope(); this.chartRequests = new Runtime.RequestScope();
      this.ready = null;
    }
    clear() { this.cache.clear(); this.sizes.clear(); this.bytes = 0; }
    get(key) {
      if (!this.cache.has(key)) return undefined;
      const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value); return value;
    }
    put(key, value) {
      const bytes = value.bytes || JSON.stringify(value.chart).length * 4;
      this.bytes -= this.sizes.get(key) || 0; this.cache.delete(key);
      this.cache.set(key, value); this.sizes.set(key, bytes); this.bytes += bytes;
      while (this.cache.size > 40 || this.bytes > 24 * 1024 * 1024) {
        const oldest = this.cache.keys().next().value;
        this.bytes -= this.sizes.get(oldest) || 0; this.cache.delete(oldest); this.sizes.delete(oldest);
      }
    }
    dispose() { this.libraryRequests.cancel(); this.chartRequests.cancel(); this.clear(); }
  }
  function pcmBudget(memoryGiB) {
    return Number.isFinite(memoryGiB) && memoryGiB <= 2 ? 32 * 1024 * 1024 : 96 * 1024 * 1024;
  }
  function pcmBytes(info) {
    const {duration, sampleRate = 48000, channels = 2} = info || {};
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleRate) || sampleRate < 8000
        || sampleRate > 192000 || !Number.isInteger(channels) || channels < 1 || channels > 8) return Infinity;
    return Math.ceil(duration * sampleRate * channels * 4);
  }
  function audioHeader(bytes) {
    const data=new Uint8Array(bytes),view=new DataView(bytes);
    const text=new TextDecoder('latin1').decode(data.subarray(0,Math.min(data.length,65536)));
    const opus=text.indexOf('OpusHead'),vorbis=text.indexOf('\x01vorbis');
    const result=opus>=0&&opus+10<=data.length?{channels:data[opus+9],sampleRate:48000}:
      vorbis>=0&&vorbis+16<=data.length?{channels:data[vorbis+11],sampleRate:view.getUint32(vorbis+12,true)}:{};
    if(data.length>=27&&view.getUint32(0)===0x4f676753&&result.channels) {
      const serial=view.getUint32(14,true);let offset=0,samples=0;
      while(offset+27<=data.length) {
        if(view.getUint32(offset)!==0x4f676753||view.getUint32(offset+14,true)!==serial)return result;
        const segments=data[offset+26];if(offset+27+segments>data.length)return result;
        let length=27+segments;for(let i=0;i<segments;i++)length+=data[offset+27+i];
        if(offset+length>data.length)return result;
        const low=view.getUint32(offset+6,true),high=view.getUint32(offset+10,true);
        if(high!==0xffffffff||low!==0xffffffff)samples=Math.max(samples,high*4294967296+low);
        offset+=length;
      }
      if(offset===data.length&&samples>0&&Number.isSafeInteger(samples))result.duration=samples/result.sampleRate;
      return result;
    }
    if(text.startsWith('RIFF')&&text.slice(8,12)==='WAVE') {
      const format={};let audioBytes=0;
      for(let offset=12;offset+8<=data.length;) {
        const length=view.getUint32(offset+4,true);
        if(offset+8+length>data.length)return {};
        if(text.slice(offset,offset+4)==='fmt '&&length>=16) {
          const kind=view.getUint16(offset+8,true);
          if(kind!==1&&kind!==3)return {};
          format.channels=view.getUint16(offset+10,true);format.sampleRate=view.getUint32(offset+12,true);
          format.block=view.getUint16(offset+20,true);
        }
        if(view.getUint32(offset)===0x64617461)audioBytes+=length;
        offset+=8+length+(length%2);
      }
      if(format.block&&format.sampleRate&&audioBytes)return {...format,duration:audioBytes/format.block/format.sampleRate};
    }
    return result;
  }
  class AudioTransport {
    constructor(runtime = Runtime) {
      this.backend = {mode: 'element', buf: null, src: null, anchorPos: 0, anchorCtx: 0, url: '', objectUrl: '', rate: 1};
      this.requests = new runtime.RequestScope(); this.session = new runtime.AudioSession();
    }
    releaseObject() { if (this.backend.objectUrl) URL.revokeObjectURL(this.backend.objectUrl); this.backend.objectUrl = ''; }
    stop() {
      this.session.invalidate(); const src = this.backend.src; this.backend.src = null;
      if (src) { try { src.stop(); } catch (_) {} try { src.disconnect(); } catch (_) {} }
    }
    cancel() { this.requests.cancel(); this.releaseObject(); }
    dispose() { this.stop(); this.cancel(); this.backend.buf = null; }
  }
  class CanvasRenderer {
    constructor() { this.lastUi = -Infinity; this.mode = 'auto'; }
    uiDue(now, force = false) {
      if (!force && now - this.lastUi < 100) return false;
      this.lastUi = now; return true;
    }
    ratio(width, height, {dpr = 1, recording = false, memoryGiB, coarse = false} = {}) {
      const native = Math.max(1, Math.min(Number(dpr) || 1, 8));
      if (recording || this.mode === 'sharp') return native;
      const cap = this.mode === 'eco' || memoryGiB <= 2 || coarse ? 2 : 3;
      return Math.max(1, Math.min(native, cap, Math.sqrt(1600000 / Math.max(1, width * height))));
    }
  }
  return {Services, SettingsStore, CatalogStore, AudioTransport, CanvasRenderer, pcmBudget, pcmBytes, audioHeader};
});
