// ============================================================================
// main.js — runs in Electron's MAIN process (full Node/OS access, no DOM).
//
// This file is "the engine": it owns the window(s), creates one
// WebContentsView per browser tab, positions them on screen, and exposes tab
// actions (new tab, navigate, back, forward, close, drag between windows...)
// over IPC so the UI can call them. You generally shouldn't need to edit this
// file to change how the browser LOOKS — that's all in theme.css /
// styles.css / index.html / renderer.js (and home.* / settings.* for those
// pages).
//
// MULTI-WINDOW: Gloza can have any number of windows open at once (the app
// starts with one; dragging a tab out of a window's tab strip, or into
// another window, creates/updates windows — see the "Tab drag: detach +
// cross-window transfer" section near the bottom). All per-window state
// (its WebContentsViews, tab order, active tab, measured toolbar height,
// whether its context menu is open) lives in a WindowState instance kept in
// the `windows` map, keyed by the owning BrowserWindow's id. Nothing that
// used to be a single global (mainWindow, toolbarView, tabs, tabOrder,
// activeTabId, toolbarHeight, contextMenuOpen) is global anymore — it's all
// per-window now.
// ============================================================================

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell, session, net, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Must run before app is ready (ideally before any other app.* call): this
// is what the macOS menu bar, Dock, and "Force Quit" list use as the app's
// name. package.json's "productName" (read automatically by Electron when
// packaged) already covers a built app, but an unpackaged `electron .` dev
// run — e.g. `npm start` — otherwise falls back to the Electron binary's
// own name ("Electron"), which is what this fixes for development too.
app.setName('GlozaNet');

// The Gloza "G" mark, rendered from the exact same shape as the inline SVG
// brand-mark on the new-tab page (home.html) — see assets/icon-source.svg.
// Used for: the macOS About panel's icon (setAboutPanelOptions below) and,
// in dev, the Dock icon (app.whenReady() below); a packaged build instead
// gets its icon baked in by the packager (electron-builder/forge) from
// these same PNGs.
const APP_ICON_PATH = path.join(__dirname, '..', 'assets', 'icon-512.png');



// Native ad/tracker-blocking engine (Part 1B). Kept as its own module tree
// (src/adblock/) with no dependency on anything else in this file beyond
// what's passed into its constructor — see src/adblock/index.js for the
// full design notes. The actual `adblock` instance is created further down
// (once settingsTabIds/windows exist) and registered in app.whenReady(), at
// the spot HANDOFF-part-1a.md marked for it.
const { Adblock } = require('./adblock');
const { DarkMode } = require('./darkmode');
// Pure URL validation shared by every bookmark store — see that file for why
// it's split out (Electron-free, so it's independently testable).
const { isSafeBookmarkUrl, normalizeBookmarkUrl } = require('./bookmark-url-utils');

// Your browser's name. Shows in the window title bar / taskbar.
// (It's separately written in home.html's heading too — see that file.)
const BROWSER_NAME = 'GlozaNet';

// Color shown behind everything while the UI loads or the window is resized,
// so you never see a white flash. Matches --bg-1 in theme.css for each
// theme — chromeBg() (defined below, once loadPrefs() exists) picks the
// right one for whichever theme is currently saved, so a light-mode user
// doesn't get a dark flash (or a dark-mode user a light one) before the
// page's own CSS has had a chance to paint.
const CHROME_BG_DARK = '#101212';
const CHROME_BG_LIGHT = '#fafbfa';

// Must match --tab-row-h in styles.css: it's both the height of Gloza's own
// tab strip AND (in 'custom' Title Bar Mode, see below) the exact height we
// ask the OS to reserve for its native window-control overlay, so the
// native buttons line up with the strip instead of sitting in a shorter or
// taller band than the row around them.
const TAB_ROW_H = 50;

// Symbol (glyph) color for Electron's native Window Controls Overlay on
// Windows/Linux — see nativeControlOptions() below. The overlay itself is
// drawn entirely by the OS (that's the point), but Electron lets us tint
// the glyph to match Gloza's own theme instead of defaulting to black,
// same as chromeBg() already does for the window background.
const OVERLAY_SYMBOL_DARK = '#d7dadb';
const OVERLAY_SYMBOL_LIGHT = '#1c1f1f';
function overlaySymbolColor() {
  return loadPrefs().theme === 'light' ? OVERLAY_SYMBOL_LIGHT : OVERLAY_SYMBOL_DARK;
}

// ---- Native OS window-control integration (Title Bar Mode: 'custom') ----
// Gloza keeps its own frameless window (frame: false — no conventional OS
// title bar, no menu bar row) and draws its tab strip as the title bar, but
// the actual Close/Minimize/Maximize/Restore (and, on macOS, the traffic
// lights) are real OS-native controls, not hand-drawn SVGs. Electron
// supports this per-platform:
//
//  - macOS: `titleBarStyle: 'hidden'` removes the conventional title bar
//    while leaving the real traffic-light buttons in place; the window
//    stays genuinely frameless (no second bar above the tab strip).
//    `trafficLightPosition` tells macOS where, inside our content area, to
//    draw them — we center them vertically in the tab row and inset them
//    from the left edge by Gloza's existing --sp-3 (12px) horizontal
//    padding so they sit flush with where tab-row content normally starts.
//    (macOS does not support `titleBarOverlay`; that's Windows/Linux only.)
//
//  - Windows / Linux: `titleBarStyle: 'hidden'` + `titleBarOverlay` turns on
//    the Window Controls Overlay (WCO) API — Chromium/Electron asks the OS
//    to draw its real native caption buttons (Windows 10's square glyphs,
//    Windows 11's rounded-hover modern set, or the Linux/Electron-provided
//    equivalent — see the chat reply for what's actually verifiable in this
//    environment) in the window's top-right corner, over our content. The
//    overlay's actual on-screen geometry (it can vary slightly by platform,
//    DPI and accessibility text scaling) is exposed to the renderer via the
//    standard `env(titlebar-area-*)` CSS environment variables and the
//    `navigator.windowControlsOverlay` web API — see styles.css/renderer.js
//    for how #tab-row reserves exactly that space instead of a hardcoded
//    offset. `height` below just tells the OS to size the overlay to match
//    our tab row instead of its own default caption height.
//
// Only used when frame === false; 'native' Title Bar Mode (frame: true)
// still gets the OS's own conventional title bar as before and none of
// this applies (see createWindow below).
// macOS traffic-light inset from the window's left edge, in CSS px.
// IMPORTANT: this is read on BOTH sides of the process boundary — main.js
// passes it to Electron as `trafficLightPosition.x`, and styles.css derives
// its --mac-traffic-light-reserve (the space #tab-row reserves so nothing,
// including the tab-list button and the tab-strip's overflow arrows, can
// ever render underneath the real lights) from the same number. If you
// change this, update MAC_TRAFFIC_LIGHT_INSET_X in styles.css to match —
// see the comment there for the full explanation of how the two stay in
// sync and why.
const MAC_TRAFFIC_LIGHT_INSET_X = 12;

// SECOND root cause (independent of the reset-on-transition issue below):
// the reserved width was a SEPARATE number, hand-copied into styles.css as
// a plain hardcoded `88px`, tied to MAC_TRAFFIC_LIGHT_INSET_X above by
// nothing but a code comment asking whoever edits one to remember to edit
// the other. Two independently hand-maintained numbers living in two
// different files/processes, never cross-checked at runtime, is exactly
// the kind of thing that quietly drifts out of sync — and with no macOS
// machine available to ever measure the real cluster against, nobody could
// confirm the CSS copy was still right, or ever was. Computed here, once,
// from the same inputs the actual native positioning call uses, and handed
// to the renderer at runtime (see prefsForRenderer below, preload.js, and
// the `--mac-traffic-light-reserve` custom property it sets as an INLINE
// style — inline beats any stylesheet rule regardless of selector
// specificity or load order, so there is no cascade path left for this to
// silently lose on) — there is now exactly one number, computed in exactly
// one place. styles.css keeps a hardcoded fallback only for the
// should-never-happen case this value doesn't arrive in time.
const MAC_TRAFFIC_LIGHT_CLUSTER_W = 36; // 3 standard 12px circles, ~8px gaps
// Pushed well past "generous" after this kept overlapping on a real Mac
// even with the earlier 36px buffer — large enough now that the remaining
// candidate explanations are no longer "the number is a little too small"
// (see the MAC_DIAG console diagnostic below, which is how to tell the
// difference on the next test).
const MAC_TRAFFIC_LIGHT_SAFETY_BUFFER = 50;
const MAC_TRAFFIC_LIGHT_RESERVE_PX =
  MAC_TRAFFIC_LIGHT_INSET_X + MAC_TRAFFIC_LIGHT_CLUSTER_W + MAC_TRAFFIC_LIGHT_SAFETY_BUFFER; // 100

// Single entry point for "the prefs object as a toolbar renderer should see
// it" — loadPrefs() alone is just the on-disk user prefs; this adds the
// derived, never-persisted window-chrome numbers (currently just the mac
// reserve) on top, so every call site that sends prefs to a toolbar
// (prefs:getSync, broadcastPrefs, the ui:ready reply) stays in sync
// automatically instead of each needing its own copy of this merge.
function prefsForRenderer() {
  return { ...loadPrefs(), macTrafficLightReserve: MAC_TRAFFIC_LIGHT_RESERVE_PX };
}

// KNOWN ELECTRON/macOS QUIRK — this is the actual root cause of the
// traffic lights overlapping the tab strip after the window has been used
// for a while, even though `trafficLightPosition` above is correct at
// creation time: macOS silently resets the traffic-light cluster back to
// its DEFAULT built-in position (flush in the window's top-left corner,
// NOT the custom inset styles.css reserves space for) whenever the window
// transitions in certain ways — most reliably, leaving real fullscreen
// (`leave-full-screen`), but also observed around maximize/unmaximize and
// some resizes. `trafficLightPosition` passed to the BrowserWindow
// constructor is a ONE-TIME placement; Electron does not keep re-asserting
// it on every redraw, so once macOS resets the cluster, it stays reset —
// at the DEFAULT position, which is well inside the --mac-traffic-light-
// reserve band styles.css carves out at the custom inset, so the tab strip
// (which only knows about the custom inset) now overlaps it. Every prior
// attempt that only tuned trafficLightPosition's numbers or the CSS
// reserve width never touched this, which is why they didn't hold up.
// The fix is `BrowserWindow#setWindowButtonPosition` (stable Electron API,
// a thin wrapper over the same native call `trafficLightPosition` makes at
// construction) — re-asserting the SAME position after every transition
// that can trigger the reset, so the cluster is pinned back to where
// styles.css actually reserves room for it instead of drifting back to the
// OS default and under the tabs.
function applyMacTrafficLightPosition(win) {
  if (process.platform !== 'darwin') return;
  if (!win || win.isDestroyed()) return;
  if (typeof win.setWindowButtonPosition !== 'function') return;
  win.setWindowButtonPosition({ x: MAC_TRAFFIC_LIGHT_INSET_X, y: Math.round(TAB_ROW_H / 2 - 8) });
}

function nativeControlOptions() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: MAC_TRAFFIC_LIGHT_INSET_X, y: Math.round(TAB_ROW_H / 2 - 8) },
    };
  }
  // win32 and linux: Window Controls Overlay. On Linux this requires a
  // recent-enough Electron/Chromium + a desktop environment that supports
  // it (CSD-aware compositors); where it isn't available Electron silently
  // keeps the window frameless WITHOUT an overlay, which is why renderer.js
  // feature-detects `navigator.windowControlsOverlay` at runtime (see
  // applyTitleBarMode) rather than assuming it always exists on these
  // platforms — see the chat reply for the honest per-platform status.
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: overlaySymbolColor(),
      height: TAB_ROW_H,
    },
  };
}

// Where user-chosen theme settings (accent color, tab shape...) are saved.
// app.getPath('userData') is a per-user folder Electron gives you for free
// (on Windows: %APPDATA%\my-browser) — the right place for small app state.
const DEFAULT_PREFS = {
  accent: '#008200',
  tabShape: 'rounded-top',
  theme: 'dark',          // 'dark' | 'light' — see theme.css [data-theme]
  titleBarMode: 'custom', // 'custom' | 'native' — see window:setTitleBarMode below
  // 'always' | 'new-tab-only' | 'never' — see prefs:setBookmarksBarMode below
  // and renderBookmarksBar()/updateBookmarksBarVisibility() in renderer.js.
  bookmarksBarMode: 'always',
  // Which provider the URL bar searches with — see SEARCH_ENGINES below for
  // the actual per-engine URL templates. Settings page controls this.
  searchEngine: 'google',
  // Where links that ask for "a new window/tab" (target="_blank", window.open,
  // Ctrl/middle-click) go — 'new-tab' | 'same-tab'. Settings page controls
  // this; see attachWindowOpenHandler() below for the actual routing.
  linkOpenMode: 'new-tab',
  // Part 3A — Privacy & History. Whether new page visits are recorded into
  // the history store at all (see trackHistory/addHistoryEntry below).
  // Existing history is left alone when this is turned off — it just stops
  // growing.
  historyEnabled: true,
  // Part 3A — which data categories are wiped automatically every time
  // Gloza fully quits (see runClearOnExitCleanup below). Each key is
  // independent; leaving one false preserves that category untouched.
  clearOnExit: {
    history: false,
    downloads: false, // download RECORDS only — never the downloaded files
    cookies: false,   // cookies + site storage (localStorage/IndexedDB/etc.)
    cache: false,     // HTTP cache (session.defaultSession.clearCache())
  },
  // ---- Part 3B ---------------------------------------------------------
  // Homepage: '' means "Gloza's own new-tab page" (home.html). Anything
  // else is a URL, normalized the same way the address bar normalizes
  // typed input (see normalizeHomepageUrl). Used by startupBehavior
  // ('homepage') and newTabBehavior ('homepage') below.
  homepage: '',
  // What the FIRST window shows when Gloza itself launches:
  //  'blank'    -> Gloza's new-tab page (existing/default behavior)
  //  'homepage' -> the configured homepage above
  //  'restore'  -> every window/tab open at the last quit (session-state.json)
  startupBehavior: 'blank',
  // What a freshly-opened tab (new-tab button, Ctrl+T, last-tab-closed,
  // new window) shows — independent of startupBehavior, which only governs
  // the very first window of a fresh launch:
  //  'blank'    -> Gloza's new-tab page
  //  'homepage' -> the configured homepage above
  newTabBehavior: 'blank',
  // Address-bar live suggestions (search:suggest below). Turning this off
  // stops the network request entirely rather than just hiding the result.
  searchSuggestionsEnabled: true,
  // Default page zoom for newly created tabs, as a percentage (50-300).
  // Applied once at tab creation via webContents.setZoomFactor — existing
  // per-tab zoom in/out (zoom:in/out/reset, ZOOM_STEP) is untouched and
  // still works relative to whatever this started a tab at.
  defaultZoomPercent: 100,
  // '' = OS default Downloads folder (app.getPath('downloads')). Otherwise
  // an absolute directory path, validated at download time (see
  // attachDownloadHandling) — never trusted blindly in case it was deleted
  // or became unwritable since it was chosen.
  downloadDir: '',
  // When true, every download shows a native "Save As" dialog instead of
  // saving straight to downloadDir.
  askWhereToSave: false,

  // ---- Home Screen Settings (Part 2) ------------------------------------
  // Whether the saved home-screen bookmark grid (cards + plus cards + the
  // home-screen "Add bookmark" tiles) is shown at all. Purely a display
  // preference — the underlying collection, its order and the 4-bookmark
  // limit (home-bookmarks:* above) are completely unaffected by this and
  // keep working the same whether it's true or false.
  showHomeBookmarks: true,
  // Home screen background. mode is 'default' | 'color' | 'image'.
  //  'default' -> the original Gloza aurora/base background, ignoring the
  //               two fields below entirely.
  //  'color'   -> a flat built-in color, selected by id from HOME_BG_COLORS.
  //  'image'   -> a user-picked picture. Stored as a FILE NAME ONLY (never
  //               a temp picker path or a data: URL) inside
  //               userData/home-backgrounds/ — see
  //               prefs:chooseHomeBackgroundImage — so it survives restarts
  //               and prefs.json stays small.
  homeBackgroundMode: 'default',
  homeBackgroundColor: 'charcoal',
  homeBackgroundImageFile: '',
  // The top green aurora glow on the home screen (the `.aurora` element in
  // home.css). Independent of homeBackground* above — both apply at once,
  // the gradient layer sits on top of whichever background is chosen.
  showTopGradient: true,
};

// Built-in home-screen background colors — chosen to stay dark/neutral so
// bookmark card text, favicons and the plus-card icon stay readable in both
// themes (see home.css's --text / --glass contrast against each of these).
const HOME_BG_COLORS = {
  charcoal: '#14181a',
  midnight: '#0b1220',
  forest:   '#0e1f16',
  slate:    '#1b222b',
  plum:     '#1d1626',
  sand:     '#2a2420',
};
// Custom home-screen background images live here, never inline in
// prefs.json — see prefs:chooseHomeBackgroundImage.
function getHomeBackgroundsDir() {
  return path.join(app.getPath('userData'), 'home-backgrounds');
}

// ----------------------------------------------------------------------------
// Search engines — one place that knows how to build a given provider's
// search-results URL and (where it has a public one) its JSON suggestion
// endpoint. Adding a provider here is enough to make it selectable in
// Settings and usable everywhere a search URL is built (normalizeUrl,
// home.js's search box, the address-bar suggestion fetcher).
// ----------------------------------------------------------------------------
const SEARCH_ENGINES = {
  google: {
    name: 'Google',
    searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    suggestUrl: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
    // Google/Firefox-style endpoint replies with [query, [suggestions...]].
    parseSuggestions: (body) => {
      const data = JSON.parse(body);
      return Array.isArray(data?.[1]) ? data[1].filter((s) => typeof s === 'string') : [];
    },
  },
  bing: {
    name: 'Bing',
    searchUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    suggestUrl: (q) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
    parseSuggestions: (body) => {
      const data = JSON.parse(body);
      return Array.isArray(data?.[1]) ? data[1].filter((s) => typeof s === 'string') : [];
    },
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    searchUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    suggestUrl: (q) => `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
    parseSuggestions: (body) => {
      const data = JSON.parse(body);
      return Array.isArray(data?.[1]) ? data[1].filter((s) => typeof s === 'string') : [];
    },
  },
  brave: {
    // Brave Search has no public, key-free suggestion endpoint — fall back
    // to DuckDuckGo's for suggestions only; the actual search still goes to
    // Brave. Still fully functional (requirement: "provided they can be
    // implemented correctly" / "Do not add API keys").
    name: 'Brave Search',
    searchUrl: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    suggestUrl: (q) => `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
    parseSuggestions: (body) => {
      const data = JSON.parse(body);
      return Array.isArray(data?.[1]) ? data[1].filter((s) => typeof s === 'string') : [];
    },
  },
};
const DEFAULT_SEARCH_ENGINE = 'google';

function currentEngine() {
  const prefs = loadPrefs();
  return SEARCH_ENGINES[prefs.searchEngine] || SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE];
}

// ---- Part 3B: homepage / startup / new-tab URL resolution ----------------
// Same normalization the address bar uses for a bare host ("example.com" ->
// "https://example.com") — kept separate from normalizeUrl() below because
// a homepage is never a search query, only ever a URL.
function normalizeHomepageUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// What a brand-new tab (new-tab button, Ctrl+T, last-tab-closed, new
// window) should load, per the 'newTabBehavior' preference. Returns null to
// mean "Gloza's own new-tab page" (home.html) — the existing/default path.
function defaultNewTabUrl() {
  const prefs = loadPrefs();
  if (prefs.newTabBehavior === 'homepage') {
    const hp = normalizeHomepageUrl(prefs.homepage);
    if (hp) return hp;
  }
  return null;
}

// A function, not a constant — app.getPath() shouldn't be called before the
// app's 'ready' event, and this is only ever invoked after that point.
function getPrefsPath() {
  return path.join(app.getPath('userData'), 'prefs.json');
}

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(getPrefsPath(), 'utf-8')) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function chromeBg() {
  return loadPrefs().theme === 'light' ? CHROME_BG_LIGHT : CHROME_BG_DARK;
}

// Query string passed to home.html's loadFile() so its inline anti-FOUC
// <head> script (see home.html) can paint the right theme on its very first
// frame — home.html's preload has no SYNCHRONOUS getter the way
// index.html/settings.html's preloads do (see the comment in home.html),
// so this query string is still its equivalent of prefs:getSync.
// Resolves the saved background preference to what home.html can actually
// paint: for 'image' mode this means checking the file still exists on disk
// (it may have been deleted/moved since it was chosen) and falling back to
// 'default' rather than showing a broken background if it's gone — the
// preference itself is left untouched so it can recover if the file
// reappears (e.g. a restored backup), matching "keep the previous valid
// background intact if a new selection fails" for the read side too.
function resolveHomeBackground(prefs) {
  const mode = prefs.homeBackgroundMode;
  if (mode === 'color') {
    const hex = HOME_BG_COLORS[prefs.homeBackgroundColor] || HOME_BG_COLORS.charcoal;
    return { mode: 'color', color: hex, imageUrl: null };
  }
  if (mode === 'image' && prefs.homeBackgroundImageFile) {
    const full = path.join(getHomeBackgroundsDir(), prefs.homeBackgroundImageFile);
    try {
      if (fs.statSync(full).isFile()) {
        // url.pathToFileURL (not a hand-built `file://${path}` string) so
        // this comes out correct on Windows too — a manually-built string
        // produces `file://C:/Users/...`, which is actually invalid (the
        // drive letter gets parsed as a URL host); pathToFileURL emits the
        // required third slash: `file:///C:/Users/...`.
        return { mode: 'image', color: null, imageUrl: pathToFileURL(full).href };
      }
    } catch { /* file missing/unreadable — fall through to default below */ }
  }
  return { mode: 'default', color: null, imageUrl: null };
}

