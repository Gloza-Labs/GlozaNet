// ============================================================================
// adblock/stats.js — blocking counters. Three layers, matching what Part 2's
// toolbar popup/Settings page will want to show:
//   - per-tab: resets every time that tab navigates to a new top-level page
//     (same convention as uBlock-style "blocked on this page" counters).
//   - session: total since the browser process started, never persisted.
//   - all-time: persisted across restarts, via store.js.
// Pure in-memory bookkeeping — no Electron APIs — so it's unit-testable.
// ============================================================================

'use strict';

class BlockStats {
  constructor({ getPersistedTotal, onPersistedTotalChange } = {}) {
    this._perTab = new Map(); // tabId -> count (current page)
    this._sessionTotal = 0;
    this._getPersistedTotal = getPersistedTotal || (() => 0);
    this._onPersistedTotalChange = onPersistedTotalChange || (() => {});
  }

  recordBlocked(tabId) {
    this._sessionTotal++;
    if (tabId !== undefined && tabId !== null) {
      this._perTab.set(tabId, (this._perTab.get(tabId) || 0) + 1);
    }
    this._onPersistedTotalChange(this._getPersistedTotal() + 1);
  }

  // Call when a tab navigates to a new top-level document — the
  // "blocked on this site" counter is scoped to the CURRENT page, not the
  // tab's whole lifetime, matching how real ad-blocker toolbar icons work.
  resetTab(tabId) {
    this._perTab.set(tabId, 0);
  }

  // Call when a tab is closed so the map doesn't grow unboundedly over a
  // long browsing session.
  forgetTab(tabId) {
    this._perTab.delete(tabId);
  }

  getTabCount(tabId) {
    return this._perTab.get(tabId) || 0;
  }

  getSessionTotal() {
    return this._sessionTotal;
  }

  getAllTimeTotal() {
    return this._getPersistedTotal();
  }

  snapshot(tabId) {
    return {
      currentSite: this.getTabCount(tabId),
      session: this.getSessionTotal(),
      allTime: this.getAllTimeTotal(),
    };
  }
}

module.exports = { BlockStats };
