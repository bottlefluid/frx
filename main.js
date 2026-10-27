// Frixion for computers. A window around the Frixion website, a tray icon, start-with-computer, and the game detector
// that powers Activity Status. The website does all the real work; this app only adds what a browser tab can't do.
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, dialog, powerMonitor, globalShortcut, screen, Notification, net } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const detector = require('./detector');
const config = require('./config.json');

const SITE = new URL(config.url);
const SCAN_EVERY_MS = 12000;
const IDLE_AFTER_SECONDS = 10 * 60;   // like Discord: idle after 10 minutes without keyboard or mouse anywhere on the computer

// Sound from the Shop music should start without a click, like it does when you're already using the page.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Windows only shows an app's notifications (with its name and icon) when they carry the app's id.
if (process.platform === 'win32') app.setAppUserModelId('com.frixion.desktop');

let win = null, tray = null, quitting = false;
let updateReady = null;   // the version number of an update that is downloaded and waiting for a restart
let detectionOn = true, lastSent = 'null', scanTimer = null, scanning = false;

// Small saved preferences (close to tray). Kept next to the app's other data.
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = { closeToTray: true };
function loadPrefs() { try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch (e) {} }
function savePrefs() { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch (e) {} }

const isSiteUrl = u => { try { return new URL(u).origin === SITE.origin; } catch (e) { return false; } };
const iconPath = name => path.join(__dirname, 'build', name);