function homeQuery() {
  const prefs = loadPrefs();
  const bg = resolveHomeBackground(prefs);
  return {
    theme: prefs.theme === 'light' ? 'light' : 'dark',
    accent: prefs.accent || '',
    // Same reasoning: no synchronous "build me a search URL" ask is
    // available, so home.html gets the chosen engine's URL prefix once here
    // and appends its own encoded query text to it client-side.
    searchUrlPrefix: currentEngine().searchUrl(''),
    // Home Screen Settings (Part 2) — same "pass it on the query string so
    // the very first paint is already correct" reasoning as theme/accent
    // above, so hiding bookmarks / a custom background / a disabled
    // gradient never flashes the default look first.
    showBookmarks: prefs.showHomeBookmarks !== false ? '1' : '0',
    showGradient: prefs.showTopGradient !== false ? '1' : '0',
    bgMode: bg.mode,
    bgColor: bg.color || '',
    bgImageUrl: bg.imageUrl || '',
  };
}

// ---- Part 3B: session restore ("Continue where you left off") -----------
// Separate file from prefs.json on purpose: this is transient state about
// what happened to be open, not a user preference, and gets rewritten on
// every quit regardless of whether startupBehavior is 'restore' at that
// moment (so turning the setting ON always has a real, fresh snapshot to
// restore from, not a stale one from whenever it was last on).
function getSessionStatePath() {
  return path.join(app.getPath('userData'), 'session-state.json');
}

function loadSessionState() {
  try {
    const data = JSON.parse(fs.readFileSync(getSessionStatePath(), 'utf-8'));
    return Array.isArray(data?.windows) ? data : null;
  } catch {
    return null;
  }
}

// Snapshots every window's tab URLs (in order) + which tab was active.
// Internal-only tabs (Settings) are skipped — restoring into "Settings was
// open" would be nonsensical. A tab still showing Gloza's own new-tab page
// is stored as `null` so restore reopens it via the same defaultNewTabUrl()
// path a fresh tab would use, instead of hardcoding home.html's file:// URL.
function saveSessionState() {
  try {
    const winsData = [];
    for (const state of windows.values()) {
      const tabs = [];
      let activeIndex = 0;
      for (const id of state.tabOrder) {
        if (settingsTabIds.has(id)) continue;
        const discarded = discardedTabs.get(id);
        const url = discarded ? discarded.url : (tabViews.get(id)?.webContents?.getURL() || '');
        const isHome = !url || (url.startsWith('file://') && url.includes('home.html'));
        if (id === state.activeTabId) activeIndex = tabs.length;
        tabs.push(isHome ? null : url);
      }
      if (tabs.length) winsData.push({ tabs, activeIndex });
    }
    fs.mkdirSync(path.dirname(getSessionStatePath()), { recursive: true });
    fs.writeFileSync(getSessionStatePath(), JSON.stringify({ windows: winsData }, null, 2));
  } catch { /* best-effort on the way out — never block quit over this */ }
}

function savePrefs(prefs) {
  const prefsPath = getPrefsPath();
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
  broadcastPrefs();
}

// Push current prefs to every window's toolbar so each can re-apply them as
// CSS variables. (Used to just be one toolbarView — now there can be many.)
function broadcastPrefs() {
  const prefs = prefsForRenderer();
  for (const state of windows.values()) {
    state.toolbarView?.webContents.send('prefs-updated', prefs);
    // Keep the native Window Controls Overlay glyph color in sync with a
    // live dark/light toggle. macOS traffic lights are drawn entirely by
    // the OS and have no themable color, and `setTitleBarOverlay` doesn't
    // exist on 'native' Title Bar Mode windows (frame: true, no overlay to
    // begin with), so this only ever does anything on win32/linux windows
    // currently in 'custom' mode.
    if (process.platform !== 'darwin' && !state.win.isDestroyed() && typeof state.win.setTitleBarOverlay === 'function') {
      try {
        state.win.setTitleBarOverlay({ color: '#00000000', symbolColor: overlaySymbolColor(), height: TAB_ROW_H });
      } catch { /* not a frameless/overlay window (e.g. 'native' mode) — nothing to update */ }
    }
  }
  broadcastHomeData();
}

// ----------------------------------------------------------------------------
// New-tab (home.html) theme push — home.html is loaded into an ORDINARY tab
// WebContentsView (see createTab below) that can later navigate to any real
// website. It now also has a preload (home-preload.js), but that preload
// only exposes a privileged API while the page currently loaded really is
// home.html (checked inside the preload itself, re-checked on every
// navigation) — so giving this view a preload at all still never hands a
// real website an Electron API. Theme is still pushed the original way, via
// a single executeJavaScript() call, so nothing about that existing path had
// to change. Home-SCREEN bookmarks (the independent collection from Part 1)
// go over the new real IPC bridge instead — see home-bookmarks:* handlers
// and home-preload.js — and the TOOLBAR tree is no longer sent to home.html
// at all now that the home screen has its own, separate collection (see
// Section 2 of the Part 1 brief; home.js used to flatten+display the toolbar
// tree here as a placeholder before any of this existed).
// Canonical identity for Gloza's own internal pages: the EXACT file:// URL
// each one loads from (via wc.loadFile(path.join(__dirname, '...'))
// elsewhere in this file), computed once with the same pathToFileURL()
// Node already uses to build those file:// URLs in the first place — so
// this can never disagree with what loadFile() actually produced, on any
// OS/path-separator convention.
const HOME_PAGE_URL = pathToFileURL(path.join(__dirname, 'home.html')).href;
const SETTINGS_PAGE_URL = pathToFileURL(path.join(__dirname, 'settings.html')).href;

// Strips a trailing ?query and/or #hash so a navigation that merely adds
// one (settings.html?highlight=privacy, home.html#recent) still identifies
// as the same internal page.
function stripUrlQueryAndHash(url) {
  if (typeof url !== 'string') return '';
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const queryIdx = noHash.indexOf('?');
  return queryIdx === -1 ? noHash : noHash.slice(0, queryIdx);
}

// Exact-identity check, not a keyword/substring test — only Gloza's own
// file:// home.html is "home", so an external https:// page that merely
// happens to be named home.html, or to contain the word "home" or
// "settings" anywhere in its URL, is never mistaken for one.
function isHomeUrl(url) {
  return stripUrlQueryAndHash(url) === HOME_PAGE_URL;
}

// Mirrors isHomeUrl() exactly, for Settings.
function isSettingsUrl(url) {
  return stripUrlQueryAndHash(url) === SETTINGS_PAGE_URL;
}

// ---- Single source of truth: "is this a page Gloza itself must never let
// the user bookmark" ----------------------------------------------------
// ROOT CAUSE (bookmark-restriction-bypass audit): the New Tab restriction
// that already existed only lived in the renderer's star-button code
// (`bookmarkBtn.disabled = isInternalUrl(...)`, a UI-only gate). Every
// bookmark-WRITING path in the main process — bookmarks:addBookmark,
// bookmarks:toggleForTab, bookmarks:update's url-rename, and the
// context-menu's 'bookmark-page' case — took whatever url string it was
// handed at face value and wrote it straight into the bookmark tree with no
// check at all. A disabled button is not a security boundary: the
// right-click menu's "Bookmark Page" action (and, for that matter, a
// scripted/replayed IPC call) called straight into those handlers and
// bypassed it entirely. This function is now the ONE place that decides
// bookmark-eligibility, called from every writing path below, so there is
// no longer a second code path that can disagree with it.
function isRestrictedBookmarkUrl(url) {
  return isHomeUrl(url) || isSettingsUrl(url);
}

function pushHomeData(id) {
  const wc = tabViews.get(id)?.webContents;
  if (!wc || wc.isDestroyed() || !isHomeUrl(wc.getURL())) return;
  const prefs = loadPrefs();
  const bg = resolveHomeBackground(prefs);
  const payload = {
    theme: prefs.theme || 'dark',
    accent: prefs.accent,
    searchUrlPrefix: currentEngine().searchUrl(''),
    showBookmarks: prefs.showHomeBookmarks !== false,
    showGradient: prefs.showTopGradient !== false,
    bgMode: bg.mode,
    bgColor: bg.color,
    bgImageUrl: bg.imageUrl,
  };
  wc.executeJavaScript(
    `window.__glozaHomeUpdate && window.__glozaHomeUpdate(${JSON.stringify(payload)});`
  ).catch(() => {});
}

function broadcastHomeData() {
  for (const id of tabViews.keys()) pushHomeData(id);
}

// ----------------------------------------------------------------------------
// Bookmarks — a TREE, shared by every window (the bookmark toolbar, the star
// button, the new-tab page and the address-bar dropdown all read/write this
// same store). The root level IS the bookmarks toolbar; folders can nest to
// any depth the UI cares to render.
//
// Node shape:
//   bookmark: { id, type: 'bookmark', title, url, favicon }
//   folder:   { id, type: 'folder', title, children: [Node, ...] }
//
// Old data (a flat array of {id,title,url,favicon} with no `type`, from
// before folders existed) is migrated in place the first time it's loaded —
// every old entry becomes a root-level bookmark node, so nothing already
// saved is lost.
// ----------------------------------------------------------------------------
// Home-screen bookmarks — a SEPARATE, independent store from the bookmark
// toolbar tree above. A bookmark placed on the home screen does not appear
// on the toolbar and vice versa; the only way an item crosses from one to
// the other is an explicit Move (home-bookmarks:moveToToolbar /
// bookmarks:moveToHome below), which is one atomic remove-then-add.
//
// Shape: a flat, ORDERED array (array order == grid position, left-to-right,
// top-to-bottom), max 4 entries: { id, title, url, favicon }. No nesting —
// the home screen has no folders.
// ----------------------------------------------------------------------------
const HOME_BOOKMARKS_LIMIT = 4;

function getHomeBookmarksPath() {
  return path.join(app.getPath('userData'), 'home-bookmarks.json');
}

let nextHomeBookmarkId = 1;

function loadHomeBookmarks() {
  try {
    const data = JSON.parse(fs.readFileSync(getHomeBookmarksPath(), 'utf-8'));
    const list = Array.isArray(data) ? data : [];
    const cleaned = [];
    for (const raw of list) {
      if (!raw || typeof raw.url !== 'string' || !raw.url.trim()) continue; // drop corrupt entries, never crash the home page
      let id = raw.id;
      if (typeof id !== 'number') id = nextHomeBookmarkId++;
      else nextHomeBookmarkId = Math.max(nextHomeBookmarkId, id + 1);
      cleaned.push({ id, title: raw.title || raw.url, url: raw.url, favicon: raw.favicon || null });
    }
    // Enforce the 4-slot limit against whatever's actually on disk too, in
    // case the file was ever hand-edited or written by an older build.
    return cleaned.slice(0, HOME_BOOKMARKS_LIMIT);
  } catch {
    return [];
  }
}

function saveHomeBookmarks(list) {
  const p = getHomeBookmarksPath();
  const trimmed = (list || []).slice(0, HOME_BOOKMARKS_LIMIT);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  // Write-to-temp-then-rename so a crash or failed write mid-flight can
  // never leave home-bookmarks.json truncated/corrupt — the previous good
  // file stays on disk until the new one is fully written.
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  fs.renameSync(tmp, p);
  broadcastHomeBookmarks(trimmed);
  return trimmed;
}

function broadcastHomeBookmarks(list) {
  const data = list || loadHomeBookmarks();
  for (const id of tabViews.keys()) {
    const wc = tabViews.get(id)?.webContents;
    if (wc && !wc.isDestroyed() && isHomeUrl(wc.getURL())) {
      wc.send('home-bookmarks-updated', data);
    }
  }
  // Also reach any open Settings tab (Part 2's bookmark manager), same
  // "reach settingsTabIds too" pattern as broadcastAdblockStatus/
  // broadcastDarkModeStatus above. Without this, Settings' manager would
  // never find out about a bookmark added/edited/moved/reordered from
  // home.html (or another Settings window) while it happens to be open —
  // settingsTabIds isn't declared until further down this file, but that's
  // fine: this function only ever RUNS after the whole module (and that
  // const) has finished loading, since nothing calls it until an IPC
  // handler fires.
  for (const id of settingsTabIds) {
    tabViews.get(id)?.webContents.send('home-bookmarks-updated', data);
  }
  return data;
}

ipcMain.handle('home-bookmarks:list', () => loadHomeBookmarks());

ipcMain.handle('home-bookmarks:add', (e, { title, url } = {}) => {
  if (!isSafeBookmarkUrl(url)) return { ok: false, error: 'invalid-url', list: loadHomeBookmarks() };
  const name = (title || '').trim();
  if (!name) return { ok: false, error: 'invalid-name', list: loadHomeBookmarks() };
  const list = loadHomeBookmarks(); // re-read fresh so a second dialog open elsewhere can't race past the limit
  if (list.length >= HOME_BOOKMARKS_LIMIT) return { ok: false, error: 'full', list };
  const node = { id: nextHomeBookmarkId++, title: name, url: normalizeBookmarkUrl(url), favicon: null };
  list.push(node);
  const saved = saveHomeBookmarks(list);
  return { ok: true, id: node.id, list: saved };
});

ipcMain.handle('home-bookmarks:update', (e, { id, title, url } = {}) => {
  const list = loadHomeBookmarks();
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: false, error: 'not-found', list };
  if (typeof url === 'string') {
    if (!isSafeBookmarkUrl(url)) return { ok: false, error: 'invalid-url', list };
  }
  const name = typeof title === 'string' ? title.trim() : list[idx].title;
  if (!name) return { ok: false, error: 'invalid-name', list };
  // Update in place (same array index) so position is preserved exactly.
  list[idx] = {
    ...list[idx],
    title: name,
    url: typeof url === 'string' ? normalizeBookmarkUrl(url) : list[idx].url,
  };
  const saved = saveHomeBookmarks(list);
  return { ok: true, list: saved };
});

ipcMain.handle('home-bookmarks:remove', (e, id) => {
  const list = loadHomeBookmarks();
  const next = list.filter((b) => b.id !== id);
  const saved = saveHomeBookmarks(next);
  return { ok: true, list: saved };
});

// Reorders the saved collection to match orderedIds (used by the Settings
// bookmark manager's move-up/move-down controls). Re-reads fresh and
// reconciles against orderedIds defensively, rather than trusting the
// caller's array completely, so a stale/partial list from a race with
// another window can't drop or duplicate a bookmark: every id present in
// BOTH the saved list and orderedIds is placed per orderedIds' sequence;
// anything saved but missing from orderedIds (e.g. added elsewhere a
// moment ago) is appended afterward, preserving its relative order,
// instead of being silently discarded.
ipcMain.handle('home-bookmarks:reorder', (e, orderedIds) => {
  const list = loadHomeBookmarks();
  if (!Array.isArray(orderedIds)) return { ok: false, error: 'invalid', list };
  const byId = new Map(list.map((b) => [b.id, b]));
  const next = [];
  for (const id of orderedIds) {
    const b = byId.get(id);
    if (b) { next.push(b); byId.delete(id); }
  }
  for (const b of byId.values()) next.push(b); // anything not mentioned keeps its relative order, appended at the end
  const saved = saveHomeBookmarks(next);
  return { ok: true, list: saved };
});

// Home screen -> toolbar. Two separate JSON files can't be written in a
// single filesystem transaction, so "atomic" here means: write the
// destination first, and if the SOURCE write then fails, best-effort roll
// the destination write back before reporting failure — so a disk error
// mid-move can never leave the bookmark duplicated in both collections (the
// failure mode an all-at-once two-file write would otherwise risk). If the
// rollback write itself also fails (e.g. disk genuinely full), that's
// surfaced too so the caller doesn't report success over a real duplicate.
ipcMain.handle('home-bookmarks:moveToToolbar', (e, id) => {
  const homeList = loadHomeBookmarks();
  const idx = homeList.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: false, error: 'not-found', homeList, tree: loadBookmarkTree() };
  const item = homeList[idx];
  const originalTree = loadBookmarkTree(); // snapshot to roll back to if the second write fails
  let toolbarWritten = false;
  try {
    const tree = loadBookmarkTree();
    const node = { id: nextBookmarkId++, type: 'bookmark', title: item.title, url: item.url, favicon: item.favicon || null };
    tree.push(node);
    saveBookmarkTree(tree);
    toolbarWritten = true;
    const nextHome = homeList.slice(0, idx).concat(homeList.slice(idx + 1));
    const savedHome = saveHomeBookmarks(nextHome); // if THIS throws, the toolbar write above already landed
    return { ok: true, homeList: savedHome, tree };
  } catch (err) {
    if (toolbarWritten) {
      try { saveBookmarkTree(originalTree); } catch { return { ok: false, error: 'persist-failed-unrecoverable', homeList, tree: loadBookmarkTree() }; }
    }
    return { ok: false, error: 'persist-failed', homeList, tree: loadBookmarkTree() };
  }
});

// Toolbar -> home screen. Same two-write/rollback-on-failure contract as
// above, reversed: home list written first, toolbar removal rolled back to
// if that second write fails. Respects the 4-slot home limit and never
// silently drops/replaces another home bookmark to make room.
ipcMain.handle('bookmarks:moveToHome', (e, id) => {
  const tree = loadBookmarkTree();
  const found = findBookmarkNode(tree, id);
  if (!found || found.node.type !== 'bookmark') return { ok: false, error: 'not-found', tree, homeList: loadHomeBookmarks() };
  const homeList = loadHomeBookmarks();
  if (homeList.length >= HOME_BOOKMARKS_LIMIT) return { ok: false, error: 'full', tree, homeList };
  const originalHomeList = homeList.slice(); // snapshot to roll back to if the second write fails
  let homeWritten = false;
  try {
    const node = { id: nextHomeBookmarkId++, title: found.node.title, url: found.node.url, favicon: found.node.favicon || null };
    const nextHomeList = homeList.concat([node]);
    saveHomeBookmarks(nextHomeList);
    homeWritten = true;
    found.siblings.splice(found.index, 1);
    saveBookmarkTree(tree); // if THIS throws, the home write above already landed
    return { ok: true, tree, homeList: nextHomeList };
  } catch (err) {
    if (homeWritten) {
      try { saveHomeBookmarks(originalHomeList); } catch { return { ok: false, error: 'persist-failed-unrecoverable', tree: loadBookmarkTree(), homeList: loadHomeBookmarks() }; }
    }
    return { ok: false, error: 'persist-failed', tree: loadBookmarkTree(), homeList: loadHomeBookmarks() };
  }
});

function getBookmarksPath() {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}

let nextBookmarkId = 1;

function migrateNode(raw) {
  if (raw && raw.type === 'folder') {
    return {
      id: raw.id,
      type: 'folder',
      title: raw.title || 'New folder',
      children: Array.isArray(raw.children) ? raw.children.map(migrateNode).filter(Boolean) : [],
    };
  }
  if (raw && raw.url) {
    // Either already type:'bookmark', or a pre-folders legacy entry.
    return { id: raw.id, type: 'bookmark', title: raw.title || raw.url, url: raw.url, favicon: raw.favicon || null };
  }
  return null;
}

function ensureBookmarkIds(nodes) {
  for (const n of nodes) {
    if (typeof n.id !== 'number') n.id = nextBookmarkId++;
    else nextBookmarkId = Math.max(nextBookmarkId, n.id + 1);
    if (n.type === 'folder') ensureBookmarkIds(n.children);
  }
  return nodes;
}

function loadBookmarkTree() {
  try {
    const data = JSON.parse(fs.readFileSync(getBookmarksPath(), 'utf-8'));
    const nodes = Array.isArray(data) ? data.map(migrateNode).filter(Boolean) : [];
    return ensureBookmarkIds(nodes);
  } catch {
    return [];
  }
}

function saveBookmarkTree(tree) {
  const bookmarksPath = getBookmarksPath();
  fs.mkdirSync(path.dirname(bookmarksPath), { recursive: true });
  fs.writeFileSync(bookmarksPath, JSON.stringify(tree, null, 2));
  broadcastBookmarks(tree);
}

function broadcastBookmarks(tree) {
  const data = tree || loadBookmarkTree();
  for (const state of windows.values()) {
    state.toolbarView?.webContents.send('bookmarks-updated', data);
  }
  broadcastHomeData();
}

// Depth-first search for a node by id. Returns { node, parent, siblings,
// index } where `siblings` is the actual array the node lives in (so the
// caller can splice it directly) and `parent` is null at the root.
function findBookmarkNode(tree, id, parent = null) {
  const siblings = parent ? parent.children : tree;
  for (let i = 0; i < siblings.length; i++) {
    const node = siblings[i];
    if (node.id === id) return { node, parent, siblings, index: i };
    if (node.type === 'folder') {
      const found = findBookmarkNode(tree, id, node);
      if (found) return found;
    }
  }
  return null;
}

// Depth-first search by URL (used by the star button + address-bar dropdown
// to know "is this page bookmarked somewhere, anywhere" without caring which
// folder it's in).
function findBookmarkByUrl(tree, url) {
  for (const node of tree) {
    if (node.type === 'bookmark' && node.url === url) return node;
    if (node.type === 'folder') {
      const found = findBookmarkByUrl(node.children, url);
      if (found) return found;
    }
  }
  return null;
}

// True if `maybeAncestorId` is `id` itself or one of its folder ancestors —
// used to reject "move a folder into its own descendant" before it can
// create a cycle.
function isNodeOrDescendant(node, targetId) {
  if (!node) return false;
  if (node.id === targetId) return true;
  if (node.type === 'folder') return node.children.some((c) => isNodeOrDescendant(c, targetId));
  return false;
}

ipcMain.handle('bookmarks:list', () => loadBookmarkTree());

ipcMain.handle('bookmarks:addBookmark', (e, { title, url, favicon, parentId } = {}) => {
  const tree = loadBookmarkTree();
  if (!url) return tree;
  if (isRestrictedBookmarkUrl(url)) return tree; // see isRestrictedBookmarkUrl() above
  const parentFolder = parentId != null ? findBookmarkNode(tree, parentId)?.node : null;
  const siblings = parentFolder && parentFolder.type === 'folder' ? parentFolder.children : tree;
  const node = { id: nextBookmarkId++, type: 'bookmark', title: title || url, url, favicon: favicon || null };
  siblings.push(node);
  saveBookmarkTree(tree);
  return { tree, id: node.id };
});

ipcMain.handle('bookmarks:addFolder', (e, { title, parentId } = {}) => {
  const tree = loadBookmarkTree();
  const parentFolder = parentId != null ? findBookmarkNode(tree, parentId)?.node : null;
  const siblings = parentFolder && parentFolder.type === 'folder' ? parentFolder.children : tree;
  const node = { id: nextBookmarkId++, type: 'folder', title: title || 'New folder', children: [] };
  siblings.push(node);
  saveBookmarkTree(tree);
  return { tree, id: node.id };
});

