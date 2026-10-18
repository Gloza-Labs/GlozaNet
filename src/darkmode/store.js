// ============================================================================
// darkmode/store.js — persistence for "Force dark mode on websites", in its
// own file (darkmode.json) under app.getPath('userData'). Follows the exact
// same pattern as src/adblock/store.js (its own file, deep-merge onto
// defaults, atomic write-then-rename) rather than piggybacking on
// prefs.json, so a bug here can't corrupt unrelated browser settings and
// this feature can be reasoned about independently of the ad blocker.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  schemaVersion: 1,
  // Global on/off switch for the whole feature.
  enabled: false,
  // hostname -> true means "don't force dark on this site" (an exception).
  // Only disabled sites are stored, same reasoning as adblock's
  // siteExceptions: a corrupt/stale entry can never accidentally force-dark
  // a site the user excepted, only fail to.
  siteExceptions: {},
};

function statePath(app) {
  return path.join(app.getPath('userData'), 'darkmode.json');
}

function deepMergeDefaults(loaded) {
  const merged = JSON.parse(JSON.stringify(DEFAULT_STATE));
  if (!loaded || typeof loaded !== 'object') return merged;
  if (typeof loaded.enabled === 'boolean') merged.enabled = loaded.enabled;
  if (loaded.siteExceptions && typeof loaded.siteExceptions === 'object') {
    for (const [host, disabled] of Object.entries(loaded.siteExceptions)) {
      if (typeof host === 'string' && host && disabled === true) merged.siteExceptions[host] = true;
    }
  }
  return merged;
}

function load(app) {
  try {
    const raw = fs.readFileSync(statePath(app), 'utf-8');
    return deepMergeDefaults(JSON.parse(raw));
  } catch {
    // Missing file (first run) or corrupt JSON — safe defaults either way.
    return deepMergeDefaults(null);
  }
}

function save(app, state) {
  const p = statePath(app);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

module.exports = { DEFAULT_STATE, load, save };