function createWindow(startHidden) {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 940, minHeight: 560,
    show: false, frame: false, backgroundColor: '#1e1f22', title: 'Frixion',
    icon: iconPath('icon.png'),
    // backgroundThrottling off: in the tray the window is hidden, and Chromium would otherwise slow the page's timers
    // until its connection to Frixion dropped, so friends saw this person go offline. The page pauses its own
    // animations while the window is hidden (see 'win:visible' below).
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.loadURL(config.url);
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;       // -3 is a cancelled load, not an error
    win.loadFile(path.join(__dirname, 'offline.html'), { search: 'retry=' + encodeURIComponent(config.url) });
  });
  guardNavigation(win);
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  ['show', 'hide', 'minimize', 'restore'].forEach(ev => win.on(ev, sendVisibility));
  win.webContents.on('did-finish-load', () => { sendVisibility(); lastIdle = null; checkIdle(); });
  win.on('close', (e) => {
    if (quitting || !prefs.closeToTray || !tray) return;
    e.preventDefault(); win.hide();                 // keep running in the tray so the activity status keeps working
  });
  win.on('closed', () => { win = null; });
}
function showWindow() { if (!win) createWindow(false); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
// Links to other sites open in the person's normal browser, never inside the app. A page may only go to the Frixion
// site (the offline page is opened by the app, which doesn't count as the page navigating).
function guardNavigation(w) {
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => {
    if (isSiteUrl(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}
// The page can't tell on its own that the window is in the tray (see backgroundThrottling above).
function sendVisibility() {
  if (win && !win.isDestroyed()) win.webContents.send('win:visible', win.isVisible() && !win.isMinimized());
}

// ---- Idle: friends see "Idle" after 10 minutes away from the computer or when it is locked, not when the window is hidden ----
let lastIdle = null, idleTimer = null;
function checkIdle() {
  let idle = false;
  try { idle = powerMonitor.getSystemIdleState(IDLE_AFTER_SECONDS) !== 'active'; } catch (e) {}
  if (idle === lastIdle) return;
  lastIdle = idle;
  if (win && !win.isDestroyed()) win.webContents.send('presence:idle', idle);
}
function startIdleWatch() {
  if (idleTimer) return;
  idleTimer = setInterval(checkIdle, 15000);
  powerMonitor.on('lock-screen', checkIdle);
  powerMonitor.on('unlock-screen', checkIdle);
  powerMonitor.on('resume', checkIdle);
}

// ---- Overlay: the overlay shortcut opens Frixion's overlay on top of other programs and games ----
// The shortcut is registered with the computer itself (globalShortcut), so it works while a game is in front. It shows the
// website in a see-through, always-on-top window (?overlay=1) that only draws the overlay. In Frixion's own window the
// page opens its overlay itself. Games in true (exclusive) fullscreen may minimize when the overlay takes focus; windowed
// and borderless fullscreen games are fine.
let overlay = null, overlayReady = false, overlayWanted = false;
let overlayBind = { code: 'Backquote', shift: true, ctrl: false, alt: false, meta: false };   // the website's default: Shift + `
let overlayAccel = null, overlayPaused = false, gameRunning = false;
const KEY_NAMES = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
// The website's format ({ code: 'Backquote', shift: true, ... }, from KeyboardEvent.code) to Electron's ('Shift+`').
function acceleratorFor(b) {
  if (!b || typeof b.code !== 'string') return null;
  const c = b.code;
  const key = KEY_NAMES[c] || (/^Key[A-Z]$/.test(c) && c.slice(3)) || (/^Digit\d$/.test(c) && c.slice(5))
    || (/^F([1-9]|1\d|2[0-4])$/.test(c) && c) || (/^Numpad\d$/.test(c) && 'num' + c.slice(6));
  if (!key) return null;
  return [b.ctrl && 'Control', b.alt && 'Alt', b.shift && 'Shift', b.meta && 'Super', key].filter(Boolean).join('+');
}
// Taking over a shortcut that types something (Shift + ` is ~) would stop it typing in every other program, so those
// are only taken while a game is running or the overlay is open. Ctrl, Alt and Windows-key combos and F-keys always work.
const typesSomething = b => !b.ctrl && !b.alt && !b.meta && !/^F\d+$/.test(b.code);
function updateOverlayShortcut() {
  const accel = overlayPaused ? null : acceleratorFor(overlayBind);
  const wanted = accel && (!typesSomething(overlayBind) || gameRunning || (overlay && overlay.isVisible())) ? accel : null;
  if (wanted === overlayAccel) return;
  if (overlayAccel) { try { globalShortcut.unregister(overlayAccel); } catch (e) {} }
  overlayAccel = null;
  if (wanted) { try { if (globalShortcut.register(wanted, onOverlayShortcut)) overlayAccel = wanted; } catch (e) {} }
}
function onOverlayShortcut() {
  if (overlay && overlay.isVisible()) { hideOverlay(); return; }
  if (win && win.isVisible() && win.isFocused()) { win.webContents.send('overlay', 'toggle'); return; }   // in Frixion itself
  showOverlay();
}
function ensureOverlay() {
  if (overlay) return;
  overlayReady = false;
  overlay = new BrowserWindow({
    show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, skipTaskbar: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true,
    title: 'Frixion overlay', icon: iconPath('icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');                 // above fullscreen windows too
  if (process.platform === 'darwin') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  guardNavigation(overlay);
  overlay.on('show', updateOverlayShortcut);
  overlay.on('hide', updateOverlayShortcut);
  overlay.on('closed', () => { overlay = null; overlayReady = false; updateOverlayShortcut(); });
  overlay.webContents.on('did-start-loading', () => { overlayReady = false; });
  overlay.webContents.on('did-fail-load', (_e, code, _d, _u, isMainFrame) => { if (isMainFrame && code !== -3 && overlay) overlay.destroy(); });
  const url = new URL(config.url);
  url.searchParams.set('overlay', '1');
  overlay.loadURL(url.toString());
}
function showOverlay() {
  ensureOverlay();
  overlayWanted = true;
  if (!overlayReady) return;                                    // opens as soon as the page has loaded (see 'overlay:ready')
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());   // the screen the game is on
  overlay.setBounds(d.bounds);
  // Opened right after a notification popped up over the game: open that chat, so it can be answered straight away.
  if (lastGameNote && lastGameNote.open && Date.now() - lastGameNote.at < 60000) overlay.webContents.send('notify:open', lastGameNote.open);
  lastGameNote = null;
  clearPopup();
  overlay.show();
  overlay.focus();
  overlay.webContents.send('overlay', 'show');
}
function hideOverlay() {
  overlayWanted = false;
  if (!overlay || !overlay.isVisible()) return;
  overlay.webContents.send('overlay', 'hide');
  overlay.hide();
}

// ---- Notifications: over the game while one is running (like Discord's overlay), otherwise Windows notifications ----
// While a game is in front, Windows usually holds its own notifications back, so the app draws them itself: a small
// see-through window in the bottom-right corner that never takes focus and lets every click through to the game.
// Games in true (exclusive) fullscreen may hide it; windowed and borderless fullscreen games show it.
let popup = null, popupCards = [], popupSeq = 0, lastGameNote = null;
const POPUP_W = 360, POPUP_CARD_H = 112, POPUP_MAX = 3, POPUP_MS = 6000;
const liveNotes = new Set();                                    // Windows notifications stay clickable only while referenced
function overlayHint() {
  const a = acceleratorFor(overlayBind);
  return a && !overlayPaused ? `Press ${a.replace(/\+/g, ' + ')} to answer` : '';
}
function ensurePopup() {
  if (popup && !popup.isDestroyed()) return;
  popup = new BrowserWindow({
    width: POPUP_W, height: POPUP_CARD_H, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false, alwaysOnTop: true, title: 'Frixion notification',
    webPreferences: { preload: path.join(__dirname, 'notify-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.setIgnoreMouseEvents(true);
  if (process.platform === 'darwin') popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', e => e.preventDefault());
  popup.webContents.on('did-finish-load', layoutPopup);
  popup.on('closed', () => { popup = null; });
  popup.loadFile(path.join(__dirname, 'notify.html'));
}
function layoutPopup() {
  if (!popup || popup.isDestroyed() || popup.webContents.isLoading()) return;
  if (!popupCards.length) { popup.hide(); popup.webContents.send('popup:cards', []); return; }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;   // the screen the game is on
  const h = popupCards.length * POPUP_CARD_H;
  popup.setBounds({ x: d.x + d.width - POPUP_W - 16, y: d.y + d.height - h - 64, width: POPUP_W, height: h });
  popup.webContents.send('popup:cards', popupCards);
  if (!popup.isVisible()) popup.showInactive();                 // never takes the game's focus
}
function clearPopup() { popupCards = []; layoutPopup(); }
function showGamePopup(n) {
  ensurePopup();
  const card = { id: ++popupSeq, title: n.title, body: n.body, icon: n.icon, hint: overlayHint() };
  popupCards = [...popupCards, card].slice(-POPUP_MAX);
  lastGameNote = { open: n.open, at: Date.now() };
  layoutPopup();
  setTimeout(() => { popupCards = popupCards.filter(c => c !== card); layoutPopup(); }, POPUP_MS);
}
// The sender's picture for a Windows notification: a data: picture, or a https: one fetched quickly; else Frixion's icon.
async function noteIcon(url) {
  let img = null;
  try {
    if (/^data:image\/(png|jpe?g|gif|webp);/i.test(url)) img = nativeImage.createFromDataURL(url);
    else if (/^https:\/\//i.test(url)) {
      const r = await net.fetch(url, { signal: AbortSignal.timeout(3000) });
      const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      if (buf && buf.length < 3e6) img = nativeImage.createFromBuffer(buf);
    }
  } catch (e) { img = null; }
  return img && !img.isEmpty() ? img : nativeImage.createFromPath(iconPath('icon.png'));
}
async function showWindowsNotification(n) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, icon: await noteIcon(n.icon), silent: true });   // the page plays Frixion's own sound
  liveNotes.add(note);
  const done = () => liveNotes.delete(note);
  note.on('click', () => { done(); showWindow(); if (n.open && win && !win.isDestroyed()) win.webContents.send('notify:open', n.open); });
  note.on('close', done);
  note.show();
  setTimeout(done, 5 * 60 * 1000);
}

function buildTray() {
  try {
    const img = nativeImage.createFromPath(iconPath('tray.png'));
    tray = new Tray(process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img);
  } catch (e) { return; }
  tray.setToolTip('Frixion');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Frixion', click: showWindow },
    ...(updateReady ? [{ label: 'Restart to update to ' + updateReady, click: installUpdate }] : []),
    { type: 'separator' },
    // args is how Windows starts it in the tray; openAsHidden is the Mac way.
    { label: 'Start with my computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: i => app.setLoginItemSettings({ openAtLogin: i.checked, openAsHidden: i.checked, args: i.checked ? ['--hidden'] : [] }) },
    { label: 'Keep running in the tray when I close the window', type: 'checkbox', checked: prefs.closeToTray, click: i => { prefs.closeToTray = i.checked; savePrefs(); } },
    { type: 'separator' },
    { label: 'Quit Frixion', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.setContextMenu(menu()));   // rebuilt so the checkmarks are always current
}

// ---- Updates: the app checks GitHub Releases, downloads quietly, then restarts into the new version ----
// Mac builds aren't signed, and macOS refuses to auto-update unsigned apps, so there the app just stays as installed.
function setupUpdates() {
  if (!app.isPackaged || process.platform === 'darwin') return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  global.autoUpdater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => {});               // offline or no release yet: try again next time
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version;
    if (!win || (!win.isVisible() && !win.isMinimized())) {
      // Living in the tray: nobody is looking, so just update, and come back in the tray rather than popping up.
      prefs.startHiddenOnce = true; savePrefs();
      installUpdate(); return;
    }
    if (win.isMinimized()) return;                  // don't interrupt; it's in the tray menu and installs when Frixion is closed
    dialog.showMessageBox(win, {
      type: 'info', title: 'Frixion update', message: 'A new version of Frixion is ready.',
      detail: 'Restart now to use version ' + info.version + ', or it will install the next time you close Frixion.',
      buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    }).then(r => { if (r.response === 0) installUpdate(); }).catch(() => {});
  });
  const check = () => { try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) {} };
  setTimeout(check, 15000);                        // shortly after opening, then every 4 hours
  setInterval(check, 4 * 60 * 60 * 1000);
}
function installUpdate() { quitting = true; if (global.autoUpdater) global.autoUpdater.quitAndInstall(false, true); }

// ---- Activity Status: look for games every few seconds and tell the website only when something changes ----
function sendActivity(a) {
  const s = JSON.stringify(a || null);
  if (s === lastSent) return;
  lastSent = s;
  if (win && !win.isDestroyed()) win.webContents.send('rpc:activity', a || null);
}
// The picture shown next to the activity is the program's own icon, read from its .exe (Windows) or .app (Mac). It's shrunk to a
// small PNG so it's light to share. Looked up once per program, then remembered. Linux just shows Frixion's built-in picture.
const iconCache = new Map();   // program name -> data URL, or null when there isn't one
function windowsExePath(name) {
  return new Promise(resolve => {
    const n = String(name).replace(/\.exe$/i, '');
    if (!/^[\w .\-()]+$/.test(n)) return resolve(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Name '${n.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`],
      { timeout: 10000, windowsHide: true }, (err, out) => resolve(err ? null : (String(out).trim() || null)));
  });
}
async function iconFor(program) {
  if (!program || !program.name) return null;
  const key = program.name.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  let url = null;
  try {
    let target = null;
    if (process.platform === 'win32') target = await windowsExePath(program.name);
    else if (process.platform === 'darwin' && program.path) { const mm = /^(.*?\.app)\//.exec(program.path); target = mm ? mm[1] : null; }
    if (target) {
      let img = await app.getFileIcon(target, { size: 'large' });
      const s = img.getSize();
      if (s.width > 64) img = img.resize({ width: 64, height: 64, quality: 'best' });
      if (!img.isEmpty()) { const png = img.toPNG(); if (png.length < 18000) url = 'data:image/png;base64,' + png.toString('base64'); }
    }
  } catch (e) { url = null; }
  iconCache.set(key, url);
  return url;
}
async function scanOnce() {
  if (scanning) return;
  scanning = true;
  try {
    // The overlay shortcut and notifications over games need to know when a game is running, so games are looked for
    // even while sharing is off (then nothing is sent anywhere; Spotify is only checked when sharing is on).
    let a = await detector.scan({ spotify: detectionOn });
    gameRunning = !!(a && a.type === 'playing');
    updateOverlayShortcut();
    if (!detectionOn) a = null;
    if (a) { const { program, ...rest } = a; a = rest; a.image = await iconFor(program); }
    sendActivity(a);
  }
  catch (e) { /* a failed scan just means "nothing found" this time */ }
  finally { scanning = false; }
}
function startScanning() { if (!scanTimer) { scanOnce(); scanTimer = setInterval(scanOnce, SCAN_EVERY_MS); } }

// ---- messages from the website (see preload.js) ----
const fromSite = e => e.sender === (win && win.webContents);
ipcMain.on('app:version', e => { e.returnValue = app.getVersion(); });
ipcMain.on('win:minimize', e => { if (fromSite(e)) win.minimize(); });
ipcMain.on('win:toggleMaximize', e => { if (fromSite(e)) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
ipcMain.on('win:close', e => { if (fromSite(e)) win.close(); });
ipcMain.on('win:askMaximized', e => { if (fromSite(e)) win.webContents.send('win:maximized', win.isMaximized()); });
ipcMain.on('rpc:ready', e => { if (fromSite(e)) { lastSent = 'null'; scanOnce(); } });
ipcMain.on('presence:askIdle', e => { if (fromSite(e)) { lastIdle = null; checkIdle(); } });
ipcMain.on('win:askVisible', e => { if (fromSite(e)) sendVisibility(); });
ipcMain.on('rpc:setEnabled', (e, on) => {
  if (!fromSite(e)) return;
  const was = detectionOn; detectionOn = !!on;
  if (was !== detectionOn) { if (!detectionOn) sendActivity(null); else scanOnce(); }
});
// The overlay window's page (see "Overlay" above)
const fromOverlay = e => !!overlay && e.sender === overlay.webContents;
ipcMain.on('overlay:ready', (e, signedIn) => {
  if (!fromOverlay(e)) return;
  overlayReady = !!signedIn;
  if (!overlayReady) { if (overlayWanted) { overlayWanted = false; showWindow(); } return; }   // nobody signed in: open Frixion
  if (overlayWanted) showOverlay();
});
ipcMain.on('overlay:hide', e => { if (fromOverlay(e)) hideOverlay(); });
// A notification from the website (it only asks while you aren't looking at Frixion).
ipcMain.on('notify:show', (e, n) => {
  if (!fromSite(e) || !n || typeof n !== 'object') return;
  if ((win && win.isVisible() && win.isFocused()) || (overlay && overlay.isVisible())) return;   // already looking at Frixion
  const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const o = n.open && typeof n.open === 'object' ? n.open : null;
  const note = {
    title: s(n.title, 100) || 'Frixion', body: s(n.body, 180), icon: typeof n.icon === 'string' && n.icon.length < 400000 ? n.icon : '',
    open: o ? { type: s(o.type, 10), id: s(o.id, 200), other: s(o.other, 60), sid: s(o.sid, 200), cid: s(o.cid, 200), tid: s(o.tid, 200) } : null,
  };
  if (n.inGame !== false && gameRunning) showGamePopup(note);
  else showWindowsNotification(note);
});
// The shortcut from Settings, in the website's format. null pauses it while Settings waits for a new one.
ipcMain.on('overlay:setShortcut', (e, b) => {
  if (!fromSite(e) && !fromOverlay(e)) return;
  if (b === null) overlayPaused = true;
  else if (b && typeof b.code === 'string') {
    overlayPaused = false;
    overlayBind = { code: b.code.slice(0, 32), shift: !!b.shift, ctrl: !!b.ctrl, alt: !!b.alt, meta: !!b.meta };
  }
  updateOverlayShortcut();
});

app.on('second-instance', showWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { quitting = true; });
app.on('activate', showWindow);                       // clicking the Dock icon on a Mac
app.on('window-all-closed', () => { if (quitting || !tray) app.quit(); });

app.whenReady().then(() => {
  loadPrefs();
  // Only the permissions Frixion actually uses.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['notifications', 'fullscreen', 'clipboard-sanitized-write', 'media'].includes(permission) && isSiteUrl(wc.getURL())));
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden || !!prefs.startHiddenOnce;
  if (prefs.startHiddenOnce) { delete prefs.startHiddenOnce; savePrefs(); }
  buildTray();
  createWindow(hidden && !!tray);
  startScanning();
  startIdleWatch();
  updateOverlayShortcut();
  setupUpdates();
});
