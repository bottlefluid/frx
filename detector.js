// Works out what someone is doing on their computer: a known game that is running, or the song playing in the Spotify app.
// It only ever looks at program names (and the Spotify window title). Nothing is recorded or sent anywhere except the
// activity itself, which Frixion shows to friends. No dependencies: it uses the commands every system already has.
'use strict';
const { execFile } = require('child_process');
const path = require('path');
const DB = require('./games.json');

const norm = n => String(n || '').trim().toLowerCase().replace(/\.exe$/, '');
const run = (cmd, args, timeout = 8000) => new Promise(resolve => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

// ---- reading the process list (one line per program) ----
function parseCsvLine(line) {            // "a","b c","d" -> [a, b c, d]
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
// `tasklist /fo csv /nh` gives "Image Name","PID",... and with /v the last column is the window title.
function parseTasklist(text, verbose) {
  return text.split(/\r?\n/).filter(Boolean).map(parseCsvLine).filter(c => c.length >= 2).map(c => ({ name: c[0], title: verbose && c.length >= 9 ? c[c.length - 1] : '' }));
}
// `ps -axo comm=` gives one command per line, on Mac as a full path.
function parsePs(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ name: path.basename(l), title: '', path: l }));
}
async function listProcesses() {
  if (process.platform === 'win32') return parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh']), false);
  return parsePs(await run('ps', ['-axo', 'comm=']));
}
// Window titles only for the programs that need them (the full list with titles is slow on Windows).
async function titlesFor(exeName) {
  if (process.platform === 'win32') return parseTasklist(await run('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', `IMAGENAME eq ${exeName}`], 12000), true).map(p => p.title);
  if (process.platform === 'darwin') return [];
  return [];
}

// ---- matching ----
// Linux cuts program names to 15 characters, so a 15-character name matches any name that starts with it.
function sameProgram(procName, wanted) {
  const a = norm(procName), b = norm(wanted);
  if (a === b) return true;
  return a.length === 15 && b.startsWith(a);
}
function findGames(procs, db = DB) {
  const hits = [];
  for (const g of db.games) {
    const proc = procs.find(p => g.exe.some(e => sameProgram(p.name, e)));
    if (proc) hits.push({ game: g, proc });
  }
  return hits;
}
// "Artist - Song" while Spotify is playing; just "Spotify", "Spotify Free" or "Spotify Premium" when it isn't.
function parseSpotifyTitle(title) {
  const t = String(title || '').trim();
  if (!t || /^spotify(\s+(free|premium))?$/i.test(t) || /^(n\/a)$/i.test(t)) return null;
  const i = t.indexOf(' - ');
  if (i < 1) return null;
  return { artist: t.slice(0, i).trim(), song: t.slice(i + 3).trim() };
}
async function spotifyNowPlaying(procs, db = DB) {
  const proc = procs.find(p => db.spotify.exe.some(e => sameProgram(p.name, e)));
  if (!proc) return null;
  if (process.platform === 'win32') {
    for (const t of await titlesFor(proc.name)) { const r = parseSpotifyTitle(t); if (r) return { ...r, proc }; }
    return null;
  }
  if (process.platform === 'darwin') {
    const out = (await run('osascript', ['-e', 'tell application "Spotify" to if player state is playing then (artist of current track) & "\n" & (name of current track)'])).trim().split('\n');
    return out.length >= 2 && out[1] ? { artist: out[0], song: out.slice(1).join(' '), proc } : null;
  }
  const out = (await run('playerctl', ['-p', 'spotify', 'metadata', '--format', '{{artist}}\n{{title}}'])).trim().split('\n');   // needs playerctl installed
  return out.length >= 2 && out[1] ? { artist: out[0], song: out.slice(1).join(' '), proc } : null;
}

// ---- the detector: call scan() every few seconds; it returns the current activity (or null) ----
// scan({ spotify: false }) only looks for games.
const firstSeen = new Map();       // game name -> when it was first noticed running
async function scan(opts = {}) {
  const procs = await listProcesses();
  if (!procs.length) return null;
  let hits = findGames(procs);
  // Entries with a titleStarts need the window title to match as well (Java programs are all "javaw.exe").
  const checked = [];
  for (const h of hits) {
    if (!h.game.titleStarts) { checked.push(h); continue; }
    const titles = await titlesFor(h.proc.name);
    if (titles.some(t => t.toLowerCase().startsWith(h.game.titleStarts.toLowerCase()))) checked.push(h);
  }
  hits = checked;
  const now = Date.now();
  const names = new Set(hits.map(h => h.game.name));
  [...firstSeen.keys()].forEach(n => { if (!names.has(n)) firstSeen.delete(n); });
  hits.forEach(h => { if (!firstSeen.has(h.game.name)) firstSeen.set(h.game.name, now); });
  if (hits.length) {
    // If several are open, show the one that was started last.
    const best = hits.slice().sort((a, b) => firstSeen.get(b.game.name) - firstSeen.get(a.game.name))[0];
    return { type: 'playing', name: best.game.name, details: '', state: '', image: null, startedAt: firstSeen.get(best.game.name), source: 'desktop', program: { name: best.proc.name, path: best.proc.path || null } };
  }
  if (opts.spotify === false) return null;
  const sp = await spotifyNowPlaying(procs);
  if (sp) return { type: 'listening', name: sp.song, details: sp.artist, state: 'on Spotify', image: null, startedAt: null, source: 'desktop', program: { name: sp.proc.name, path: sp.proc.path || null } };
  return null;
}
module.exports = { scan, parseTasklist, parsePs, findGames, parseSpotifyTitle, sameProgram, norm };
