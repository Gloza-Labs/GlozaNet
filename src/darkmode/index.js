// ============================================================================
// darkmode/index.js — "Force dark mode on websites" (Website Appearance).
// Mirrors adblock/index.js's shape on purpose (constructor takes
// {app, settingsTabIds, broadcast}, attachTab/detachTab hooks called from
// the same spots in main.js, registerIpc(ipcMain)) so the two features read
// as one consistent pattern rather than two different architectures, per
// the Part 2 brief's "do not introduce another settings store" guidance —
// this is the SAME pattern as the one store Part 1B already introduced for
// the ad blocker, not a new one.
// ============================================================================

'use strict';

const store = require('./store');
const { buildForceDarkCss } = require('./css');
const { isFilterableUrl, normalizeHostname } = require('../adblock/domain-utils');

// Small heuristic probe, run with wc.executeJavaScript once the DOM exists:
// samples the resolved (post author-CSS) background color of <html> and
// <body> and reports whether the page already looks dark, so a site that
// ships its own dark theme is left alone instead of being double-darkened.
// Kept intentionally simple/cheap (no full color-contrast engine) — a
// known, documented best-effort heuristic, not a guarantee; see
// HANDOFF-part-2.md's limitations section.
const PROBE_SCRIPT = `
(() => {
  try {
    function parseRgb(str) {
      const m = /rgba?\\(([^)]+)\\)/.exec(str || '');
      if (!m) return null;
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      const alpha = parts.length > 3 ? parts[3] : 1;
      return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
    }
    function luminance(c) {
      if (!c) return null;
      const lin = [c.r, c.g, c.b].map((v) => v / 255);
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    }
    const htmlBg = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
    const bodyBg = document.body ? parseRgb(getComputedStyle(document.body).backgroundColor) : null;
    const candidate = (bodyBg && bodyBg.a > 0.5) ? bodyBg : ((htmlBg && htmlBg.a > 0.5) ? htmlBg : null);
    const lum = luminance(candidate);
    // No usable (opaque) background found at all -> treat as "not already
    // dark" so we still force it; a genuinely dark page almost always sets
    // an explicit opaque background somewhere in this chain.
    return lum === null ? false : lum < 0.35;
  } catch {
    return false;
  }
})()
`;

class DarkMode {
  constructor({ app, settingsTabIds, broadcast }) {
    this.app = app;
    this.settingsTabIds = settingsTabIds;
    this.broadcast = broadcast || (() => {});
    this.state = store.load(app);

    this._tabHosts = new Map();      // tabId -> current page hostname (or null)
    this._insertedKey = new Map();   // tabId -> the key insertCSS returned (for removeInsertedCSS)
    this._wcByTab = new Map();       // tabId -> webContents, so IPC-triggered toggles can re-apply instantly
    this._alreadyDark = new Map();   // tabId -> was the last-applied page detected as already-dark?
  }

  // ---- Tab lifecycle hooks (same call sites as Adblock.attachTab/detachTab) ----

  attachTab(tabId, wc) {
    this._wcByTab.set(tabId, wc);
    this._tabHosts.set(tabId, normalizeHostname(wc.getURL() || '') || null);

    wc.on('did-navigate', (_event, url) => {
      this._tabHosts.set(tabId, normalizeHostname(url) || null);
      this._insertedKey.delete(tabId); // the navigation itself already dropped any inserted CSS
      this._alreadyDark.delete(tabId);
    });

    // dom-ready (not did-finish-load) so forced dark applies before images/
    // subresources finish loading — minimizes the light-then-dark flash on
    // a slow page, at the cost of occasionally running the probe against an
    // not-yet-fully-styled DOM (acceptable trade-off; a mis-detected site
    // can still be fixed with a one-click per-site exception).
    wc.on('dom-ready', () => this._applyToTab(tabId, wc));
  }

  detachTab(tabId) {
    this._tabHosts.delete(tabId);
    this._insertedKey.delete(tabId);
    this._wcByTab.delete(tabId);
    this._alreadyDark.delete(tabId);
  }

