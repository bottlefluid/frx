// The only thing the website can see of the desktop app: window.frixionDesktop. It can move/close the window, hear about detected
// activity, idle and window visibility, and tell the app whether detection is allowed. It can't run commands, read files or touch
// the system in any other way.
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
  // cb(true|false) when the computer goes idle (10 minutes without keyboard or mouse, or locked) or comes back (and once right away)
  onIdleChange: cb => {
    ipcRenderer.on('presence:idle', (_e, v) => cb(!!v));
    ipcRenderer.send('presence:askIdle');
  },
  // cb(true|false) when the window is shown or hidden in the tray / minimized (and once right away)
  onWindowVisibility: cb => {
    ipcRenderer.on('win:visible', (_e, v) => cb(!!v));
    ipcRenderer.send('win:askVisible');
  },
  // The overlay shortcut, in the website's format ({ code, shift, ctrl, alt, meta }); null pauses it. The app registers it
  // with the computer so it works on top of other programs.
  setOverlayShortcut: b => ipcRenderer.send('overlay:setShortcut', b ? { code: String(b.code), shift: !!b.shift, ctrl: !!b.ctrl, alt: !!b.alt, meta: !!b.meta } : null),
  // cb('show' | 'hide' | 'toggle'): the app asks the page to open or close the overlay
  onOverlay: cb => ipcRenderer.on('overlay', (_e, what) => cb(String(what))),
  // Only used by the overlay window: it has loaded (and whether someone is signed in), or it wants to go away
  overlayReady: signedIn => ipcRenderer.send('overlay:ready', !!signedIn),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  // A notification ({ title, body, icon, open, inGame }): the app shows it over the game you're playing, or as a Windows
  // notification. open says which chat it's about.
  notify: n => {
    if (!n || typeof n !== 'object') return;
    const o = n.open && typeof n.open === 'object' ? n.open : null;
    const s = v => (typeof v === 'string' ? v : null);
    ipcRenderer.send('notify:show', { title: String(n.title || ''), body: String(n.body || ''), icon: String(n.icon || ''), inGame: n.inGame !== false,
      open: o ? { type: s(o.type), id: s(o.id), other: s(o.other), sid: s(o.sid), cid: s(o.cid), tid: s(o.tid) } : null });
  },
  // cb(open) when a notification is clicked, or when the overlay opens right after one popped up over a game
  onNotifyOpen: cb => ipcRenderer.on('notify:open', (_e, o) => cb(o || null)),
});
