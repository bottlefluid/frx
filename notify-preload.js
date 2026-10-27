// The notification pop-up over games (notify.html) can only hear which cards to show. Nothing else.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frxPopup', {
  onCards: cb => ipcRenderer.on('popup:cards', (_e, cards) => cb(Array.isArray(cards) ? cards : [])),
});