// Rename a bookmark/folder, and/or (bookmarks only) change its URL. Never
// creates a duplicate — it edits the existing node in place.
ipcMain.handle('bookmarks:update', (e, { id, title, url } = {}) => {
  const tree = loadBookmarkTree();
  const found = findBookmarkNode(tree, id);
  if (!found) return tree;
  if (typeof title === 'string' && title.trim()) found.node.title = title.trim();
  // Same restriction applies to editing an EXISTING bookmark's URL — the
  // edit dialog is itself a "creation function" of a bookmark pointing at
  // Settings/New Tab if it weren't checked here too.
  if (found.node.type === 'bookmark' && typeof url === 'string' && url.trim() && !isRestrictedBookmarkUrl(url.trim())) {
    found.node.url = url.trim();
  }
  saveBookmarkTree(tree);
  return tree;
});

ipcMain.handle('bookmarks:remove', (e, id) => {
  const tree = loadBookmarkTree();
  const found = findBookmarkNode(tree, id);
  if (found) {
    found.siblings.splice(found.index, 1);
    saveBookmarkTree(tree);
  }
  return tree;
});

ipcMain.handle('bookmarks:removeByUrl', (e, url) => {
  const tree = loadBookmarkTree();
  const found = findBookmarkByUrl(tree, url);
  if (found) {
    const loc = findBookmarkNode(tree, found.id);
    if (loc) loc.siblings.splice(loc.index, 1);
    saveBookmarkTree(tree);
  }
  return tree;
});

// Star button: toggle the CURRENTLY ACTIVE tab's bookmark state (add if
// missing anywhere in the tree, remove from wherever it currently lives if
// already bookmarked) using that tab's real title/favicon. New bookmarks
// always land on the toolbar (root level) by default.
ipcMain.handle('bookmarks:toggleForTab', (e, id) => {
  // BUG: same missing-ownership-check class fixed throughout this file —
  // this is documented as acting on "the CURRENTLY ACTIVE tab" of the
  // window that asked, but took whatever `id` it was given at face value
  // instead of confirming it's actually owned by the sending window.
  const wc = ownedTabView(stateFromSender(e), id)?.webContents;
  if (!wc) return { bookmarked: false, tree: loadBookmarkTree() };
  const url = wc.getURL();
  const tree = loadBookmarkTree();
  // Settings/New Tab: never creates a bookmark (there is also nothing
  // existing to remove, since isRestrictedBookmarkUrl() is enforced on
  // every path that could have created one in the first place).
  if (isRestrictedBookmarkUrl(url)) return { bookmarked: false, tree };
  const existing = findBookmarkByUrl(tree, url);
  if (existing) {
    const loc = findBookmarkNode(tree, existing.id);
    if (loc) loc.siblings.splice(loc.index, 1);
    saveBookmarkTree(tree);
    return { bookmarked: false, tree };
  }
  const node = { id: nextBookmarkId++, type: 'bookmark', title: wc.getTitle() || url, url, favicon: tabFavicons.get(id) || null };
  tree.push(node);
  saveBookmarkTree(tree);
  return { bookmarked: true, tree, id: node.id };
});

// Move a node to a (possibly different) parent folder at a given index
// within that parent's children, OR reorder within its current parent.
// `parentId: null` means the toolbar root. Refuses to move a folder into
// itself or one of its own descendants (would create a cycle).
ipcMain.handle('bookmarks:move', (e, { id, parentId, index } = {}) => {
  const tree = loadBookmarkTree();
  const found = findBookmarkNode(tree, id);
  if (!found) return tree;
  if (isNodeOrDescendant(found.node, parentId)) return tree; // invalid: into self/descendant
  const destFolder = parentId != null ? findBookmarkNode(tree, parentId)?.node : null;
  if (parentId != null && (!destFolder || destFolder.type !== 'folder')) return tree;
  const destSiblings = destFolder ? destFolder.children : tree;

  found.siblings.splice(found.index, 1);
  let insertAt = typeof index === 'number' ? index : destSiblings.length;
  // If we just removed the node from this SAME array before its target
  // index, every later index shifted down by one — compensate.
  if (found.siblings === destSiblings && found.index < insertAt) insertAt -= 1;
  insertAt = Math.max(0, Math.min(insertAt, destSiblings.length));
  destSiblings.splice(insertAt, 0, found.node);

  saveBookmarkTree(tree);
  return tree;
});

// Reorder siblings within one parent (bookmark bar drag-to-reorder, or a
// folder popup's own drag-to-reorder). `parentId: null` = toolbar root.
ipcMain.handle('bookmarks:reorder', (e, { parentId, order } = {}) => {
  const tree = loadBookmarkTree();
  const folder = parentId != null ? findBookmarkNode(tree, parentId)?.node : null;
  const siblings = folder ? folder.children : tree;
  const byId = new Map(siblings.map((n) => [n.id, n]));
  const next = [];
  for (const id of order || []) { const n = byId.get(id); if (n && !next.includes(n)) next.push(n); } // ignore unknown/duplicate/NaN ids
  for (const n of siblings) if (!next.includes(n)) next.push(n);
  siblings.length = 0;
  siblings.push(...next);
  saveBookmarkTree(tree);
  return tree;
});

// ----------------------------------------------------------------------------
// Recent searches — plain queries typed into the address bar (not every URL
// visited, just what looked like a search), shown in the address-bar
// dropdown. Capped and de-duplicated, most recent first.
// ----------------------------------------------------------------------------
const MAX_RECENT_SEARCHES = 8;
function getSearchHistoryPath() {
  return path.join(app.getPath('userData'), 'search-history.json');
}
function loadSearchHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(getSearchHistoryPath(), 'utf-8'));
    return Array.isArray(data) ? data.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
function saveSearchHistory(list) {
  const p = getSearchHistoryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 2));
  for (const state of windows.values()) {
    state.toolbarView?.webContents.send('search-history-updated', list);
  }
}
ipcMain.handle('search:recent', () => loadSearchHistory());
ipcMain.handle('search:addRecent', (e, query) => {
  const q = (query || '').trim();
  if (!q) return loadSearchHistory();
  let list = loadSearchHistory().filter((s) => s.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  list = list.slice(0, MAX_RECENT_SEARCHES);
  saveSearchHistory(list);
  return list;
});
ipcMain.handle('search:clearRecent', () => {
  saveSearchHistory([]);
  return [];
});

// ----------------------------------------------------------------------------
// Downloads — tracked app-wide (not per-window: a download keeps going even
// if the window that started it is later closed) and broadcast to every
// window's toolbar so the downloads panel stays in sync everywhere.
// ----------------------------------------------------------------------------
const downloads = new Map(); // downloadId -> record
let nextDownloadId = 1;
const pendingAutoOpen = new Map(); // DownloadItem -> bool, set before the download starts saving

function broadcastDownloads() {
  const list = Array.from(downloads.values())
    .sort((a, b) => b.startTime - a.startTime)
    .map(({ item, ...rest }) => rest); // never send the live DownloadItem across IPC
  for (const state of windows.values()) {
    state.toolbarView?.webContents.send('downloads-updated', list);
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Part 3B: resolves the directory a download should land in, falling back
// to the OS Downloads folder (and logging nothing destructive) if the
// saved preference points at something that no longer exists or isn't
// writable — "handle unavailable directories ... gracefully" per the brief.
function resolveDownloadDir() {
  const prefs = loadPrefs();
  const configured = (prefs.downloadDir || '').trim();
  if (!configured) return app.getPath('downloads');
  try {
    const stat = fs.statSync(configured);
    if (stat.isDirectory()) {
      fs.accessSync(configured, fs.constants.W_OK);
      return configured;
    }
  } catch { /* fall through to the default below */ }
  return app.getPath('downloads');
}

function attachDownloadHandling(sess) {
  sess.on('will-download', (event, item, wc) => {
    const prefs = loadPrefs();
    const targetDir = resolveDownloadDir();
    const suggestedPath = path.join(targetDir, item.getFilename());
    if (prefs.askWhereToSave) {
      // Must be synchronous within this handler — DownloadItem#setSavePath
      // (and leaving it unset, which Electron would otherwise do silently)
      // both have to happen before will-download returns.
      const ownerWin = BrowserWindow.fromWebContents(wc) || BrowserWindow.getFocusedWindow() || null;
      let chosen;
      try {
        chosen = dialog.showSaveDialogSync(ownerWin, { defaultPath: suggestedPath });
      } catch {
        chosen = undefined;
      }
      if (!chosen) {
        item.cancel();
        return;
      }
      item.setSavePath(chosen);
    } else {
      item.setSavePath(suggestedPath);
    }

    const id = nextDownloadId++;
    const record = {
      id,
      item,
      filename: item.getFilename(),
      url: item.getURL(),
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startTime: Date.now(),
      savePath: item.getSavePath && item.getSavePath(),
      autoOpen: false,
      speedBytesPerSec: 0,
    };
    downloads.set(id, record);

    let lastTick = Date.now();
    let lastBytes = 0;

    item.on('updated', (_evt, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      record.savePath = item.getSavePath ? item.getSavePath() : record.savePath;
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      if (dt >= 0.4) {
        record.speedBytesPerSec = Math.max(0, (record.receivedBytes - lastBytes) / dt);
        lastTick = now;
        lastBytes = record.receivedBytes;
      }
      broadcastDownloads();
    });

    item.once('done', (_evt, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.state = state; // 'completed' | 'cancelled' | 'interrupted'
      record.savePath = item.getSavePath ? item.getSavePath() : record.savePath;
      record.speedBytesPerSec = 0;
      broadcastDownloads();
      if (state === 'completed' && record.autoOpen && record.savePath) {
        shell.openPath(record.savePath).catch(() => {});
      }
    });

    broadcastDownloads();
  });
}

ipcMain.handle('downloads:list', () => {
  return Array.from(downloads.values())
    .sort((a, b) => b.startTime - a.startTime)
    .map(({ item, ...rest }) => rest);
});
ipcMain.handle('downloads:open', (e, id) => {
  const rec = downloads.get(id);
  if (rec?.savePath) return shell.openPath(rec.savePath);
});
ipcMain.handle('downloads:reveal', (e, id) => {
  const rec = downloads.get(id);
  if (rec?.savePath) shell.showItemInFolder(rec.savePath);
});
ipcMain.handle('downloads:cancel', (e, id) => {
  const rec = downloads.get(id);
  try { rec?.item.cancel(); } catch { /* already finished */ }
});
ipcMain.handle('downloads:remove', (e, id) => {
  downloads.delete(id);
  broadcastDownloads();
});
ipcMain.handle('downloads:clearCompleted', () => {
  for (const [id, rec] of downloads) {
    if (rec.state !== 'progressing') downloads.delete(id);
  }
  broadcastDownloads();
});
ipcMain.handle('downloads:setAutoOpen', (e, { id, enabled }) => {
  const rec = downloads.get(id);
  if (rec) {
    rec.autoOpen = Boolean(enabled);
    broadcastDownloads();
  }
});

// ----------------------------------------------------------------------------
// Browsing history — every real (http/https) navigation a regular tab makes,
// most-recent-first, persisted to disk and broadcast to every window's
// toolbar so the History panel (opened from the browser menu) always shows
// the current list. Same shape/pattern as the downloads store above.
// ----------------------------------------------------------------------------
const MAX_HISTORY_ENTRIES = 500;
let nextHistoryId = 1;
let historyEntries = null; // lazily loaded, kept in memory, written back on every change

function getHistoryPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function loadHistory() {
  if (historyEntries) return historyEntries;
  try {
    const data = JSON.parse(fs.readFileSync(getHistoryPath(), 'utf-8'));
    historyEntries = Array.isArray(data) ? data : [];
  } catch {
    historyEntries = [];
  }
  for (const h of historyEntries) {
    if (typeof h.id === 'number') nextHistoryId = Math.max(nextHistoryId, h.id + 1);
  }
  return historyEntries;
}

function saveHistory() {
  const historyPath = getHistoryPath();
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(historyEntries, null, 2));
  broadcastHistory();
}

function broadcastHistory() {
  for (const state of windows.values()) {
    state.toolbarView?.webContents.send('history-updated', historyEntries || []);
  }
}

// Only real web pages are worth remembering — never our own internal pages
// (home/settings), and never a bare empty/about page.
function isRecordableHistoryUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && !isHomeUrl(url);
}

function addHistoryEntry({ url, title, favicon }) {
  // Recording toggle (Part 3A, Settings → Privacy & History). Checked here —
  // not just in the caller — so nothing else in the app can accidentally
  // keep writing history behind the setting's back; existing entries are
  // untouched, the list just stops growing.
  if (!loadPrefs().historyEnabled) return;
  const list = loadHistory();
  list.unshift({ id: nextHistoryId++, url, title: title || url, favicon: favicon || null, time: Date.now() });
  if (list.length > MAX_HISTORY_ENTRIES) list.length = MAX_HISTORY_ENTRIES;
  saveHistory();
}

// Attach to a regular tab's WebContents so every completed navigation to a
// real page is recorded exactly once (did-navigate-in-page covers SPA
// route changes too, same as a real browser's history). Dedupes consecutive
// identical URLs on the SAME tab (e.g. a page re-asserting its own URL)
// without suppressing a genuine repeat visit later in the session.
function trackHistory(id, wc) {
  let lastUrl = '';
  const record = () => {
    const url = wc.getURL();
    if (url === lastUrl || !isRecordableHistoryUrl(url)) return;
    lastUrl = url;
    // Title/favicon usually aren't final the instant navigation commits —
    // give the page a tick to report them, same tolerance the favicon
    // tracker already uses elsewhere in this file.
    setTimeout(() => {
      if (wc.isDestroyed() || wc.getURL() !== url) return;
      addHistoryEntry({ url, title: wc.getTitle() || url, favicon: tabFavicons.get(id) || null });
    }, 600);
  };
  wc.on('did-navigate', record);
  wc.on('did-navigate-in-page', record);
}

ipcMain.handle('history:list', () => loadHistory());
ipcMain.handle('history:clear', () => {
  historyEntries = [];
  saveHistory();
  return [];
});
ipcMain.handle('history:removeItem', (e, id) => {
  historyEntries = loadHistory().filter((h) => h.id !== id);
  saveHistory();
  return historyEntries;
});
// Bulk remove (History panel "select multiple" mode, Part 3A). Same
// single-source-of-truth path as history:removeItem — filters the real
// in-memory/on-disk list, never just a UI-side hide.
ipcMain.handle('history:removeItems', (e, ids) => {
  const idSet = new Set(Array.isArray(ids) ? ids : []);
  historyEntries = loadHistory().filter((h) => !idSet.has(h.id));
  saveHistory();
  return historyEntries;
});

// Time-range clearing (Part 3A). Only ranges whose accuracy the stored
// `time` (a plain Date.now() ms timestamp — see addHistoryEntry) actually
// supports are offered: no invented/approximate periods. Returns the ms
// cutoff — entries with time >= cutoff are the ones being cleared — or
// null for an unrecognized key (caller then leaves history untouched).
const HISTORY_RANGE_KEYS = new Set(['hour', 'today', '24h', '7d', 'all']);
function historyRangeCutoff(rangeKey) {
  const now = Date.now();
  switch (rangeKey) {
    case 'hour': return now - 60 * 60 * 1000;
    case '24h': return now - 24 * 60 * 60 * 1000;
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case 'today': {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    case 'all': return 0; // every real entry has time > 0, so all of them clear
    default: return null;
  }
}
// Entries with time >= cutoff are the ones being cleared (kept: h.time < cutoff).
ipcMain.handle('history:clearRange', (e, rangeKey) => {
  if (!HISTORY_RANGE_KEYS.has(rangeKey)) return loadHistory();
  const cutoff = historyRangeCutoff(rangeKey);
  historyEntries = loadHistory().filter((h) => h.time < cutoff);
  saveHistory();
  return historyEntries;
});

// ----------------------------------------------------------------------------
// Zoom — per-tab, via Chromium's native zoom level (persists per-origin like
// a real browser). Ctrl+scroll is handled here: Electron reports the
// gesture via 'zoom-changed' but deliberately leaves applying it to the app.
// ----------------------------------------------------------------------------
const ZOOM_STEP = 0.5; // zoom LEVEL units (each level ~= 20% factor change)
const ZOOM_MIN = -6;   // ~33%
const ZOOM_MAX = 8;    // ~300%

function clampZoomLevel(level) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

function attachZoomHandling(id, wc) {
  wc.on('zoom-changed', (_event, direction) => {
    const level = wc.getZoomLevel();
    wc.setZoomLevel(clampZoomLevel(level + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP)));
    const ownerWin = BrowserWindow.fromId(tabOwner.get(id));
    sendTabsUpdate(stateForWindow(ownerWin));
  });
}

// BUG: same missing-ownership-check class as tabs:navigate/print/dragEnd
// etc. — these three looked up `tabViews.get(id)` directly with no check
// that `id` belongs to the window that sent the request, unlike
// attachZoomHandling's own in-page 'zoom-changed' listener just above,
// which correctly looks up the tab's actual current owner via `tabOwner`.
// `sendTabsUpdate(stateFromSender(e))` compounded it: even when `id`
// belonged to another window, it would push the (unrelated) sending
// window's own tab list afterward, which could mask the fact that nothing
// it owned had actually changed zoom.
ipcMain.handle('zoom:in', (e, id) => {
  const state = stateFromSender(e);
  const wc = ownedTabView(state, id)?.webContents;
  if (!wc) return;
  wc.setZoomLevel(clampZoomLevel(wc.getZoomLevel() + ZOOM_STEP));
  sendTabsUpdate(state);
});
ipcMain.handle('zoom:out', (e, id) => {
  const state = stateFromSender(e);
  const wc = ownedTabView(state, id)?.webContents;
  if (!wc) return;
  wc.setZoomLevel(clampZoomLevel(wc.getZoomLevel() - ZOOM_STEP));
  sendTabsUpdate(state);
});
ipcMain.handle('zoom:reset', (e, id) => {
  const state = stateFromSender(e);
  const wc = ownedTabView(state, id)?.webContents;
  if (!wc) return;
  wc.setZoomLevel(0);
  sendTabsUpdate(state);
});

// ----------------------------------------------------------------------------
// Per-window state
// ----------------------------------------------------------------------------
// windows: BrowserWindow.id -> WindowState
const windows = new Map();

// Cross-window lookups that don't belong to any single window:
const tabViews = new Map();      // tabId -> WebContentsView (the tab's actual page)
const tabOwner = new Map();      // tabId -> owning BrowserWindow id
const tabFavicons = new Map();   // tabId -> icon URL
const tabOrigins = new Map();    // tabId -> last origin, to know when the site changed
const wcToTabId = new Map();     // webContentsId -> tabId
const settingsTabIds = new Set(); // tabId -> is this the (at most one per window) internal Settings tab
const pinnedTabs = new Set();    // tabId -> pinned (persists only for the life of the process, like the rest of tab state)
const discardedTabs = new Map(); // tabId -> { url, title, favicon } snapshot, while its WebContentsView is torn down (see unloadTab/restoreDiscardedTab)
let nextTabId = 1;

// Native ad/tracker blocker (Part 1B). NOT constructed here — like
// getPrefsPath()/loadPrefs() elsewhere in this file, app.getPath('userData')
// (which the Adblock constructor calls via store.js) must not run before
// the app's 'ready' event, so `adblock` stays null until app.whenReady()
// actually builds it (see the integration point further down), right
// before the first window/tab is ever created. broadcastAdblockStatus()
// pushes a fresh status snapshot to every window's toolbar, the same
// fan-out pattern broadcastPrefs() already uses.
let adblock = null;
function broadcastAdblockStatus(status) {
  for (const state of windows.values()) {
    state.toolbarView?.webContents.send('adblock:updated', status);
  }
  // Also reach any open Settings tab (a separate WebContentsView, not the
  // toolbar) so its Ad Blocker page stays live-synced with the popup/
  // backend instead of only refreshing on its own actions — see the Part 2
  // brief's "settings changes ... popup, Settings page, and backend remain
  // synchronized" requirement.
  for (const id of settingsTabIds) {
    tabViews.get(id)?.webContents.send('adblock:updated', status);
  }
}

// Force Dark Mode (Website Appearance, Part 2) — same "stays null until
// app.whenReady()" reasoning as `adblock` above (store.js's load() calls
// app.getPath('userData')).
let darkMode = null;
function broadcastDarkModeStatus(status) {
  for (const state of windows.values()) {
    state.toolbarView?.webContents.send('darkmode:updated', status);
  }
  for (const id of settingsTabIds) {
    tabViews.get(id)?.webContents.send('darkmode:updated', status);
  }
}

class WindowState {
  constructor(win, toolbarView) {
    this.win = win;
    this.toolbarView = toolbarView;
    this.tabOrder = [];       // tab ids, left-to-right display order, owned by this window
    this.activeTabId = null;
    this.toolbarHeight = 96;  // starting value; the toolbar reports its real height (chrome:height)
    this.contextMenuOpen = false;
    this.surfaceOwners = new Set(); // which of 'context-menu' / 'panel' currently need the toolbar view expanded — see expandToolbarForMenu
    // See the 'ui:ready' handler below: a window's initial tab (fresh home
    // tab, or a tab dragged in from elsewhere) is only created/attached once
    // its toolbar renderer confirms it's actually listening, not the moment
    // this window is constructed.
    this.initialized = false;
    this.pendingSeedTabId = null;
    // Set together by window:setTitleBarMode when recreating a window with
    // a new frame setting, to carry every one of the old window's tabs
    // (not just one) across once 'ui:ready' confirms it's safe — see there.
    this.pendingSeedTabIds = null;
    this.pendingSeedActiveTabId = null;
  }
}

function stateForWindow(win) {
  return win ? windows.get(win.id) : undefined;
}

// Resolve "which window is this IPC call about" from the sender's WebContents
// (every IPC call below is made BY a toolbar view, so its owning BrowserWindow
// is always the right window).
function stateFromSender(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return stateForWindow(win);
}

function createWindow(options = {}) {
  const { x, y, seedTab, width, height } = options;
  // Title Bar Mode (Settings → "custom" draws Gloza's own frameless chrome;
  // "native" uses the OS title bar instead — see window:setTitleBarMode).
  // options.frame lets the mode-switch path below be explicit about which
  // kind of window it's recreating, independent of whatever is currently
  // saved in prefs at the moment this particular call happens to run.
  const frame = options.frame ?? (loadPrefs().titleBarMode === 'native');
  const win = new BrowserWindow({
    width: width || 1280,
    height: height || 820,
    minWidth: 480,
    minHeight: 320,
    x,
    y,
    title: BROWSER_NAME,
    backgroundColor: chromeBg(),
    // Gloza draws its own tab strip + window controls (see index.html /
    // styles.css) when `frame` is false — the OS title bar and the
    // visible File/Edit/View menu BAR it would otherwise force on us are
    // removed in that mode. In 'native' Title Bar Mode, frame is true
    // instead and the toolbar hides its own custom window-control row (see
    // applyTitleBarMode in renderer.js). Either way we still install a REAL
    // application Menu below (see buildAppMenu/Menu.setApplicationMenu) —
    // without one, macOS has no Edit-menu key equivalents at all and
    // Cmd+C/V/X/A/Z simply do nothing (see the big comment above
    // buildAppMenu). autoHideMenuBar + the explicit setMenuBarVisibility(false)
    // right below just keep that real menu's BAR invisible/out of layout on
    // Windows/Linux; the menu (and its accelerators) still exists and still
    // works, same as every other app that hides its menu bar behind Alt.
    frame,
    // Only meaningful when frame === false ('custom' Title Bar Mode): asks
    // the OS/Electron to draw REAL native window controls (traffic lights
    // on macOS, the Window Controls Overlay on Windows/Linux) inside this
    // still-frameless window instead of Gloza's old hand-drawn SVG button
    // row — see nativeControlOptions() above. Spreading `{}` on 'native'
    // mode (frame: true) is a deliberate no-op: that mode already gets the
    // OS's own conventional title bar and must not also request an overlay.
    ...(frame ? {} : nativeControlOptions()),
    autoHideMenuBar: true,
    show: true,
  });
  // Belt-and-suspenders on top of autoHideMenuBar: some platforms briefly
  // show the bar on first paint otherwise. Harmless to call unconditionally
  // (no-op on macOS, which has no per-window menu bar to hide).
  win.setMenuBarVisibility(false);

  const toolbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Transparent for the view's whole life (not flipped opaque/transparent per
  // menu): #chrome paints the opaque toolbar strip itself, and the opaque<->
  // transparent flip on every menu open/close was a compositing change on
  // the full-window overlay layered above the page.
  toolbarView.setBackgroundColor?.('#00000000');
  attachDevToolsShortcut(toolbarView.webContents);
  // The toolbar UI never needs a second window; if anything in it asks for
  // one, open it as a tab of this window instead of a bare BrowserWindow.
  toolbarView.webContents.setWindowOpenHandler(
    windowOpenHandlerFor(() => windows.get(win.id), () => null)
  );
  win.contentView.addChildView(toolbarView);

  const state = new WindowState(win, toolbarView);
  windows.set(win.id, state);

  // ---- URL bar right-click menu: reuse the SAME context-menu pipeline as
  // every tab's WebContents (attachContextMenu below / New Tab's search
  // bar), instead of the toolbar renderer hand-rolling its own clipboard
  // logic. ROOT CAUSE of the URL bar's Copy/Paste bugs: index.html's own
  // #address-bar <input> lives in toolbarView's WebContents, which never
  // had a 'context-menu' listener attached at all — so renderer.js grew a
  // second, independent implementation (manual clipboard.readText() +
  // document.execCommand) instead of this one, and that second copy is
  // what had the stale/disabled-Paste bug. Electron's native 'context-menu'
  // event (the same event attachContextMenu() below listens for on every
  // tab) already reports real-time, accurate editFlags for this exact
  // input — including canPaste reflecting the ACTUAL current clipboard
  // contents, never a value cached at some earlier point — so forwarding
  // it through the existing context-menu:show/action IPC and the existing
  // #ctx-menu UI (buildItems() in renderer.js) is the correct fix, not a
  // new menu.
  //
  // Scoped to `params.isEditable` only: toolbarView also contains the tab
  // strip, bookmarks bar, and window controls, each of which already has
  // its OWN right-click menu wired as a plain DOM 'contextmenu' listener
  // (openTabContextMenu/openBookmarkContextMenu, via openLocalMenu) — none
  // of those targets are editable, so this listener leaves them completely
  // untouched and never fires two menus at once. #address-bar is the only
  // editable element anywhere in the toolbar chrome.
  toolbarView.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const { width, height } = win.getContentBounds();
    expandToolbarForMenu(state, 'context-menu');
    toolbarView.webContents.send('context-menu:show', {
      x: Math.max(0, Math.min(params.x, width - 4)),
      y: params.y,
      windowW: width,
      windowH: height,
      tabId: null,
      params: {
        selectionText: params.selectionText || '',
        linkURL: '',
        srcURL: '',
        mediaType: 'none',
        isEditable: true,
        // Tells buildItems() (renderer.js) to render the trimmed
        // edit-only menu (Cut/Copy/Paste/Select All/Undo/Redo) instead of
        // the full page menu — Back/Forward/Reload/Bookmark/Save/View
        // Source/Inspect don't apply to the chrome's own address field.
        isToolbar: true,
        pageURL: '',
        canGoBack: false,
        canGoForward: false,
        editFlags: {
          canCut: Boolean(params.editFlags && params.editFlags.canCut),
          canCopy: Boolean(params.editFlags && params.editFlags.canCopy),
          canPaste: Boolean(params.editFlags && params.editFlags.canPaste),
          canSelectAll: Boolean(params.editFlags && params.editFlags.canSelectAll),
          canUndo: Boolean(params.editFlags && params.editFlags.canUndo),
          canRedo: Boolean(params.editFlags && params.editFlags.canRedo),
        },
      },
    });
  });

  // Tell this window's toolbar whenever its maximize state changes so it can
  // swap the maximize icon for a restore icon (and back).
  const sendWindowState = () => {
    toolbarView.webContents.send('window:state', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    });
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.on('enter-full-screen', sendWindowState);
  win.on('leave-full-screen', sendWindowState);

  // Re-pin the traffic lights after every transition macOS is known (or
  // suspected — resize/maximize are cheap to cover defensively) to reset
  // them around. Only wired up in 'custom' Title Bar Mode (frame === false,
  // the only mode where we asked for a custom trafficLightPosition at all
  // — see nativeControlOptions()); 'native' mode has a real OS title bar
  // and no custom light position to defend. See applyMacTrafficLightPosition
  // for the full root-cause explanation.
  if (process.platform === 'darwin' && !frame) {
    win.on('leave-full-screen', () => applyMacTrafficLightPosition(win));
    win.on('enter-full-screen', () => applyMacTrafficLightPosition(win));
    win.on('maximize', () => applyMacTrafficLightPosition(win));
    win.on('unmaximize', () => applyMacTrafficLightPosition(win));
    win.on('resize', () => applyMacTrafficLightPosition(win));
    win.once('ready-to-show', () => applyMacTrafficLightPosition(win));
  }

  win.once('ready-to-show', () => win.show());

  toolbarView.webContents.loadFile(path.join(__dirname, 'index.html'));

  layoutViews(state);
  win.on('resize', () => layoutViews(state));

  // Any tab still owned by this window when it closes has nowhere left to
  // live — dispose it so it doesn't become an orphaned WebContents still
  // consuming memory/network in the background.
  win.on('closed', () => {
    for (const id of state.tabOrder) {
      const view = tabViews.get(id);
      tabViews.delete(id);
      adblock?.detachTab(id, view?.webContents);
      darkMode?.detachTab(id);
      try { view?.webContents?.close(); } catch { /* already gone */ }
      tabOwner.delete(id);
      tabFavicons.delete(id);
      tabOrigins.delete(id);
    }
    windows.delete(win.id);
  });

  // ROOT CAUSE of "the transferred tab is invisible until I open another
  // tab": this used to call attachExistingTab()/createTab() (both of which
  // end up sending a 'tabs-updated' IPC message) SYNCHRONOUSLY, right here,
  // immediately after kicking off loadFile() above. loadFile() is async —
  // the toolbar's page (and so renderer.js's `ipcRenderer.on('tabs-updated',
  // ...)` listener) doesn't exist yet at this point in time. Electron does
  // NOT queue IPC messages sent before a renderer has loaded and registered
  // its listeners; it just drops them. So that very first tab's state was
  // silently lost every single time.
  //
  // For an ordinary new tab (home page) this used to go unnoticed: the new
  // tab's OWN page then fires 'did-start-loading' / 'did-stop-loading' /
  // 'page-title-updated' etc., each of which re-sends 'tabs-updated' — and
  // by the time those fire the toolbar page has long since finished
  // loading, so one of those later sends "accidentally" gets through and
  // the UI self-heals. A tab dragged in from another window, though, has
  // usually already finished loading — it fires no further loading events —
  // so that one lost send was the ONLY send, and the tab stayed invisible
  // (space reserved for it in the strip, since the toolbarHeight/layout
  // logic doesn't depend on tab state, but no actual tab element) until
  // something unrelated (like opening another tab) happened to trigger a
  // fresh 'tabs-updated'.
  //
  // Fix: don't guess at timing at all. Store what this window should show
  // once its renderer is actually ready, and only push state in response to
  // an explicit 'ui:ready' message the renderer sends itself once it has
  // finished registering its listeners (see the end of renderer.js and the
  // 'ui:ready' handler below). That makes correctness independent of how
  // long loadFile() takes, how fast the machine is, or whether the tab is
  // brand-new or transferred in already-loaded.
  state.pendingSeedTabId = seedTab ? seedTab.id : null;

  return state;
}

