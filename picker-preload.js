// The screen-share picker window (picker.html) can only see thumbnail previews, ask to refresh, pick a source id, or cancel.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frxPicker', {
  onSources: cb => ipcRenderer.on('picker:sources', (_e, data) => cb(data || { sources: [], denied: false, loading: false })),
  refresh: () => ipcRenderer.send('picker:refresh'),
  choose: id => ipcRenderer.send('picker:choose', String(id || '')),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