  async _applyToTab(tabId, wc) {
    if (wc.isDestroyed()) return;
    if (this.settingsTabIds.has(tabId)) return; // never touch Gloza's own UI
    const url = wc.getURL();
    if (!isFilterableUrl(url)) return; // file:/about:/devtools:/etc — leave untouched

    // Always start from a clean slate for this page load.
    const prevKey = this._insertedKey.get(tabId);
    if (prevKey != null) {
      try { await wc.removeInsertedCSS(prevKey); } catch { /* page may have already navigated */ }
      this._insertedKey.delete(tabId);
    }

    if (!this.state.enabled) return;

    const host = this._tabHosts.get(tabId);
    if (host && this.state.siteExceptions[host]) return; // user turned it off for this site

    let alreadyDark = false;
    try {
      alreadyDark = await wc.executeJavaScript(PROBE_SCRIPT, true);
    } catch {
      alreadyDark = false; // probe failure -> fail toward "still try to force it"
    }
    this._alreadyDark.set(tabId, Boolean(alreadyDark));
    if (alreadyDark) return; // site already provides its own dark theme — leave it alone

    if (wc.isDestroyed() || wc.getURL() !== url) return; // navigated away while we were probing
    try {
      const key = await wc.insertCSS(buildForceDarkCss());
      this._insertedKey.set(tabId, key);
    } catch {
      // Page may have navigated/closed mid-insert — nothing to clean up,
      // next dom-ready (for whatever loaded instead) starts fresh.
    }
  }

  // Re-apply (or remove) forced dark on every currently-open, currently-
  // filterable tab without a reload — used after setEnabled/setSiteException
  // so a toggle in the popup/Settings takes effect on pages already open,
  // per the "updates to active pages when possible, no unnecessary tab
  // reloads" requirement.
  _reapplyAllTabs() {
    for (const [tabId, wc] of this._wcByTab) {
      if (!wc.isDestroyed()) this._applyToTab(tabId, wc);
    }
  }

  // ---- Public operations ------------------------------------------------

  getStatus() {
    return {
      enabled: this.state.enabled,
      exceptions: Object.keys(this.state.siteExceptions).sort(),
    };
  }

  getSiteState(urlOrHost) {
    const host = normalizeHostname(urlOrHost);
    return { hostname: host, disabled: Boolean(host && this.state.siteExceptions[host]) };
  }

  _persist() {
    try { store.save(this.app, this.state); } catch { /* best-effort, same as adblock's store */ }
  }

  setEnabled(enabled) {
    this.state.enabled = Boolean(enabled);
    this._persist();
    this._reapplyAllTabs();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return this.state.enabled;
  }

  setSiteException(urlOrHost, disabled) {
    const host = normalizeHostname(urlOrHost);
    if (!host) return { ok: false, reason: 'could not determine a hostname for that URL' };
    if (disabled) this.state.siteExceptions[host] = true;
    else delete this.state.siteExceptions[host];
    this._persist();
    this._reapplyAllTabs();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return { ok: true, hostname: host, disabled: Boolean(disabled) };
  }

  listExceptions() {
    return Object.keys(this.state.siteExceptions).sort();
  }

  removeException(hostname) {
    const existed = Boolean(this.state.siteExceptions[hostname]);
    delete this.state.siteExceptions[hostname];
    if (existed) {
      this._persist();
      this._reapplyAllTabs();
      this.broadcast({ type: 'status', status: this.getStatus() });
    }
    return { ok: true, removed: existed };
  }

  clearExceptions() {
    this.state.siteExceptions = {};
    this._persist();
    this._reapplyAllTabs();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return { ok: true };
  }

  shutdown() {
    this._persist();
  }

  // ---- IPC wiring ---------------------------------------------------------
  registerIpc(ipcMain) {
    ipcMain.handle('darkmode:getStatus', () => this.getStatus());
    ipcMain.handle('darkmode:setEnabled', (_e, enabled) => this.setEnabled(enabled));
    ipcMain.handle('darkmode:getSiteState', (_e, urlOrHost) => this.getSiteState(urlOrHost));
    ipcMain.handle('darkmode:setSiteException', (_e, { urlOrHost, disabled }) => this.setSiteException(urlOrHost, disabled));
    ipcMain.handle('darkmode:listExceptions', () => this.listExceptions());
    ipcMain.handle('darkmode:removeException', (_e, hostname) => this.removeException(hostname));
    ipcMain.handle('darkmode:clearExceptions', () => this.clearExceptions());
  }
}

module.exports = { DarkMode };