// Resizes the toolbar view + the active tab's view to fill the window.
// While the context menu is open, the toolbar view is temporarily expanded
// to cover the whole window (see expandToolbarForMenu below) — skip
// clobbering that bounds change until the menu closes.
function layoutViews(state) {
  if (!state || !state.win || state.win.isDestroyed()) return;
  const { width, height } = state.win.getContentBounds();
  if (!state.contextMenuOpen) {
    state.toolbarView.setBounds({ x: 0, y: 0, width, height: state.toolbarHeight });
  }
  if (state.activeTabId !== null && tabViews.has(state.activeTabId)) {
    const v = tabViews.get(state.activeTabId);
    const next = { x: 0, y: state.toolbarHeight, width, height: Math.max(0, height - state.toolbarHeight) };
    const cur = v.getBounds();
    // Skip identical bounds: setBounds on the page view schedules a native
    // resize/repaint even when nothing changed.
    if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) v.setBounds(next);
  }
}

// F12 or Ctrl+Shift+I opens DevTools for whichever part of the browser has
// focus: click the toolbar first to inspect YOUR UI, or click a page to
// inspect that page. Only fires while this app is focused (unlike a global
// shortcut, which would steal the key from every other program).
// "detach" = DevTools opens in its own window; docked, it would be squeezed
// into the thin toolbar strip.
function attachDevToolsShortcut(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isInspect = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
    if (!isF12 && !isInspect) return;
    event.preventDefault();
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  });
}

// Exported for callers that just need the "is this a URL or a search
// query" judgment without building a URL (e.g. the renderer's dropdown
// deciding whether to show a "Visit" row vs a "Search" row).
function looksLikeUrlInput(trimmed) {
  return (
    /^[a-z]+:\/\//i.test(trimmed) ||
    // A bare "localhost" (optionally with a port) is a valid address even
    // though it has no dot — handle it explicitly rather than only via the
    // dotted-hostname pattern below.
    /^localhost(:\d+)?(\/.*)?$/i.test(trimmed) ||
    /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(trimmed)
  );
}

function normalizeUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return 'https://www.google.com';
  if (looksLikeUrlInput(trimmed)) {
    return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  return currentEngine().searchUrl(trimmed);
}

// ---- Favicons ----
const isHttpUrl = (u) => /^https?:\/\//i.test(u);
// Only pass along icon URLs the toolbar can safely show as an <img>
const isSafeFavicon = (u) => typeof u === 'string' && (isHttpUrl(u) || /^data:image\//i.test(u));

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// Must be called BEFORE the generic listeners in createTab, so the state is
// already up to date when those listeners send it to the toolbar.
function trackFavicon(id, wc) {
  // A new page committed. If the site changed, forget the old site's icon so
  // it doesn't linger on a page that has none.
  wc.on('did-navigate', (event, url) => {
    const origin = originOf(url);
    if (origin !== tabOrigins.get(id)) {
      tabOrigins.set(id, origin);
      tabFavicons.delete(id);
    }
  });

  // The page declared its icon(s) via <link rel="icon">. Use the first usable one.
  wc.on('page-favicon-updated', (event, favicons) => {
    const best = favicons.find(isSafeFavicon);
    if (best) tabFavicons.set(id, best);
  });

  // Finished loading and the page never declared an icon: many sites still
  // serve one at /favicon.ico. The toolbar falls back to a globe if it's missing.
  wc.on('did-stop-loading', () => {
    const url = wc.getURL();
    if (!tabFavicons.has(id) && isHttpUrl(url)) {
      tabFavicons.set(id, `${originOf(url)}/favicon.ico`);
    }
  });
}

// ----------------------------------------------------------------------------
// Links that want "a new window" (target="_blank", window.open(), Ctrl/middle-
// click, form target=_blank...).
//
// Without a window-open handler Electron answers every one of these by
// spawning a bare BrowserWindow — no tab strip, no toolbar, no Gloza chrome.
// This handler is attached to every tab (and the toolbar) so those requests
// are always routed into Gloza's own tabs instead, following the "Open links"
// setting (prefs.linkOpenMode):
//   'new-tab'  — the link opens in a new tab (background tab for Ctrl/middle-
//                click, foreground otherwise).
//   'same-tab' — the link replaces the page in the tab it was clicked in
//                (Ctrl/middle-click still opens a background tab).
// Script popups that need a live connection to the page that opened them
// (OAuth/"Sign in with…" windows, window.open('') + document.write, POSTed
// target=_blank forms) always get a real tab with window.opener intact, even
// in 'same-tab' mode, because replacing the opener would break them.
// ----------------------------------------------------------------------------
function currentLinkOpenMode() {
  return loadPrefs().linkOpenMode === 'same-tab' ? 'same-tab' : 'new-tab';
}

// Hands a mailto:/tel: link to the OS; anything else we can't show in a tab
// is simply ignored (the old behaviour was an empty, chrome-less window).
function openNonWebUrl(url) {
  if (/^(mailto|tel):/i.test(url)) shell.openExternal(url).catch(() => {});
}

const TAB_LOADABLE_URL = /^(https?|file|ftp|data|blob|about|view-source):/i;

function openedAsPopup(details) {
  const url = details.url || '';
  const features = details.features || '';
  // `noopener` (and `noreferrer`, which implies it) means the page
  // EXPLICITLY asked for no relationship back to the opener at all — the
  // opposite of "this popup needs window.opener preserved". Treating it as
  // a such a popup anyway (which the plain "features string is non-empty"
  // check below used to do, since 'noopener' itself is a non-empty
  // features string) sends it down the createWindow/adopt-the-WebContents
  // path in windowOpenHandlerFor — and Electron cannot synchronously hand
  // back a live WebContents for a noopener window the way it can for a
  // real opener-linked popup, so attempting it throws "Invalid webContents"
  // in the main process rather than opening anything. A plain
  // `window.open(url, '_blank', 'noopener')` from any ordinary page is
  // just a normal new-tab request and must never take this branch.
  if (/\bnoopener\b|\bnoreferrer\b/i.test(features)) return false;
  return (
    !url || url === 'about:blank' ||
    Boolean(details.postBody) ||
    Boolean(features && features.trim())
  );
}

// `getOwnerState` is a function (not a value) because a tab can move to
// another window after this handler was attached.
function windowOpenHandlerFor(getOwnerState, getOpenerWc) {
  return (details) => {
    const state = getOwnerState();
    if (!state || state.win.isDestroyed()) return { action: 'deny' };
    const url = details.url || '';
    const background = details.disposition === 'background-tab';

    // Popup that needs window.opener: give it a real tab backed by the exact
    // WebContents Chromium is opening, so the opener relationship survives.
    if (openedAsPopup(details)) {
      return {
        action: 'allow',
        createWindow: (options) => {
          const view = new WebContentsView({
            webPreferences: {
              ...((options && options.webPreferences) || {}),
              contextIsolation: true,
              sandbox: true,
            },
          });
          createTab(state, null, { view, background });
          return view.webContents;
        },
      };
    }

    if (!TAB_LOADABLE_URL.test(url)) {
      openNonWebUrl(url);
      return { action: 'deny' };
    }

    const openerWc = getOpenerWc();
    // Ctrl/middle-click is an explicit "open this elsewhere", so it still
    // gets a (background) tab even in 'same-tab' mode.
    if (currentLinkOpenMode() === 'same-tab' && !background && openerWc && !openerWc.isDestroyed()) {
      // Deferred so we're not navigating from inside Chromium's own
      // open-window callback.
      setImmediate(() => { if (!openerWc.isDestroyed()) openerWc.loadURL(url); });
    } else {
      setImmediate(() => {
        if (!state.win.isDestroyed()) createTab(state, url, { exact: true, background });
      });
    }
    return { action: 'deny' };
  };
}

function attachWindowOpenHandler(id, wc) {
  wc.setWindowOpenHandler(
    windowOpenHandlerFor(
      () => stateForWindow(BrowserWindow.fromId(tabOwner.get(id))),
      () => wc
    )
  );
}

// If a tab's page closes itself (window.close() — e.g. a sign-in popup
// finishing) its WebContents is destroyed out from under us. Drop the tab
// from the strip instead of leaving a dead entry that breaks every
// subsequent tab update. Intentional closes/unloads/replacements remove the
// tabViews entry BEFORE destroying the view, so the identity check below
// ignores them.
function watchTabDestroyed(id, view) {
  view.webContents.once('destroyed', () => {
    if (tabViews.get(id) !== view) return;
    const state = stateForWindow(BrowserWindow.fromId(tabOwner.get(id)));
    if (state) closeTab(state, id);
  });
}

// Pass a url to go straight there, or call with nothing for your home page.
// opts.view: adopt an already-created WebContentsView (a popup Chromium is
//            opening itself) instead of making one and loading `url`.
// opts.exact: `url` is already a complete, canonical URL — don't run it
//            through normalizeUrl() (which would e.g. turn blob:/data: into
//            a web search).
// opts.background: add the tab without switching to it.
function createTab(state, url, opts = {}) {
  const id = nextTabId++;
  const view = opts.view || new WebContentsView({
    // preload: home-preload.js — same "can become any website" tab view as
    // ever, so it only ever exposes a privileged API when the page currently
    // loaded really is our own home.html (checked inside the preload itself,
    // re-checked on every navigation since preload re-runs each time). See
    // the big comment above pushHomeData/isHomeUrl for the full rationale.
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'home-preload.js') },
  });
  // Only for our OWN home.html (no url given) — a brand-new WebContentsView
  // otherwise defaults to a plain white backing color, which flashes behind
  // home.html until its CSS paints. A real website gets left at the normal
  // default: imposing Gloza's dark/light chrome color behind an arbitrary
  // page would itself look like a glitch if that site is the other theme.
  if (!opts.view && (!url || !url.trim())) view.setBackgroundColor?.(chromeBg());
  tabViews.set(id, view);
  tabOwner.set(id, state.win.id);
  state.tabOrder.push(id);

  const wc = view.webContents;
  attachDevToolsShortcut(wc);
  trackFavicon(id, wc);
  trackHistory(id, wc);
  attachContextMenu(id, wc);
  attachFindInPage(id, wc);
  attachZoomHandling(id, wc);
  attachWindowOpenHandler(id, wc);
  watchTabDestroyed(id, view);
  adblock?.attachTab(id, wc);
  darkMode?.attachTab(id, wc);

  // Part 3B: default page zoom. Applied once, here, at creation time — the
  // existing per-tab zoom:in/out/reset (ZOOM_STEP, attachZoomHandling
  // above) still works normally from whatever this starts a tab at; they
  // share the same underlying Chromium zoom, just two different ways of
  // changing it.
  if (!opts.view) {
    const zoomPercent = loadPrefs().defaultZoomPercent;
    if (Number.isFinite(zoomPercent) && zoomPercent !== 100) {
      wc.setZoomFactor(Math.min(3, Math.max(0.25, zoomPercent / 100)));
    }
  }

  if (opts.view) {
    // Popup adopted from Chromium: the page that opened it drives its
    // navigation, nothing to load here.
  } else if (!url || !url.trim()) {
    // home.html is mostly a plain page — clicking a link on it navigates
    // this same tab normally, nothing special required — but it now also
    // gets a narrowly-scoped privileged API (window.glozaHome, exposed by
    // home-preload.js only while this page is actually showing) for its own
    // home-screen bookmark grid. See home-preload.js and the home-bookmarks:*
    // handlers above.
    wc.loadFile(path.join(__dirname, 'home.html'), { query: homeQuery() });
  } else {
    wc.loadURL(opts.exact ? url : normalizeUrl(url));
  }

  // Whenever anything about the page changes, tell that tab's CURRENT
  // window to re-render (resolved fresh each time, since a tab can move
  // between windows after this listener was attached).
  const notify = () => {
    const ownerWin = BrowserWindow.fromId(tabOwner.get(id));
    sendTabsUpdate(stateForWindow(ownerWin));
  };
  wc.on('page-title-updated', notify);
  wc.on('did-navigate', notify);
  wc.on('did-navigate-in-page', notify);
  wc.on('did-start-loading', notify);
  wc.on('did-stop-loading', notify);
  wc.on('page-favicon-updated', notify);
  // Real audio/mute state (Chromium-reported, not a separate UI toggle) —
  // fires whenever the page starts/stops actually producing sound, so the
  // tab-strip speaker icon always reflects reality the moment it changes.
  wc.on('audio-state-changed', notify);
  // See pushHomeData above: home.html has no preload, so this is how it
  // learns the current theme/accent/bookmarks right after it loads.
  wc.on('did-finish-load', () => pushHomeData(id));

  if (opts.background) sendTabsUpdate(state);
  else switchTab(state, id);
  return id;
}

