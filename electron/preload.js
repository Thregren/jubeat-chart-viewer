const { contextBridge, ipcRenderer } = require('electron');
function call(op, key, value) {
  const result = ipcRenderer.sendSync('viewer-preference', { op, key, value });
  if (!result?.ok) throw new Error('Preference storage unavailable');
  return result.value;
}
contextBridge.exposeInMainWorld('JubeatPreferences', Object.freeze({
  getItem: key => call('get', key),
  setItem: (key, value) => call('set', key, value),
  removeItem: key => call('remove', key),
}));
