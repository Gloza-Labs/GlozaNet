// ============================================================================
// adblock/store.js — persistence for everything ad-blocker-related, in its
// own file (adblock.json) under app.getPath('userData'), following the
// same flat-JSON pattern main.js already uses for prefs.json/bookmarks.json
// (see HANDOFF-part-1a.md's "how to wire it" notes). Kept entirely separate
// from prefs.json so a bug here can never corrupt unrelated browser
// settings, and vice versa.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  schemaVersion: 1,
  // Global on/off switch for the whole feature. Turning this off disables
  // BOTH YouTube ad-blocking methods below (and everything else), same as
  // before this round — it's the master kill switch, not a third method.
  enabled: true,
  // ---- Independent per-method switches (YouTube ad-blocking fix) --------
  // Added this round so the two YouTube ad-blocking methods required by the
  // brief ("I want two identifiable YouTube ad-blocking methods... so I can
  // test either one alone or both together") can genuinely be turned on/off
  // one at a time, instead of sharing the single `enabled` switch above.
  // Both default to true (matches the existing out-of-the-box behavior:
  // network filtering and the YouTube ad-skip script were both always-on
  // whenever `enabled` was true, before this round added a way to split
  // them apart).
  //  - networkFilterEnabled gates Method 1 (engine.js/_decide(): filter-list
  //    network-level request blocking) independently of Method 2.
  //  - youtubeAdSkipEnabled gates Method 2 (the YOUTUBE_AD_SKIP_SCRIPT
  //    DOM layer in adblock/index.js: clicking the native Skip button and
  //    hiding ad-chrome overlays) independently of Method 1.
  // Neither one can re-enable anything while the master `enabled` switch
  // above is off.
  networkFilterEnabled: true,
  youtubeAdSkipEnabled: true,
  // hostname -> true means "protection disabled for this site". Only
  // disabled sites are stored (an empty object means no exceptions), so an
  // old/corrupt entry can't accidentally re-enable something.
  siteExceptions: {},
  lists: {
    // listId -> { enabled, url, lastSuccessfulUpdate, lastAttempt,
    //             lastError, ruleCounts, updateIntervalMs }
  },
  updateIntervalMs: 24 * 60 * 60 * 1000, // 24h, matches common ad-blocker defaults
  stats: {
    // Historical, persisted totals — independent of the in-memory
    // session/per-tab counters kept by stats.js.
    totalBlockedAllTime: 0,
    sessionsStartedAllTime: 0,
  },
};

function statePath(app) {
  return path.join(app.getPath('userData'), 'adblock.json');
}

function listsDir(app) {
  return path.join(app.getPath('userData'), 'adblock-lists');
}

function deepMergeDefaults(loaded) {
  const merged = JSON.parse(JSON.stringify(DEFAULT_STATE));
  if (!loaded || typeof loaded !== 'object') return merged;
  if (typeof loaded.enabled === 'boolean') merged.enabled = loaded.enabled;
  if (typeof loaded.networkFilterEnabled === 'boolean') merged.networkFilterEnabled = loaded.networkFilterEnabled;
  if (typeof loaded.youtubeAdSkipEnabled === 'boolean') merged.youtubeAdSkipEnabled = loaded.youtubeAdSkipEnabled;
  if (loaded.siteExceptions && typeof loaded.siteExceptions === 'object') {
    for (const [host, disabled] of Object.entries(loaded.siteExceptions)) {
      if (typeof host === 'string' && host && disabled === true) merged.siteExceptions[host] = true;
    }
  }
  if (loaded.lists && typeof loaded.lists === 'object') {
    for (const [id, entry] of Object.entries(loaded.lists)) {
      if (entry && typeof entry === 'object') merged.lists[id] = { ...entry };
    }
  }
  if (Number.isFinite(loaded.updateIntervalMs) && loaded.updateIntervalMs >= 60000) {
    merged.updateIntervalMs = loaded.updateIntervalMs;
  }
  if (loaded.stats && typeof loaded.stats === 'object') {
    if (Number.isFinite(loaded.stats.totalBlockedAllTime)) {
      merged.stats.totalBlockedAllTime = Math.max(0, Math.floor(loaded.stats.totalBlockedAllTime));
    }
    if (Number.isFinite(loaded.stats.sessionsStartedAllTime)) {
      merged.stats.sessionsStartedAllTime = Math.max(0, Math.floor(loaded.stats.sessionsStartedAllTime));
    }
  }
  return merged;
}

function load(app) {
  try {
    const raw = fs.readFileSync(statePath(app), 'utf-8');
    return deepMergeDefaults(JSON.parse(raw));
  } catch {
    // Missing file (first run) or corrupt JSON — safe defaults either way,
    // per "Use safe defaults and handle missing or invalid stored values."
    return deepMergeDefaults(null);
  }
}

function save(app, state) {
  const p = statePath(app);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  // Write-then-rename so a crash mid-write can never leave adblock.json
  // truncated/corrupt (the previous good copy stays in place until the
  // rename, which is atomic on the same filesystem).
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

// --- Filter-list file storage -----------------------------------------------
// Each list's raw rule text lives in its own file under adblock-lists/, with
// a ".bak" sibling holding the last-known-good copy. Keeping this off to the
// side (not inside adblock.json) means multi-megabyte list text never has to
// be JSON-escaped/parsed as part of every small preference change.

function listFilePath(app, listId) {
  return path.join(listsDir(app), `${listId}.txt`);
}

function listBackupPath(app, listId) {
  return path.join(listsDir(app), `${listId}.txt.bak`);
}

function readListFile(app, listId) {
  try {
    return fs.readFileSync(listFilePath(app, listId), 'utf-8');
  } catch {
    return null;
  }
}

function readListBackup(app, listId) {
  try {
    return fs.readFileSync(listBackupPath(app, listId), 'utf-8');
  } catch {
    return null;
  }
}

// Writes new list text, first moving whatever was previously "live" into
// the .bak slot, so "retain the last known working rules if an update
// fails" has something to fall back to even across a failed update that
// happens on the NEXT attempt (not just within one attempt).
function writeListFile(app, listId, text) {
  const dir = listsDir(app);
  fs.mkdirSync(dir, { recursive: true });
  const live = listFilePath(app, listId);
  const bak = listBackupPath(app, listId);
  if (fs.existsSync(live)) {
    fs.copyFileSync(live, bak);
  }
  const tmp = `${live}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, live);
}

function restoreListBackup(app, listId) {
  const bak = readListBackup(app, listId);
  if (bak === null) return false;
  writeListFileRaw(app, listId, bak);
  return true;
}

// Internal: write without rotating a new backup (used only when restoring
// FROM the backup, so we don't overwrite the backup with itself).
function writeListFileRaw(app, listId, text) {
  const dir = listsDir(app);
  fs.mkdirSync(dir, { recursive: true });
  const live = listFilePath(app, listId);
  const tmp = `${live}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, live);
}

module.exports = {
  DEFAULT_STATE,
  load,
  save,
  readListFile,
  readListBackup,
  writeListFile,
  restoreListBackup,
  listsDir,
};