// The settings page is "internal" (loaded from our own files, not the web),
// so unlike regular tabs it gets its own preload with access to prefs.
// Regular createTab() tabs intentionally get NO preload — a random website
// must never be able to read/write files on the user's machine.
function createSettingsTab(state, navOpts) {
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setBackgroundColor?.(chromeBg());
  tabViews.set(id, view);
  tabOwner.set(id, state.win.id);
  settingsTabIds.add(id);
  state.tabOrder.push(id);

  const wc = view.webContents;
  attachDevToolsShortcut(wc);
  attachContextMenu(id, wc);
  attachFindInPage(id, wc);
  attachWindowOpenHandler(id, wc);
  watchTabDestroyed(id, view);
  // Deep-link into a specific Settings page via a query string rather than
  // a post-load IPC event, so there's no race against settings.js
  // attaching its listener before the page has even loaded.
  wc.loadFile(path.join(__dirname, 'settings.html'), navOpts ? { query: navOpts } : undefined);

  const notify = () => {
    const ownerWin = BrowserWindow.fromId(tabOwner.get(id));
    sendTabsUpdate(stateForWindow(ownerWin));
  };
  wc.on('page-title-updated', notify);
  wc.on('did-start-loading', notify);
  wc.on('did-stop-loading', notify);

  switchTab(state, id);
  return id;
}

// Re-creates a discarded tab's WebContentsView from its saved snapshot and
// re-registers it under the SAME tab id, so its position, pin state, and
// slot in tabOrder never change — unloading/restoring must be invisible to
// everything except the page's own live state (which is intentionally
// lost, same as any real browser's tab-discard).
function restoreDiscardedTab(state, id) {
  const snap = discardedTabs.get(id);
  if (!snap) return;
  discardedTabs.delete(id);

  const view = new WebContentsView({
    // Same guarded home-preload as createTab() above — a restored tab can
    // just as easily have been showing home.html as any real site.
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'home-preload.js') },
  });
  tabViews.set(id, view);
  tabOwner.set(id, state.win.id);

  const wc = view.webContents;
  attachDevToolsShortcut(wc);
  trackFavicon(id, wc);
  trackHistory(id, wc);
  attachContextMenu(id, wc);
  attachFindInPage(id, wc);
  attachZoomHandling(id, wc);
  attachWindowOpenHandler(id, wc);
  watchTabDestroyed(id, view);
  adblock?.attachTab(id, wc);
  darkMode?.attachTab(id, wc);
  if (snap.favicon) tabFavicons.set(id, snap.favicon);

  if (snap.isHome || !snap.url || !snap.url.trim()) {
    wc.loadFile(path.join(__dirname, 'home.html'), { query: homeQuery() });
  } else {
    wc.loadURL(normalizeUrl(snap.url));
  }

  const notify = () => {
    const ownerWin = BrowserWindow.fromId(tabOwner.get(id));
    sendTabsUpdate(stateForWindow(ownerWin));
  };
  wc.on('page-title-updated', notify);
  wc.on('did-navigate', notify);
  wc.on('did-navigate-in-page', notify);
  wc.on('did-start-loading', notify);
  wc.on('did-stop-loading', notify);
  wc.on('page-favicon-updated', notify);
  wc.on('audio-state-changed', notify);
  wc.on('did-finish-load', () => pushHomeData(id));
}

function switchTab(state, id) {
  if (discardedTabs.has(id) && tabOwner.get(id) === state.win.id) restoreDiscardedTab(state, id);
  if (!tabViews.has(id) || tabOwner.get(id) !== state.win.id) return;
  if (state.activeTabId !== null && tabViews.has(state.activeTabId)) {
    state.win.contentView.removeChildView(tabViews.get(state.activeTabId));
  }
  state.activeTabId = id;
  state.win.contentView.addChildView(tabViews.get(id));
  layoutViews(state);
  sendTabsUpdate(state);
}

function closeTab(state, id) {
  const view = tabViews.get(id);
  // A discarded (unloaded) tab has no view left to close — it can also
  // never be the active tab (switchTab always restores it first), so the
  // only thing closing it needs to do is drop its bookkeeping below.
  const isDiscarded = discardedTabs.has(id);
  if ((!view && !isDiscarded) || tabOwner.get(id) !== state.win.id) return;

  const wasActive = Boolean(view) && state.activeTabId === id;
  if (wasActive) state.win.contentView.removeChildView(view);

  // Unregister BEFORE destroying so watchTabDestroyed() sees an intentional close.
  tabViews.delete(id);
  adblock?.detachTab(id, view?.webContents);
  darkMode?.detachTab(id);
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
  tabOwner.delete(id);
  tabFavicons.delete(id);
  tabOrigins.delete(id);
  settingsTabIds.delete(id);
  pinnedTabs.delete(id);
  discardedTabs.delete(id);
  state.tabOrder = state.tabOrder.filter((t) => t !== id);

  if (wasActive) {
    state.activeTabId = null;
    const next = state.tabOrder[state.tabOrder.length - 1];
    if (next !== undefined) {
      switchTab(state, next);
    } else {
      // No tabs left in this window. Previously this silently opened a
      // fresh home tab, which meant closing "the last tab" never actually
      // felt like closing anything. A window with zero tabs isn't a useful
      // state for Gloza to be in, so close the whole window instead — same
      // behavior a user would expect from closing the last tab of a real
      // browser window. win.close() tears the window down via the normal
      // 'closed' handler (which already cleans up `windows`), so nothing
      // extra is needed here.
      if (!state.win.isDestroyed()) state.win.close();
    }
  } else {
    sendTabsUpdate(state);
  }
}

function sendTabsUpdate(state) {
  if (!state || !state.toolbarView || state.win.isDestroyed()) return;
  const data = state.tabOrder.map((id) => {
    // A discarded (unloaded) tab has no WebContentsView right now — render
    // it from the snapshot unloadTab() took before tearing it down instead.
    if (discardedTabs.has(id)) {
      const snap = discardedTabs.get(id);
      return {
        id,
        title: snap.title || 'New Tab',
        url: snap.url,
        favicon: snap.favicon || null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
        pinned: pinnedTabs.has(id),
        muted: false,
        audible: false,
        discarded: true,
      };
    }
    const wc = tabViews.get(id).webContents;
    return {
      id,
      title: wc.getTitle() || 'New Tab',
      url: wc.getURL(),
      favicon: tabFavicons.get(id) || null,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      zoomPercent: Math.round(wc.getZoomFactor() * 100),
      pinned: pinnedTabs.has(id),
      // Real Chromium state, not an independent UI toggle: `muted` is the
      // user's mute choice (persists even when the page goes quiet);
      // `audible` is whether the page is ACTUALLY producing sound right now.
      muted: wc.isAudioMuted(),
      audible: wc.isCurrentlyAudible(),
      discarded: false,
    };
  });
  state.toolbarView.webContents.send('tabs-updated', { tabs: data, activeTabId: state.activeTabId });
}

// The toolbar sends this exactly once, right after it has finished
// registering every ipcRenderer.on(...) listener it needs (see the very end
// of renderer.js) — i.e. the first moment it's actually safe to push state
// at it. This is what fixes the "transferred tab stays invisible" bug: we
// no longer guess that loadFile() having resolved (or any other timing)
// means the renderer is ready to receive 'tabs-updated'/'prefs-updated' —
// we wait to be told.
ipcMain.on('ui:ready', (event) => {
  const state = stateFromSender(event);
  if (!state || event.sender !== state.toolbarView.webContents) return;
  if (!state.initialized) {
    state.initialized = true;
    if (state.pendingSeedTabIds) {
      // This window was created by window:setTitleBarMode to take over
      // every tab from a window being recreated with a different frame
      // setting — attach them all, in their original order, and restore
      // whichever one was active.
      const ids = state.pendingSeedTabIds;
      const activeId = state.pendingSeedActiveTabId;
      state.pendingSeedTabIds = null;
      state.pendingSeedActiveTabId = null;
      for (const id of ids) attachExistingTab(state, id, id === activeId);
      if (state.activeTabId == null && state.tabOrder.length) switchTab(state, state.tabOrder[0]);
    } else if (state.pendingSeedTabId != null) {
      // This window was created to receive a tab dragged out of (or into)
      // another window — attach it now instead of creating a fresh home tab.
      attachExistingTab(state, state.pendingSeedTabId, /* becomeActive */ true);
    } else if (state.pendingRestoreTabs) {
      // Part 3B: startupBehavior === 'restore' seeded this window with the
      // URLs it had open at the last quit (see loadSessionState/the
      // app.whenReady() call site below). null entries are Gloza's own
      // new-tab page — same createTab(state, null) path as a fresh tab.
      const urls = state.pendingRestoreTabs;
      const activeIndex = state.pendingRestoreActiveIndex || 0;
      state.pendingRestoreTabs = null;
      state.pendingRestoreActiveIndex = null;
      if (!urls.length) {
        createTab(state, defaultNewTabUrl());
      } else {
        // BUG (found in the full-browser audit): this used to be
        // `createTab(state, u || defaultNewTabUrl())`. `u` is `null`
        // specifically to mean "this tab was on Gloza's own new-tab page"
        // (see saveSessionState above and the comment a few lines up —
        // "same createTab(state, null) path as a fresh tab"). But
        // `defaultNewTabUrl()` does NOT always return null: when the user
        // has "Open homepage on new tab" enabled (newTabBehavior ===
        // 'homepage'), it returns their homepage URL instead. So restoring
        // a session that had a plain new-tab-page tab open at quit would
        // silently send that tab to the user's homepage instead of
        // Gloza's new-tab page — misrepresenting exactly what was open,
        // and contradicting the "same ... path as a fresh tab" contract
        // this code is supposed to follow. createTab() already treats a
        // null/empty url as "load home.html" on its own (see its
        // `!url || !url.trim()` branch), so passing `u` straight through
        // does the right thing for both cases without reinterpreting it.
        const ids = urls.map((u) => createTab(state, u));
        // createTab() activates whichever tab it just created, so once
        // they're all in, explicitly restore the one that was actually
        // active last time instead of leaving the LAST one active.
        switchTab(state, ids[Math.min(activeIndex, ids.length - 1)]);
      }
    } else {
      createTab(state, defaultNewTabUrl()); // no seed tab — fresh new tab per newTabBehavior
    }
  }
  // (Re-)send everything this window's UI needs to be fully correct, every
  // time it reports ready — harmless if called again (e.g. renderer reload
  // during development) and guarantees nothing is ever silently lost.
  state.toolbarView.webContents.send('prefs-updated', prefsForRenderer());
  state.toolbarView.webContents.send('window:state', {
    maximized: state.win.isMaximized(),
    fullscreen: state.win.isFullScreen(),
  });
  state.toolbarView.webContents.send('bookmarks-updated', loadBookmarkTree());
  state.toolbarView.webContents.send('search-history-updated', loadSearchHistory());
  state.toolbarView.webContents.send('history-updated', loadHistory());
  state.toolbarView.webContents.send(
    'downloads-updated',
    Array.from(downloads.values()).sort((a, b) => b.startTime - a.startTime).map(({ item, ...rest }) => rest)
  );
  sendTabsUpdate(state);
});

// ---- IPC: the toolbar UI (renderer.js, via preload.js) calls these ----
ipcMain.handle('tabs:new', (e, url) => createTab(stateFromSender(e), url));
ipcMain.handle('tabs:close', (e, id) => closeTab(stateFromSender(e), id));
ipcMain.handle('tabs:switch', (e, id) => switchTab(stateFromSender(e), id));
// Drag-to-reorder (renderer.js): accepts the full list of tab ids in their
// new left-to-right order, for tabs that never left this window. Only
// reorders — doesn't touch which view is active or any tab's content, so
// dragging never disturbs navigation state.
ipcMain.handle('tabs:reorder', (e, order) => {
  const state = stateFromSender(e);
  if (!state || !Array.isArray(order)) return;
  state.tabOrder = reconcileOrder(state, order);
  sendTabsUpdate(state);
});

