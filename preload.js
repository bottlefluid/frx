// The only thing the website can see of the desktop app: window.frixionDesktop. It can move/close the window, hear about detected
// activity, and tell the app whether detection is allowed. It can't run commands, read files or touch the system in any other way.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frixionDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: ipcRenderer.sendSync('app:version'),
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  close: () => ipcRenderer.send('win:close'),
  // cb(true|false) whenever the window is maximized or restored (and once right away)
  onMaximizeChange: cb => {
    ipcRenderer.on('win:maximized', (_e, v) => cb(!!v));
    ipcRenderer.send('win:askMaximized');
  },
  // cb(activity|null) whenever the detected game / song changes (and once right away)
  onActivity: cb => {
    ipcRenderer.on('rpc:activity', (_e, a) => cb(a || null));
    ipcRenderer.send('rpc:ready');
  },
  // Frixion tells the app whether detection should run (the person's "Share my activity" and "Detect games" settings)
  setDetection: on => ipcRenderer.send('rpc:setEnabled', !!on),
});
