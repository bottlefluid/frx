// Frixion for computers. A window around the Frixion website, a tray icon, start-with-computer, and the game detector
// that powers Activity Status. The website does all the real work; this app only adds what a browser tab can't do.
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, dialog } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const detector = require('./detector');
const config = require('./config.json');

const SITE = new URL(config.url);
const SCAN_EVERY_MS = 12000;

// Sound from the Shop music should start without a click, like it does when you're already using the page.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.loadURL(config.url);
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;       // -3 is a cancelled load, not an error
    win.loadFile(path.join(__dirname, 'offline.html'), { search: 'retry=' + encodeURIComponent(config.url) });
  });
  // Links to other sites open in the person's normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (isSiteUrl(url) || url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  win.on('close', (e) => {
    if (quitting || !prefs.closeToTray || !tray) return;
    e.preventDefault(); win.hide();                 // keep running in the tray so the activity status keeps working
  });
  win.on('closed', () => { win = null; });
}
function showWindow() { if (!win) createWindow(false); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

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
    { label: 'Start with my computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: i => app.setLoginItemSettings({ openAtLogin: i.checked, args: i.checked ? ['--hidden'] : [] }) },
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
    if (!win || (!win.isVisible() && !win.isMinimized())) { installUpdate(); return; }   // living in the tray: nobody is looking, so just update
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
    let a = detectionOn ? await detector.scan() : null;
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
ipcMain.on('rpc:setEnabled', (e, on) => {
  if (!fromSite(e)) return;
  const was = detectionOn; detectionOn = !!on;
  if (was !== detectionOn) { if (!detectionOn) sendActivity(null); else scanOnce(); }
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('activate', showWindow);                       // clicking the Dock icon on a Mac
app.on('window-all-closed', () => { if (quitting || !tray) app.quit(); });

app.whenReady().then(() => {
  loadPrefs();
  // Only the permissions Frixion actually uses.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['notifications', 'fullscreen', 'clipboard-sanitized-write', 'media'].includes(permission) && isSiteUrl(wc.getURL())));
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  buildTray();
  createWindow(hidden && !!tray);
  startScanning();
  setupUpdates();
});