function reconcileOrder(state, order) {
  const seen = new Set();
  const next = [];
  for (const id of order) {
    if (tabOwner.get(id) === state.win.id && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  // Safety net: if the renderer's list is missing/duplicating ids (e.g. a
  // tab closed mid-drag), append any real tabs it left out, preserving
  // their previous relative order, so no tab is ever lost.
  for (const id of state.tabOrder) {
    if (!seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  return next;
}

// ----------------------------------------------------------------------
// Tab context-menu actions (New Tab to Right/Left, Unload, Duplicate,
// Mute, Pin, Move submenu, Close Multiple submenu). See the renderer's
// openTabContextMenu for the menu itself; everything here just mutates
// tabOrder / pinnedTabs / discardedTabs and re-renders via sendTabsUpdate,
// same pattern as every other tab action above.
// ----------------------------------------------------------------------

function insertTabAt(state, id, index) {
  state.tabOrder = state.tabOrder.filter((t) => t !== id);
  state.tabOrder.splice(Math.max(0, Math.min(index, state.tabOrder.length)), 0, id);
}

// New Tab to Right / New Tab to Left of a given tab.
function newTabAdjacent(state, relativeId, side) {
  const id = createTab(state, defaultNewTabUrl()); // createTab() already makes it active + sends an update
  // Index of relativeId with the just-created tab excluded, so "+1" for
  // the right side always lands immediately after it regardless of where
  // createTab() happened to push the new tab onto the end of tabOrder.
  const relIndex = state.tabOrder.filter((t) => t !== id).indexOf(relativeId);
  if (relIndex === -1) return id;
  insertTabAt(state, id, side === 'left' ? relIndex : relIndex + 1);
  sendTabsUpdate(state);
  return id;
}

function duplicateTab(state, id) {
  // BUG: this ownership check exists on the live-tab branch just below
  // (`tabOwner.get(id) !== state.win.id`) but was missing here on the
  // discarded-tab branch. `discardedTabs` and `tabOwner` are both global
  // maps keyed by tab id, not scoped to a window, so without this check a
  // discarded tab belonging to a DIFFERENT window would still be accepted:
  // duplicateTab would read that other window's snapshot and insert a
  // fresh, duplicate tab into the window that merely issued the IPC call
  // (`tabs:duplicate` itself does no ownership validation either — this
  // function is the only gatekeeper). Same bug class as the title-bar-mode
  // window-close issue: code that's careful about window ownership in one
  // branch but not a parallel one.
  if (discardedTabs.has(id) && tabOwner.get(id) === state.win.id) {
    const snap = discardedTabs.get(id);
    newTabAdjacent(state, id, 'right');
    // newTabAdjacent already created+placed a fresh tab; now point it at
    // the discarded tab's URL instead of the new-tab page.
    const newId = state.activeTabId;
    const view = tabViews.get(newId);
    if (view && !snap.isHome && snap.url) view.webContents.loadURL(normalizeUrl(snap.url));
    return;
  }
  const view = tabViews.get(id);
  if (!view || tabOwner.get(id) !== state.win.id) return;
  const url = view.webContents.getURL();
  const isHome = url.startsWith('file://') && url.includes('home.html');
  const newId = createTab(state, isHome ? '' : url);
  insertTabAt(state, newId, state.tabOrder.indexOf(id) + 1);
  sendTabsUpdate(state);
}

function unloadTab(state, id) {
  const view = tabViews.get(id);
  if (!view || tabOwner.get(id) !== state.win.id) return;
  if (discardedTabs.has(id)) return; // already unloaded
  if (state.activeTabId === id) return; // discarding the active tab has no visible effect — just reload it; nothing to save by unloading

  const wc = view.webContents;
  const url = wc.getURL();
  const isHome = url.startsWith('file://') && url.includes('home.html');
  discardedTabs.set(id, {
    url: isHome ? '' : url,
    isHome,
    title: wc.getTitle() || 'New Tab',
    favicon: tabFavicons.get(id) || null,
  });
  tabViews.delete(id); // before close(): see watchTabDestroyed()
  adblock?.detachTab(id, wc);
  darkMode?.detachTab(id);
  wc.close();
  sendTabsUpdate(state);
}

function togglePinTab(state, id) {
  if (tabOwner.get(id) !== state.win.id) return;
  if (pinnedTabs.has(id)) {
    pinnedTabs.delete(id);
  } else {
    pinnedTabs.add(id);
    // Pinned tabs live at the front of the strip, in the order they were
    // pinned — move this one to the end of the already-pinned block.
    const pinnedCount = state.tabOrder.filter((t) => pinnedTabs.has(t)).length;
    insertTabAt(state, id, pinnedCount - 1);
  }
  sendTabsUpdate(state);
}

function moveTabToStart(state, id) {
  if (tabOwner.get(id) !== state.win.id) return;
  // Stay inside/outside the pinned block rather than jumping across it —
  // an unpinned tab moved "to start" goes right after the last pinned tab,
  // a pinned tab goes to index 0.
  const target = pinnedTabs.has(id) ? 0 : state.tabOrder.filter((t) => pinnedTabs.has(t) && t !== id).length;
  insertTabAt(state, id, target);
  sendTabsUpdate(state);
}

function moveTabToEnd(state, id) {
  if (tabOwner.get(id) !== state.win.id) return;
  if (pinnedTabs.has(id)) {
    // "End" for a pinned tab means the end of the pinned block, not past it.
    const lastPinnedIndex = state.tabOrder.filter((t) => pinnedTabs.has(t) && t !== id).length - 1;
    insertTabAt(state, id, lastPinnedIndex + 1);
  } else {
    insertTabAt(state, id, state.tabOrder.length);
  }
  sendTabsUpdate(state);
}

function moveTabToNewWindow(state, id) {
  if (tabOwner.get(id) !== state.win.id) return;
  const view = tabViews.get(id);
  const bounds = state.win.getBounds();
  pinnedTabs.delete(id); // pin state doesn't currently carry across windows
  createWindow({
    x: bounds.x + 40,
    y: bounds.y + 40,
    seedTab: { id },
  });
  // attachExistingTab (run via the new window's 'ui:ready') detaches `id`
  // from `state` for us; nothing else to do here.
}

// Close every OTHER tab (keep only `id`), used by both "Close Other Tabs"
// and as the shared core of "Close Tabs to Right/Left". Pinned tabs are
// never swept up by a bulk-close — same rule real browsers use, since
// pinning is specifically "protect this tab from the tabs around it being
// closed".
function closeTabsWhere(state, predicate) {
  const toClose = state.tabOrder.filter((t) => predicate(t) && !pinnedTabs.has(t));
  for (const t of toClose) closeTab(state, t);
}

ipcMain.handle('tabs:newTabAdjacent', (e, { relativeId, side }) => {
  const state = stateFromSender(e);
  if (state) newTabAdjacent(state, relativeId, side);
});
ipcMain.handle('tabs:duplicate', (e, id) => {
  const state = stateFromSender(e);
  if (state) duplicateTab(state, id);
});
ipcMain.handle('tabs:unload', async (e, id) => {
  const state = stateFromSender(e);
  if (!state) return { result: 'noop' };
  const view = tabViews.get(id);
  if (!view || tabOwner.get(id) !== state.win.id) return { result: 'noop' };
  if (state.activeTabId === id) return { result: 'is-active' };
  // Best-effort "would this lose something" check: if the page has any
  // non-empty text input/textarea, warn before discarding it — unloading
  // truly does drop in-page state (forms, scroll position, JS memory),
  // same as a real tab discard, so this is the one place that can
  // meaningfully warn about it rather than silently mislabeling a reload
  // as a safe no-op.
  let hasUnsavedInput = false;
  try {
    hasUnsavedInput = await view.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('input,textarea')).some(el => (el.value || '').trim().length > 0)`,
      true
    );
  } catch { /* page blocked script execution (e.g. a PDF viewer) — proceed without the check */ }
  if (hasUnsavedInput) {
    const { response } = await dialog.showMessageBox(state.win, {
      type: 'warning',
      buttons: ['Unload Anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unload Tab',
      message: 'This tab has unsaved input.',
      detail: 'Unloading it will discard anything typed into it. The tab will reload its URL fresh when you switch back to it.',
    });
    if (response !== 0) return { result: 'cancelled' };
  }
  unloadTab(state, id);
  return { result: 'unloaded' };
});
// Print the page of exactly the tab id given (never "whatever is focused" —
// focus is in the toolbar view while a menu is open).
ipcMain.handle('tabs:print', (e, id) => {
  const view = ownedTabView(stateFromSender(e), id);
  if (!view || view.webContents.isDestroyed()) return false;
  view.webContents.print({ silent: false, printBackground: true }, () => {});
  return true;
});

ipcMain.handle('tabs:toggleMute', (e, id) => {
  const state = stateFromSender(e);
  const view = ownedTabView(state, id);
  if (!view) return;
  view.webContents.setAudioMuted(!view.webContents.isAudioMuted());
  sendTabsUpdate(state);
});
ipcMain.handle('tabs:togglePin', (e, id) => {
  const state = stateFromSender(e);
  if (state) togglePinTab(state, id);
});
ipcMain.handle('tabs:moveToStart', (e, id) => {
  const state = stateFromSender(e);
  if (state) moveTabToStart(state, id);
});
ipcMain.handle('tabs:moveToEnd', (e, id) => {
  const state = stateFromSender(e);
  if (state) moveTabToEnd(state, id);
});
ipcMain.handle('tabs:moveToNewWindow', (e, id) => {
  const state = stateFromSender(e);
  if (state) moveTabToNewWindow(state, id);
});
ipcMain.handle('tabs:closeToRight', (e, id) => {
  const state = stateFromSender(e);
  if (!state) return;
  const idx = state.tabOrder.indexOf(id);
  if (idx === -1) return;
  const rightIds = new Set(state.tabOrder.slice(idx + 1));
  closeTabsWhere(state, (t) => rightIds.has(t));
});
ipcMain.handle('tabs:closeToLeft', (e, id) => {
  const state = stateFromSender(e);
  if (!state) return;
  const idx = state.tabOrder.indexOf(id);
  if (idx === -1) return;
  const leftIds = new Set(state.tabOrder.slice(0, idx));
  closeTabsWhere(state, (t) => leftIds.has(t));
});
ipcMain.handle('tabs:closeOthers', (e, id) => {
  const state = stateFromSender(e);
  if (!state) return;
  closeTabsWhere(state, (t) => t !== id);
});
ipcMain.handle('tabs:closeMultiple', (e, ids) => {
  const state = stateFromSender(e);
  if (!state || !Array.isArray(ids)) return;
  const set = new Set(ids);
  closeTabsWhere(state, (t) => set.has(t));
});

// BUG: tabs:navigate/back/forward/reload (and, further down, tabs:print
// and tabs:toggleMute) used to act on `tabViews.get(id)` directly with no
// check at all that `id` actually belongs to the window that sent the IPC
// message. Every OTHER tab-mutating handler in this file enforces that —
// either inline (`tabOwner.get(id) !== state.win.id`) or inside the
// function it calls (closeTab, switchTab, togglePinTab, duplicateTab,
// etc.) — specifically because tab ids are global and a renderer can only
// be trusted to know about ITS OWN window's tabs; under ordinary use the
// toolbar never hands out another window's id, but the whole reason this
// file is full of `tabOwner.get(id) !== state.win.id` guards is the
// windows where that stops being true — a tab mid-handoff during a drag
// to a new window, or during a title-bar-mode window swap (see the fixes
// above) — exactly when a stale id sitting in a timer or a just-fired
// keyboard shortcut in the OLD window could still reach one of these six
// handlers and act on a tab that isn't this window's anymore (navigate it,
// print it, mute it, walk its history) with no check stopping it. Adding
// the same ownership check these handlers were missing, matching the rest
// of the file.
function ownedTabView(state, id) {
  if (!state || tabOwner.get(id) !== state.win.id) return null;
  return tabViews.get(id) || null;
}
ipcMain.handle('tabs:navigate', (e, { id, url } = {}) => {
  const view = ownedTabView(stateFromSender(e), id);
  if (!view) return;
  if (!url || !url.trim()) {
    view.webContents.loadFile(path.join(__dirname, 'home.html'), { query: homeQuery() });
  } else {
    view.webContents.loadURL(normalizeUrl(url));
  }
});
ipcMain.handle('tabs:back', (e, id) => ownedTabView(stateFromSender(e), id)?.webContents.navigationHistory.goBack());
ipcMain.handle('tabs:forward', (e, id) => ownedTabView(stateFromSender(e), id)?.webContents.navigationHistory.goForward());
ipcMain.handle('tabs:reload', (e, id) => ownedTabView(stateFromSender(e), id)?.webContents.reload());
ipcMain.handle('tabs:openSettings', (e, navOpts) => {
  const state = stateFromSender(e);
  if (!state) return;
  // There should only ever be one Settings tab per window. If one is
  // already open (anywhere in this window's tab order, not just the active
  // tab), just switch to it instead of stacking up duplicates.
  const existing = state.tabOrder.find((id) => settingsTabIds.has(id));
  if (existing !== undefined) {
    switchTab(state, existing);
    // The tab (and its listener) already exists, so a deep-link request
    // is delivered as a live event instead of a fresh query string.
    if (navOpts) tabViews.get(existing)?.webContents.send('settings:navigate', navOpts);
    return existing;
  }
  return createSettingsTab(state, navOpts);
});
// Mirror image of tabs:openSettings above: called FROM the Settings tab
// ("Manage history…", Part 3A) to tell that window's toolbar to open the
// real History panel, since the Settings page is a separate tab with no
// direct access to the toolbar's DOM.
ipcMain.handle('toolbar:openHistoryPanel', (e) => {
  const state = stateFromSender(e);
  if (!state) return;
  state.toolbarView?.webContents.send('toolbar:openHistoryPanel');
});
// ----------------------------------------------------------------------------
// Address-bar search suggestions. Uses Electron's own `net` module (shares
// Chromium's network stack, proxy config, etc — more correct here than
// Node's https) so this works the same way a normal page request would.
//
// Cancellation: `net.request` objects support .abort(). We only ever want
// ONE in-flight suggestion request per window (a fast typist firing off a
// new keystroke should kill the previous request, not just race it), so we
// key the in-flight request by the toolbar webContents id and abort+replace
// on every call. We also return the query we actually answered so the
// renderer can drop a response that arrives after a newer one if an abort
// raced a request that was already in-flight past the point of no return.
// ----------------------------------------------------------------------------
const inflightSuggestRequests = new Map(); // toolbarWebContentsId -> net.ClientRequest

ipcMain.handle('search:suggest', (event, query) => {
  const q = (query || '').trim();
  // Part 3B: when the user has turned suggestions off, stop short of the
  // network request entirely rather than fetching and hiding the result —
  // "respect the user's preferences" per the brief, not just cosmetically.
  if (!loadPrefs().searchSuggestionsEnabled) return Promise.resolve({ query: q, suggestions: [] });
  const senderId = event.sender.id;
  const prior = inflightSuggestRequests.get(senderId);
  if (prior) { try { prior.abort(); } catch { /* already finished */ } }
  inflightSuggestRequests.delete(senderId);

  if (!q) return Promise.resolve({ query: q, suggestions: [] });

  const engine = currentEngine();
  return new Promise((resolve) => {
    let settled = false;
    let req; // declared before finish() so finish's closure can compare identity
    const finish = (result) => {
      if (settled) return;
      settled = true;
      // Only clear the map entry if it's still THIS request — a just-
      // aborted prior request's late 'error' callback must not delete the
      // entry a newer request has since installed for the same sender.
      if (inflightSuggestRequests.get(senderId) === req) inflightSuggestRequests.delete(senderId);
      resolve(result);
    };
    try {
      req = net.request(engine.suggestUrl(q));
    } catch {
      finish({ query: q, suggestions: [], error: true });
      return;
    }
    inflightSuggestRequests.set(senderId, req);
    // Don't let a slow/hanging provider hold the dropdown in "loading"
    // forever — same spirit as debouncing on the renderer side, just for
    // the network leg specifically.
    const timeout = setTimeout(() => {
      try { req.abort(); } catch { /* already finished */ }
    }, 4000);
    let body = '';
    req.on('response', (res) => {
      res.on('data', (chunk) => { body += chunk.toString('utf-8'); });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          finish({ query: q, suggestions: engine.parseSuggestions(body).slice(0, 6) });
        } catch {
          finish({ query: q, suggestions: [], error: true });
        }
      });
    });
    req.on('error', () => {
      clearTimeout(timeout);
      finish({ query: q, suggestions: [], error: true });
    });
    req.end();
  });
});

// About section (Settings): the ONLY thing the renderer ever learns about
// the package is this one string, via app.getVersion() — Electron reads it
// straight from package.json (dev) / the packaged app's own bundled
// package.json (production), so there is exactly one place the version is
// ever declared. No preload exposes `require('../package.json')` or any
// other broader Node/package access just to read this.
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('prefs:get', () => loadPrefs());
ipcMain.handle('prefs:save', (e, prefs) => savePrefs(prefs));
// Dedicated handler (same pattern as window:setTitleBarMode below) so the
// bookmarks-bar visibility submenu can persist its choice immediately,
// without going through the Settings page's full-form "Save changes" flow.
const BOOKMARKS_BAR_MODES = new Set(['always', 'new-tab-only', 'never']);
ipcMain.handle('prefs:setBookmarksBarMode', (e, mode) => {
  const next = BOOKMARKS_BAR_MODES.has(mode) ? mode : 'always';
  savePrefs({ ...loadPrefs(), bookmarksBarMode: next });
  return next;
});
// "Open links" (Settings): where target=_blank / window.open links go — see
// attachWindowOpenHandler(). Applied immediately; merges into the saved prefs
// so it can't clobber anything else.
const LINK_OPEN_MODES = new Set(['new-tab', 'same-tab']);
ipcMain.handle('prefs:setLinkOpenMode', (e, mode) => {
  const next = LINK_OPEN_MODES.has(mode) ? mode : 'new-tab';
  savePrefs({ ...loadPrefs(), linkOpenMode: next });
  return next;
});
// History recording toggle (Settings → Privacy & History, Part 3A). Applied
// immediately, same pattern as the two handlers above.
ipcMain.handle('prefs:setHistoryEnabled', (e, enabled) => {
  const next = Boolean(enabled);
  savePrefs({ ...loadPrefs(), historyEnabled: next });
  return next;
});
// Clear-on-exit categories (Part 3A). Merges just the keys the caller sent
// over the CURRENT saved clearOnExit object (itself backfilled with
// defaults) so toggling one checkbox in Settings can never silently reset
// the other three to their defaults.
ipcMain.handle('prefs:setClearOnExit', (e, partial) => {
  const prefs = loadPrefs();
  const next = { ...DEFAULT_PREFS.clearOnExit, ...prefs.clearOnExit, ...(partial || {}) };
  savePrefs({ ...prefs, clearOnExit: next });
  return next;
});

// ---- Part 3B: General / Appearance / Downloads prefs, same "applied
// immediately, validated, merged over current saved prefs" pattern as the
// three handlers above. ----------------------------------------------------

// Homepage: '' is the explicit "use Gloza's own new-tab page" value — not
// an unset/invalid state — so it's accepted as-is. Anything else is run
// through the same normalization the address bar uses for bare hosts.
ipcMain.handle('prefs:setHomepage', (e, value) => {
  const trimmed = (value || '').trim();
  const next = trimmed ? (normalizeHomepageUrl(trimmed) || '') : '';
  savePrefs({ ...loadPrefs(), homepage: next });
  return next;
});

const STARTUP_BEHAVIORS = new Set(['blank', 'homepage', 'restore']);
ipcMain.handle('prefs:setStartupBehavior', (e, mode) => {
  const next = STARTUP_BEHAVIORS.has(mode) ? mode : 'blank';
  savePrefs({ ...loadPrefs(), startupBehavior: next });
  return next;
});

const NEW_TAB_BEHAVIORS = new Set(['blank', 'homepage']);
ipcMain.handle('prefs:setNewTabBehavior', (e, mode) => {
  const next = NEW_TAB_BEHAVIORS.has(mode) ? mode : 'blank';
  savePrefs({ ...loadPrefs(), newTabBehavior: next });
  return next;
});

ipcMain.handle('prefs:setSearchSuggestionsEnabled', (e, enabled) => {
  const next = Boolean(enabled);
  savePrefs({ ...loadPrefs(), searchSuggestionsEnabled: next });
  return next;
});

// Default zoom, as a whole percentage. Clamped to the same range the save
// dialog below and tab creation above actually honor (25%-300%) so a
// malformed/out-of-range value from the renderer can never be persisted
// and silently fail to apply later.
ipcMain.handle('prefs:setDefaultZoomPercent', (e, percent) => {
  const n = Number(percent);
  const next = Number.isFinite(n) ? Math.min(300, Math.max(25, Math.round(n))) : 100;
  savePrefs({ ...loadPrefs(), defaultZoomPercent: next });
  return next;
});

// Lets the user pick a download directory via a real native dialog (rather
// than typing a path by hand). Does NOT persist it — the caller (Settings
// page) follows up with prefs:setDownloadDir once it has the chosen path,
// same two-step shape as any other dialog-backed setting.
ipcMain.handle('prefs:chooseDownloadDir', async (e) => {
  const state = stateFromSender(e);
  const result = await dialog.showOpenDialog(state?.win || null, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: loadPrefs().downloadDir || app.getPath('downloads'),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Validates the directory actually exists and is a directory before
// persisting it — an unavailable/mistyped path is rejected here rather
// than silently failing the next time something tries to download into it.
ipcMain.handle('prefs:setDownloadDir', (e, dirPath) => {
  const trimmed = (dirPath || '').trim();
  if (!trimmed) {
    savePrefs({ ...loadPrefs(), downloadDir: '' });
    return { value: '', error: null };
  }
  try {
    const stat = fs.statSync(trimmed);
    if (!stat.isDirectory()) throw new Error('not-a-directory');
    fs.accessSync(trimmed, fs.constants.W_OK);
  } catch {
    return { value: loadPrefs().downloadDir, error: 'That folder isn\'t available or isn\'t writable.' };
  }
  savePrefs({ ...loadPrefs(), downloadDir: trimmed });
  return { value: trimmed, error: null };
});

ipcMain.handle('prefs:setAskWhereToSave', (e, enabled) => {
  const next = Boolean(enabled);
  savePrefs({ ...loadPrefs(), askWhereToSave: next });
  return next;
});

// ---- Home Screen Settings (Part 2) ----------------------------------------
// Same "applied immediately, validated, merged over current saved prefs"
// pattern as every handler above — nothing new invented here.

// Resolved view of the current background (actual hex / usable file:// URL,
// with the same "image file went missing -> report default" fallback as
// homeQuery()) — lets the Settings page show an accurate preview/active
// state without duplicating resolveHomeBackground's file-existence check.
ipcMain.handle('prefs:getHomeBackgroundPreview', () => resolveHomeBackground(loadPrefs()));

ipcMain.handle('prefs:setShowHomeBookmarks', (e, enabled) => {
  const next = Boolean(enabled);
  savePrefs({ ...loadPrefs(), showHomeBookmarks: next });
  return next;
});

ipcMain.handle('prefs:setShowTopGradient', (e, enabled) => {
  const next = Boolean(enabled);
  savePrefs({ ...loadPrefs(), showTopGradient: next });
  return next;
});

// Selecting a built-in color sets both the color AND the mode in one write,
// so "pick a color" always and immediately shows that color — it can never
// land on a saved color while mode is still 'default'/'image' from before.
ipcMain.handle('prefs:setHomeBackgroundColor', (e, colorId) => {
  const next = Object.prototype.hasOwnProperty.call(HOME_BG_COLORS, colorId) ? colorId : 'charcoal';
  savePrefs({ ...loadPrefs(), homeBackgroundMode: 'color', homeBackgroundColor: next });
  return { mode: 'color', color: next };
});

// Switches back to the original Gloza background. Deliberately does NOT
// delete any previously-chosen custom image file — picking "Default" then
// "Custom picture" again should not force a fresh file picker if the user
// is just toggling between looks.
ipcMain.handle('prefs:setHomeBackgroundDefault', () => {
  savePrefs({ ...loadPrefs(), homeBackgroundMode: 'default' });
  return { mode: 'default' };
});

// If a previously-chosen custom image is still on disk, switches straight
// to it (no file picker needed — "select a different image" is a separate
// action, below). If none was ever chosen, this is a no-op on the mode so
// the caller can fall back to opening the picker.
ipcMain.handle('prefs:setHomeBackgroundImageMode', () => {
  const prefs = loadPrefs();
  if (!prefs.homeBackgroundImageFile) return { mode: prefs.homeBackgroundMode, error: 'no-image' };
  try {
    const full = path.join(getHomeBackgroundsDir(), prefs.homeBackgroundImageFile);
    if (!fs.statSync(full).isFile()) throw new Error('missing');
  } catch {
    return { mode: prefs.homeBackgroundMode, error: 'no-image' };
  }
  savePrefs({ ...prefs, homeBackgroundMode: 'image' });
  return { mode: 'image' };
});

const HOME_BG_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Opens a native file picker for a custom home-screen background, validates
// the chosen file, copies it into userData/home-backgrounds/ (never relies
// on the picker's own temp path, which is not guaranteed to survive a
// restart) and switches mode to 'image'. The previous custom image file (if
// any) is deleted only AFTER the new one is copied and prefs are saved
// successfully, so a failure partway through never leaves the background in
// a broken state and never loses the previous valid picture.
ipcMain.handle('prefs:chooseHomeBackgroundImage', async (e) => {
  const state = stateFromSender(e);
  const result = await dialog.showOpenDialog(state?.win || null, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, error: 'canceled' };
  const chosen = result.filePaths[0];

  const ext = path.extname(chosen).toLowerCase();
  if (!HOME_BG_IMAGE_EXTENSIONS.has(ext)) {
    return { ok: false, error: 'unsupported-format' };
  }
  let stat;
  try {
    stat = fs.statSync(chosen);
    if (!stat.isFile() || stat.size === 0) throw new Error('empty-or-not-a-file');
    fs.accessSync(chosen, fs.constants.R_OK);
  } catch {
    return { ok: false, error: 'unreadable' };
  }

  const prefs = loadPrefs();
  const dir = getHomeBackgroundsDir();
  const fileName = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const dest = path.join(dir, fileName);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(chosen, dest);
  } catch {
    return { ok: false, error: 'copy-failed' };
  }

  const previousFile = prefs.homeBackgroundImageFile;
  try {
    savePrefs({ ...prefs, homeBackgroundMode: 'image', homeBackgroundImageFile: fileName });
  } catch {
    // Saving prefs failed — remove the copy we just made so it doesn't
    // linger as an orphaned file, and leave the old background intact.
    try { fs.unlinkSync(dest); } catch { /* best-effort cleanup */ }
    return { ok: false, error: 'persist-failed' };
  }
  if (previousFile && previousFile !== fileName) {
    try { fs.unlinkSync(path.join(dir, previousFile)); } catch { /* best-effort; an orphaned old file is harmless */ }
  }
  const bg = resolveHomeBackground(loadPrefs());
  // fileName is echoed back (not just mode/imageUrl) so the Settings renderer
  // can keep its own loadedPrefs.homeBackgroundImageFile mirror accurate —
  // see the "Save changes" cross-clobbering note in settings.js. Without
  // this, Settings' batched Save button (General/Appearance page) could
  // later write a stale/empty homeBackgroundImageFile back over this new
  // one, silently reverting the background to default.
  return { ok: true, mode: bg.mode, imageUrl: bg.imageUrl, fileName };
});
// Synchronous counterpart of 'prefs:get', called once at the very top of
// preload.js/settings-preload.js (before any page script or stylesheet has
// run) so the toolbar/settings page can set data-theme on <html> BEFORE its
// first paint. Without this, the page always paints with whatever :root
// (dark) looks like first and only flips to the real theme after the normal
// async 'prefs-updated' round-trip resolves — a visible flash to/from dark
// for anyone using light mode. See CHROME_BG below for the matching fix at
// the native BrowserWindow level.
ipcMain.on('prefs:getSync', (event) => {
  event.returnValue = prefsForRenderer();
});

// The toolbar reports its own rendered height so the page area below it
// always starts exactly at its bottom edge (only the toolbar itself may call this).
ipcMain.on('chrome:height', (event, height) => {
  const state = stateFromSender(event);
  if (!state || event.sender !== state.toolbarView.webContents) return;
  if (!Number.isFinite(height) || height < 40 || height > 300) return;
  state.toolbarHeight = Math.round(height);
  layoutViews(state);
});

// ---- IPC: window-control actions (minimize / maximize-restore / close) ----
// In 'custom' Title Bar Mode the actual Close/Minimize/Maximize/Restore
// buttons are now real OS-native controls (see nativeControlOptions()
// above) that the OS wires up itself — these handlers are no longer behind
// Gloza-drawn buttons for that case. They're kept for the other ways the
// app still triggers these actions programmatically: double-clicking empty
// tab-row space (maximizeToggle), app-menu/keyboard shortcuts, and the
// last-tab-close path in renderer.js (closeWindow).
ipcMain.handle('window:minimize', (e) => stateFromSender(e)?.win.minimize());
ipcMain.handle('window:maximizeToggle', (e) => {
  const state = stateFromSender(e);
  if (!state) return;
  if (state.win.isMaximized()) state.win.unmaximize();
  else state.win.maximize();
});
ipcMain.handle('window:close', (e) => stateFromSender(e)?.win.close());
// ---- IPC: custom drag for the empty tab-strip space -----------------------
// That area is deliberately `-webkit-app-region: no-drag` (see styles.css)
// instead of relying on the OS-level drag region Electron normally offers
// for `-webkit-app-region: drag`: that native drag swallows mouse events at
// the OS level before they ever reach the DOM, which is exactly why a plain
// click there could never reliably dismiss the URL dropdown no matter how
// the renderer-side listener was wired. Doing the drag ourselves — move the
// window by the same pixel delta the renderer's pointermove already
// reports — keeps dragging working while letting a plain click (no
// movement) behave like a normal, fully-delivered DOM click.
// Fire-and-forget (ipcMain.on, not .handle): this fires on every
// pointermove while dragging, so it skips the async reply round-trip.
ipcMain.on('window:moveBy', (e, { dx, dy } = {}) => {
  const state = stateFromSender(e);
  if (!state || state.win.isMaximized() || state.win.isFullScreen()) return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = state.win.getPosition();
  state.win.setPosition(Math.round(x + dx), Math.round(y + dy));
});
// Browser menu → "New Window": a brand-new Gloza window with its own fresh
// home tab, same as the app's very first window. Independent of the window
// that asked for it — closing the original window afterwards must not
// affect this one, and vice versa (ordinary multi-window behavior, already
// what createWindow()/window-all-closed give every other window).
ipcMain.handle('windows:new', () => {
  const state = createWindow();
  return state.win.id;
});
ipcMain.handle('window:isMaximized', (e) => Boolean(stateFromSender(e)?.win.isMaximized()));
ipcMain.handle('window:fullscreenToggle', (e) => {
  const state = stateFromSender(e);
  if (!state) return;
  state.win.setFullScreen(!state.win.isFullScreen());
});
ipcMain.handle('window:isFullscreen', (e) => Boolean(stateFromSender(e)?.win.isFullScreen()));

// Title Bar Mode (Settings): 'custom' (Gloza's own frameless chrome) or
// 'native' (the OS title bar). Electron can't flip a live BrowserWindow's
// `frame` option in place, so switching modes recreates EVERY currently
// open window with the new frame setting and hands each one's existing
// tabs to its replacement via attachExistingTab (same mechanism used to
// move a tab between windows during a drag — see "Tab drag" below) rather
// than reloading/recreating the tabs themselves, so navigation history,
// zoom, scroll position etc. all survive the switch untouched. The setting
// itself is saved first so every NEW window created afterwards (including
// the replacements built here) already picks up the right frame value.
ipcMain.handle('window:setTitleBarMode', (e, mode) => {
  const next = mode === 'native' ? 'native' : 'custom';
  savePrefs({ ...loadPrefs(), titleBarMode: next });

  const wantFrame = next === 'native';
  for (const state of Array.from(windows.values())) {
    const oldWin = state.win;
    if (oldWin.isDestroyed()) continue;
    // isMaximized() reported through frame:false can behave oddly if read
    // AFTER the old window starts closing, so capture everything up front.
    const bounds = oldWin.getBounds();
    const wasMaximized = oldWin.isMaximized();
    const tabOrder = [...state.tabOrder];
    const activeTabId = state.activeTabId;

    const newState = createWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: wantFrame,
    });
    // Same race the single-tab drag-detach path avoids with
    // pendingSeedTabId (see 'ui:ready' below): this new window's toolbar
    // hasn't necessarily finished loading/registering its IPC listeners
    // yet, so sending tabs-updated right now could be silently dropped.
    // pendingSeedTabIds (plural) lets 'ui:ready' attach every carried-over
    // tab, in order, the moment it's actually safe to.
    newState.pendingSeedTabIds = tabOrder;
    newState.pendingSeedActiveTabId = activeTabId;

    newState.win.once('ready-to-show', () => {
      if (wasMaximized) newState.win.maximize();
    });

    // BUG (this is the "tabs disappear / New Tab resets everything" report):
    // createWindow()'s own `win.on('closed', ...)` handler (above) treats
    // ANY tab still sitting in `state.tabOrder` at close time as abandoned
    // and destroys it — deletes it from tabViews/tabOwner and explicitly
    // closes its webContents. That's the right behavior for an ordinary
    // window close (a tab really does have nowhere left to go), but it's
    // exactly wrong here: oldWin.close() below runs immediately, while the
    // actual hand-off of these tabs to newState only happens later, async,
    // once the NEW window's renderer reports 'ui:ready' (necessarily
    // deferred — see the big comment on that handler). `state.tabOrder`
    // still listed every one of these tabs right up until that handoff, so
    // oldWin's 'closed' cleanup ran first every time and tore them all down
    // — tabViews.delete()'d and webContents.close()'d — before
    // attachExistingTab() ever got a chance to claim them. By the time
    // 'ui:ready' fired, there was nothing left to attach: the new window
    // opened with zero tabs (rendered as an empty strip, since the chrome/
    // toolbar layout itself doesn't depend on tab count — hence "space
    // reserved but invisible"), and clicking New Tab created tab #1 in a
    // window that genuinely had none, which is indistinguishable from "all
    // my tabs got replaced by one new tab."
    //
    // Fix: tell oldWin's own 'closed' handler there's nothing left for IT
    // to clean up, by clearing its tabOrder/activeTabId first — the tabs
    // themselves (their WebContentsViews/webContents) are untouched; they
    // just stop being this soon-to-be-destroyed window's responsibility.
    // They stay alive in the global tabViews/tabOwner maps, exactly where
    // attachExistingTab() looks for them once newState's 'ui:ready' arrives.
    if (state.activeTabId != null) {
      const activeView = tabViews.get(state.activeTabId);
      if (activeView) {
        try { oldWin.contentView.removeChildView(activeView); } catch { /* already gone */ }
      }
    }
    state.tabOrder = [];
    state.activeTabId = null;

    oldWin.close();
  }
  return next;
});
// Absolute screen bounds of this window — used by the renderer to detect,
// during a tab drag, whether the pointer has left its own window (see the
// "Tab drag" section in renderer.js). frame:false means getBounds() already
// is the content bounds (no OS chrome to subtract).
ipcMain.handle('window:getBounds', (e) => {
  const state = stateFromSender(e);
  return state ? state.win.getBounds() : null;
});

// ============================================================================
// Custom context menu
// ============================================================================
// Strategy: intercept 'context-menu' on every tab's WebContents and forward
// the cursor position + Electron's ContextMenuParams to that tab's window's
// toolbar view, which renders the styled overlay. The toolbar sends an IPC
// action back here to execute the chosen command against the correct
// WebContents.
//
// We cannot use a separate WebContentsView for the menu (CSS click-through
// doesn't work between views), so the menu lives as a DOM element inside the
// toolbar view and is positioned to overlap the page area via inline styles.
//
// ROOT CAUSE of "the menu never appears": the toolbar WebContentsView's
// bounds are only `toolbarHeight` tall (~96px, just the tab row + address
// bar). A WebContentsView clips its content to its own bounds like any
// native view — position:fixed/absolute in its HTML is relative to THAT
// view's small viewport, not the window. So whenever a right-click happened
// anywhere below the toolbar strip (i.e. almost always, since that's the
// page area), the menu's computed `top` landed outside the view's own
// bounds and was simply never painted or hit-testable — not hidden by CSS,
// not behind another view, just physically outside the surface that exists.
//
// Fix: while the menu is open, temporarily grow the toolbar view to cover
// the full window (so its viewport includes the whole page area) and raise
// it above the active tab's view so it can actually receive clicks/keys.
// Shrink it back the instant the menu closes. See expandToolbarForMenu /
// collapseToolbarAfterMenu below.

// Grow a window's toolbar view to fill it and bring it to the front so the
// menu (which lives inside it) is both visible and interactive over the
// full page area. Its native background is switched to transparent so the
// tab page underneath still shows through everywhere except the opaque
// #chrome strip and the menu panel itself (both painted by its own CSS).
//
// `owner` is one of 'context-menu' or 'panel'. Both the right-click menu
// and the Downloads/tab-list/browser-menu panels share this exact same
// expand/shrink trick (one toolbar view, since separate WebContentsViews
// can't click-through to the one below — see the comment above), but they
// claim and release it independently and their release can be deferred
// behind a CSS close animation. A plain shared boolean here previously
// meant one consumer's deferred "I'm done, shrink it back" could fire
// AFTER a different consumer had since re-expanded the surface for its own
// menu — yanking it back to the thin toolbar strip out from under whatever
// was just opened (a real, if narrow, contributor to menus intermittently
// flashing and disappearing). Tracking *who* currently needs the surface
// expanded (an idempotent Set, not a counter — re-expanding for the same
// still-open owner, e.g. a second right-click replacing an already-open
// context menu, must not require two matching releases) fixes that: the
// surface only actually shrinks once every current claimant has released it.
function expandToolbarForMenu(state, owner = 'context-menu') {
  if (!state || state.win.isDestroyed()) return;
  if (!state.surfaceOwners) state.surfaceOwners = new Set();
  state.surfaceOwners.add(owner);
  const wasExpanded = state.contextMenuOpen;
  state.contextMenuOpen = true;
  const { width, height } = state.win.getContentBounds();
  // Only touch the native view when something actually has to change.
  // Re-applying an identical background/bounds on every open (e.g. a second
  // menu opening while the surface is already expanded) still schedules a
  // native resize/repaint of the full-window view for nothing.
  const cur = state.toolbarView.getBounds();
  if (cur.x !== 0 || cur.y !== 0 || cur.width !== width || cur.height !== height) {
    state.toolbarView.setBounds({ x: 0, y: 0, width, height });
  }
  // ACTUAL ROOT CAUSE OF THE PAGE FLICKER (found by tracing through
  // Electron's native View implementation, not assumed): this used to call
  // state.win.contentView.removeChildView(state.toolbarView) immediately
  // followed by addChildView(state.toolbarView). Per Electron's own View
  // semantics, detaching and reattaching a View tears down and recreates
  // its compositor/layer association in the native (Views-framework) tree,
  // which forces a full-window paint invalidation — the active tab's
  // WebContentsView sits in the same contentView tree, so it gets caught
  // in that invalidation and briefly presents a blank/stale frame before
  // the next composited frame lands. That's the flicker, and it fired on
  // every single menu, panel, and submenu open because every one of them
  // called expandToolbarForMenu.
  //
  // The fix needs no remove step at all: per Electron's documented View
  // behavior, "If the same View is added to a parent which already
  // contains it, it will be reordered such that it becomes the topmost
  // view" — i.e. addChildView alone already moves an existing child to the
  // top of the stacking order in place, with no detach/reattach and no
  // extra paint invalidation of its siblings (the tab view just keeps
  // compositing normally underneath). So: just reorder, never remove.
  const kids = state.win.contentView.children;
  if (kids[kids.length - 1] !== state.toolbarView) {
    state.win.contentView.addChildView(state.toolbarView);
  }
  // Give it keyboard focus so Escape / arrow-key navigation in the menu
  // works even though the right-click originated in a different WebContents.
  if (!state.toolbarView.webContents.isFocused()) state.toolbarView.webContents.focus();
}

// Release one consumer's claim on the expanded toolbar surface (action
// chosen, outside click, Escape, or a new context-menu replacing the old
// one). Only actually shrinks the view back down to the toolbar strip once
// NO owner still needs it expanded — see expandToolbarForMenu above.
function collapseToolbarAfterMenu(state, owner = 'context-menu') {
  if (!state || state.win.isDestroyed()) return;
  if (!state.surfaceOwners) state.surfaceOwners = new Set();
  // Idempotent: the renderer calls hideContextMenu() defensively at the top
  // of every panel/menu open ("the two overlay families never coexist"),
  // usually when no context menu is open. That used to run a full collapse
  // (opaque background + re-layout) immediately followed by the real
  // expand for the menu being opened — a shrink/grow/background flip on
  // EVERY menu open. If this owner doesn't hold the surface there is
  // nothing to release.
  if (!state.surfaceOwners.delete(owner)) return;
  if (state.surfaceOwners.size > 0) return; // someone else still needs it expanded
  state.contextMenuOpen = false;
  // Shrink FIRST, then restore the opaque background. The old order made
  // the still-full-window view opaque for a frame, blanking the page
  // underneath (the page is only visible through this view's transparent
  // background while it covers the window).
  layoutViews(state);
}

// Find-in-page (Cmd/Ctrl+F — see buildAppMenu's 'toolbar:toggleFind' and the
// find:query/find:stop handlers below). One listener per tab's WebContents,
// forwarding Electron's own match-count/active-match results to that tab's
// CURRENT window's toolbar — only while that tab is still the active one, so
// a slow/background find result can't paint over whatever tab the user has
// since switched to. Call this from createTab / createSettingsTab after the
// view is created, same pattern as attachContextMenu above.
function attachFindInPage(id, wc) {
  wc.on('found-in-page', (_event, result) => {
    const state = stateForWindow(BrowserWindow.fromId(tabOwner.get(id)));
    if (!state || state.activeTabId !== id || state.win.isDestroyed()) return;
    state.toolbarView.webContents.send('find:result', {
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal,
    });
  });
}

// Hook into every new tab's context-menu event. Call this from createTab /
// createSettingsTab after the view is created.
function attachContextMenu(id, wc) {
  wcToTabId.set(wc.id, id);
  wc.on('context-menu', (_event, params) => {
    // Resolve the CURRENT owner at event time, not at attach time — a tab
    // dragged into a different window must pop its menu there.
    const state = stateForWindow(BrowserWindow.fromId(tabOwner.get(id)));
    if (!state) return;
    // Get the window content bounds to compute offset from toolbar bottom.
    const { width, height } = state.win.getContentBounds();
    // params.x/y are relative to the WebContentsView's origin (i.e. already
    // offset by toolbarHeight from the top of the window content area).
    const menuX = Math.max(0, Math.min(params.x, width - 4));
    const menuY = params.y + state.toolbarHeight; // window-relative y
    expandToolbarForMenu(state, 'context-menu');
    state.toolbarView.webContents.send('context-menu:show', {
      x: menuX,
      y: menuY,
      windowW: width,
      windowH: height,
      tabId: id,
      params: {
        // Only pass what the renderer needs — no Node objects.
        selectionText: params.selectionText || '',
        linkURL: params.linkURL || '',
        srcURL: params.srcURL || '',
        mediaType: params.mediaType || 'none',
        isEditable: Boolean(params.isEditable),
        pageURL: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        // Electron already works out exactly which edit commands are valid
        // right now (is there a selection to copy, is the field non-empty
        // enough to select-all, does the clipboard have anything pasteable,
        // etc) — just forward it instead of re-deriving it ourselves.
        editFlags: {
          canCut: Boolean(params.editFlags?.canCut),
          canCopy: Boolean(params.editFlags?.canCopy),
          canPaste: Boolean(params.editFlags?.canPaste),
          canSelectAll: Boolean(params.editFlags?.canSelectAll),
        },
        // Page-relative coordinates of the right-clicked element (NOT the
        // window-relative menuX/menuY above) — needed so "Inspect" can hand
        // the exact point back to wc.inspectElement().
        elementX: params.x,
        elementY: params.y,
      },
    });
  });
}

// Small helper for "Open Link in New Window": create a full Gloza window
// (same interface as every other Gloza window) and point its initial tab
// straight at the given URL, instead of opening a second tab next to a
// blank home tab.
function createWindowWithUrl(url) {
  const state = createWindow();
  const id = state.tabOrder[0];
  if (id !== undefined) {
    tabViews.get(id)?.webContents.loadURL(normalizeUrl(url));
  }
  return state;
}

// Execute an action that was chosen in the context menu.
ipcMain.handle('context-menu:action', async (event, { action, payload }) => {
  const { tabId } = payload || {};
  // NOTE: some actions (open-link-new-tab, open-link-window, copy-link,
  // copy-image-address...) don't need an existing tab's WebContents at all —
  // only navigation/reload/save/copy-image do. Each case below guards for
  // `wc` itself, so we deliberately do NOT bail out early just because
  // `tabId` didn't resolve to a view; doing so previously blocked every
  // single action whenever tabId was missing/stale.
  //
  // BUG (found in this audit): same missing-ownership-check class already
  // fixed throughout this file for tabs:navigate/zoom:in-out-reset/etc.
  // (see e.g. attachZoomHandling's comment above) — this handler used to
  // resolve `tabId` straight through `tabViews.get(tabId)` and derive
  // `ownerState` from whichever window *actually* owns that tab via
  // `tabOwner`, with no check that the tab belongs to the window that
  // actually sent this request. Unlike the simpler handlers already fixed,
  // this one is a strictly bigger attack surface: it can navigate, reload,
  // reveal/save files to disk, write to the OS clipboard, and create new
  // bookmarks, all driven by a renderer-supplied `tabId`. Fixed the same
  // way as everywhere else — resolve ownership from the real sender
  // (`stateFromSender`/`ownedTabView`) instead of trusting `tabId` alone.
  const senderState = stateFromSender(event);
  // The URL bar's own context menu (see the toolbarView.webContents
  // 'context-menu' listener in createWindow) has no tab to act on at all —
  // its target IS the toolbar's own WebContents (the #address-bar <input>
  // lives there, not in any tab). `payload.isToolbar` is only ever set by
  // that listener, never by the renderer itself, so it can't be spoofed
  // into redirecting an action meant for a tab onto the toolbar.
  const isToolbar = Boolean(payload && payload.isToolbar);
  const view = !isToolbar && tabId != null ? ownedTabView(senderState, tabId) : null;
  const wc = isToolbar ? (senderState ? senderState.toolbarView.webContents : null) : (view ? view.webContents : null);
  const ownerState = view ? senderState : null;

  switch (action) {
    case 'back':    wc?.navigationHistory.canGoBack()    && wc.navigationHistory.goBack();    break;
    case 'forward': wc?.navigationHistory.canGoForward() && wc.navigationHistory.goForward(); break;
    case 'reload':  wc?.reload(); break;
    case 'undo':    wc?.undo(); break;
    case 'redo':    wc?.redo(); break;
    case 'open-link-new-tab': if (payload.url && ownerState) createTab(ownerState, payload.url); break;
    case 'open-image-new-tab': if (payload.url && ownerState) createTab(ownerState, payload.url); break;
    case 'copy-link': {
      const { clipboard } = require('electron');
      if (payload.url) clipboard.writeText(payload.url);
      break;
    }
    case 'copy-image-address': {
      const { clipboard } = require('electron');
      if (payload.url) clipboard.writeText(payload.url);
      break;
    }
    case 'copy-image': {
      // Do this entirely in the main process via nativeImage/clipboard
      // instead of calling navigator.clipboard.write() inside the page via
      // executeJavaScript. That approach is unreliable here: the page's
      // WebContents loses focus the moment the menu's toolbar view takes
      // keyboard focus (see expandToolbarForMenu), and the async Clipboard
      // API rejects with NotAllowedError on an unfocused document; it also
      // requires a secure context, which plain http:// pages aren't. Fetching
      // the bytes ourselves and writing a nativeImage sidesteps both issues.
      if (payload.url) {
        try {
          const { clipboard, nativeImage } = require('electron');
          let buffer;
          if (/^data:/i.test(payload.url)) {
            const base64 = payload.url.slice(payload.url.indexOf(',') + 1);
            buffer = Buffer.from(base64, 'base64');
          } else {
            const { net } = require('electron');
            const res = await net.fetch(payload.url);
            buffer = Buffer.from(await res.arrayBuffer());
          }
          const image = nativeImage.createFromBuffer(buffer);
          if (!image.isEmpty()) clipboard.writeImage(image);
        } catch {
          // Unreachable image, CORS-blocked fetch, bad data URL, etc. —
          // fail quietly rather than throwing across the IPC boundary.
        }
      }
      break;
    }
    case 'save-image': {
      if (wc && payload.url) {
        wc.downloadURL(payload.url);
      }
      break;
    }
    case 'save-page': {
      if (wc && ownerState) {
        const { dialog } = require('electron');
        const title = wc.getTitle().replace(/[\\/:*?"<>|]/g, '_');
        const { filePath, canceled } = await dialog.showSaveDialog(ownerState.win, {
          defaultPath: `${title}.html`,
          filters: [{ name: 'Web Page', extensions: ['html'] }],
        });
        if (!canceled && filePath) {
          wc.savePage(filePath, 'HTMLComplete').catch(() => {});
        }
      }
      break;
    }
    case 'bookmark-page': {
      const url = payload.url || wc?.getURL();
      if (url && !isRestrictedBookmarkUrl(url)) {
        const tree = loadBookmarkTree();
        if (!findBookmarkByUrl(tree, url)) {
          tree.push({
            id: nextBookmarkId++,
            type: 'bookmark',
            title: (wc && wc.getURL() === url ? wc.getTitle() : url) || url,
            url,
            favicon: tabId != null ? tabFavicons.get(tabId) || null : null,
          });
          saveBookmarkTree(tree);
        }
      }
      break;
    }
    // Cut/Copy/Paste/Select All go straight through Electron's own edit
    // commands rather than any custom clipboard code. These are routed by
    // Electron directly to whichever frame/element currently has DOM focus
    // inside that WebContents — the same mechanism a real keyboard
    // shortcut (Ctrl/Cmd+C etc.) would use — so they keep working correctly
    // no matter which WebContents currently has OS-level window focus
    // (relevant here since showing the menu briefly focuses the toolbar).
    case 'cut':        wc?.cut();       break;
    case 'copy':       wc?.copy();      break;
    case 'paste':      wc?.paste();     break;
    case 'select-all': wc?.selectAll(); break;
    case 'view-source': {
      if (wc && ownerState) {
        try {
          const html = await wc.executeJavaScript('document.documentElement.outerHTML');
          const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const page = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>View Source — ${esc(wc.getTitle() || wc.getURL())}</title>
<style>
  html, body { margin: 0; background: #101212; color: #d7dede; }
  pre {
    margin: 0; padding: 16px;
    font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
</style></head><body><pre>${esc(html)}</pre></body></html>`;
          // A data: URL can hit length limits on large pages; writing a temp
          // file and loading that instead has no such ceiling.
          const tmpPath = path.join(
            app.getPath('temp'),
            `gloza-view-source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`
          );
          fs.writeFileSync(tmpPath, page, 'utf-8');
          createTab(ownerState, require('url').pathToFileURL(tmpPath).toString());
        } catch {
          // Page blocked script injection (rare, e.g. some internal
          // schemes) — fail quietly rather than throwing across IPC.
        }
      }
      break;
    }
    case 'inspect': {
      if (wc) {
        // inspectElement opens DevTools (if needed) and selects/highlights
        // the exact element at these page-relative coordinates.
        wc.inspectElement(payload.x ?? 0, payload.y ?? 0);
        if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus();
      }
      break;
    }
    // Browser menu → "Inspect Element": there's no right-clicked point to
    // target here (unlike the context-menu 'inspect' case above), so just
    // open/focus DevTools for the active page, detached so it never has to
    // squeeze into the toolbar strip.
    case 'open-devtools': {
      if (wc) {
        if (wc.isDevToolsOpened()) {
          wc.devToolsWebContents?.focus();
        } else {
          wc.openDevTools({ mode: 'detach' });
        }
      }
      break;
    }
    case 'open-link-window': {
      // Opens as a full Gloza window (same interface, tab strip, toolbar,
      // controls, bookmarks, themes) rather than a bare BrowserWindow, so it
      // matches every other new window Gloza creates.
      if (payload.url) createWindowWithUrl(payload.url);
      break;
    }
    default: break;
  }
});

