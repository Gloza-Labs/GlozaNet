// ============================================================================
// test/home-bookmarks-test.js — regression tests for the Part 1 home-screen
// bookmark backend. Runs under plain Node (no Electron binary required —
// same reasoning as test/adblock-engine-test.js): the URL validation/
// normalization logic lives in src/bookmark-url-utils.js specifically so it
// has no dependency on 'electron' and can be required directly here.
//
// What this file does NOT (and cannot, in this sandbox) cover: the
// home-bookmarks:* IPC handlers themselves (they live in main.js, which
// requires 'electron' at the top and is only meaningfully exercised inside a
// running Electron app), live favicon loading, the dialog, the context menu/
// submenu, and anything about actual on-screen rendering. See the Part 1
// delivery report for the full list of what was smoke-tested by inspection
// instead of by an automated run.
//
// Run with: node test/home-bookmarks-test.js
// ============================================================================

'use strict';

const assert = require('assert');
const { isSafeBookmarkUrl, normalizeBookmarkUrl } = require('../src/bookmark-url-utils');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

test('1a. accepts an ordinary https URL', () => {
  assert.strictEqual(isSafeBookmarkUrl('https://example.com'), true);
});

test('1b. accepts a bare domain (protocol added implicitly)', () => {
  assert.strictEqual(isSafeBookmarkUrl('example.com'), true);
  assert.strictEqual(normalizeBookmarkUrl('example.com'), 'https://example.com/');
});

test('1c. accepts an explicit http URL and does NOT upgrade it to https', () => {
  assert.strictEqual(isSafeBookmarkUrl('http://example.com'), true);
  assert.strictEqual(normalizeBookmarkUrl('http://example.com'), 'http://example.com/');
});

test('1d. rejects empty / whitespace-only input', () => {
  assert.strictEqual(isSafeBookmarkUrl(''), false);
  assert.strictEqual(isSafeBookmarkUrl('   '), false);
  assert.strictEqual(isSafeBookmarkUrl(undefined), false);
  assert.strictEqual(isSafeBookmarkUrl(null), false);
});

test('1e. rejects javascript: URLs', () => {
  assert.strictEqual(isSafeBookmarkUrl('javascript:alert(1)'), false);
});

test('1f. rejects data: URLs', () => {
  assert.strictEqual(isSafeBookmarkUrl('data:text/html,<script>alert(1)</script>'), false);
});

test('1g. rejects vbscript: and file: URLs', () => {
  assert.strictEqual(isSafeBookmarkUrl('vbscript:msgbox(1)'), false);
  assert.strictEqual(isSafeBookmarkUrl('file:///etc/passwd'), false);
});

test('1h. rejects garbage that cannot be parsed as a URL even with https:// prepended', () => {
  assert.strictEqual(isSafeBookmarkUrl('   '), false);
  assert.strictEqual(isSafeBookmarkUrl('::::'), false);
});

test('1i. normalization preserves path/query/fragment exactly, only adding a scheme', () => {
  assert.strictEqual(
    normalizeBookmarkUrl('example.com/a/b?x=1#frag'),
    'https://example.com/a/b?x=1#frag',
  );
});

test('1j. a URL that already has a scheme is left otherwise untouched', () => {
  assert.strictEqual(normalizeBookmarkUrl('https://example.com/path'), 'https://example.com/path');
});

// ---------------------------------------------------------------------------
// 4-slot capacity rule — the same trim/limit logic main.js applies in
// loadHomeBookmarks()/saveHomeBookmarks(), re-expressed here directly (both
// require 'electron' to import for real) so the CONTRACT is pinned by a
// test even though the IPC handlers themselves can't run in this sandbox.
// ---------------------------------------------------------------------------

const HOME_BOOKMARKS_LIMIT = 4;
function enforceLimit(list) {
  return (list || []).slice(0, HOME_BOOKMARKS_LIMIT);
}

test('2a. 0..4 bookmarks all pass through unchanged', () => {
  for (let n = 0; n <= 4; n++) {
    const list = Array.from({ length: n }, (_, i) => ({ id: i, url: `https://site${i}.example/` }));
    assert.strictEqual(enforceLimit(list).length, n);
  }
});

