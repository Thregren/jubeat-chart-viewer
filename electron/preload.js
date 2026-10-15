const { contextBridge, ipcRenderer, webUtils } = require('electron');
window.addEventListener('dragover',event=>{event.preventDefault();});
window.addEventListener('drop',event=>{
  event.preventDefault();
  if(!event.isTrusted)return;
  const paths=Array.from(event.dataTransfer?.files || [],file=>webUtils.getPathForFile(file)).filter(Boolean);
  if(paths.length)ipcRenderer.invoke('import-library',paths).catch(()=>{});
});
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
