const { contextBridge, ipcRenderer, webUtils } = require('electron');
window.addEventListener('dragover',event=>{event.preventDefault();});
window.addEventListener('drop',event=>{
  event.preventDefault();
  if(!event.isTrusted)return;
  const paths=Array.from(event.dataTransfer?.files || [],file=>webUtils.getPathForFile(file)).filter(Boolean);
  if(paths.length)ipcRenderer.invoke('import-library',paths).catch(()=>{});
});
const snapshot = ipcRenderer.sendSync('viewer-preferences-snapshot');
const values = Object.assign(Object.create(null), snapshot?.ok ? snapshot.value : {});
const revisions = new Map();
function getItem(key) {
  if (!snapshot?.ok) throw Error('Preference storage unavailable');
  return values[key] ?? null;
}
function write(op, key, value) {
  if (!snapshot?.ok) throw Error('Preference storage unavailable');
  const previous = values[key], revision = (revisions.get(key) || 0) + 1;
  revisions.set(key, revision);
  if (op === 'remove') delete values[key]; else values[key] = value;
  return ipcRenderer.invoke('viewer-preference-write', { op, key, value }).then(result => {
    if (!result?.ok) throw Error('Preference storage unavailable');
  }).catch(error => {
    if (revisions.get(key) === revision) { if (previous === undefined) delete values[key]; else values[key] = previous; }
    throw error;
  });
}
contextBridge.exposeInMainWorld('JubeatPreferences', Object.freeze({
  getItem,
  getAll: () => { if (!snapshot?.ok) throw Error("Preference storage unavailable"); return { ...values }; },
  setItem: (key, value) => write('set', key, value),
  removeItem: key => write('remove', key),
}));
