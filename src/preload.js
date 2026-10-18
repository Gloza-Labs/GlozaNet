// ============================================================================
// preload.js — the ONLY place allowed to touch both Node and the page's DOM.
// It exposes a small, safe `window.browser` object to index.html/renderer.js.
// You generally won't need to edit this unless you add a new tab action.
// ============================================================================

const { contextBridge, ipcRenderer, clipboard } = require('electron');

// Anti-FOUC: apply the saved theme/accent/shape/titlebar-mode to <html>
// synchronously, here, before index.html's own scripts (and ideally before
// its stylesheets finish applying) ever run. Preload executes ahead of the
// page's own <script> tags on every navigation, and contextIsolation still
// shares the same underlying `document` with the page (only the JS globals
// are isolated) — so mutating document.documentElement here is visible to
// the CSS engine immediately, before the renderer's own async 'prefs-updated'
// round-trip would otherwise resolve. Without this, the page always paints
// once with the :root (dark) defaults first and only flips to the real
// theme afterwards — a visible dark/light flash on every launch for anyone
// not using the default dark theme. ipcRenderer.sendSync is used (not
// invoke) specifically because it blocks until main.js replies, which is
// what makes this synchronous and thus flash-free.
try {
  const prefs = ipcRenderer.sendSync('prefs:getSync') || {};
  const root = document.documentElement;
  if (prefs.accent) root.style.setProperty('--accent', prefs.accent);
  root.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
  root.dataset.tabShape = prefs.tabShape || 'rounded-top';
  root.dataset.titlebar = prefs.titleBarMode === 'native' ? 'native' : 'custom';
  // Lets styles.css reserve the right space for the OS-native window
  // controls main.js now asks for in 'custom' Title Bar Mode: macOS gets
  // traffic lights at the LEFT of #tab-row, Windows/Linux get the Window
  // Controls Overlay at the RIGHT (see nativeControlOptions() in main.js
  // and the [data-platform] rules in styles.css). `process.platform` is
  // safe to read here — preload.js runs with Node access.
  root.dataset.platform = process.platform === 'darwin' ? 'mac' : (process.platform === 'win32' ? 'win' : 'linux');
  // The actual reserved width now comes from main.js (see
  // MAC_TRAFFIC_LIGHT_RESERVE_PX / prefsForRenderer there), not a
  // hand-copied number living only in styles.css — this is what keeps the
  // two in sync. Setting it here, as an INLINE style property on <html>,
  // rather than only relying on styles.css's own `:root { ... }` rule,
  // means this value always wins the cascade: inline style beats any
  // selector's specificity and isn't affected by stylesheet load order, so
  // there's no cascade path left for the reserve to silently not apply.
  // styles.css's own `:root` declaration becomes a fallback for the
  // (should-never-happen) case prefs.macTrafficLightReserve is missing.
  if (root.dataset.platform === 'mac' && Number.isFinite(prefs.macTrafficLightReserve)) {
    root.style.setProperty('--mac-traffic-light-reserve', `${prefs.macTrafficLightReserve}px`);
  }
} catch {
  // If this ever fails for some reason, renderer.js's normal async
  // 'prefs-updated' listener still applies the theme a moment later — this
  // is a flash-prevention optimization, not the only place theme is set.
}

