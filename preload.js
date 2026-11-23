const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('audio:state'),
  setVolume: (id, pct) => ipcRenderer.invoke('audio:setVolume', id, pct),
  toggleMute: (id) => ipcRenderer.invoke('audio:toggleMute', id),
  setDefault: (id) => ipcRenderer.invoke('audio:setDefault', id),
  getApps: () => ipcRenderer.invoke('apps:list'),
  setAppVolume: (target, pct) => ipcRenderer.invoke('apps:setVolume', target, pct),
  setAppMute: (target, muted) => ipcRenderer.invoke('apps:setMute', target, muted),
  setAppDevice: (target, deviceId, kind) => ipcRenderer.invoke('apps:setDevice', target, deviceId, kind),
  getPower: () => ipcRenderer.invoke('power:list'),
  setPower: (id) => ipcRenderer.invoke('power:set', id),
  getSystem: () => ipcRenderer.invoke('sys:state'),
  setGameGpu: (pref) => ipcRenderer.invoke('game:setGpu', pref),
  resetGameStats: () => ipcRenderer.invoke('game:resetStats'),
  enableSensors: () => ipcRenderer.invoke('sys:enable'),
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_, s) => cb(s)),
  onShown: (cb) => ipcRenderer.on('ui:shown', () => cb()),
});
