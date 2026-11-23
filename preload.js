const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('audio:state'),
  setVolume: (id, pct) => ipcRenderer.invoke('audio:setVolume', id, pct),
  toggleMute: (id) => ipcRenderer.invoke('audio:toggleMute', id),
  setDefault: (id) => ipcRenderer.invoke('audio:setDefault', id),
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  resize: (h) => ipcRenderer.send('ui:resize', h),
  hide: () => ipcRenderer.send('ui:hide'),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_, s) => cb(s)),
  onShown: (cb) => ipcRenderer.on('ui:shown', () => cb()),
});