// Dismiss the context menu from the main process side (e.g. when another
// context-menu fires before the toolbar had a chance to dismiss the old one).
// The renderer calls this (via window.browser.hideContextMenu()) whenever it
// hides the overlay — outside click, Escape, or after an action is chosen —
// so this is also where we shrink the toolbar view back down.
ipcMain.on('context-menu:hide', (event) => {
  const state = stateFromSender(event);
  collapseToolbarAfterMenu(state, 'context-menu');
  state?.toolbarView.webContents.send('context-menu:hide');
});

// The tab-list / downloads / browser-menu slide-out panels are DOM elements
// living inside this same toolbar view, so they hit the exact clipping issue
// documented above for the context menu (a WebContentsView clips to its own
// ~96px-tall bounds) whenever they need to extend below the toolbar strip.
// Reuse the same expand/collapse trick rather than re-solving it.
// invoke (not send): resolves only AFTER the view has been resized, handing
// back the full-window size so the renderer can place menus against the real
// surface size instead of guessing when window.innerHeight catches up.
// Find-in-page (Cmd/Ctrl+F). Always targets the CALLING window's current
// active tab — the toolbar is per-window, so stateFromSender already
// resolves the right window; there's nothing tab-identifying coming from
// the renderer to trust or distrust here, unlike the context-menu actions
// above. query === '' means the find bar was just opened/cleared: clear any
// existing highlight without instantiating a search for an empty string.
ipcMain.handle('find:query', (event, { query, forward } = {}) => {
  const state = stateFromSender(event);
  const wc = state && state.activeTabId != null ? tabViews.get(state.activeTabId)?.webContents : null;
  if (!wc || wc.isDestroyed()) return false;
  const trimmed = (query || '');
  if (!trimmed) {
    wc.stopFindInPage('clearSelection');
    return false;
  }
  // findNext:false on every call (not just the first): Electron's own
  // findNext flag means "this is the same search as last time, just move
  // to the next/previous match" — distinct from "findInPage() is just how
  // you request a new search" is handled below via the separate
  // 'find:next' channel. Starting a fresh text search with findNext:true
  // would wrongly try to continue a search Chromium doesn't think is
  // running (e.g. right after the text changed), so every call from the
  // text field itself is a new search.
  wc.findInPage(trimmed, { forward: forward !== false, findNext: false, matchCase: false });
  return true;
});
// Next/Previous match on the CURRENT query (Enter / Shift+Enter / the
// bar's own prev/next buttons) — a true findNext, not a new search, so
// Chromium keeps the existing match list instead of re-scanning the page.
ipcMain.handle('find:next', (event, { query, forward }) => {
  const state = stateFromSender(event);
  const wc = state && state.activeTabId != null ? tabViews.get(state.activeTabId)?.webContents : null;
  if (!wc || wc.isDestroyed() || !query) return false;
  wc.findInPage(query, { forward: forward !== false, findNext: true, matchCase: false });
  return true;
});
ipcMain.on('find:stop', (event, action) => {
  const state = stateFromSender(event);
  const wc = state && state.activeTabId != null ? tabViews.get(state.activeTabId)?.webContents : null;
  if (wc && !wc.isDestroyed()) wc.stopFindInPage(action || 'clearSelection');
});

