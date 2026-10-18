// Only ever loaded into the settings tab (see createSettingsTab in main.js) —
// never into a tab showing an actual website.
const { contextBridge, ipcRenderer } = require('electron');

// Anti-FOUC: same technique as preload.js — set theme/accent on <html>
// synchronously before settings.html's own scripts/CSS ever get a chance to
// paint with the :root (dark) defaults. See preload.js for the full
// explanation of why this is safe and necessary in a sandboxed,
// contextIsolated preload.
try {
  const prefs = ipcRenderer.sendSync('prefs:getSync') || {};
  const root = document.documentElement;
  if (prefs.accent) root.style.setProperty('--accent', prefs.accent);
  root.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
} catch {
  // settings.js's normal async settingsAPI.get() call still applies the
  // theme a moment later if this fails — this is just the flash-prevention
  // fast path.
}

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('prefs:get'),
  save: (prefs) => ipcRenderer.invoke('prefs:save', prefs),
  // ---- About (Part … About GlozaNet) -------------------------------------
  // getVersion: the ONLY package info exposed to this page — a single
  // string from app.getVersion(), never the full package.json.
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  // Opens a URL in a brand-new tab in THIS window, unconditionally — reuses
  // the exact same 'tabs:new' channel the toolbar itself calls (see
  // newTab() in preload.js / tabs:new in main.js), so About's links go
  // through the one real tab-creation path rather than a second one. This
  // deliberately bypasses the user's "Open links" (new-tab vs same-tab)
  // preference: About's links must always land in a new tab and must never
  // navigate the Settings page itself away.
  openInNewTab: (url) => ipcRenderer.invoke('tabs:new', url),
  // Title Bar Mode needs to recreate every open window (see
  // window:setTitleBarMode in main.js), so it's applied immediately rather
  // than waiting for the "Save changes" button like the other settings.
  setTitleBarMode: (mode) => ipcRenderer.invoke('window:setTitleBarMode', mode),
  // "Open links": new tab vs. same tab — applied immediately, merged into
  // the saved prefs by main.js (see prefs:setLinkOpenMode).
  setLinkOpenMode: (mode) => ipcRenderer.invoke('prefs:setLinkOpenMode', mode),

  // ---- Part 3B: Homepage / startup / new tab / suggestions / zoom /
  // downloads — each applied immediately, same pattern as setLinkOpenMode
  // above, not batched behind the page's "Save changes" button.
  setHomepage: (value) => ipcRenderer.invoke('prefs:setHomepage', value),
  setStartupBehavior: (mode) => ipcRenderer.invoke('prefs:setStartupBehavior', mode),
  setNewTabBehavior: (mode) => ipcRenderer.invoke('prefs:setNewTabBehavior', mode),
  setSearchSuggestionsEnabled: (enabled) => ipcRenderer.invoke('prefs:setSearchSuggestionsEnabled', enabled),
  setDefaultZoomPercent: (percent) => ipcRenderer.invoke('prefs:setDefaultZoomPercent', percent),
  chooseDownloadDir: () => ipcRenderer.invoke('prefs:chooseDownloadDir'),
  setDownloadDir: (dirPath) => ipcRenderer.invoke('prefs:setDownloadDir', dirPath),
  setAskWhereToSave: (enabled) => ipcRenderer.invoke('prefs:setAskWhereToSave', enabled),

  // ---- Home Screen Settings (Part 2) -------------------------------------
  homeScreen: {
    // Shared bookmark collection (same store + IPC home.html's own dialog
    // uses — see home-preload.js/home-bookmarks:* in main.js) so Settings'
    // bookmark manager is never a separate copy.
    list: () => ipcRenderer.invoke('home-bookmarks:list'),
    add: (title, url) => ipcRenderer.invoke('home-bookmarks:add', { title, url }),
    update: (id, changes) => ipcRenderer.invoke('home-bookmarks:update', { id, ...changes }),
    remove: (id) => ipcRenderer.invoke('home-bookmarks:remove', id),
    reorder: (orderedIds) => ipcRenderer.invoke('home-bookmarks:reorder', orderedIds),
    onUpdated: (callback) => {
      ipcRenderer.on('home-bookmarks-updated', (_event, list) => callback(list));
    },
    setShowBookmarks: (enabled) => ipcRenderer.invoke('prefs:setShowHomeBookmarks', enabled),
    setShowGradient: (enabled) => ipcRenderer.invoke('prefs:setShowTopGradient', enabled),
    getBackgroundPreview: () => ipcRenderer.invoke('prefs:getHomeBackgroundPreview'),
    setBackgroundColor: (colorId) => ipcRenderer.invoke('prefs:setHomeBackgroundColor', colorId),
    setBackgroundDefault: () => ipcRenderer.invoke('prefs:setHomeBackgroundDefault'),
    setBackgroundImageMode: () => ipcRenderer.invoke('prefs:setHomeBackgroundImageMode'),
    chooseBackgroundImage: () => ipcRenderer.invoke('prefs:chooseHomeBackgroundImage'),
  },

  // Deep-link navigation into a specific Settings page, sent only when this
  // Settings tab already existed; a freshly-created tab instead gets its
  // target via the page's own query string (no race against this listener
  // attaching — see createSettingsTab in main.js).
  onNavigate: (callback) => {
    ipcRenderer.on('settings:navigate', (_event, opts) => callback(opts || {}));
  },

  // ---- Ad/tracker blocker (Part 1B backend; Part 2 builds the actual
  // Settings page UI on top of these — see src/adblock/index.js) --------
  adblock: {
    getStatus: () => ipcRenderer.invoke('adblock:getStatus'),
    setEnabled: (enabled) => ipcRenderer.invoke('adblock:setEnabled', enabled),
    setNetworkFilterEnabled: (enabled) => ipcRenderer.invoke('adblock:setNetworkFilterEnabled', enabled),
    setYoutubeAdSkipEnabled: (enabled) => ipcRenderer.invoke('adblock:setYoutubeAdSkipEnabled', enabled),
    getSiteState: (urlOrHost) => ipcRenderer.invoke('adblock:getSiteState', urlOrHost),
    setSiteException: (urlOrHost, disabled) => ipcRenderer.invoke('adblock:setSiteException', { urlOrHost, disabled }),
    listExceptions: () => ipcRenderer.invoke('adblock:listExceptions'),
    removeException: (hostname) => ipcRenderer.invoke('adblock:removeException', hostname),
    clearExceptions: () => ipcRenderer.invoke('adblock:clearExceptions'),
    getStats: (tabId) => ipcRenderer.invoke('adblock:getStats', tabId),
    resetStats: () => ipcRenderer.invoke('adblock:resetStats'),
    setListEnabled: (listId, enabled) => ipcRenderer.invoke('adblock:setListEnabled', { listId, enabled }),
    updateLists: (opts) => ipcRenderer.invoke('adblock:updateLists', opts),
    restoreDefaults: () => ipcRenderer.invoke('adblock:restoreDefaults'),
    onUpdated: (callback) => {
      ipcRenderer.on('adblock:updated', (_event, status) => callback(status));
    },
    // ---- Diagnostics (Part 2 §2) — Settings-only, never exposed to any
    // web page's own preload surface (see preload.js: no equivalent there).
    setDiagnosticsEnabled: (enabled) => ipcRenderer.invoke('adblock:setDiagnosticsEnabled', enabled),
    getDiagnostics: (limit) => ipcRenderer.invoke('adblock:getDiagnostics', limit),
    clearDiagnostics: () => ipcRenderer.invoke('adblock:clearDiagnostics'),
  },

  // ---- Privacy & History (Part 3A) ---------------------------------------
  privacy: {
    getHistoryCount: () => ipcRenderer.invoke('history:list').then((list) => list.length),
    setHistoryEnabled: (enabled) => ipcRenderer.invoke('prefs:setHistoryEnabled', enabled),
    clearHistoryRange: (rangeKey) => ipcRenderer.invoke('history:clearRange', rangeKey),
    clearAllHistory: () => ipcRenderer.invoke('history:clear'),
    getClearOnExit: () => ipcRenderer.invoke('prefs:get').then((p) => p.clearOnExit),
    setClearOnExit: (partial) => ipcRenderer.invoke('prefs:setClearOnExit', partial),
    // Opens the real History panel in this window's toolbar (see
    // toolbar:openHistoryPanel in main.js) — this tab has no direct access
    // to it.
    openHistoryPanel: () => ipcRenderer.invoke('toolbar:openHistoryPanel'),
  },

  // ---- Force dark mode on websites (Website Appearance, Part 2) --------
  darkmode: {
    getStatus: () => ipcRenderer.invoke('darkmode:getStatus'),
    setEnabled: (enabled) => ipcRenderer.invoke('darkmode:setEnabled', enabled),
    getSiteState: (urlOrHost) => ipcRenderer.invoke('darkmode:getSiteState', urlOrHost),
    setSiteException: (urlOrHost, disabled) => ipcRenderer.invoke('darkmode:setSiteException', { urlOrHost, disabled }),
    listExceptions: () => ipcRenderer.invoke('darkmode:listExceptions'),
    removeException: (hostname) => ipcRenderer.invoke('darkmode:removeException', hostname),
    clearExceptions: () => ipcRenderer.invoke('darkmode:clearExceptions'),
    onUpdated: (callback) => {
      ipcRenderer.on('darkmode:updated', (_event, status) => callback(status));
    },
  },
});