test('2b. a 5th+ entry is trimmed, never silently kept', () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ id: i, url: `https://site${i}.example/` }));
  const result = enforceLimit(list);
  assert.strictEqual(result.length, 4);
  assert.deepStrictEqual(result.map((b) => b.id), [0, 1, 2, 3]);
});

test('2c. the limit is enforced against the real list length, not a displayed count — '
  + 'simulates a corrupt/hand-edited file with 6 saved entries still being capped to 4 on load', () => {
  const corruptOnDisk = Array.from({ length: 6 }, (_, i) => ({ id: i, url: `https://site${i}.example/` }));
  assert.strictEqual(enforceLimit(corruptOnDisk).length, 4);
});



// ---------------------------------------------------------------------------
// home-bookmarks:reorder reconciliation (Part 2 — Settings bookmark
// manager's move-up/move-down). The real handler lives in main.js (requires
// 'electron', not runnable here — same limitation noted at the top of this
// file for add/update/remove/moveToToolbar), so this re-implements the same
// pure reconciliation algorithm used there to verify its logic in isolation:
// every id present in both the saved list and the requested order is placed
// per the requested order; anything saved but NOT mentioned in the request
// is appended afterward, preserving its relative order, instead of being
// dropped.
// ---------------------------------------------------------------------------
function reconcileOrder(list, orderedIds) {
  const byId = new Map(list.map((b) => [b.id, b]));
  const next = [];
  for (const id of orderedIds) {
    const b = byId.get(id);
    if (b) { next.push(b); byId.delete(id); }
  }
  for (const b of byId.values()) next.push(b);
  return next;
}

test('3a. reorder: a full, valid id list reorders exactly as requested', () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const result = reconcileOrder(list, [3, 1, 2]);
  assert.deepStrictEqual(result.map((b) => b.id), [3, 1, 2]);
});

test('3b. reorder: an id missing from the request is appended, not dropped', () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const result = reconcileOrder(list, [2]); // id 1 and 3 omitted
  assert.deepStrictEqual(result.map((b) => b.id), [2, 1, 3]);
});

test('3c. reorder: an id in the request that no longer exists is silently ignored', () => {
  const list = [{ id: 1 }, { id: 2 }];
  const result = reconcileOrder(list, [99, 2, 1]); // 99 was deleted elsewhere already
  assert.deepStrictEqual(result.map((b) => b.id), [2, 1]);
});