ipcMain.handle('panel:expand', (event) => {
  const state = stateFromSender(event);
  expandToolbarForMenu(state, 'panel');
  if (!state || state.win.isDestroyed()) return null;
  const { width, height } = state.win.getContentBounds();
  return { width, height };
});
ipcMain.on('panel:collapse', (event) => collapseToolbarAfterMenu(stateFromSender(event), 'panel'));

// ============================================================================
// Tab drag: detach to a new window + transfer between existing windows
// ============================================================================
// renderer.js runs the actual drag gesture (pointer tracking, FLIP reorder
// animation, etc). Everything below is only reached once the user releases
// the pointer OUTSIDE the window the drag started in — for an ordinary
// same-window reorder, renderer.js just calls tabs:reorder above and none of
// this runs.
//
// Electron's WebContentsView is not permanently tied to one BrowserWindow:
// removing it from one window's contentView and adding it to another's is
// exactly what "move the tab" means here — same WebContents instance, same
// process, same navigation history, no reload. That's what
// attachExistingTab / the tabs:dragEnd handler below do.

// Remove a tab's view from whichever window currently owns it (without
// destroying the WebContents) and hand it to `state`, optionally making it
// the active tab there.
function attachExistingTab(state, id, becomeActive) {
  const view = tabViews.get(id);
  if (!view) return;
  const prevOwnerId = tabOwner.get(id);
  const prevState = prevOwnerId != null ? windows.get(prevOwnerId) : null;
  if (prevState && prevState !== state) {
    if (prevState.activeTabId === id) {
      prevState.win.contentView.removeChildView(view);
    }
    prevState.tabOrder = prevState.tabOrder.filter((t) => t !== id);
    if (prevState.activeTabId === id) {
      prevState.activeTabId = null;
      const next = prevState.tabOrder[prevState.tabOrder.length - 1];
      if (next !== undefined) switchTab(prevState, next);
      else createTab(prevState); // source window would otherwise be left with no tabs
    } else {
      sendTabsUpdate(prevState);
    }
  }

  tabOwner.set(id, state.win.id);
  if (!state.tabOrder.includes(id)) state.tabOrder.push(id);
  if (becomeActive) {
    switchTab(state, id);
  } else {
    sendTabsUpdate(state);
  }
}

// Find an existing Gloza window (other than `excludeWin`) whose screen
// bounds contain the given screen point.
function windowAtScreenPoint(x, y, excludeWin) {
  for (const state of windows.values()) {
    if (state.win === excludeWin || state.win.isDestroyed()) continue;
    const b = state.win.getBounds();
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
      return state;
    }
  }
  return null;
}

// Called when a tab drag ends. `order` is the source window's local
// left-to-right id list if the pointer never left that window (ordinary
// reorder); screenX/screenY is where the pointer was released, in desktop
// coordinates.
ipcMain.handle('tabs:dragEnd', (event, { tabId, order, screenX, screenY }) => {
  const sourceState = stateFromSender(event);
  // BUG: same missing-ownership-check class as tabs:navigate/print/etc.
  // above and duplicateTab() — this only checked that `tabId` exists
  // ANYWHERE (`tabViews.has(tabId)`), never that it's actually one of
  // *this* window's tabs. attachExistingTab() below will happily reparent
  // whatever tab `tabOwner` currently says `tabId` belongs to, to wherever
  // this drag ends up — so a drag event carrying a stale id (e.g. the tab
  // got moved to another window by something else — another drag, the
  // title-bar-mode swap fixed above — while this window's drag was still
  // in flight) would rip that tab back out of wherever it had just
  // legitimately landed, based on a window that no longer owns it.
  if (!sourceState || tabOwner.get(tabId) !== sourceState.win.id) return { result: 'noop' };

  const sourceBounds = sourceState.win.getBounds();
  const haveScreenPoint = Number.isFinite(screenX) && Number.isFinite(screenY);
  const releasedInsideSource =
    haveScreenPoint &&
    screenX >= sourceBounds.x && screenX < sourceBounds.x + sourceBounds.width &&
    screenY >= sourceBounds.y && screenY < sourceBounds.y + sourceBounds.height;

  if (!haveScreenPoint || releasedInsideSource) {
    // Ordinary same-window reorder.
    sourceState.tabOrder = reconcileOrder(sourceState, order || sourceState.tabOrder);
    sendTabsUpdate(sourceState);
    return { result: 'reordered' };
  }

  const destState = windowAtScreenPoint(screenX, screenY, sourceState.win);
  if (destState) {
    // Dropped onto another existing Gloza window — move the tab there.
    // Rough left/right placement by comparing the drop x to the
    // destination window's horizontal midpoint, since we don't have that
    // window's individual tab layout available in the main process.
    const destBounds = destState.win.getBounds();
    const dropIsLeftHalf = screenX < destBounds.x + destBounds.width / 2;
    attachExistingTab(destState, tabId, /* becomeActive */ true);
    if (dropIsLeftHalf) {
      destState.tabOrder = [tabId, ...destState.tabOrder.filter((t) => t !== tabId)];
      sendTabsUpdate(destState);
    }
    return { result: 'transferred' };
  }

  // Dropped outside every Gloza window — detach into a brand-new one, unless
  // this was the source window's only tab (nothing meaningful to detach: it
  // would just create an empty duplicate window next to an identical one).
  if (sourceState.tabOrder.length <= 1) {
    return { result: 'noop' };
  }
  const newState = createWindow({
    x: Math.round(screenX - 80),
    y: Math.round(screenY - 20),
    seedTab: { id: tabId },
  });
  return { result: 'detached', windowId: newState.win.id };
});

// ============================================================================
// Tab drag preview ("ghost")
// ============================================================================
// A DOM element inside a WebContentsView is clipped to that view's own
// bounds — once the pointer leaves the window during a drag, there is no
// way for a plain in-page element to keep following it (it would just be
// cut off at the window edge, or destroyed with the view). The only thing
// in Electron that CAN render on screen outside any particular window's
// bounds, follow the OS cursor, and stay on top of other windows (including
// other Gloza windows) is another top-level window. So the preview is a
// second, tiny, frameless, transparent, always-on-top, non-focusable
// BrowserWindow that renderer.js repositions on every pointer move — not a
// DOM node, exactly so it can't be clipped or destroyed by the window the
// drag started in.
//
// Only one drag can be in progress at a time (pointer capture is global to
// the OS), so a single module-level handle is enough — no per-window state
// needed here.
let dragGhost = null;
const GHOST_W = 240;
const GHOST_H = 56;

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Only allow icon URLs the preview can safely load — same rule renderer.js
// already applies to real tab favicons (http(s) or a data: image).
function isSafeGhostFavicon(u) {
  return typeof u === 'string' && (/^https?:\/\//i.test(u) || /^data:image\//i.test(u));
}

// Small, self-contained markup mirroring the real tab's look (dark charcoal,
// rounded, a thin green accent line) at reduced opacity with a lifted
// shadow, per the brief — built as a data: URL so showing it has no file
// I/O latency on the critical "finger just left the window" path.
function buildGhostHtml(title, favicon) {
  const safeFavicon = isSafeGhostFavicon(favicon) ? favicon : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; overflow: hidden; }
    body { display: flex; align-items: center; justify-content: center; height: 100%; }
    #ghost {
      display: flex; align-items: center; gap: 8px;
      height: 34px; max-width: 208px; padding: 0 12px;
      border-radius: 10px 10px 6px 6px;
      background: rgba(20, 22, 22, 0.82);
      box-shadow: 0 14px 26px -10px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(0, 130, 0, 0.4);
      font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #d7dede; white-space: nowrap;
    }
    #ic {
      width: 14px; height: 14px; border-radius: 3px; flex: none;
      background: #008200; display: flex; align-items: center; justify-content: center;
    }
    #ic img { width: 14px; height: 14px; border-radius: 3px; display: block; }
    #t { overflow: hidden; text-overflow: ellipsis; }
  </style></head><body>
    <div id="ghost">
      <span id="ic">${safeFavicon ? `<img src="${escapeHtml(favicon)}">` : ''}</span>
      <span id="t">${escapeHtml(title) || 'New Tab'}</span>
    </div>
  </body></html>`;
}

function showDragGhost(x, y, title, favicon) {
  hideDragGhost();
  const win = new BrowserWindow({
    width: GHOST_W,
    height: GHOST_H,
    x: Math.round(x - GHOST_W / 2),
    y: Math.round(y - 14),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    focusable: false,     // never steals OS focus from whatever the drag's pointer capture is on
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
  });
  win.setIgnoreMouseEvents(true); // purely visual — must never intercept the drop
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildGhostHtml(title, favicon)));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  dragGhost = win;
}

function moveDragGhost(x, y) {
  if (!dragGhost || dragGhost.isDestroyed()) return;
  dragGhost.setPosition(Math.round(x - GHOST_W / 2), Math.round(y - 14));
}

function hideDragGhost() {
  if (dragGhost && !dragGhost.isDestroyed()) dragGhost.close();
  dragGhost = null;
}

ipcMain.on('drag-preview:start', (event, { x, y, title, favicon }) => {
  if (!stateFromSender(event)) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  showDragGhost(x, y, title, favicon);
});
ipcMain.on('drag-preview:move', (_event, { x, y }) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  moveDragGhost(x, y);
});
ipcMain.on('drag-preview:end', () => hideDragGhost());

// ----------------------------------------------------------------------------
// Application menu: invisible, but NOT absent.
//
// ROOT CAUSE of "Cmd+V/X/A don't work on macOS" (Cmd+C happening to work was
// a coincidence — see below): this used to be `Menu.setApplicationMenu(null)`,
// removing the menu entirely so Gloza's own tab strip could replace its
// reserved layout space. That part of the reasoning is still correct and is
// preserved (see autoHideMenuBar + win.setMenuBarVisibility(false) in
// createWindow above — the BAR stays gone). But the menu object itself is
// not just a strip of clickable labels: on macOS in particular, standard
// text-editing key equivalents (Cmd+C/X/V/A/Z/Shift+Cmd+Z) are NOT handled
// by Chromium's renderer automatically — they only exist because an Edit
// menu with role: 'cut'/'copy'/'paste'/'selectAll'/'undo'/'redo' registers
// them as native NSMenu key equivalents, which is how macOS's input system
// decides a key combo is an editing command at all and asks the focused
// responder (here, Electron's currently-focused WebContents, which Electron
// tracks correctly across every WebContentsView in the window — the
// toolbar's own #address-bar included, not just "tab" pages) to perform it.
// With `Menu.setApplicationMenu(null)`, none of that exists, so every one of
// those shortcuts was silently swallowed by the OS before it ever reached
// any renderer. (Cmd+C alone sometimes appears to "work" because some
// elements' plain text selection can still be copied via other native
// routes on some macOS versions/inputs — but this was never reliable, which
// matches the reported "Cmd+C may work, but V/X/A are not working
// correctly".) Windows/Linux are less strict about requiring a menu for
// Ctrl+C/V/X/A inside a plain <input>, which is why this mostly presented
// as a macOS-only complaint — but installing the real menu here makes the
// behavior correct and explicit on every platform rather than relying on
// each OS's own fallback behavior.
//
// Using role: 'editMenu' (rather than hand-building Cut/Copy/Paste/etc. as
// custom click handlers) is deliberate: it's Electron's own built-in,
// platform-correct implementation of these commands — correct accelerators
// per OS (Cmd+X/C/V/A/Z + Shift+Cmd+Z on macOS, Ctrl+X/C/V/A/Z + Ctrl+Y on
// Windows/Linux) already baked in, and it dispatches to whichever
// WebContents in the app currently has focus (toolbar address bar, a tab's
// page, a settings field — all of it) via Electron's own focus tracking,
// not a custom keyboard listener reinventing that logic. This is exactly
// the "prefer native Electron/Chromium mechanisms" ask from the brief.
//
// Two small additions beyond the stock roles, both using real `accelerator`
// entries on the SAME (invisible) menu rather than a bespoke global
// keydown handler, so they get the identical native dispatch/accelerator
// handling as the Edit role items above:
//   - Ctrl+Tab / Ctrl+Shift+Tab: cycle the active tab. Deliberately
//     'Control+Tab' (not 'CommandOrControl+Tab') on EVERY platform,
//     including macOS, per explicit request — Cmd+Tab is the OS's own
//     app switcher and must keep doing that; Ctrl+Tab is free on macOS and
//     is what Gloza uses for in-window tab cycling instead, same physical
//     chord as Windows/Linux.
//   - CommandOrControl+F: opens Gloza's find-in-page bar (see the
//     'toolbar:toggleFind' push below and find-bar handling in
//     renderer.js). There was no find feature at all before this; the
//     brief explicitly lists Cmd/Ctrl+F as required standard editing
//     shortcut parity, so this adds the minimal real implementation
//     (Electron's own webContents.findInPage/stopFindInPage — see the
//     find:query/find:stop handlers below) rather than just a hint with
//     nothing behind it.
function cycleActiveTab(win, delta) {
  const state = stateForWindow(win);
  if (!state || !state.tabOrder.length) return;
  const order = state.tabOrder;
  const curIdx = Math.max(0, order.indexOf(state.activeTabId));
  const next = order[(curIdx + delta + order.length) % order.length];
  if (next !== state.activeTabId) switchTab(state, next);
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    // macOS: the app menu (Gloza/About/Hide/Quit…) is itself required for
    // Cmd+Q, Cmd+H, etc. to work via the same native-menu mechanism as the
    // Edit role above; it lives in the system-wide menu bar (not any
    // window's own chrome), so it never competes with Gloza's custom
    // in-window tab strip the way a Windows/Linux menu BAR would.
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Next Tab',
          accelerator: 'Control+Tab',
          click: (_item, win) => { if (win) cycleActiveTab(win, 1); },
        },
        {
          label: 'Previous Tab',
          accelerator: 'Control+Shift+Tab',
          click: (_item, win) => { if (win) cycleActiveTab(win, -1); },
        },
        {
          label: 'Find on Page',
          accelerator: 'CommandOrControl+F',
          click: (_item, win) => {
            const state = win && stateForWindow(win);
            if (state && !state.win.isDestroyed()) state.toolbarView.webContents.send('toolbar:toggleFind');
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
Menu.setApplicationMenu(buildAppMenu());

app.whenReady().then(async () => {
  // Dev-only Dock icon: an unpackaged `electron .`/`npm start` run otherwise
  // shows the generic Electron icon in the Dock on macOS. A packaged build
  // gets its Dock icon baked in by the packager instead, so this only
  // matters (and only runs) during development.
  if (process.platform === 'darwin') {
    // Dev-only Dock icon: an unpackaged `electron .`/`npm start` run
    // otherwise shows the generic Electron icon in the Dock. A packaged
    // build gets its Dock icon baked in by the packager instead.
    if (!app.isPackaged) {
      try {
        const dockIcon = nativeImage.createFromPath(APP_ICON_PATH);
        if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
      } catch {
        // Non-fatal — dev-only cosmetic fallback.
      }
    }

    // "GlozaNet" > "About GlozaNet" in the app menu. applicationVersion
    // comes from the SAME app.getVersion() the About-Settings page uses
    // (see the app:getVersion IPC handler below) — package.json stays the
    // one place the version is ever declared. Called here, inside
    // whenReady(), rather than at module load, since the native About
    // panel isn't guaranteed to exist until the app is ready.
    try {
      app.setAboutPanelOptions({
        applicationName: 'GlozaNet',
        applicationVersion: app.getVersion(),
        version: app.getVersion(),
        iconPath: APP_ICON_PATH,
        copyright: '© GlozaNet by GlozaLabs® 2026',
      });
    } catch {
      // Non-fatal — worst case the OS default About panel (still correctly
      // named, since app.setName() above already ran) shows instead.
    }
  }

  attachDownloadHandling(session.defaultSession);

  // ---- Native ad blocker integration point (Part 1B) ------------------------
  // session.defaultSession is the one and only session every ordinary tab's
  // WebContentsView uses (see createTab() — it never passes a `partition`
  // option), and the internal pages (Settings, home) run on it too, so
  // registering here, before createWindow(), is the one place that sees
  // every request from every tab in every window before any tab exists —
  // no competing interceptor exists anywhere else in main.js. Adblock
  // itself (src/adblock/index.js) is responsible for recognizing and
  // skipping internal/non-blockable requests (toolbar, Settings, file:/
  // about:/devtools: schemes) rather than this call site special-casing
  // anything.
  adblock = new Adblock({
    app,
    settingsTabIds,
    broadcast: (payload) => {
      if (payload && payload.type === 'status') broadcastAdblockStatus(payload.status);
    },
  });
  adblock.registerSession(session.defaultSession);
  adblock.registerIpc(ipcMain);
  // Fire-and-forget: never blocks startup (see filterlist-manager.js's
  // scheduleAutomaticUpdates — the first check itself is delayed, and every
  // check after that is its own independent timer).
  adblock.startScheduledUpdates();

  // ---- Force Dark Mode integration point (Part 2) --------------------------
  // Same reasoning as the ad blocker above: constructed once app.whenReady()
  // guarantees userData is available, before the first tab exists, so its
  // dom-ready hook is wired via attachTab() on every tab from the very
  // first one created.
  darkMode = new DarkMode({
    app,
    settingsTabIds,
    broadcast: (payload) => {
      if (payload && payload.type === 'status') broadcastDarkModeStatus(payload.status);
    },
  });
  darkMode.registerIpc(ipcMain);

  // Part 3B — startupBehavior. Only governs the very first window of a
  // fresh launch; every subsequent window (Ctrl+N, "New window", a tab
  // dragged out into its own window) goes through the normal createWindow()
  // / defaultNewTabUrl() path regardless of this setting.
  const startupPrefs = loadPrefs();
  if (startupPrefs.startupBehavior === 'restore') {
    const saved = loadSessionState();
    if (saved && saved.windows.length) {
      for (const w of saved.windows) {
        const state = createWindow();
        state.pendingRestoreTabs = Array.isArray(w.tabs) ? w.tabs : [];
        state.pendingRestoreActiveIndex = Number.isInteger(w.activeIndex) ? w.activeIndex : 0;
      }
    } else {
      // Nothing to restore (first run, or last quit had no eligible tabs) —
      // fall back to the normal new-tab default rather than an empty window.
      createWindow();
    }
  } else if (startupPrefs.startupBehavior === 'homepage') {
    const hp = normalizeHomepageUrl(startupPrefs.homepage);
    const state = createWindow();
    state.pendingSeedTabId = null;
    state.pendingRestoreTabs = [hp]; // reuse the restore path: one tab, that URL
    state.pendingRestoreActiveIndex = 0;
  } else {
    createWindow();
  }
});

// ----------------------------------------------------------------------------
// Clear-on-exit (Part 3A) — runs once, right before the app actually quits.
// Each category is independent and only touches its own store:
//   history   -> the history.json store above (addHistoryEntry/saveHistory)
//   downloads -> the in-memory download RECORDS map (never the files on
//                disk — nothing here ever calls fs.unlink/shell.trashItem on
//                a download's savePath)
//   cookies   -> session.defaultSession's cookies + site storage (IndexedDB,
//                localStorage, service workers, Cache Storage API) — NOT the
//                HTTP cache, which is its own category below
//   cache     -> session.defaultSession's HTTP cache only
// Gloza's tabs all share session.defaultSession (see the registerSession
// call in app.whenReady() below) and there is no second/partitioned session
// anywhere in this file, so targeting defaultSession here is targeting
// every regular tab's cookies/cache — not "one session out of several".
// ----------------------------------------------------------------------------
async function runClearOnExitCleanup() {
  const prefs = loadPrefs();
  const opts = { ...DEFAULT_PREFS.clearOnExit, ...prefs.clearOnExit };
  const tasks = [];

  if (opts.history) {
    try { historyEntries = []; saveHistory(); } catch { /* best-effort on the way out */ }
  }
  if (opts.downloads) {
    // Clears RECORDS only. Each record's underlying file lives wherever the
    // OS save dialog put it; nothing here ever touches that path.
    try { downloads.clear(); } catch { /* best-effort */ }
  }

  const ses = session.defaultSession;
  if (opts.cookies) {
    tasks.push(
      ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
      }).catch(() => {})
    );
  }
  if (opts.cache) {
    tasks.push(ses.clearCache().catch(() => {}));
  }

  if (!tasks.length) return;
  // Session clearing is async and has no hard guarantee of how long it
  // takes; don't let it hang app quit forever if something in Electron's
  // session layer never resolves.
  await Promise.race([
    Promise.all(tasks),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
}

// before-quit fires once per quit attempt. The FIRST time, we hold the quit
// (preventDefault) just long enough to run the async cleanup above, then
// call app.quit() again ourselves — that second attempt sets
// clearOnExitDone first, so this handler lets it straight through instead
// of looping forever.
let clearOnExitDone = false;
app.on('before-quit', (event) => {
  adblock?.shutdown();
  darkMode?.shutdown();
  if (clearOnExitDone) return;
  // Part 3B: snapshot session state before any windows start tearing down
  // (synchronous — must finish before 'window-all-closed'/'closed' handlers
  // start clearing tabViews/discardedTabs out from under it).
  saveSessionState();
  event.preventDefault();
  runClearOnExitCleanup()
    .catch(() => {}) // a cleanup failure must never block the app from closing
    .finally(() => {
      clearOnExitDone = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
