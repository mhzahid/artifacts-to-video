// Bridge between the sandboxed window and the main process. Only these calls are exposed.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('a2v', {
  init: () => ipcRenderer.invoke('init'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  addFiles: (files) => ipcRenderer.invoke('add-files', Array.from(files || []).map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  removeItem: (id) => ipcRenderer.invoke('remove-item', id),
  clearFinished: () => ipcRenderer.invoke('clear-finished'),
  convert: (ids, options, perItem) => ipcRenderer.invoke('convert', { ids, options, perItem }),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  cancelAll: () => ipcRenderer.invoke('cancel-all'),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openOutputDir: () => ipcRenderer.invoke('open-output-dir'),
  chooseOutputDir: () => ipcRenderer.invoke('choose-output-dir'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  pickWatermark: () => ipcRenderer.invoke('pick-watermark'),
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  removeAudio: (id) => ipcRenderer.invoke('remove-audio', id),
  previewFrame: (id, time, options) => ipcRenderer.invoke('preview-frame', { id, time, options }),
  systemCheck: () => ipcRenderer.invoke('system-check'),
  rerunSystemCheck: () => ipcRenderer.invoke('rerun-system-check'),
  openLog: () => ipcRenderer.invoke('open-log'),
  onSystemCheck: (fn) => { const h = (e, c) => fn(c); ipcRenderer.on('system-check', h); return () => ipcRenderer.off('system-check', h); },
  onItem: (fn) => { const h = (e, item) => fn(item); ipcRenderer.on('item', h); return () => ipcRenderer.off('item', h); },
});
