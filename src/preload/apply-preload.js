'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('applyApi', {
  context: () => ipcRenderer.invoke('browser:context'),
  fill: () => ipcRenderer.invoke('browser:fill'),
  attach: (which) => ipcRenderer.invoke('browser:attach', { which }),
  reveal: (which) => ipcRenderer.invoke('browser:reveal', { which }),
  nav: (action) => ipcRenderer.invoke('browser:nav', { action }),
  close: () => ipcRenderer.invoke('browser:close'),
  markSubmitted: (applicationId) => ipcRenderer.invoke('browser:submitted', { applicationId }),
  onNav: (fn) => on('nav', fn),
  onContext: (fn) => on('context', fn),
  onLoadError: (fn) => on('loadError', fn),
});