test('3d. reorder: an empty request leaves the saved order unchanged', () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const result = reconcileOrder(list, []);
  assert.deepStrictEqual(result.map((b) => b.id), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Home Screen background resolution (Part 2) — reimplements the pure
// decision logic of resolveHomeBackground() in main.js (the real function
// also calls fs.statSync via an Electron-resolved userData path, so it can't
// be imported directly here — same limitation as every other main.js-only
// handler in this file). `fileExists` stands in for the real filesystem
// check so the DECISION logic (not disk I/O) is what's actually verified:
// default/color/image mode selection, an unknown saved colorId falling back
// to 'charcoal' rather than crashing or rendering nothing, and a missing
// custom-image file falling back to the default background WITHOUT losing
// the saved preference itself (the caller — main.js — never writes anything
// back here; this function is read-only).
// ---------------------------------------------------------------------------
const HOME_BG_COLORS = {
  charcoal: '#14181a', midnight: '#0b1220', forest: '#0e1f16',
  slate: '#1b222b', plum: '#1d1626', sand: '#2a2420',
};
function resolveHomeBackground(prefs, fileExists) {
  const mode = prefs.homeBackgroundMode;
  if (mode === 'color') {
    const hex = HOME_BG_COLORS[prefs.homeBackgroundColor] || HOME_BG_COLORS.charcoal;
    return { mode: 'color', color: hex, imageUrl: null };
  }
  if (mode === 'image' && prefs.homeBackgroundImageFile) {
    if (fileExists(prefs.homeBackgroundImageFile)) {
      return { mode: 'image', color: null, imageUrl: `file:///fake/${prefs.homeBackgroundImageFile}` };
    }
    // file missing/unreadable — fall through to default, same as main.js
  }
  return { mode: 'default', color: null, imageUrl: null };
}

test('4a. background: mode "default" ignores color/image fields entirely', () => {
  const result = resolveHomeBackground(
    { homeBackgroundMode: 'default', homeBackgroundColor: 'forest', homeBackgroundImageFile: 'x.png' },
    () => true,
  );
  assert.deepStrictEqual(result, { mode: 'default', color: null, imageUrl: null });
});

test('4b. background: mode "color" resolves a known id to its hex value', () => {
  const result = resolveHomeBackground({ homeBackgroundMode: 'color', homeBackgroundColor: 'plum' }, () => true);
  assert.strictEqual(result.mode, 'color');
  assert.strictEqual(result.color, HOME_BG_COLORS.plum);
});

test('4c. background: an unknown/corrupt saved colorId falls back to charcoal, never crashes', () => {
  const result = resolveHomeBackground({ homeBackgroundMode: 'color', homeBackgroundColor: 'not-a-real-id' }, () => true);
  assert.strictEqual(result.color, HOME_BG_COLORS.charcoal);
});

test('4d. background: mode "image" with an existing file resolves to an image URL', () => {
  const result = resolveHomeBackground(
    { homeBackgroundMode: 'image', homeBackgroundImageFile: 'bg-123.png' },
    (name) => name === 'bg-123.png',
  );
  assert.strictEqual(result.mode, 'image');
  assert.ok(result.imageUrl.includes('bg-123.png'));
});

test('4e. background: mode "image" with a missing/deleted file falls back to default, '
  + 'not a broken background — the caller never mutates the preference itself here', () => {
  const prefs = { homeBackgroundMode: 'image', homeBackgroundImageFile: 'gone.png' };
  const result = resolveHomeBackground(prefs, () => false);
  assert.strictEqual(result.mode, 'default');
  // the input preference object is untouched — recovery (e.g. a restored
  // backup bringing the file back) is possible on a later read
  assert.strictEqual(prefs.homeBackgroundMode, 'image');
  assert.strictEqual(prefs.homeBackgroundImageFile, 'gone.png');
});

test('4f. background: mode "image" with no image ever chosen (empty filename) falls back to default', () => {
  const result = resolveHomeBackground({ homeBackgroundMode: 'image', homeBackgroundImageFile: '' }, () => true);
  assert.strictEqual(result.mode, 'default');
});

// ---------------------------------------------------------------------------
// "Use this picture" (prefs:setHomeBackgroundImageMode) — switches back to a
// previously-chosen custom image without reopening the file picker, but only
// when one is actually still on disk. Reimplements the pure guard logic.
// ---------------------------------------------------------------------------
function switchToStoredImage(prefs, fileExists) {
  if (!prefs.homeBackgroundImageFile) return { mode: prefs.homeBackgroundMode, error: 'no-image' };
  if (!fileExists(prefs.homeBackgroundImageFile)) return { mode: prefs.homeBackgroundMode, error: 'no-image' };
  return { mode: 'image' };
}

test('4g. "Use this picture": no image was ever chosen -> refused, mode left unchanged', () => {
  const result = switchToStoredImage({ homeBackgroundMode: 'color', homeBackgroundImageFile: '' }, () => true);
  assert.strictEqual(result.error, 'no-image');
  assert.strictEqual(result.mode, 'color');
});

test('4h. "Use this picture": a stored file name that no longer exists on disk -> refused, not silently switched', () => {
  const result = switchToStoredImage({ homeBackgroundMode: 'default', homeBackgroundImageFile: 'deleted.png' }, () => false);
  assert.strictEqual(result.error, 'no-image');
  assert.strictEqual(result.mode, 'default');
});

test('4i. "Use this picture": a stored file that still exists switches mode to "image"', () => {
  const result = switchToStoredImage({ homeBackgroundMode: 'color', homeBackgroundImageFile: 'bg-1.png' }, () => true);
  assert.deepStrictEqual(result, { mode: 'image' });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