contextBridge.exposeInMainWorld('browser', {
  newTab: (url) => ipcRenderer.invoke('tabs:new', url),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  switchTab: (id) => ipcRenderer.invoke('tabs:switch', id),
  // Drag-to-reorder: send the full new left-to-right list of tab ids.
  reorderTabs: (order) => ipcRenderer.invoke('tabs:reorder', order),
  // End of a tab-drag gesture. `order` is this window's local left-to-right
  // id list (used if the pointer never left this window); screenX/screenY is
  // where the pointer was released, in desktop coordinates (used to detect a
  // drop onto another Gloza window, or outside every window, for detaching
  // into / transferring between windows). Resolves to
  // { result: 'reordered' | 'transferred' | 'detached' | 'noop', windowId? }.
  dragEndTab: (tabId, order, screenX, screenY) =>
    ipcRenderer.invoke('tabs:dragEnd', { tabId, order, screenX, screenY }),
  navigate: (id, url) => ipcRenderer.invoke('tabs:navigate', { id, url }),
  back: (id) => ipcRenderer.invoke('tabs:back', id),
  forward: (id) => ipcRenderer.invoke('tabs:forward', id),
  reload: (id) => ipcRenderer.invoke('tabs:reload', id),

  // Tab context-menu actions.
  newTabAdjacent: (relativeId, side) => ipcRenderer.invoke('tabs:newTabAdjacent', { relativeId, side }),
  duplicateTab: (id) => ipcRenderer.invoke('tabs:duplicate', id),
  unloadTab: (id) => ipcRenderer.invoke('tabs:unload', id),
  printTab: (id) => ipcRenderer.invoke('tabs:print', id),
  toggleMuteTab: (id) => ipcRenderer.invoke('tabs:toggleMute', id),
  togglePinTab: (id) => ipcRenderer.invoke('tabs:togglePin', id),
  moveTabToStart: (id) => ipcRenderer.invoke('tabs:moveToStart', id),
  moveTabToEnd: (id) => ipcRenderer.invoke('tabs:moveToEnd', id),
  moveTabToNewWindow: (id) => ipcRenderer.invoke('tabs:moveToNewWindow', id),
  closeTabsToRight: (id) => ipcRenderer.invoke('tabs:closeToRight', id),
  closeTabsToLeft: (id) => ipcRenderer.invoke('tabs:closeToLeft', id),
  closeOtherTabs: (id) => ipcRenderer.invoke('tabs:closeOthers', id),
  closeMultipleTabs: (ids) => ipcRenderer.invoke('tabs:closeMultiple', ids),

  // Fires every time tab state changes (new/closed/switched/navigated/loading).
  onTabsUpdated: (callback) => {
    ipcRenderer.on('tabs-updated', (_event, data) => callback(data));
  },

  openSettings: (navOpts) => ipcRenderer.invoke('tabs:openSettings', navOpts),

  // The toolbar tells the engine how tall it is, so pages start right below it.
  setChromeHeight: (height) => ipcRenderer.send('chrome:height', height),

  // Fires on startup and whenever the settings page saves a change.
  onPrefsUpdated: (callback) => {
    ipcRenderer.on('prefs-updated', (_event, prefs) => callback(prefs));
  },

  // Context menu: the toolbar asks main.js to show/hide the overlay.
  // `info` = { x, y, params } where params is Electron's ContextMenuParams.
  onContextMenu: (callback) => {
    ipcRenderer.on('context-menu:show', (_event, info) => callback(info));
  },
  onHideContextMenu: (callback) => {
    ipcRenderer.on('context-menu:hide', () => callback());
  },
  hideContextMenu: () => ipcRenderer.send('context-menu:hide'),
  contextMenuAction: (action, payload) =>
    ipcRenderer.invoke('context-menu:action', { action, payload }),

  // Find-in-page (Cmd/Ctrl+F — see buildAppMenu in main.js). findQuery starts
  // or restarts a search for the current active tab; findNext moves to the
  // next/previous match of the SAME search (Chromium keeps its existing
  // match list rather than re-scanning); findStop clears the highlight/bar.
  findQuery: (query, forward) => ipcRenderer.invoke('find:query', { query, forward }),
  findNext: (query, forward) => ipcRenderer.invoke('find:next', { query, forward }),
  findStop: (action) => ipcRenderer.send('find:stop', action),
  onFindResult: (callback) => {
    ipcRenderer.on('find:result', (_event, result) => callback(result));
  },
  // Pushed by the CommandOrControl+F menu accelerator (works regardless of
  // which element in the window currently has focus — see buildAppMenu).
  onToggleFind: (callback) => {
    ipcRenderer.on('toolbar:toggleFind', () => callback());
  },

  // Custom window controls — the native title bar is removed (frame: false
  // in main.js), so these are the ONLY way to minimize/maximize/close.
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  // Custom drag for the empty tab-strip space — see the pointerdown
  // handler on #tab-row in renderer.js and the 'window:moveBy' handler in
  // main.js for why this replaces the native -webkit-app-region drag there.
  moveWindowBy: (dx, dy) => ipcRenderer.send('window:moveBy', { dx, dy }),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  // Browser menu → "New Window": opens a brand-new, fully independent Gloza
  // window (own tabs, own toolbar) — not tied to the window that opened it.
  newWindow: () => ipcRenderer.invoke('windows:new'),

  // Fires whenever the OS-level maximize state changes (maximize button,
  // double-clicking the drag region, Windows snap, etc).
  onWindowState: (callback) => {
    ipcRenderer.on('window:state', (_event, state) => callback(state));
  },

  // Absolute desktop bounds {x, y, width, height} of this window. Used
  // during a tab drag to tell whether the pointer has left this window.
  getWindowBounds: () => ipcRenderer.invoke('window:getBounds'),

  // The cross-window drag preview ("ghost"): a separate always-on-top
  // BrowserWindow main.js positions at (x, y) in desktop coordinates, since
  // a DOM element can't render or follow the cursor outside this window's
  // own bounds. start() creates it and shows the given tab's title/favicon;
  // move() repositions it; end() tears it down. These are one-way (send,
  // not invoke) since the drag loop calls move() on every animation frame
  // and doesn't need to wait for a reply.
  startDragPreview: (x, y, title, favicon) => ipcRenderer.send('drag-preview:start', { x, y, title, favicon }),
  moveDragPreview: (x, y) => ipcRenderer.send('drag-preview:move', { x, y }),
  endDragPreview: () => ipcRenderer.send('drag-preview:end'),

  // Tells main.js this page has finished registering every listener below
  // and is now safe to receive state pushes. Call this exactly once, after
  // everything above is wired up — see the bottom of renderer.js. main.js
  // withholds this window's very first tab (fresh or dragged in from
  // elsewhere) and its initial prefs/window-state until it hears this,
  // instead of guessing from load timing.
  notifyReady: () => ipcRenderer.send('ui:ready'),

  // ---- Bookmarks (tree: root = toolbar, folders can nest) ---------------
  listBookmarks: () => ipcRenderer.invoke('bookmarks:list'),
  addBookmark: (title, url, favicon, parentId) =>
    ipcRenderer.invoke('bookmarks:addBookmark', { title, url, favicon, parentId }),
  addBookmarkFolder: (title, parentId) => ipcRenderer.invoke('bookmarks:addFolder', { title, parentId }),
  updateBookmark: (id, changes) => ipcRenderer.invoke('bookmarks:update', { id, ...changes }),
  removeBookmark: (id) => ipcRenderer.invoke('bookmarks:remove', id),
  toggleBookmarkForTab: (id) => ipcRenderer.invoke('bookmarks:toggleForTab', id),
  moveBookmark: (id, parentId, index) => ipcRenderer.invoke('bookmarks:move', { id, parentId, index }),
  // Toolbar -> home screen (the reverse of window.glozaHome.moveToToolbar on
  // the home page itself). Resolves { ok, error?, tree, homeList }.
  moveBookmarkToHome: (id) => ipcRenderer.invoke('bookmarks:moveToHome', id),
  reorderBookmarks: (parentId, order) => ipcRenderer.invoke('bookmarks:reorder', { parentId, order }),
  onBookmarksUpdated: (callback) => {
    ipcRenderer.on('bookmarks-updated', (_event, tree) => callback(tree));
  },
  // Adds a new entry straight to the independent home-screen collection —
  // the toolbar's own star-button "Bookmark dialog" (openBookmarkDialog in
  // renderer.js) uses this when the user picks "Home Screen" as the save
  // destination, instead of bookmarks:addBookmark above. Separate store,
  // same validation (home-bookmarks:add re-checks isSafeBookmarkUrl and the
  // 4-slot limit itself — see main.js). The home page (home.html) has its
  // own richer bridge (window.glozaHome, home-preload.js); this is just the
  // one call the toolbar chrome needs.
  addHomeBookmark: (title, url) => ipcRenderer.invoke('home-bookmarks:add', { title, url }),

  // ---- URL bar right-click copy/paste/cut --------------------------------
  // Plain-text-only clipboard access for the address bar's own Gloza-style
  // context menu (openLocalMenu reused in renderer.js). Electron's
  // `clipboard` module is required directly here (preload scripts can
  // always reach Electron's own built-in modules, even with sandbox: true)
  // rather than going over IPC, since it's synchronous and read/write text
  // carries no meaningful risk. This bridge only ever reaches Gloza's own
  // chrome page (index.html) — a website's own webContents has a
  // completely separate (or absent) preload and never sees `window.browser`
  // at all — so it never hands clipboard access to arbitrary web content.
  clipboardReadText: () => {
    try { return clipboard.readText(); } catch { return ''; }
  },
  clipboardWriteText: (text) => {
    try { clipboard.writeText(String(text ?? '')); return true; } catch { return false; }
  },

  // ---- Recent searches (address-bar dropdown) ----------------------------
  listRecentSearches: () => ipcRenderer.invoke('search:recent'),
  addRecentSearch: (query) => ipcRenderer.invoke('search:addRecent', query),
  clearRecentSearches: () => ipcRenderer.invoke('search:clearRecent'),
  // Returns { query, suggestions, error? } — `query` is echoed back so the
  // renderer can ignore a stale response that resolves after a newer
  // keystroke already asked a different question.
  getSearchSuggestions: (query) => ipcRenderer.invoke('search:suggest', query),
  onSearchHistoryUpdated: (callback) => {
    ipcRenderer.on('search-history-updated', (_event, list) => callback(list));
  },

  // ---- Title Bar Mode (Settings) ------------------------------------------
  setTitleBarMode: (mode) => ipcRenderer.invoke('window:setTitleBarMode', mode),

  // ---- Bookmarks-bar visibility ('always' | 'new-tab-only' | 'never') ----
  // Applied+persisted immediately (same pattern as setTitleBarMode above),
  // reachable from the bookmarks bar's own right-click menu rather than
  // only from Settings. prefs-updated (already wired above) is how every
  // window — including this one — finds out the new value.
  setBookmarksBarMode: (mode) => ipcRenderer.invoke('prefs:setBookmarksBarMode', mode),

  // ---- Downloads --------------------------------------------------------
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  openDownload: (id) => ipcRenderer.invoke('downloads:open', id),
  revealDownload: (id) => ipcRenderer.invoke('downloads:reveal', id),
  cancelDownload: (id) => ipcRenderer.invoke('downloads:cancel', id),
  removeDownload: (id) => ipcRenderer.invoke('downloads:remove', id),
  clearCompletedDownloads: () => ipcRenderer.invoke('downloads:clearCompleted'),
  setDownloadAutoOpen: (id, enabled) => ipcRenderer.invoke('downloads:setAutoOpen', { id, enabled }),
  onDownloadsUpdated: (callback) => {
    ipcRenderer.on('downloads-updated', (_event, list) => callback(list));
  },

  // ---- Browsing history (History panel, from the browser menu) ----------
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  removeHistoryItem: (id) => ipcRenderer.invoke('history:removeItem', id),
  // Part 3A — bulk removal ("select multiple" mode) and range-based
  // clearing ('hour' | 'today' | '24h' | '7d' | 'all').
  removeHistoryItems: (ids) => ipcRenderer.invoke('history:removeItems', ids),
  clearHistoryRange: (rangeKey) => ipcRenderer.invoke('history:clearRange', rangeKey),
  onHistoryUpdated: (callback) => {
    ipcRenderer.on('history-updated', (_event, list) => callback(list));
  },
  // Settings → Privacy & History sends this so the toolbar opens the real
  // History panel from a different tab (the Settings page is its own tab
  // with no direct DOM access to this one) — see toolbar:openHistoryPanel
  // in main.js / the "Manage history…" button in settings.js.
  onOpenHistoryPanel: (callback) => {
    ipcRenderer.on('toolbar:openHistoryPanel', () => callback());
  },

  // ---- Zoom ---------------------------------------------------------------
  zoomIn: (id) => ipcRenderer.invoke('zoom:in', id),
  zoomOut: (id) => ipcRenderer.invoke('zoom:out', id),
  zoomReset: (id) => ipcRenderer.invoke('zoom:reset', id),

  // ---- Fullscreen -----------------------------------------------------
  fullscreenToggle: () => ipcRenderer.invoke('window:fullscreenToggle'),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),

  // The slide-out panels (tab list / downloads / browser menu) live inside
  // this toolbar view and need the same "temporarily grow to cover the whole
  // window" trick the context menu uses — see panel:expand/collapse in
  // main.js for why.
  expandPanelSurface: () => ipcRenderer.invoke('panel:expand'),
  collapsePanelSurface: () => ipcRenderer.send('panel:collapse'),

  // ---- Ad/tracker blocker (Part 1B backend; Part 2 builds the shield
  // popup/Settings page on top of these) --------------------------------
  adblock: {
    getStatus: () => ipcRenderer.invoke('adblock:getStatus'),
    setEnabled: (enabled) => ipcRenderer.invoke('adblock:setEnabled', enabled),
    // `urlOrHost` can be a full URL (e.g. the active tab's current URL) or
    // a bare hostname — main.js normalizes either.
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
    // Fires whenever global/per-site state or list configuration changes,
    // from any source (this window or another one) — same broadcast
    // pattern as onPrefsUpdated above.
    onUpdated: (callback) => {
      ipcRenderer.on('adblock:updated', (_event, status) => callback(status));
    },
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
