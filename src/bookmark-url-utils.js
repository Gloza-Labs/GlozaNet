// ============================================================================
// bookmark-url-utils.js — pure URL validation/normalization shared by every
// bookmark store (toolbar tree and home-screen collection) in main.js. Pulled
// out into its own Electron-free module specifically so it can be exercised
// by test/home-bookmarks-test.js under plain Node, the same pattern already
// used for the ad-blocker engine (see adblock/engine.js + its test file).
// ============================================================================

'use strict';

// http(s) only. Explicitly rejects javascript:/data:/vbscript:/file: and any
// other scheme that would be dangerous to store and later "open" with a
// click — ordinary web bookmarks should always end up http:// or https://.
function isSafeBookmarkUrl(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) candidate = `https://${candidate}`;
  let u;
  try { u = new URL(candidate); } catch { return false; }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

// Adds https:// to a protocol-less entry ("example.com" -> "https://example.com/")
// and otherwise leaves the user's intended destination alone — never
// rewrites http to https or changes host/path/query. Caller must have
// already confirmed isSafeBookmarkUrl(raw).
function normalizeBookmarkUrl(raw) {
  const trimmed = raw.trim();
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(candidate).href;
}

module.exports = { isSafeBookmarkUrl, normalizeBookmarkUrl };
