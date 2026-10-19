// Run with: npm test   (no packages needed)
'use strict';
const assert = require('assert');
const d = require('../detector');
const db = require('../games.json');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

t('reads a Windows tasklist', () => {
  const txt = '"System Idle Process","0","Services","0","8 K"\r\n"RobloxPlayerBeta.exe","4242","Console","1","812,000 K"\r\n"Spotify.exe","77","Console","1","300,000 K"\r\n';
  const p = d.parseTasklist(txt, false);
  assert.strictEqual(p.length, 3); assert.strictEqual(p[1].name, 'RobloxPlayerBeta.exe');
});
t('reads window titles from a verbose Windows tasklist', () => {
  const txt = '"Spotify.exe","77","Console","1","300,000 K","Running","PC\\\\me","0:01:02","PinocchioP - Pinocchio"\r\n"Spotify.exe","78","Console","1","9 K","Running","PC\\\\me","0:00:01","N/A"\r\n';
  const p = d.parseTasklist(txt, true);
  assert.strictEqual(p[0].title, 'PinocchioP - Pinocchio'); assert.strictEqual(p[1].title, 'N/A');
});
t('reads a Mac/Linux ps list', () => {
  const p = d.parsePs('/Applications/Terraria.app/Contents/MacOS/Terraria\n/usr/bin/zsh\n');
  assert.deepStrictEqual(p.map(x => x.name), ['Terraria', 'zsh']);
});
t('finds a known game, ignoring case and .exe', () => {
  const hits = d.findGames([{ name: 'robloxplayerbeta.EXE' }, { name: 'chrome.exe' }]);
  assert.strictEqual(hits.length, 1); assert.strictEqual(hits[0].game.name, 'Roblox');
});
t('finds nothing for ordinary programs', () => {
  assert.strictEqual(d.findGames([{ name: 'chrome.exe' }, { name: 'explorer.exe' }, { name: 'Code.exe' }]).length, 0);
});
t('Linux 15-character cut-off names still match', () => {
  assert.ok(d.sameProgram('FortniteClient-', 'FortniteClient-Win64-Shipping.exe'));
  assert.ok(!d.sameProgram('chrome', 'cs2.exe'));
});
t('Spotify window titles', () => {
  assert.deepStrictEqual(d.parseSpotifyTitle('PinocchioP - Pinocchio'), { artist: 'PinocchioP', song: 'Pinocchio' });
  assert.deepStrictEqual(d.parseSpotifyTitle('AC/DC - Back In Black - Remastered'), { artist: 'AC/DC', song: 'Back In Black - Remastered' });
  ['Spotify', 'Spotify Free', 'Spotify Premium', 'N/A', '', null].forEach(x => assert.strictEqual(d.parseSpotifyTitle(x), null));
});
t('the game list is well formed', () => {
  assert.ok(db.games.length > 40);
  db.games.forEach(g => { assert.ok(g.name && Array.isArray(g.exe) && g.exe.length, 'bad entry ' + JSON.stringify(g)); });
  assert.ok(db.spotify.exe.length);
});
t('Minecraft entry needs the window title (so other Java programs do not count)', () => {
  const mc = db.games.find(g => g.name === 'Minecraft' && g.titleStarts);
  assert.ok(mc && mc.exe.includes('javaw.exe'));
});
console.log(n + ' tests passed');
