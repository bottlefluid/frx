// Helpers for the desktop screen-share picker (pure JS so they can be unit-tested without Electron).
'use strict';

const HIDDEN_WINDOWS = new Set(['Frixion notification', 'Frixion overlay', 'Share your screen']);

function safeDataUrl(img) {
  try {
    if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return '';
    const u = typeof img.toDataURL === 'function' ? img.toDataURL() : '';
    return /^data:image\/(png|jpe?g|webp);base64,/i.test(u) ? u : '';
  } catch (e) {
    return '';
  }
}

function serializeSources(rawSources) {
  const cards = [];
  const byId = new Map();
  for (const s of rawSources || []) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    const kind = s.id.startsWith('screen:') ? 'screen' : 'window';
    const name = String(s.name || '').trim();
    if (kind === 'window' && (!name || HIDDEN_WINDOWS.has(name))) continue;
    byId.set(s.id, s);
    cards.push({
      id: s.id,
      kind,
      name: name || (kind === 'screen' ? 'Screen' : 'Window'),
      thumb: safeDataUrl(s.thumbnail),
      icon: kind === 'window' ? safeDataUrl(s.appIcon) : '',
    });
  }
  cards.sort((a, b) => (a.kind === b.kind ? 0 : (a.kind === 'screen' ? -1 : 1)));
  return { cards, byId };
}

function isAllowedDisplayRequest(request, isSiteUrl) {
  if (!request || typeof isSiteUrl !== 'function') return false;
  const frameUrl = request.frame && typeof request.frame.url === 'string' ? request.frame.url : '';
  const origin = typeof request.securityOrigin === 'string' ? request.securityOrigin : '';
  return isSiteUrl(frameUrl || origin);
}

module.exports = { serializeSources, isAllowedDisplayRequest, HIDDEN_WINDOWS };
