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
  // 启动时把整份偏好一次拿走（一次同步 IPC，而不是每个键一次）。
  // 渲染进程侧 SettingsStore 会拿它当基线，之后的写仍然逐键走 setItem。
  getAll: () => call('all'),
  setItem: (key, value) => call('set', key, value),
  removeItem: key => call('remove', key),
}));
