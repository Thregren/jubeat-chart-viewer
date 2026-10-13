const fs = require('node:fs');
const path = require('node:path');
const KEYS = new Set([
  'markerNormalSpeed','marker','metroSound','metroVolume','showCombo','firstMarker','showNumbers',
  'numScale','numAlpha','numGlowAlpha','numCorner','numColorMode','numColor','showChordGlow',
  'chordGlowStyle','phraseMult','phraseFloor','phraseMax','chordGlowPair','settingsVersion',
  'collapsed','sort','holdFilter',
].map(key => 'jubeat.' + key));
const MAX_VALUE = 4096;
function allowed(key, value = null) {
  return typeof key === 'string' && KEYS.has(key) && (value === null ||
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_VALUE);
}
class Preferences {
  constructor(file) {
    this.file = file; this.values = Object.create(null);
    try {
      if (fs.statSync(file).size > 128 * 1024) return;
      const values = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(values || {})) if (value !== null && allowed(key, value)) this.values[key] = value;
    } catch { /* Missing or invalid settings fall back to viewer defaults. */ }
  }
  getItem(key) { if (!allowed(key)) throw Error('Unknown preference'); return this.values[key] ?? null; }
  setItem(key, value) {
    if (!allowed(key, value)) throw Error('Invalid preference');
    const next = { ...this.values }; if (value === null) delete next[key]; else next[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded, 'utf8') > 128 * 1024) throw Error('Preference storage limit');
    const temp = this.file + '.tmp';
    try {
      fs.writeFileSync(temp, encoded, { mode: 0o600 });
      fs.renameSync(temp, this.file); this.values = next;
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  removeItem(key) { this.setItem(key, null); }
}
function trustedSender(event, win, url) {
  try { return !!win && !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame && new URL(event.senderFrame.url).origin === new URL(url).origin; }
  catch { return false; }
}
function registerPreferences(ipcMain, preferences, getWindow, getUrl) {
  ipcMain.on('viewer-preference', (event, request) => {
    let response = { ok: false };
    if (trustedSender(event, getWindow(), getUrl()) && request && typeof request === 'object') {
      try {
        let value = null;
        if (request.op === 'get') value = preferences.getItem(request.key);
        else if (request.op === 'set') preferences.setItem(request.key, request.value);
        else if (request.op === 'remove') preferences.removeItem(request.key);
        else throw Error('Invalid operation');
        response = { ok: true, value };
      } catch { /* Never send filesystem paths or native exception details to the renderer. */ }
    }
    // Electron sends a synchronous reply as soon as this setter is called.
    event.returnValue = response;
  });
}
module.exports = { Preferences, KEYS, MAX_VALUE, allowed, trustedSender, registerPreferences };
