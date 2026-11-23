const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('audio:state'),
  setVolume: (id, pct) => ipcRenderer.invoke('audio:setVolume', id, pct),
  toggleMute: (id) => ipcRenderer.invoke('audio:toggleMute', id),
  setDefault: (id) => ipcRenderer.invoke('audio:setDefault', id),
  getApps: () => ipcRenderer.invoke('apps:list'),
  setAppVolume: (target, pct) => ipcRenderer.invoke('apps:setVolume', target, pct),
  setAppMute: (target, muted) => ipcRenderer.invoke('apps:setMute', target, muted),
  openMixer: () => ipcRenderer.invoke('ui:openMixer'),
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_, s) => cb(s)),
  onShown: (cb) => ipcRenderer.on('ui:shown', () => cb()),
});
