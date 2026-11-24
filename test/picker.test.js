// Run with: npm test (no packages needed)
'use strict';
const assert = require('assert');
const p = require('../picker-sources');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const fakeImg = (url, empty = false) => ({ isEmpty: () => empty, toDataURL: () => url });

t('filters out Frixion helper windows and unnamed windows, keeps screens and normal windows', () => {
  const { cards, byId } = p.serializeSources([
    { id: 'window:1:0', name: 'Frixion notification', thumbnail: fakeImg('data:image/png;base64,AAA') },
    { id: 'window:2:0', name: 'Frixion overlay', thumbnail: fakeImg('data:image/png;base64,BBB') },
    { id: 'window:3:0', name: 'Share your screen', thumbnail: fakeImg('data:image/png;base64,CCC') },
    { id: 'window:4:0', name: '   ', thumbnail: fakeImg('data:image/png;base64,DDD') },
    { id: 'window:5:0', name: 'Visual Studio Code', thumbnail: fakeImg('data:image/png;base64,EEE'), appIcon: fakeImg('data:image/png;base64,ICON') },
    { id: 'screen:0:0', name: 'Entire screen', thumbnail: fakeImg('data:image/png;base64,FFF') },
  ]);
  assert.strictEqual(cards.length, 2);
  assert.strictEqual(cards[0].id, 'screen:0:0');
  assert.strictEqual(cards[0].kind, 'screen');
  assert.strictEqual(cards[1].id, 'window:5:0');
  assert.strictEqual(cards[1].kind, 'window');
  assert.strictEqual(cards[1].icon, 'data:image/png;base64,ICON');
  assert.strictEqual(byId.size, 2);
  assert.ok(!byId.has('window:1:0'));
});

t('drops non-data-image URLs and empty thumbnails safely', () => {
  const { cards } = p.serializeSources([
    { id: 'screen:1:0', name: 'Display 2', thumbnail: fakeImg('javascript:alert(1)') },
    { id: 'window:9:0', name: 'Game', thumbnail: fakeImg('data:image/png;base64,OK'), appIcon: fakeImg('', true) },
  ]);
  assert.strictEqual(cards[0].thumb, '');
  assert.strictEqual(cards[1].thumb, 'data:image/png;base64,OK');
  assert.strictEqual(cards[1].icon, '');
});

t('display media request gate allows only Frixion site origin', () => {
  const isSite = u => { try { return new URL(u).origin === 'https://frixionbeta.pages.dev'; } catch (e) { return false; } };
  assert.strictEqual(p.isAllowedDisplayRequest({ frame: { url: 'https://frixionbeta.pages.dev/' } }, isSite), true);
  assert.strictEqual(p.isAllowedDisplayRequest({ securityOrigin: 'https://frixionbeta.pages.dev' }, isSite), true);
  assert.strictEqual(p.isAllowedDisplayRequest({ frame: { url: 'https://evil.example/' } }, isSite), false);
  assert.strictEqual(p.isAllowedDisplayRequest({ frame: { url: 'https://frixionbeta.pages.dev.evil.com/' } }, isSite), false);
  assert.strictEqual(p.isAllowedDisplayRequest(null, isSite), false);
});

console.log(n + ' picker tests passed');
