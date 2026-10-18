// ============================================================================
// renderer.js — runs INSIDE index.html, in the browser's toolbar page.
// It has no direct Node/OS access; everything it does goes through the
// `window.browser` object that preload.js exposed.
//
// The pattern is simple and repeats for every new feature you add:
//   1. main.js sends a 'tabs-updated' event whenever tab state changes.
//   2. renderer.js updates the tab strip / address bar from that state.
//   3. Clicking something in the UI calls a window.browser.* function,
//      which asks main.js to actually do something (navigate, close, etc).
//
// Tabs are UPDATED IN PLACE (not rebuilt) so CSS transitions can animate
// between states — that's what makes active-tab changes and tab open/close
// look smooth.
// ============================================================================

'use strict';

const $ = (selector) => document.querySelector(selector);
const SVG_NS = 'http://www.w3.org/2000/svg';

let tabsState = { tabs: [], activeTabId: null };
let bookmarksState = [];
let downloadsState = [];

// Our own pages (home, settings) are files that sit next to this one.
// Anything starting with this prefix is "internal" and gets the Gloza mark
// instead of a favicon, and an empty address bar.
const APP_PAGES_BASE = location.href.replace(/[^/]*$/, '');
const isInternalUrl = (url) => url.startsWith(APP_PAGES_BASE);


// ---------------------------------------------------------------------------
// Icons — see the <symbol> sprite at the top of index.html
// ---------------------------------------------------------------------------
function createIcon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function setIcon(svg, name) {
  svg.querySelector('use').setAttribute('href', `#i-${name}`);
}


// ---------------------------------------------------------------------------
// macOS traffic-light reserve — belt-and-suspenders beyond the
// [data-platform="mac"] #tab-row stylesheet rule in styles.css. preload.js
// has already (a) set data-platform="mac" and (b) set the inline
// --mac-traffic-light-reserve custom property on <html>, both BEFORE this
// script ever ran (preload executes first, and this script sits at the
// bottom of index.html's <body>, so the DOM is fully parsed here). This
// applies that same reserve directly to #tab-row's own inline style —
// bypassing the stylesheet cascade entirely instead of depending on it —
// so the tab-list button, the first tab, and everything else in the row is
// pushed clear of the real traffic lights no matter what. Runs immediately
// at script load (not inside applyPrefs/onPrefsUpdated) so it's not waiting
// on any async IPC round trip either.
// An inline style always wins the cascade, which would also defeat the
// genuinely-needed `html.is-fullscreen #tab-row` reclaim rule in
// styles.css (macOS hides the lights entirely in real fullscreen, so that
// space needs to come back) — so this doesn't just set-and-forget a fixed
// inline value. applyMacTabRowReserve() is called once now, and again from
// applyWindowState() below every time `.is-fullscreen` changes, each time
// choosing the right value for the CURRENT state, so the inline style and
// the fullscreen rule never disagree.
// Reads the 'is-fullscreen' class straight off <html> (rather than the
// isFullscreenNow variable, which is declared further down this file and
// so isn't safely readable yet the first time this runs at script load).
// Every layer of the fix so far (preload's data-platform, preload's inline
// --mac-traffic-light-reserve, the styles.css rule, this file's own inline
// padding) ultimately traces back to ONE piece of information: whether
// preload.js's `process.platform === 'darwin'` check actually ran and
// actually resolved to 'mac' in the running app. If that single check
// silently didn't happen — a failed/slow IPC round trip, a sandboxed-
// preload quirk, anything — every one of those layers goes dark at once
// with no error, which matches "the reserve doesn't exist at all" exactly.
// So this no longer trusts that one signal alone: it independently
// re-derives "is this macOS" from navigator.userAgent, which needs no IPC,
// no main-process round trip, and no preload cooperation at all — it's
// just a string the renderer already has. If this disagrees with
// data-platform, it WINS and self-heals data-platform too, so the
// styles.css rule (which keys off data-platform) starts working on its own
// even if preload's half of this never did.
function detectMacIndependently() {
  const ua = (navigator.userAgent || '') + ' ' + (navigator.platform || '');
  return /Mac|iPhone|iPad|iPod/.test(ua) && !/Windows|Linux/.test(ua);
}

function applyMacTabRowReserve() {
  const root = document.documentElement;
  const tabRowEl = document.getElementById('tab-row');
  if (!tabRowEl) return;
  const uaSaysMac = detectMacIndependently();
  if (uaSaysMac && root.dataset.platform !== 'mac') {
    // Self-heal: preload's own detection didn't mark this mac for some
    // reason, but the renderer can see plainly that it is one. Fix the
    // attribute itself (not just this function's local decision) so every
    // OTHER [data-platform="mac"] rule in styles.css benefits too, not only
    // the inline override below.
    root.dataset.platform = 'mac';
  }
  // Belt-and-suspenders fallback for the inline custom property too, in
  // case preload's IPC round trip didn't resolve it (see the comment on
  // MAC_TRAFFIC_LIGHT_RESERVE_PX in main.js for what normally sets this).
  if (root.dataset.platform === 'mac' && !getComputedStyle(root).getPropertyValue('--mac-traffic-light-reserve').trim()) {
    root.style.setProperty('--mac-traffic-light-reserve', '134px');
  }
  // Only 'custom' Title Bar Mode (frame: false) ever asks macOS for a
  // custom trafficLightPosition at all (see nativeControlOptions() in
  // main.js) — 'native' mode has a real OS title bar above this row
  // already and must keep styles.css's own [data-titlebar="native"] rule
  // in charge, not an inline style that would always beat it. Clearing the
  // inline property (rather than just skipping the call) matters on a
  // live custom->native switch: without it, a stale inline value from
  // custom mode would keep winning the cascade after the switch.
  if (root.dataset.platform !== 'mac' || root.dataset.titlebar === 'native') {
    tabRowEl.style.paddingInlineStart = '';
    logMacTrafficLightDiag(tabRowEl, uaSaysMac);
    return;
  }
  tabRowEl.style.paddingInlineStart = root.classList.contains('is-fullscreen')
    ? 'var(--sp-3)'
    : 'var(--mac-traffic-light-reserve)';
  logMacTrafficLightDiag(tabRowEl, uaSaysMac);
}

// Diagnostic only — does not affect layout. Every fix applied so far has
// been correct on paper but still reported as not visibly working, which
// can only mean one of: (a) the reserve isn't actually being computed as
// "mac" here, (b) the inline style isn't actually landing on the real
// element, or (c) it IS landing, but the lights themselves are drawn
// further right/down than any of this accounts for. This makes all three
// checkable from the toolbar's own DevTools (click the tab strip, then F12
// or Cmd+Shift+I — NOT "Inspect Element" from the menu, which opens the
// PAGE's DevTools, a different WebContents that never runs this file) —
// instead of guessing blind again. Logs once per reserve recomputation, not
// on every call, matching `applyMacTabRowReserve()`'s own call sites.
function logMacTrafficLightDiag(tabRowEl, uaSaysMac) {
  const root = document.documentElement;
  const computed = getComputedStyle(tabRowEl).paddingInlineStart;
  const rect = tabRowEl.getBoundingClientRect();
  const tabListBtn = document.getElementById('tab-list-btn');
  const btnRect = tabListBtn ? tabListBtn.getBoundingClientRect() : null;
  console.info('[gloza mac-traffic-light-diag]', {
    'navigator.userAgent says mac': uaSaysMac,
    'data-platform (after any self-heal)': root.dataset.platform,
    'data-titlebar': root.dataset.titlebar,
    'is-fullscreen': root.classList.contains('is-fullscreen'),
    '--mac-traffic-light-reserve (computed)': getComputedStyle(root).getPropertyValue('--mac-traffic-light-reserve').trim(),
    '#tab-row inline paddingInlineStart': tabRowEl.style.paddingInlineStart,
    '#tab-row computed paddingInlineStart': computed,
    '#tab-row rect': { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) },
    '#tab-list-btn rect': btnRect ? { x: Math.round(btnRect.x), y: Math.round(btnRect.y) } : null,
  });
  if (!uaSaysMac && root.dataset.platform === 'mac') {
    console.warn('[gloza mac-traffic-light-diag] data-platform says "mac" but the user agent does not look like macOS at all — double-check this build is actually launching on macOS, not Windows/Linux with a stale "mac" value left over from something else.');
  }
  if (uaSaysMac && computed === '0px') {
    console.warn('[gloza mac-traffic-light-diag] This looks like macOS and the code believes it reserved space, but the COMPUTED padding is still 0px — something else in styles.css is overriding #tab-row after this ran. Check the Elements panel > Styles for #tab-row for a rule with higher priority than an inline style, which should not be possible unless something is setting padding on #tab-row with !important.');
  }
}
applyMacTabRowReserve();


// ---------------------------------------------------------------------------
// Preferences (accent color + tab shape) — saved from the Settings page
// ---------------------------------------------------------------------------
// 'always' | 'new-tab-only' | 'never' — see prefs:setBookmarksBarMode in
// main.js and updateBookmarksBarVisibility() below.
let bookmarksBarMode = 'always';

// Mirrors main.js's SEARCH_ENGINES display names — only used for the
// dropdown's "Search with <Engine>" section label, so a plain lookup table
// is enough; the actual search URL building stays server-side (main.js) so
// there's exactly one place that owns "how do I build engine X's URL".
const SEARCH_ENGINE_NAMES = { google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo', brave: 'Brave Search' };
let currentSearchEngine = 'google';

function applyPrefs(prefs) {
  currentSearchEngine = SEARCH_ENGINE_NAMES[prefs.searchEngine] ? prefs.searchEngine : 'google';
  const root = document.documentElement;
  if (prefs.accent) root.style.setProperty('--accent', prefs.accent);
  // theme.css turns this attribute into the right --tab-radius
  root.dataset.tabShape = prefs.tabShape || 'rounded-top';
  // theme.css turns this into the whole light/dark token set (surfaces,
  // text, accent tuning) — see [data-theme="light"] / [data-theme="dark"].
  root.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
  // styles.css hides the custom #window-controls row (and the tab-row's
  // drag region adjusts) when the OS is drawing its own title bar instead —
  // see window:setTitleBarMode in main.js for how the switch itself happens.
  root.dataset.titlebar = prefs.titleBarMode === 'native' ? 'native' : 'custom';
  // Keep the inline --mac-traffic-light-reserve (set pre-paint by
  // preload.js — see the comment there) correct across every later
  // prefs-updated push too, not just the very first one, so a title-bar
  // mode toggle or any other pref change can't leave a stale value behind.
  if (root.dataset.platform === 'mac' && Number.isFinite(prefs.macTrafficLightReserve)) {
    root.style.setProperty('--mac-traffic-light-reserve', `${prefs.macTrafficLightReserve}px`);
  }
  applyMacTabRowReserve();
  bookmarksBarMode =
    prefs.bookmarksBarMode === 'new-tab-only' || prefs.bookmarksBarMode === 'never'
      ? prefs.bookmarksBarMode
      : 'always';
  updateBookmarksBarVisibility();
}

window.browser.onPrefsUpdated(applyPrefs);
// The menu button used to navigate straight to Settings. It now opens the
// browser menu panel instead (see "Browser menu panel" below); that panel's
// own Settings row is what calls window.browser.openSettings().


// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabEntries = new Map(); // tabId -> { el, label, img, fallback, ... }

// Multi-tab selection ("Select All Tabs" from the context menu, and the
// foundation for it — real browsers' ctrl/shift-click isn't in scope here,
// but the selection itself is real: selected tabs are visually marked and
// a selection of 2+ unlocks a "Close N Selected Tabs" row, which actually
// closes exactly that set, so this isn't a decorative toggle.
const selectedTabIds = new Set();
function clearTabSelection() {
  if (!selectedTabIds.size) return;
  selectedTabIds.clear();
  for (const entry of tabEntries.values()) entry.el.classList.remove('selected');
}
function selectAllTabs() {
  selectedTabIds.clear();
  for (const tab of tabsState.tabs) selectedTabIds.add(tab.id);
  for (const [id, entry] of tabEntries) entry.el.classList.toggle('selected', selectedTabIds.has(id));
}
// A normal left-click anywhere outside the context menu drops the
// selection, same as every real browser — it's only meant to live for the
// duration of "select all, then act on them via the context menu".
document.addEventListener('pointerdown', (event) => {
  if (!selectedTabIds.size) return;
  if (event.target.closest('#bm-menu, #bm-submenu')) return;
  clearTabSelection();
});

// Marks tabs that have become too narrow for a title (see .tab.compact in styles.css)
const COMPACT_BELOW_PX = 84;
const compactObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    target.classList.toggle('compact', target.offsetWidth < COMPACT_BELOW_PX);
  }
});

function createTabEntry(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.tabIndex = 0;
  el.dataset.tabId = String(id); // read back by drag-to-reorder below

  // [fallback icon | favicon image | loading spinner] — CSS shows exactly one
  const iconBox = document.createElement('span');
  iconBox.className = 'tab-icon';
  const fallback = createIcon('globe', 'tab-fallback');
  const img = document.createElement('img');
  img.className = 'tab-favicon';
  img.alt = '';
  img.draggable = false;
  const spinner = document.createElement('span');
  spinner.className = 'tab-spinner';
  iconBox.append(fallback, img, spinner);

  const label = document.createElement('span');
  label.className = 'tab-label';

  // One icon slot shared by both audio states: a plain speaker while the
  // tab is actually producing sound (click to mute), or a muted speaker
  // while the tab is muted (click to unmute, even if it's gone quiet) —
  // never both, never neither unless the tab is silent and unmuted. See
  // updateTabEntry for the actual state logic; this just builds the element.
  const audioIcon = createIcon('speaker', 'tab-status-icon tab-audio-icon');
  audioIcon.setAttribute('hidden', ''); // SVGElement has no .hidden property — must use the attribute
  audioIcon.setAttribute('role', 'button');
  audioIcon.tabIndex = -1;

  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.setAttribute('role', 'button');
  closeBtn.setAttribute('aria-label', 'Close tab');
  closeBtn.appendChild(createIcon('close'));

  el.append(iconBox, label, audioIcon, closeBtn);
  compactObserver.observe(el);
  // Once the one-shot entrance animation (tab-in) has played, mark the tab
  // settled so styles.css stops applying it. Without this, moving a tab in
  // the DOM (which a drag reorder must do) restarts `animation: tab-in` —
  // every moved tab re-animated from flex-basis 0 / scale .88, collapsing
  // its width mid-drag and corrupting every measurement the reorder uses.
  el.addEventListener('animationend', (e) => {
    if (e.target === el && e.animationName === 'tab-in') el.classList.add('tab-settled');
  });

  const entry = { id, el, label, img, fallback, audioIcon, shownSrc: '', failedSrc: '', iconName: 'globe' };

  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openTabContextMenu(id, event.clientX, event.clientY);
  });
  // Never let this bubble to the tab's own click (switch) or pointerdown
  // (drag-start) handlers — it must only ever toggle mute for this tab.
  audioIcon.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    // Keep focus off the button on press: a focused (even tabindex=-1) SVG
    // stayed focused after the click and drew the lingering circular outline.
    event.preventDefault();
  });
  audioIcon.addEventListener('click', (event) => {
    event.stopPropagation();
    window.browser.toggleMuteTab(id);
  });

  el.addEventListener('click', () => {
    // A drag that actually moved the tab ends with a click too (pointerup
    // fires one); swallow exactly that one so it can't also switch tabs.
    if (suppressNextClick) { suppressNextClick = false; return; }
    window.browser.switchTab(id);
  });
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation(); // don't also trigger switchTab
    window.browser.closeTab(id);
  });
  el.addEventListener('pointerdown', (event) => beginTabDrag(event, el));
  el.addEventListener('keydown', (event) => {
    if (event.target !== el) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      window.browser.switchTab(id);
    } else if (event.key === 'Delete') {
      window.browser.closeTab(id);
    }
  });

  // Never show a broken-image icon: only reveal the <img> once it really loaded
  img.addEventListener('load', () => el.classList.add('has-favicon'));
  img.addEventListener('error', () => {
    entry.failedSrc = entry.shownSrc; // remember so we don't retry in a loop
    el.classList.remove('has-favicon');
  });

  return entry;
}

function updateTabEntry(entry, tab, isActive) {
  const { el } = entry;

  el.classList.toggle('active', isActive);
  el.classList.toggle('loading', Boolean(tab.loading));
  el.classList.toggle('pinned', Boolean(tab.pinned));
  el.classList.toggle('discarded', Boolean(tab.discarded));
  el.setAttribute('aria-selected', String(isActive));
  if (entry.audioIcon) {
    // Muted wins visually even if the page has gone quiet (a muted tab
    // should always look muted); otherwise show the plain speaker only
    // while the tab is actually producing sound right now; otherwise show
    // nothing at all.
    const showMuted = Boolean(tab.muted);
    const showAudible = !showMuted && Boolean(tab.audible);
    // Attribute, not `.hidden =`: audioIcon is an SVG element and SVGElement
    // has no `hidden` property, so assigning it was a silent no-op and the
    // icon was never actually hidden on normal tabs.
    entry.audioIcon.toggleAttribute('hidden', !(showMuted || showAudible));
    // Drives the resting "this is currently ON" tint in styles.css
    // (.tab-audio-icon[aria-pressed="true"]) — also the correct a11y state
    // for a toggle button, independent of the icon swap below.
    entry.audioIcon.setAttribute('aria-pressed', String(showMuted));
    if (showMuted) {
      setIcon(entry.audioIcon, 'mute');
      entry.audioIcon.setAttribute('aria-label', 'Muted — click to unmute');
    } else if (showAudible) {
      setIcon(entry.audioIcon, 'speaker');
      entry.audioIcon.setAttribute('aria-label', 'Playing audio — click to mute');
    }
  }

  const text = tab.loading ? 'Loading…' : tab.title;
  if (entry.label.textContent !== text) entry.label.textContent = text;
  el.title = tab.title; // full title on hover when the label is truncated

  // Fallback icon: gear for Settings, Gloza mark for our other own pages,
  // globe for everything else (see iconNameForUrl()).
  const internal = isInternalUrl(tab.url);
  const fallbackName = iconNameForUrl(tab.url);
  if (entry.iconName !== fallbackName) {
    entry.iconName = fallbackName;
    setIcon(entry.fallback, fallbackName);
  }

  // Favicon: only touch the <img> when the URL actually changed (avoids flicker)
  const wanted = !internal && tab.favicon && tab.favicon !== entry.failedSrc ? tab.favicon : '';
  if (wanted !== entry.shownSrc) {
    entry.shownSrc = wanted;
    el.classList.remove('has-favicon');
    if (wanted) entry.img.src = wanted;
    else entry.img.removeAttribute('src');
  }
}

function removeTabEntry(id, entry) {
  tabEntries.delete(id);
  const { el } = entry;
  compactObserver.unobserve(el);
  el.classList.add('closing');
  el.setAttribute('aria-hidden', 'true');
  // Remove once the shrink-away animation ends (timeout is just a safety net)
  const finish = () => { el.remove(); updateTabCount(); };
  el.addEventListener('animationend', (event) => {
    if (event.target === el) finish();
  });
  setTimeout(finish, 400);
}

// Closing tabs stay in the DOM briefly for their exit animation; skip them
// when working out where each live tab belongs.
function nextLive(node) {
  let n = node;
  while (n && n.classList.contains('closing')) n = n.nextElementSibling;
  return n;
}

// Tells the CSS how many *live* tabs exist — deliberately NOT counting ones
// still animating out (tabEntries already had them deleted by
// removeTabEntry, see below). That's what lets #tab-strip's own reserved
// width (its flex-basis, which transitions — see styles.css) ease down in
// step with a closing tab's shrink animation, instead of staying put until
// the element is finally removed and then snapping. #new-tab-btn, as the
// strip's flex sibling, rides along with that same eased width change for
// free — no separate animation needed for it.
function updateTabCount() {
  $('#tab-strip').style.setProperty('--tab-count', Math.max(1, tabEntries.size));
}

function renderTabs() {
  const strip = $('#tab-strip');
  const liveIds = new Set(tabsState.tabs.map((t) => t.id));

  for (const [id, entry] of tabEntries) {
    if (!liveIds.has(id)) removeTabEntry(id, entry);
  }

  // Mid-drag, the strip's DOM order is the live, authoritative order (the
  // user is actively setting it by hand) — an update arriving from the
  // engine in the middle of that gesture (e.g. a title change) must still
  // refresh each tab's content, but must NOT reshuffle elements back to the
  // pre-drag order underneath the user's pointer.
  let cursor = nextLive(strip.firstElementChild);
  for (const tab of tabsState.tabs) {
    let entry = tabEntries.get(tab.id);
    if (!entry) {
      entry = createTabEntry(tab.id);
      tabEntries.set(tab.id, entry);
    }
    updateTabEntry(entry, tab, tab.id === tabsState.activeTabId);

    if (dragInProgress) continue;
    if (entry.el === cursor) cursor = nextLive(cursor.nextElementSibling);
    else strip.insertBefore(entry.el, cursor); // cursor null → appended at the end
  }
  updateTabCount();

  // Keep the active tab visible — after opening/closing/switching tabs or
  // activating one from the tab-list dropdown, this all funnels through a
  // tabs-updated event and so through here. Deferred one frame so it runs
  // after the strip's own width/flex-basis transition settles the layout
  // this scroll position depends on.
  const activeEntry = tabsState.activeTabId != null ? tabEntries.get(tabsState.activeTabId) : null;
  if (activeEntry && !dragInProgress) {
    requestAnimationFrame(() => {
      activeEntry.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  layoutTabStripArrows();
}

// ---------------------------------------------------------------------------
// Tab-strip overflow: start/end arrow buttons (see index.html) that scroll
// #tab-strip horizontally once tabs can no longer all fit at their minimum
// width. The strip already scrolls on its own (overflow-x: auto, see
// styles.css) — these arrows are just an explicit, discoverable, clickable
// way to move it, matching the bookmarks-bar overflow treatment.
// ---------------------------------------------------------------------------
const TAB_STRIP_SCROLL_STEP = 180;

function layoutTabStripArrows() {
  const strip = $('#tab-strip');
  const startArrow = $('#tab-strip-start-arrow');
  const endArrow = $('#tab-strip-end-arrow');
  if (!strip || !startArrow || !endArrow) return;

  // 1px slack: fractional sub-pixel layout can leave scrollWidth a hair
  // larger than clientWidth even when nothing is actually hidden.
  const hasOverflow = strip.scrollWidth > strip.clientWidth + 1;
  startArrow.hidden = !hasOverflow;
  endArrow.hidden = !hasOverflow;
  if (!hasOverflow) return;

  const maxScroll = strip.scrollWidth - strip.clientWidth;
  startArrow.disabled = strip.scrollLeft <= 0;
  endArrow.disabled = strip.scrollLeft >= maxScroll - 1;
}

$('#tab-strip-start-arrow').addEventListener('click', () => {
  $('#tab-strip').scrollBy({ left: -TAB_STRIP_SCROLL_STEP, behavior: 'smooth' });
});
$('#tab-strip-end-arrow').addEventListener('click', () => {
  $('#tab-strip').scrollBy({ left: TAB_STRIP_SCROLL_STEP, behavior: 'smooth' });
});

// Mousewheel / trackpad scrolling and the drag-to-reorder gesture both move
// #tab-strip's scrollLeft without going through renderTabs(), so the arrows'
// disabled state needs its own listener to stay in sync.
let tabStripScrollRaf = null;
$('#tab-strip').addEventListener('scroll', () => {
  if (tabStripScrollRaf != null) return;
  tabStripScrollRaf = requestAnimationFrame(() => {
    tabStripScrollRaf = null;
    layoutTabStripArrows();
  });
});

// The strip's own width changes on window resize, and also eases in step
// with --tab-count whenever a tab opens/closes/pins (see updateTabCount) —
// both need the arrows (and their disabled state) recomputed.
new ResizeObserver(() => layoutTabStripArrows()).observe($('#tab-strip'));


// ---------------------------------------------------------------------------
// Drag to rearrange tabs. Pointer-based (not HTML5 drag/drop, which forces
// a native ghost image and its own drop-effect quirks) so the dragged tab
// can stay a normal, fully-styled element that tracks the cursor 1:1 while
// every neighbor it passes slides out of the way via a small FLIP step.
// Only the DOM order changes live; the real reorder is committed to the
// engine (and so to tabOrder in main.js) once on pointerup.
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD_PX = 4;
let suppressNextClick = false; // set on a drag that moved; consumed by the next 'click'
let dragInProgress = false; // true from the drag threshold until pointerup; see renderTabs()

function liveTabEls() {
  return Array.from($('#tab-strip').children).filter(
    (el) => el.classList.contains('tab') && !el.classList.contains('closing')
  );
}

function beginTabDrag(downEvent, el) {
  if (downEvent.button !== 0) return; // left button only
  if (downEvent.target.closest('.tab-close')) return; // let the close button work normally
  if (el.classList.contains('closing')) return;

  const pointerId = downEvent.pointerId;
  const startX = downEvent.clientX;
  const tabId = Number(el.dataset.tabId);
  let moved = false;
  let order = liveTabEls(); // local working copy of left-to-right order
  let ghostShown = false; // whether the cross-window drag preview is currently up

  // Running total of how far el's own NATURAL (no-transform) position has
  // shifted, across every reorder so far, relative to where it started this
  // drag. Every reorder below moves el to a new slot in the DOM, which
  // changes its natural left edge even though it hasn't visually moved —
  // el.style.transform is what's hiding that jump from the user. This has
  // to accumulate (not just hold the latest single-step delta): once el has
  // been reordered more than once, its natural position has drifted from
  // its drag-start position by the SUM of every step's shift, not just the
  // last one. Previously only the single most recent delta was ever
  // compensated for (applied inline in the reorder branch, then silently
  // dropped the moment a move event DIDN'T also trigger a reorder) — so the
  // instant the pointer crossed one neighbor boundary and then kept moving
  // without crossing another, the dragged tab would snap away from the
  // cursor by that neighbor's width. That's what made it look like a tab
  // could only ever be dropped at the very start or end: past the first
  // boundary the element's visual position had already desynced from the
  // pointer, so every further comparison against it was meaningless.
  let cumulativeShift = 0;

  // Desktop (screen-space) bounds of THIS window, fetched once up front so
  // we can tell, purely from a pointer event's screenX/screenY, whether the
  // cursor has left this window during the drag (used to show the
  // detach/transfer affordance below). The OS keeps delivering pointer
  // events to the element that called setPointerCapture() even once the
  // cursor is outside this window's bounds (as long as the mouse button
  // stays down), which is exactly what makes dragging a tab out, and the
  // final drop position, detectable at all from here.
  let ownBounds = null;
  window.browser.getWindowBounds().then((b) => { ownBounds = b; });

  function isOutsideOwnWindow(screenX, screenY) {
    if (!ownBounds || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return false;
    return (
      screenX < ownBounds.x || screenX >= ownBounds.x + ownBounds.width ||
      screenY < ownBounds.y || screenY >= ownBounds.y + ownBounds.height
    );
  }

  // ---- Stable layout positions -------------------------------------------
  // Read each neighbor's NATURAL left edge (what it would be with no ongoing
  // transitions / FLIP transforms applied). We do this once at drag start and
  // update it only after a confirmed reorder, so mid-animation positions
  // never corrupt the target-index calculation.
  //
  // For a node that currently has a translateX from a FLIP step, its
  // natural position is: currentLeft - currentTranslateX.
  //
  // currentTranslateX reads getComputedStyle(), NOT node.style.transform.
  // The inline attribute is set to its FINAL value ('') the instant
  // settleNeighbor() kicks off a FLIP animation, while the element's actual
  // on-screen position keeps easing toward it over --dur (200ms). Reading
  // the inline attribute therefore returns 0 (i.e. "already arrived") for
  // the entire ~200ms a neighbor is still visibly sliding — which, during
  // any real continuous drag, is most of the time, since every reorder
  // step kicks off new settle animations for the tabs it passed. That
  // mismatch between "rect.left" (live, animated, correct) and "tx"
  // (stale, assumed-zero) was producing wrong midpoints and was the actual
  // cause of tabs overshooting / snapping back / jumping around mid-drag.
  // getComputedStyle().transform reports the truly-rendered matrix at any
  // instant, mid-transition included, so this is correct throughout.
  function currentTranslateX(node) {
    const t = getComputedStyle(node).transform;
    if (!t || t === 'none') return 0;
    const m = t.match(/matrix(3d)?\(([^)]+)\)/);
    if (!m) return 0;
    const parts = m[2].split(',').map(Number);
    return m[1] ? parts[12] : parts[4]; // matrix3d: tx @12, matrix: tx @4
  }

  function naturalLeft(node) {
    return node.getBoundingClientRect().left - currentTranslateX(node);
  }

  // Snapshot stable midpoints for all non-dragged neighbors.
  let stableMids = buildStableMids();
  function buildStableMids() {
    return order.map((node) => {
      if (node === el) return null;
      const rect = node.getBoundingClientRect();
      return { node, mid: naturalLeft(node) + rect.width / 2, width: rect.width };
    }).filter(Boolean);
  }

  // One pending transitionend cleanup per node, so a node settled again
  // before its previous settle finished (routine during a fast drag that
  // crosses several tabs in a row) doesn't pile up listeners — each node
  // only ever has one.
  const pendingSettleCleanup = new Map(); // node -> listener function

  // PERFORMANCE — this used to be a per-node function called in a loop
  // (settleNeighbor), and that loop was the actual cause of the drag lag:
  // each call did a READ (getBoundingClientRect) then two WRITEs then
  // another forced READ (void node.offsetWidth) — and because the DOM only
  // flushes layout lazily, interleaving a read between every pair of
  // writes forces the browser to synchronously recompute layout right then,
  // every single iteration. For N neighbor tabs that's up to ~2N forced
  // synchronous reflows triggered inside ONE pointermove handler, every
  // time the dragged tab crossed a boundary — on a strip with a dozen tabs
  // that's enough layout thrashing to visibly stutter, and it happened on
  // nearly every frame during a continuous fast drag.
  //
  // Fix: the classic FLIP batching discipline — do ALL the reads for every
  // node first (one batch, one reflow), then ALL the "jump to the pre-move
  // position" writes (zero reads in between, so no reflow yet), then force
  // exactly ONE reflow for the whole batch, then ALL the "animate back to
  // zero" writes. Three reflows total for the entire neighbor set, not two
  // per node.
  // `beforeLeft`/`afterLeft` are pre-read by the caller (onMove already
  // needed both to compensate el's own position, in the same batch) — no
  // additional getBoundingClientRect calls happen in here at all, so this
  // function contributes zero extra reflows of its own.
  function settleNeighbors(nodes, beforeLeft, afterLeft) {
    const deltas = [];
    for (const node of nodes) {
      const dx = beforeLeft.get(node) - afterLeft.get(node);
      if (Math.abs(dx) >= 0.5) deltas.push([node, dx]);
    }
    if (!deltas.length) return;

    // ---- WRITE phase 1: jump each node back to where it visually was ----
    for (const [node, dx] of deltas) {
      // Cancel any settle still in flight for this node so listeners never
      // pile up across a fast multi-step drag.
      const prevCleanup = pendingSettleCleanup.get(node);
      if (prevCleanup) {
        node.removeEventListener('transitionend', prevCleanup);
        pendingSettleCleanup.delete(node);
      }
      node.classList.remove('drag-settling');
      node.style.transform = `translateX(${dx}px)`;
    }

    // ---- Exactly ONE forced reflow for the whole batch ----
    void $('#tab-strip').offsetWidth;

    // ---- WRITE phase 2: enable the transition and animate to rest ----
    for (const [node] of deltas) {
      node.classList.add('drag-settling');
      node.style.transform = '';
      const onEnd = (e) => {
        if (e.propertyName !== 'transform') return;
        node.classList.remove('drag-settling');
        node.style.transform = '';
        pendingSettleCleanup.delete(node);
      };
      pendingSettleCleanup.set(node, onEnd);
      node.addEventListener('transitionend', onEnd, { once: true });
    }
  }

  function onMove(moveEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    const dx = moveEvent.clientX - startX;

    if (!moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      moved = true;
      dragInProgress = true;
      el.classList.add('dragging');
      $('#tab-strip').classList.add('has-drag');
      // Snapshot stable mids NOW (before any FLIP transforms are in flight).
      stableMids = buildStableMids();
    }

    // Once the cursor has left this window's own bounds, the tab is being
    // torn off (either to detach into a new window, or to be dropped onto
    // another Gloza window) — fade it to signal that, and stop running the
    // in-strip reorder math (there's no longer a meaningful insertion index
    // to compute; onUp decides what actually happens on release).
    const tornAway = isOutsideOwnWindow(moveEvent.screenX, moveEvent.screenY);
    el.classList.toggle('tearing-away', tornAway);
    if (tornAway) {
      el.style.transform = `translateX(${dx - cumulativeShift}px)`;
      // The in-strip element itself can't be seen once the pointer leaves
      // this window (it's clipped to this WebContentsView's bounds) — that
      // cross-window "ghost" BrowserWindow is what actually stays visible
      // under the cursor from here on. Start it the instant we cross the
      // boundary, then just reposition it every subsequent frame.
      if (!ghostShown) {
        ghostShown = true;
        const tabData = tabsState.tabs.find((t) => t.id === tabId);
        window.browser.startDragPreview(moveEvent.screenX, moveEvent.screenY, tabData?.title, tabData?.favicon);
      } else {
        window.browser.moveDragPreview(moveEvent.screenX, moveEvent.screenY);
      }
      return;
    } else if (ghostShown) {
      // Dragged back inside this window — the real (non-clipped) tab
      // element is visible again, so the stand-in ghost is no longer needed.
      ghostShown = false;
      window.browser.endDragPreview();
    }

    // Pointer absolute position
    const pointerX = moveEvent.clientX;

    // Determine target insertion index using STABLE midpoints (not animated ones).
    const currentIndex = order.indexOf(el);
    let targetIndex = stableMids.length; // default: after all neighbors
    for (let i = 0; i < stableMids.length; i++) {
      if (pointerX < stableMids[i].mid) {
        targetIndex = i;
        break;
      }
    }
    // Convert from "neighbor index" (a position in stableMids, which skips
    // el entirely and so has one fewer slot than `order`) to the index we
    // splice el into.
    //
    // ROOT CAUSE of "jumps toward the farthest tab": the two splice calls
    // below run SEQUENTIALLY on the same `order` array — first
    // `order.splice(currentIndex, 1)` removes el, which by itself already
    // collapses every index after currentIndex down by one, leaving an
    // array whose indices line up 1:1 with stableMids (that's exactly what
    // buildStableMids() iterates to produce it). The removed-el array IS
    // the neighbor-space array; targetIndex (computed against stableMids)
    // is therefore already the correct index to insert el back into — no
    // further adjustment needed. The previous formula re-added +1 whenever
    // targetIndex was past currentIndex, as if both splices applied to the
    // ORIGINAL (still-containing-el) array independently. They don't: the
    // second splice sees the array AFTER the first one already ran, so
    // that extra +1 pushed every rightward placement one slot too far —
    // e.g. dropping el immediately after its right-hand neighbor landed it
    // at the very end of the strip instead, and the farther right you
    // tried to place it, the more this compounded with how far the pointer
    // had to travel, producing exactly the "tab 4 can't go between tabs 2
    // and 3, it jumps to the end" symptom.
    const fullTargetIndex = targetIndex;

    if (fullTargetIndex !== currentIndex) {
      // ---- READ phase (single batch, one reflow at most) ----
      // Snapshot current VISUAL left edges before DOM moves.
      const beforeLeft = new Map(order.map((node) => [node, node.getBoundingClientRect().left]));

      // ---- Reorder the DOM (write) ----
      order.splice(currentIndex, 1);
      order.splice(fullTargetIndex, 0, el);
      const strip = $('#tab-strip');
      // Move ONLY the dragged tab. Re-appending every tab (as this used to)
      // detached/re-attached all of them each step — restarting their CSS
      // animations and dropping pointer capture — for no benefit, since
      // every other tab's relative order is unchanged.
      const refNode = order[fullTargetIndex + 1] || null;
      if (refNode) strip.insertBefore(el, refNode);
      else strip.appendChild(el);
      try { el.setPointerCapture(pointerId); } catch { /* capture is a nicety only */ }

      // ---- Exactly ONE forced reflow to read everyone's new natural position ----
      // (Was previously one reflow for el alone PLUS one-or-two more per
      // neighbor inside the old settleNeighbor loop — see settleNeighbors'
      // comment above for why that was the actual cause of the drag lag.)
      void strip.offsetWidth;
      const afterLeft = new Map(order.map((node) => [node, node.getBoundingClientRect().left]));

      // After the DOM reorder the dragged tab's natural (layout) position
      // changed but it needs to keep appearing exactly under the pointer —
      // compensate with a corrected transform using the before/after delta
      // we already have, no extra read needed.
      const elOldLeft = beforeLeft.get(el);
      const elNewLeft = afterLeft.get(el);
      const layoutShift = elNewLeft - elOldLeft;
      cumulativeShift += layoutShift;
      el.style.transform = `translateX(${dx - cumulativeShift}px)`;

      // FLIP every neighbor into its new slot in one batched pass.
      settleNeighbors(
        order.filter((node) => node !== el),
        beforeLeft,
        afterLeft
      );

      // Rebuild stable mids after reorder so the next move event uses fresh values.
      stableMids = buildStableMids();
      return;
    }

    // No reorder this move — just track the pointer, but still compensate
    // for whatever reorders happened on EARLIER move events (see
    // cumulativeShift above). Using plain `dx` here was the bug: it threw
    // away that compensation the moment one move event went by without
    // itself triggering a new reorder, which is most of them.
    el.style.transform = `translateX(${dx - cumulativeShift}px)`;
  }

  function onUp(upEvent) {
    if (upEvent.pointerId !== pointerId) return;
    cleanup();

    dragInProgress = false;
    if (!moved) return;

    // A cancelled gesture (e.g. the OS took the pointer away mid-drag) has
    // no trustworthy release position — treat it like Escape: snap back,
    // commit nothing.
    if (upEvent.type === 'pointercancel') {
      el.classList.remove('dragging', 'tearing-away');
      $('#tab-strip').classList.remove('has-drag');
      el.style.transform = '';
      window.browser.endDragPreview();
      renderTabs();
      return;
    }

    suppressNextClick = true;
    const wasTornAway = el.classList.contains('tearing-away');
    el.classList.remove('dragging', 'tearing-away');
    $('#tab-strip').classList.remove('has-drag');
    // Whatever happens next (reorder, transfer, detach), the ghost's job
    // ends the moment the pointer is released — main.js is about to either
    // show the real tab in a new/other window or snap this one back, either
    // way the stand-in preview must go.
    window.browser.endDragPreview();

    // Animate dragged tab back to its natural (post-reorder) position. If
    // the drop ends up detaching/transferring the tab, this element and its
    // whole strip get rebuilt from the next 'tabs-updated' event anyway, so
    // this settle animation is harmless either way — it just never gets to
    // finish in that case.
    el.classList.add('drag-settling');
    el.style.transform = '';
    el.addEventListener(
      'transitionend',
      () => {
        el.classList.remove('drag-settling');
        el.style.transform = '';
      },
      { once: true }
    );

    const newOrder = liveTabEls()
      .map((node) => Number(node.dataset.tabId))
      .filter((id) => Number.isFinite(id));
    const screenX = wasTornAway ? upEvent.screenX : NaN;
    const screenY = wasTornAway ? upEvent.screenY : NaN;
    window.browser.dragEndTab(tabId, newOrder, screenX, screenY);
  }

  function onKeyDown(keyEvent) {
    if (keyEvent.key !== 'Escape' || !moved) return;
    // Cancel the drag entirely: snap back to the original order/position
    // without committing anything to the engine.
    keyEvent.preventDefault();
    cleanup();
    dragInProgress = false;
    el.classList.remove('dragging', 'tearing-away');
    $('#tab-strip').classList.remove('has-drag');
    el.style.transform = '';
    window.browser.endDragPreview();
    renderTabs(); // restore DOM order from the last known engine state
  }
  window.addEventListener('keydown', onKeyDown);

  // Coalesce pointermove to at most once per animation frame. Mice/trackpads
  // can fire far more move events than the display refreshes; running the
  // full reorder/measure/FLIP pass on every single one was extra layout
  // thrash on top of the stale-midpoint bug above, and could itself show up
  // as jitter under load. This keeps onMove's logic exactly as-is — it just
  // runs it against the latest event once per frame instead of per event.
  let rafId = null;
  let pendingMoveEvent = null;
  function queueMove(moveEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    pendingMoveEvent = moveEvent;
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      onMove(pendingMoveEvent);
    });
  }

  function cleanup() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    window.removeEventListener('pointermove', queueMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKeyDown);
    try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
  }

  // Capturing the pointer to the dragged tab keeps move events flowing to it
  // (and so to our window-level listeners, which still fire regardless)
  // even if the cursor briefly tracks over another tab or outside the strip
  // during a fast drag, instead of relying on whatever happens to be
  // directly under the cursor each frame.
  try { el.setPointerCapture(pointerId); } catch { /* not critical */ }

  window.addEventListener('pointermove', queueMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}


// ---------------------------------------------------------------------------
// Toolbar: nav buttons + address bar reflect the active tab
// ---------------------------------------------------------------------------
function renderToolbar() {
  const active = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);

  const addressBar = $('#address-bar');
  // Don't overwrite what the user is currently typing.
  if (active && document.activeElement !== addressBar) {
    addressBar.value = isInternalUrl(active.url) ? '' : active.url;
  }

  // Little icon at the left of the address bar
  let iconName = 'search';
  if (active) {
    if (isInternalUrl(active.url)) iconName = iconNameForUrl(active.url);
    else if (active.url.startsWith('https://')) iconName = 'lock';
    else iconName = 'globe';
  }
  setIcon($('#address-icon'), iconName);

  $('#back-btn').disabled = !(active && active.canGoBack);
  $('#forward-btn').disabled = !(active && active.canGoForward);
  $('#reload-btn').classList.toggle('is-loading', Boolean(active && active.loading));

  // Zoom pill: a subtle control living inside the address bar's left end.
  // Hidden entirely at the default 100% (per the design brief: "Do not make
  // it visually dominant") and otherwise shows the live percentage; clicking
  // it resets to 100%.
  const zoomPill = $('#zoom-pill');
  const zoomPercent = active ? active.zoomPercent ?? 100 : 100;
  if (zoomPercent === 100) {
    zoomPill.hidden = true;
  } else {
    zoomPill.hidden = false;
    zoomPill.textContent = `${zoomPercent}%`;
  }

  // Star button reflects whether the active tab's URL is already bookmarked.
  const bookmarkBtn = $('#bookmark-btn');
  const isInternal = !active || isInternalUrl(active.url);
  bookmarkBtn.disabled = isInternal;
  const isBookmarked = Boolean(active) && Boolean(findBookmarkByUrlLocal(bookmarksState, active.url));
  bookmarkBtn.classList.toggle('active', isBookmarked);
  bookmarkBtn.setAttribute('aria-pressed', String(isBookmarked));
  bookmarkBtn.title = isBookmarked ? 'Remove bookmark' : 'Bookmark this page';
  setIcon(bookmarkBtn.querySelector('.icon'), isBookmarked ? 'star-filled' : 'star');

  if (typeof refreshBrowserMenuLive === 'function') refreshBrowserMenuLive();
}

function render() {
  renderTabs();
  renderToolbar();
}

// Engine -> UI: re-render whenever tab state changes.
window.browser.onTabsUpdated((data) => {
  tabsState = data;
  render();
  // Skip while a drag is actively in flight: the drag's own onUp already
  // re-renders this panel right after it applies its reorder, and rebuilding
  // the rows mid-gesture (e.g. from an unrelated external update, such as a
  // page finishing a load) would yank out the DOM node the drag has pointer
  // capture on and its captured neighbor layout out from under it.
  if (openPanels.has($('#tab-list-overlay')) && !tlDragInProgress) renderTabListPanel();
  // The active tab (or its URL, e.g. navigating away from the new-tab page)
  // may have just changed, which is the only thing "Show Only on New Tab"
  // cares about — re-evaluate every time, not just when bookmarks change.
  updateBookmarksBarVisibility();
});


// ---------------------------------------------------------------------------
// UI -> engine: wire up the controls.
// ---------------------------------------------------------------------------
// Left-click the + button: just open a new tab, same as Ctrl+T.
// Right-click it: open the (existing) tab context menu, anchored under the
// button itself rather than at the pointer position — same menu as before,
// just moved off the primary click. Position is read from the button's
// live rect on every right-click, so it stays correct when the strip
// scrolls or the button moves.
$('#new-tab-btn').addEventListener('click', () => {
  window.browser.newTab();
});

$('#new-tab-btn').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const rect = $('#new-tab-btn').getBoundingClientRect();
  openTabContextMenu(tabsState.activeTabId, rect.left, rect.bottom + 6);
});

$('#home-btn').addEventListener('click', () => {
  // Navigate the CURRENT tab to the browser's existing new-tab page — not a
  // new tab. tabs:navigate in main.js already treats an empty/missing url
  // as "load home.html" (see its handler), so this is the same path the
  // address bar takes when cleared, just invoked directly. Works the same
  // whether the active tab is on a real website or an internal page.
  if (tabsState.activeTabId != null) window.browser.navigate(tabsState.activeTabId, '');
});

$('#back-btn').addEventListener('click', () => {
  window.browser.back(tabsState.activeTabId);
});

$('#forward-btn').addEventListener('click', () => {
  window.browser.forward(tabsState.activeTabId);
});

$('#reload-btn').addEventListener('click', () => {
  window.browser.reload(tabsState.activeTabId);
});

// Enter/Escape/Up/Down handling for the address bar lives with the dropdown
// logic below (it needs to know about highlighted suggestion rows), not
// here — see the '#address-bar' 'keydown' listener near
// closeAddressDropdown().


// ---------------------------------------------------------------------------
// Window state tracking — Close/Minimize/Maximize/Restore are now real
// OS-native controls (macOS traffic lights / the Windows+Linux Window
// Controls Overlay; see nativeControlOptions() in main.js) drawn directly
// by the OS, not Gloza buttons, so there's nothing left here to wire click
// handlers to or swap a maximize/restore icon on. This block just keeps
// `.is-fullscreen` (used elsewhere for fullscreen-specific layout and the
// browser menu's Full Screen / Exit Full Screen label) in sync with actual
// window state, and still lets double-clicking empty tab-row space toggle
// maximize/restore — a convention users expect from a title bar whether or
// not its buttons are native, and something the OS-native controls don't
// give us for free since they only cover their own small button area.
// ---------------------------------------------------------------------------
function applyWindowState({ maximized, fullscreen }) {
  if (typeof fullscreen === 'boolean') {
    isFullscreenNow = fullscreen;
    document.documentElement.classList.toggle('is-fullscreen', fullscreen);
    applyMacTabRowReserve();
    refreshBrowserMenuLive();
  }
}

window.browser.onWindowState(applyWindowState);
window.browser.isWindowMaximized().then((maximized) => applyWindowState({ maximized }));

// Double-clicking empty space in the tab row also toggles maximize, matching
// the usual title-bar convention (clicks on tabs/buttons never bubble here
// because they're separate elements, not because of anything special below).
$('#tab-row').addEventListener('dblclick', (event) => {
  if (event.target.closest('.tab, #new-tab-btn, #tab-list-btn, .tab-strip-arrow')) return;
  window.browser.maximizeToggle();
});


// ---------------------------------------------------------------------------
// Tell the engine how tall this toolbar really is, so the web page below it
// starts exactly at the bottom edge. Change the heights in styles.css and
// this follows automatically.
// ---------------------------------------------------------------------------
new ResizeObserver(() => {
  window.browser.setChromeHeight(Math.ceil($('#chrome').getBoundingClientRect().height));
}).observe($('#chrome'));


// ---------------------------------------------------------------------------
// Custom context menu overlay
// ---------------------------------------------------------------------------
// The menu is a <div> appended to <body> and positioned with fixed coords so
// it can overlap the page area (which lives below this view in the window).
// We pass windowW/windowH from main.js so we can prevent the menu from
// spilling outside the window.

(function initContextMenu() {
  // ---- Build the overlay element ------------------------------------------
  const overlay = document.createElement('div');
  overlay.id = 'ctx-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  document.body.appendChild(overlay);

  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  overlay.appendChild(menu);

  let currentTabId = null;
  let currentIsToolbar = false;
  let isVisible = false;
  let focusedIndex = -1;
  let menuItems = []; // live <button> elements in the current menu

  // ---- Show / hide --------------------------------------------------------
  // main.js grows the toolbar view to the full window right before sending
  // this event; that resize reaches this page asynchronously. Showing (and
  // animating) the menu before it lands drew it into the thin toolbar strip
  // — clipped, then popping fully into view — so wait for the real viewport
  // first. Stale waits are dropped via showToken (hide / newer right-click).
  let showToken = 0;
  function showMenu(info) {
    if (!info._ready) {
      const t = ++showToken;
      waitForViewport({ width: info.windowW, height: info.windowH }).then(() => {
        if (t === showToken) showMenu({ ...info, _ready: true });
      });
      return;
    }
    if (typeof closeAllPanels === 'function') closeAllPanels();
    const { x, y, windowW, windowH, tabId, params } = info;
    currentTabId = tabId;
    currentIsToolbar = Boolean(params && params.isToolbar);
    // The address suggestion dropdown is a separate DOM overlay with its own
    // open/close state (addressDropdownOpen) — right-clicking the bar while
    // it's open (e.g. the bar wasn't previously focused) must not leave both
    // overlays stacked.
    if (currentIsToolbar && typeof closeAddressDropdown === 'function') closeAddressDropdown();

    // Build item list based on context type.
    const items = buildItems(params);
    if (!items.length) { hideMenu(); return; }

    renderItems(items);
    menuItems = Array.from(menu.querySelectorAll('.ctx-item:not(.ctx-sep)'));
    focusedIndex = -1;

    // Position: near cursor, but keep fully inside window.
    overlay.style.display = 'block';
    overlay.setAttribute('aria-hidden', 'false');
    // Menu isn't laid out until display:block; measure after.
    const mw = menu.offsetWidth || 220;
    const mh = menu.offsetHeight || 100;
    const MARGIN = 8;
    const left = Math.min(x, windowW - mw - MARGIN);
    const top  = Math.min(y, windowH - mh - MARGIN);
    menu.style.left = `${Math.max(MARGIN, left)}px`;
    menu.style.top  = `${Math.max(MARGIN, top)}px`;

    // The panel should always visually grow outward from the cursor, even
    // when it had to be flipped to stay on screen — so derive the CSS
    // transform-origin (and a matching entrance slide direction) from
    // whether we actually clamped left/top above, rather than hardcoding
    // "top left" regardless of where the click happened.
    const flippedX = x > windowW - mw - MARGIN;
    const flippedY = y > windowH - mh - MARGIN;
    menu.style.setProperty('--ctx-ox', flippedX ? 'right' : 'left');
    menu.style.setProperty('--ctx-oy', flippedY ? 'bottom' : 'top');
    menu.style.setProperty('--ctx-slide-x', flippedX ? '6px' : '-6px');
    menu.style.setProperty('--ctx-slide-y', flippedY ? '6px' : '-6px');

    // Animate in
    menu.classList.remove('ctx-hide');
    void menu.offsetWidth;
    menu.classList.add('ctx-show');

    isVisible = true;

    // ROOT CAUSE of "right-clicking the URL bar loses focus/selection and
    // Paste silently does nothing": this used to unconditionally call
    // overlay.focus() here. For a PAGE's context menu that's correct and
    // necessary — the right-click happened in a different WebContents (the
    // tab's), so the overlay (which lives in the toolbar's own document)
    // has to be explicitly focused just to receive Escape/arrow-key
    // keydown events at all; it doesn't touch the page's own focused
    // element, which lives in a completely separate WebContents.
    //
    // But the URL bar's menu (isToolbar) is NOT in a different
    // WebContents — #ctx-menu-overlay and #address-bar live in the exact
    // same document (index.html / toolbarView). Focusing the overlay here
    // moved focus OFF #address-bar and onto a plain, non-editable <div>.
    // The address bar's selection/caret were still intact at that point
    // (blur doesn't clear an <input>'s selectionStart/selectionEnd, just
    // its visible highlight) — but main.js's context-menu:action handler
    // performs Cut/Copy/Paste/Select All by calling Electron's native
    // wc.cut()/copy()/paste()/selectAll() on the toolbar WebContents, and
    // those native edit commands act on whatever element is ACTUALLY
    // focused in that WebContents at the moment they run. With focus
    // moved to the overlay <div> (which isn't editable at all), paste had
    // nothing to insert into and silently did nothing; a second right
    // click+Copy after that could appear to "clear the selection" for the
    // same reason. The address bar was never actually losing its
    // selection — the menu itself was stealing the focus paste needed.
    //
    // Fix: never move focus for the toolbar's own menu — leave
    // #address-bar exactly as focused as the right-click left it, so
    // every action dispatched to the toolbar WebContents still lands on
    // it. Keyboard navigation inside the menu (Escape/arrows, handled
    // below) is wired at the window level specifically so it keeps
    // working without needing focus on the overlay either.
    overlay.tabIndex = -1;
    if (!currentIsToolbar) overlay.focus({ preventScroll: true });
  }

  function hideMenu() {
    showToken++; // cancel a show still waiting for the viewport
    if (!isVisible) return;
    isVisible = false;
    currentTabId = null;
    currentIsToolbar = false;
    menu.classList.remove('ctx-show');
    menu.classList.add('ctx-hide');
    overlay.setAttribute('aria-hidden', 'true');
    menu.addEventListener('animationend', () => {
      if (!isVisible) {
        overlay.style.display = 'none';
        menu.classList.remove('ctx-hide');
      }
    }, { once: true });
    window.browser.hideContextMenu();
  }

  // ---- Determine which actions to show ------------------------------------
  function buildItems(p) {
    const items = [];
    const sep = { type: 'sep' };

    // The URL bar's own right-click menu (toolbarView.webContents'
    // 'context-menu' listener in main.js, params.isToolbar) reuses this
    // exact function — same editFlags-driven Cut/Copy/Paste/Select All
    // logic as every tab's page/New-Tab-search-bar menu below — but none
    // of Back/Forward/Reload/Bookmark/Save Page/View Source/Inspect make
    // sense for the chrome's own address field, so render only the
    // applicable edit commands (plus Undo/Redo, which the address field
    // supports but ordinary page content generally does not expose
    // reliable editFlags for, so it's kept toolbar-only here).
    if (p.isToolbar) {
      const ef = p.editFlags || {};
      items.push(
        { label: 'Cut',  icon: 'cut',   action: 'cut',   payload: {}, disabled: !ef.canCut },
        { label: 'Copy', icon: 'copy',  action: 'copy',  payload: {}, disabled: !ef.canCopy },
        { label: 'Paste', icon: 'paste', action: 'paste', payload: {}, disabled: !ef.canPaste },
        { label: 'Select All', icon: 'select-all', action: 'select-all', payload: {}, disabled: !ef.canSelectAll },
        sep,
        { label: 'Undo', icon: 'undo', action: 'undo', payload: {}, disabled: !ef.canUndo },
        { label: 'Redo', icon: 'redo', action: 'redo', payload: {}, disabled: !ef.canRedo },
      );
      return items;
    }

    const isImage = p.mediaType === 'image';
    const isVideo = p.mediaType === 'video';
    const isAudio = p.mediaType === 'audio';
    const isLink  = Boolean(p.linkURL);
    const isEmpty = !isImage && !isLink && !p.selectionText && !isVideo && !isAudio;

    if (isLink) {
      items.push(
        { label: 'Open Link in New Tab',    icon: 'open-tab',   action: 'open-link-new-tab',   payload: { url: p.linkURL } },
        { label: 'Open Link in New Window', icon: 'open-win',   action: 'open-link-window',    payload: { url: p.linkURL } },
        sep,
        { label: 'Copy Link Address',       icon: 'copy',       action: 'copy-link',           payload: { url: p.linkURL } },
        { label: 'Bookmark Link',           icon: 'bookmark',   action: 'bookmark-page',       payload: { url: p.linkURL } },
      );
    }

    if (isImage) {
      if (items.length) items.push(sep);
      items.push(
        { label: 'Open Image in New Tab',  icon: 'open-tab', action: 'open-image-new-tab', payload: { url: p.srcURL } },
        { label: 'Save Image As…',         icon: 'save',     action: 'save-image',         payload: { url: p.srcURL } },
        { label: 'Copy Image',             icon: 'copy',     action: 'copy-image',         payload: { url: p.srcURL } },
        { label: 'Copy Image Address',     icon: 'copy',     action: 'copy-image-address', payload: { url: p.srcURL } },
      );
    }

    if (isVideo || isAudio) {
      if (items.length) items.push(sep);
      items.push(
        { label: `Open ${isVideo ? 'Video' : 'Audio'} in New Tab`, icon: 'open-tab', action: 'open-image-new-tab', payload: { url: p.srcURL } },
        { label: 'Copy Media Address', icon: 'copy', action: 'copy-image-address', payload: { url: p.srcURL } },
      );
    }

    // Edit commands — Electron already tells us (via editFlags) exactly
    // which of these are currently valid, same as it would for a native
    // menu. Copy and Paste are ALWAYS shown (greyed out via `disabled` when
    // not currently usable) so their position in the menu is predictable
    // and they're discoverable even when there's nothing to copy/paste yet.
    // Cut only ever makes sense inside an editable field, so — like the
    // original spec asked — it's still left out entirely everywhere else,
    // rather than shown greyed out on ordinary page text or empty space.
    // Select All keeps the same "only when relevant" behavior it always had.
    const ef = p.editFlags || {};
    const canCut = Boolean(ef.canCut) && p.isEditable;
    const canCopy = Boolean(ef.canCopy);
    const canPaste = Boolean(ef.canPaste) && p.isEditable;
    const canSelectAll = Boolean(ef.canSelectAll) && (p.isEditable || Boolean(p.selectionText));
    {
      if (items.length) items.push(sep);
      if (p.isEditable) {
        items.push({ label: 'Cut', icon: 'cut', action: 'cut', payload: {}, disabled: !canCut });
      }
      items.push({ label: 'Copy',  icon: 'copy',  action: 'copy',  payload: {}, disabled: !canCopy });
      items.push({ label: 'Paste', icon: 'paste', action: 'paste', payload: {}, disabled: !canPaste });
      if (canSelectAll) items.push({ label: 'Select All', icon: 'select-all', action: 'select-all', payload: {} });
    }

    if (isEmpty || (!isLink && !isImage)) {
      if (items.length) items.push(sep);
      items.push(
        { label: 'Back',    icon: 'back',    action: 'back',    payload: {}, disabled: !p.canGoBack },
        { label: 'Forward', icon: 'forward', action: 'forward', payload: {}, disabled: !p.canGoForward },
        { label: 'Reload',  icon: 'reload',  action: 'reload',  payload: {} },
        sep,
        // Settings/New Tab: the item stays visible (so the menu shape
        // doesn't jump around) but is disabled — the real restriction is
        // enforced in main.js's 'bookmark-page' handler (see
        // isRestrictedBookmarkUrl()); this just keeps the UI honest about it
        // up front instead of silently doing nothing on click.
        { label: 'Bookmark Page', icon: 'bookmark', action: 'bookmark-page', payload: { url: p.pageURL }, disabled: isHomeTabUrl(p.pageURL) || isSettingsTabUrl(p.pageURL) },
        { label: 'Save Page As…', icon: 'save',     action: 'save-page',    payload: {} },
      );
    }

    // View Source and Inspect always apply, regardless of what was clicked,
    // so they go last behind their own separator no matter which branches
    // above fired.
    if (items.length) items.push(sep);
    items.push(
      { label: 'View Page Source', icon: 'view-source', action: 'view-source', payload: {} },
      { label: 'Inspect', icon: 'inspect', action: 'inspect', payload: { x: p.elementX, y: p.elementY } },
    );

    return items;
  }

  // ---- Render items into the menu -----------------------------------------
  const ICONS = {
    'back':     `<svg viewBox="0 0 16 16"><path d="M12 8H4M7 5l-3 3 3 3"/></svg>`,
    'forward':  `<svg viewBox="0 0 16 16"><path d="M4 8h8M9 5l3 3-3 3"/></svg>`,
    'reload':   `<svg viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 1 1 9 2.7"/><path d="M9 1v3.5H12.5"/></svg>`,
    'open-tab': `<svg viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="10" height="9" rx="1.5"/><path d="M5 4V3A1.5 1.5 0 0 1 6.5 1.5H13A1.5 1.5 0 0 1 14.5 3v6.5A1.5 1.5 0 0 1 13 11h-1"/></svg>`,
    'open-win': `<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/><path d="M1.5 5h13"/><path d="M5 1.5V5"/></svg>`,
    'copy':     `<svg viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3A1.5 1.5 0 0 1 4.5 1.5H12"/></svg>`,
    'save':     `<svg viewBox="0 0 16 16"><path d="M8 1v9M4.5 7l3.5 3 3.5-3"/><path d="M1.5 11v2.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V11"/></svg>`,
    'bookmark': `<svg viewBox="0 0 16 16"><path d="M3.5 1.5h9a1 1 0 0 1 1 1V14l-5-3-5 3V2.5a1 1 0 0 1 1-1z"/></svg>`,
    'inspect':  `<svg viewBox="0 0 16 16"><rect x="1.5" y="2" width="9" height="12" rx="1.5"/><path d="M11 5.5l3.5 1.3-1.6.6 1.4 2.5-1.1.6-1.4-2.5-1 1.3z"/></svg>`,
    'cut':        `<svg viewBox="0 0 16 16"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M5.5 5.4 14 14M5.5 10.6 14 2"/></svg>`,
    'paste':      `<svg viewBox="0 0 16 16"><path d="M6 2h4a1 1 0 0 1 1 1v1H5V3a1 1 0 0 1 1-1z"/><rect x="3" y="3" width="10" height="11" rx="1.5"/><path d="M5.5 8h5M5.5 10.5h5"/></svg>`,
    'select-all': `<svg viewBox="0 0 16 16"><path d="M1.5 4.5V1.5h3M11.5 1.5h3v3M14.5 11.5v3h-3M4.5 14.5h-3v-3"/></svg>`,
    'view-source': `<svg viewBox="0 0 16 16"><path d="M5.5 3.5 1.5 8l4 4.5M10.5 3.5 14.5 8l-4 4.5"/></svg>`,
    'undo': `<svg viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 0 0 4 4.7"/><path d="M1.5 1v3.7H5.2"/></svg>`,
    'redo': `<svg viewBox="0 0 16 16"><path d="M2.5 8A5.5 5.5 0 0 1 12 4.7"/><path d="M14.5 1v3.7H10.8"/></svg>`,
  };

  // Visual hierarchy: the action someone's most likely reaching for in a
  // given context (open it, reload it, bookmark it) gets accented so the
  // eye finds it first; deep/power-user actions (View Source, Inspect) are
  // pushed back visually so they don't compete with everyday ones. Purely
  // cosmetic — does not change which actions are shown or how they behave.
  const PRIMARY_ACTIONS = new Set(['open-link-new-tab', 'open-image-new-tab', 'reload', 'bookmark-page']);
  const SECONDARY_ACTIONS = new Set(['view-source', 'inspect']);

  // Keyboard shortcut hints for the standard edit commands, shown
  // right-aligned like a native menu. Mac gets the conventional ⌘ glyphs;
  // everywhere else gets Ctrl, matching Gloza's actual accelerators.
  const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform || navigator.userAgent || '');
  const SHORTCUTS = isMac
    ? { cut: '⌘X', copy: '⌘C', paste: '⌘V', 'select-all': '⌘A', undo: '⌘Z', redo: '⇧⌘Z' }
    : { cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', 'select-all': 'Ctrl+A', undo: 'Ctrl+Z', redo: 'Ctrl+Y' };

  function renderItems(items) {
    menu.innerHTML = '';
    for (const item of items) {
      if (item.type === 'sep') {
        const hr = document.createElement('div');
        hr.className = 'ctx-sep';
        menu.appendChild(hr);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item';
      if (PRIMARY_ACTIONS.has(item.action)) btn.classList.add('ctx-item-primary');
      if (SECONDARY_ACTIONS.has(item.action)) btn.classList.add('ctx-item-secondary');
      btn.setAttribute('role', 'menuitem');
      if (item.disabled) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      }
      const iconHtml = ICONS[item.icon] || ICONS['copy'];
      const shortcut = SHORTCUTS[item.action];
      const shortcutHtml = shortcut ? `<span class="ctx-shortcut">${shortcut}</span>` : '';
      btn.innerHTML = `<span class="ctx-icon" aria-hidden="true">${iconHtml}</span><span class="ctx-label">${item.label}</span>${shortcutHtml}`;
      // BUG FIX (URL bar's Cut/Copy/Paste/Select All doing nothing when
      // clicked, while the same actions work fine from the keyboard):
      // clicking a <button> natively moves DOM focus onto that button the
      // instant the mouse goes down — before our own 'click' handler below
      // even runs. For every OTHER menu (a tab's page, New Tab's search
      // bar...) that's harmless: the menu lives in the toolbar's own
      // WebContents, a completely different one from the page being acted
      // on, so which element has focus *inside the toolbar* doesn't affect
      // main.js's wc.cut()/copy()/paste()/selectAll() calls on the PAGE's
      // WebContents at all.
      // But the URL bar's own menu (isToolbar) is the one case where the
      // menu and the thing being edited (#address-bar) live in the SAME
      // WebContents — see the long comment on showMenu() above about why
      // it skips overlay.focus() for exactly this reason. Still, the
      // browser's own native "focus follows mousedown" behavior on a
      // <button> happens regardless of any of our own focus() calls, so it
      // silently moved focus off #address-bar and onto the Copy/Paste/etc.
      // button itself — and main.js's edit commands act on whatever
      // element is ACTUALLY focused at the moment they run, same as a real
      // keyboard shortcut would, so Paste had nothing editable to act on.
      // preventDefault() on mousedown stops a <button> from taking focus on
      // click at all (the 'click' event — and this handler — still fires
      // normally afterwards), so #address-bar's focus/selection survive
      // untouched all the way through the action actually running.
      btn.addEventListener('mousedown', (event) => { event.preventDefault(); });
      btn.addEventListener('click', () => {
        // Capture tabId BEFORE hideMenu() runs — hideMenu() resets
        // currentTabId to null, so reading it afterwards always sent
        // `tabId: null` to main.js and silently no-opped every action.
        const tabId = currentTabId;
        const isToolbar = currentIsToolbar;
        hideMenu();
        window.browser.contextMenuAction(item.action, {
          ...item.payload,
          tabId,
          isToolbar,
        });
      });
      menu.appendChild(btn);
    }
  }

  // ---- Keyboard navigation ------------------------------------------------
  function moveFocus(delta) {
    if (!menuItems.length) return;
    focusedIndex = (focusedIndex + delta + menuItems.length) % menuItems.length;
    // Skip disabled items
    let tries = menuItems.length;
    while (menuItems[focusedIndex]?.disabled && tries-- > 0) {
      focusedIndex = (focusedIndex + delta + menuItems.length) % menuItems.length;
    }
    menuItems[focusedIndex]?.focus();
  }

  // Window-level (capturing), not overlay-level: for the toolbar's own menu
  // (isToolbar), focus deliberately stays on #address-bar instead of moving
  // to the overlay (see the big comment in showMenu() above) — an
  // overlay-only listener would never see those keydowns at all since they
  // never reach the overlay element. Capturing also means Home/End/Arrows
  // are claimed by menu navigation before the address bar's own keydown
  // handler (which normally uses them for caret/dropdown movement) sees
  // them — correct while a menu is actually open and intercepted; the
  // isVisible guard below means this does nothing at any other time.
  window.addEventListener('keydown', (e) => {
    if (!isVisible) return;
    switch (e.key) {
      case 'Escape':  e.preventDefault(); hideMenu(); break;
      case 'ArrowDown': e.preventDefault(); moveFocus(1); break;
      case 'ArrowUp':   e.preventDefault(); moveFocus(-1); break;
      case 'Home':    e.preventDefault(); focusedIndex = -1; moveFocus(1); break;
      case 'End':     e.preventDefault(); focusedIndex = menuItems.length; moveFocus(-1); break;
    }
  }, true);

  // ---- Outside click dismissal --------------------------------------------
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) hideMenu();
  });

  // ---- IPC ----------------------------------------------------------------
  window.browser.onContextMenu((info) => showMenu(info));
  // main.js may also push a hide event (e.g. a new context-menu replaces old)
  if (window.browser.onHideContextMenu) {
    window.browser.onHideContextMenu(hideMenu);
  }
})();

// ---------------------------------------------------------------------------
// Generic slide-out panel helper — shared by the tab-list / downloads /
// browser-menu panels so they all belong to the same animation family (see
// .panel-overlay / .panel in styles.css: consistent easing, motion
// direction, opacity + subtle scale, no abrupt show/hide). Each panel is
// anchored under the button that opens it and closes on an outside click,
// Escape, or opening a different panel.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Toolbar-surface claims (shared by the panel family, the local bookmark
// menu, the address dropdown, and the bookmark/prompt modals below).
//
// ROOT CAUSE of "the New Folder dialog flashes open then collapses to a
// tiny strip at the top of the screen": every one of those features
// independently calls window.browser.expandPanelSurface() /
// collapsePanelSurface() around main.js's single shared toolbar view (see
// expandToolbarForMenu/collapseToolbarAfterMenu there), but each one only
// checked its OWN tracking (openPanels.size, isLocalMenuOpen,
// addressDropdownOpen) before deciding it was safe to collapse. Opening a
// folder-creation dialog from the bookmark-bar right-click menu goes
// through TWO of these in a row — closeLocalMenu() (to dismiss the right-
// click menu) immediately followed by openBookmarkModal() (to show the
// dialog) — and closeLocalMenu()'s own collapse is deferred behind its
// close animation (~120ms). By the time that deferred collapse actually
// fires, the dialog has already expanded the surface again — but since
// local-menu's check only knew about ITS OWN state (already closed) and
// `openPanels` (unrelated to either the local menu or the modal), it saw
// nothing stopping it and shrank the shared toolbar view back down anyway,
// right out from under the now-open, now-centered dialog. The dialog
// itself never moved — it just lost the full-window surface it needs to
// render on, so only the sliver of it inside the collapsed toolbar strip
// remained visible: exactly the reported "tiny menu at the top".
//
// Fix: route every claim through one shared Set, the same pattern already
// used for the main-process side of this exact problem (see
// expandToolbarForMenu's `surfaceOwners`). The surface expands on the
// first claim and only actually collapses once EVERY claimant — panels,
// local menu, address dropdown, modal — has released it, regardless of
// which one claimed first or releases last.
const surfaceClaims = new Set();
// Size of the full-window surface as reported by the main process, and a
// promise that resolves once this page's viewport has ACTUALLY grown to it.
// Every menu used to position itself from window.innerHeight after a fixed
// two-requestAnimationFrame guess; if the native resize hadn't been
// delivered yet, innerHeight was still the ~96px toolbar strip, the clamp
// pinned the menu near the top of the screen, and it only landed in the
// right place (or didn't) later — the "appears too high then jumps" bug.
let surfaceSize = null;
let surfaceReady = Promise.resolve();
let lastSurfaceChangeAt = 0;
let lastInnerW = window.innerWidth;

function viewportSize() {
  return surfaceClaims.size && surfaceSize
    ? { w: surfaceSize.width, h: surfaceSize.height }
    : { w: window.innerWidth, h: window.innerHeight };
}

function waitForViewport(size) {
  return new Promise((resolve) => {
    const ok = () => !size || (window.innerHeight >= size.height - 1 && window.innerWidth >= size.width - 1);
    if (ok()) { resolve(); return; }
    const done = () => { window.removeEventListener('resize', check); clearTimeout(timer); resolve(); };
    const check = () => { if (ok()) done(); };
    const timer = setTimeout(done, 400); // never hang a menu open on this
    window.addEventListener('resize', check);
  });
}

// Returns a promise resolving when the surface is expanded AND this page
// has been resized to fill it. Safe to call by every claimant.
function claimSurface(id) {
  const wasEmpty = surfaceClaims.size === 0;
  surfaceClaims.add(id);
  if (wasEmpty) {
    lastSurfaceChangeAt = performance.now();
    surfaceReady = Promise.resolve(window.browser.expandPanelSurface())
      .then((size) => { surfaceSize = size; return waitForViewport(size); })
      .then(() => { lastSurfaceChangeAt = performance.now(); });
  }
  return surfaceReady;
}
function releaseSurface(id) {
  surfaceClaims.delete(id);
  if (surfaceClaims.size === 0) {
    lastSurfaceChangeAt = performance.now();
    surfaceReady = Promise.resolve();
    surfaceSize = null;
    window.browser.collapsePanelSurface();
  }
}

const openPanels = new Map(); // overlayEl -> { anchor }

function closePanel(overlay) {
  if (!openPanels.has(overlay)) return;
  openPanels.delete(overlay);
  const panel = overlay.querySelector('.panel');
  panel.classList.remove('panel-show');
  panel.classList.add('panel-hide');
  overlay.setAttribute('aria-hidden', 'true');
  const anchorBtn = overlay._anchorBtn;
  if (anchorBtn) anchorBtn.setAttribute('aria-expanded', 'false');
  panel.addEventListener('animationend', () => {
    if (!openPanels.has(overlay)) {
      overlay.classList.remove('panel-overlay-open');
      // Release this family's claim on the shared toolbar surface once
      // every panel in it is closed. See the surfaceClaims comment above —
      // this no longer blindly collapses the surface, since the local
      // menu, address dropdown, or a modal may have since claimed it.
      if (openPanels.size === 0) releaseSurface('panels');
    }
  }, { once: true });
}

function closeAllPanels(except) {
  for (const overlay of openPanels.keys()) {
    if (overlay !== except) closePanel(overlay);
  }
}

// Position the (already-visible, already full-window-sized) panel under its
// anchor button and animate it in. Split out from openPanel() so it can run
// a frame after the toolbar view has actually finished growing to cover the
// window — see openPanel for why that matters.
function placeAndShowPanel(overlay, panel, anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  const margin = 10;
  panel.style.visibility = 'hidden';
  panel.style.left = '0px';
  panel.style.top = '0px';
  void panel.offsetWidth;
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const { w: winW, h: winH } = viewportSize();
  let left = Math.min(rect.right - pw, winW - pw - margin);
  left = Math.max(margin, left);
  let top = rect.bottom + 8;
  top = Math.min(top, Math.max(margin, winH - ph - margin));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.visibility = '';

  const flippedX = rect.right - pw < margin;
  panel.style.setProperty('--panel-ox', flippedX ? 'left' : 'right');

  void panel.offsetWidth;
  panel.classList.add('panel-show');
  overlay.setAttribute('aria-hidden', 'false');
  anchorBtn.setAttribute('aria-expanded', 'true');
}

// ROOT CAUSE of "menus flash open and immediately close": window:'resize'
// below closes every open panel — correct for a real, user-driven window
// resize/maximize. But expandPanelSurface() just below grows the toolbar
// WebContentsView to cover the full window (same trick the context menu
// uses — see expandToolbarForMenu in main.js), and THAT bounds change
// itself fires a native 'resize' event on this very page a moment later
// (window.innerWidth/innerHeight jumping from the thin toolbar strip to
// the full window). The resize listener had no way to tell that apart from
// an actual window resize, so it was closing the panel we had just opened,
// often before placeAndShowPanel() even got to show it — hence the flash.
// Fix: flag the one resize we expect our own expandPanelSurface() call to
// produce and swallow exactly that one in the listener below, instead of
// disabling or delaying the listener itself (which would also mask real
// resizes while a panel is open).

function openPanel(overlay, anchorBtn) {
  window.browser.hideContextMenu(); // the two overlay families never coexist
  if (typeof closeLocalMenu === 'function') closeLocalMenu();
  if (typeof closeAddressDropdown === 'function' && overlay.id !== 'address-dropdown-overlay') closeAddressDropdown();
  const wasAnyOpen = openPanels.size > 0;
  closeAllPanels(overlay);
  const panel = overlay.querySelector('.panel');
  overlay._anchorBtn = anchorBtn;

  overlay.classList.add('panel-overlay-open');
  panel.classList.remove('panel-hide');
  openPanels.set(overlay, { anchor: anchorBtn });

  if (wasAnyOpen) {
    // The toolbar view is already expanded for the panel we're replacing —
    // position immediately, no need to wait on a resize round-trip.
    placeAndShowPanel(overlay, panel, anchorBtn);
    return;
  }

  // Don't show until the surface has really finished growing — the panel
  // is placed against the real full-window size, so its very first visible
  // frame is already at its final position.
  claimSurface('panels').then(() => {
    // Fast open-then-close / switch-to-another-panel guard: only show if this
    // overlay is still the current owner of the panel.
    if (openPanels.get(overlay)?.anchor !== anchorBtn) return;
    placeAndShowPanel(overlay, panel, anchorBtn);
  });
}

function togglePanel(overlay, anchorBtn) {
  if (openPanels.has(overlay)) closePanel(overlay);
  else openPanel(overlay, anchorBtn);
}

document.addEventListener('pointerdown', (event) => {
  for (const overlay of Array.from(openPanels.keys())) {
    const panel = overlay.querySelector('.panel');
    const anchor = overlay._anchorBtn;
    if (panel.contains(event.target) || event.target === anchor || anchor?.contains(event.target)) continue;
    // Don't close a panel (e.g. the tab-list popup) out from under a local
    // right-click context menu that was deliberately opened on top of it
    // (see openTabContextMenu's keepOverlay / openLocalMenu above) — only a
    // click genuinely outside BOTH should dismiss it. Once the local menu
    // itself closes, localMenuKeptOverlay is cleared and this no longer
    // applies, so a click elsewhere still closes the panel as normal.
    if (isLocalMenuOpen && localMenuKeptOverlay === overlay &&
        ($('#bm-menu').contains(event.target) || $('#bm-submenu').contains(event.target))) {
      continue;
    }
    closePanel(overlay);
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openPanels.size) closeAllPanels();
});
window.addEventListener('resize', () => {
  // The toolbar view grows/shrinks (height only) whenever a menu opens or
  // closes; that must not close the menu that caused it. A real window
  // resize changes the width (maximize/restore/drag), or arrives outside
  // the short window around one of our own surface changes.
  const widthChanged = window.innerWidth !== lastInnerW;
  lastInnerW = window.innerWidth;
  if (!widthChanged && (surfaceClaims.size || performance.now() - lastSurfaceChangeAt < 500)) return;
  closeAllPanels();
});


// ---------------------------------------------------------------------------
// Bookmarks: toolbar (with folders), right-click menus, drag-and-drop, the
// creation/edit dialog, and the star button.
//
// bookmarksState is now a TREE (see main.js): each node is either
//   { id, type:'bookmark', title, url, favicon }
//   { id, type:'folder', title, children:[Node,...] }
// with the root array itself being the bookmarks toolbar's own contents.
// ---------------------------------------------------------------------------

// Depth-first search for a node by id anywhere in the current tree.
function findBookmarkNodeLocal(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    if (n.type === 'folder') {
      const found = findBookmarkNodeLocal(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

// Every folder in the tree (root included, as `id:null`), each tagged with
// its display depth — used to build the destination picker and the
// "Move to Folder…" menu. Returns [{ id, title, depth, children }].
function collectFoldersInner(nodes, depth, out) {
  for (const n of nodes) {
    if (n.type === 'folder') {
      out.push({ id: n.id, title: n.title, depth, children: n.children });
      collectFoldersInner(n.children, depth + 1, out);
    }
  }
}
function allFolders() {
  const root = [{ id: null, title: 'Bookmarks Toolbar', depth: 0, children: bookmarksState }];
  collectFoldersInner(bookmarksState, 1, root);
  return root;
}

function bmChipIcon(node) {
  const icon = document.createElement('span');
  icon.className = 'bm-icon';
  if (node.type === 'folder') {
    icon.appendChild(createIcon('folder'));
    return icon;
  }
  if (node.favicon) {
    const img = document.createElement('img');
    img.src = node.favicon;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => { img.remove(); icon.appendChild(createIcon('globe')); });
    icon.appendChild(img);
  } else {
    icon.appendChild(createIcon('globe'));
  }
  return icon;
}

// Mirrors main.js's isHomeUrl(): true for our own new-tab page (home.html),
// false for a settings tab or any real website — used by the "Show Only on
// New Tab" bookmarks-bar mode.
function isHomeTabUrl(url) {
  return typeof url === 'string' && /\/home\.html(\?.*)?$/.test(url);
}

// Settings-favicon fix: the three spots that pick a fallback icon for an
// internal page (tab strip, address bar, tab-list overlay) used to test
// only isInternalUrl() and always draw the Gloza mark — correct for
// home.html, wrong for settings.html, which should show a gear like every
// other settings surface does. Same shape/pattern as isHomeTabUrl() above,
// checked at the one place (iconNameForUrl, below) that now feeds all
// three call sites, so fixing it here fixes it everywhere at once instead
// of patching each render function separately.
function isSettingsTabUrl(url) {
  return typeof url === 'string' && /\/settings\.html(\?.*)?$/.test(url);
}

// Single source of truth for "what fallback icon represents this URL" —
// used by the tab strip, the address bar, and the tab-list overlay so the
// mapping only has to be right in one place.
function iconNameForUrl(url) {
  if (isSettingsTabUrl(url)) return 'settings';
  if (isInternalUrl(url)) return 'gloza';
  return 'globe';
}

// Actually controls whether the bookmarks bar is shown, per the current
// bookmarksBarMode (persisted pref) and — for 'new-tab-only' — whether the
// active tab is the new-tab page right now. Called whenever the bookmark
// tree changes (renderBookmarksBar), the active tab/its URL changes
// (onTabsUpdated below), or the mode itself changes (applyPrefs above).
function updateBookmarksBarVisibility() {
  const bar = $('#bookmarks-bar');
  if (!bar) return;
  if (bookmarksState.length === 0) { bar.hidden = true; return; }
  if (bookmarksBarMode === 'never') { bar.hidden = true; return; }
  if (bookmarksBarMode === 'new-tab-only') {
    const active = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
    bar.hidden = !(active && isHomeTabUrl(active.url));
    return;
  }
  bar.hidden = false; // 'always'
}

function renderBookmarksBar() {
  const bar = $('#bookmarks-bar');
  bar.innerHTML = '';
  for (const node of bookmarksState) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bm-chip';
    chip.dataset.bmId = String(node.id);
    chip.title = node.type === 'folder' ? node.title : node.url;

    chip.appendChild(bmChipIcon(node));
    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = node.title || (node.type === 'bookmark' ? node.url : 'Folder');
    chip.appendChild(label);

    if (node.type === 'folder') {
      chip.classList.add('bm-folder');
      chip.setAttribute('aria-haspopup', 'true');
      chip.setAttribute('aria-expanded', 'false');
      chip.appendChild(createIcon('forward', 'bm-caret'));
      chip.addEventListener('click', () => {
        if (suppressNextBmClick) { suppressNextBmClick = false; return; }
        toggleBookmarkFolderPanel(node, chip);
      });
    } else {
      chip.addEventListener('click', () => {
        if (suppressNextBmClick) { suppressNextBmClick = false; return; }
        window.browser.navigate(tabsState.activeTabId, node.url);
      });
    }

    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openBookmarkContextMenu(node, null, event.clientX, event.clientY);
    });

    chip.addEventListener('pointerdown', (event) => beginBookmarkDrag(event, chip, node, null));

    bar.appendChild(chip);
  }
  updateBookmarksBarVisibility();
  layoutBookmarksBar();
}

// ---------------------------------------------------------------------------
// Bookmarks-bar overflow: when the toolbar can't fit every top-level chip,
// the tail of the bar (the chips that don't fit, in their real order) is
// hidden (display:none — never removed from the DOM/data, so nothing is
// duplicated) and exposed instead through a small overflow button at the
// end of the bar. The overflow button's dropdown reuses the exact same
// folder-popup machinery as a real bookmark folder (renderFolderPanelBody /
// #bm-folder-overlay) via a synthetic, non-persisted "folder" node — so
// favicons, nested folders, the context menu, and drag-and-drop all keep
// working inside it for free.
// ---------------------------------------------------------------------------
const BM_OVERFLOW_ID = '__gloza_bm_overflow__';
let bmOverflowNodes = [];
function overflowFolderNode() {
  return { id: BM_OVERFLOW_ID, type: 'folder', title: 'More Bookmarks', children: bmOverflowNodes };
}

function layoutBookmarksBar() {
  const bar = $('#bookmarks-bar');
  if (!bar) return;
  const prevBtn = bar.querySelector('.bm-overflow-btn');
  // layoutBookmarksBar() rebuilds the overflow button from scratch every
  // call, so if it was the anchor for a currently-open overflow panel,
  // re-point the panel at whatever button replaces it below — otherwise
  // the panel would keep a reference to a now-detached element, breaking
  // its position and making the very next outside-click (even one on the
  // brand-new button) look like a click "outside" and close it.
  const folderOverlay = $('#bm-folder-overlay');
  const wasAnchor = Boolean(prevBtn) && folderOverlay._anchorBtn === prevBtn;
  if (prevBtn) prevBtn.remove();

  const chips = Array.from(bar.querySelectorAll('.bm-chip'));
  chips.forEach((c) => { c.style.display = ''; });

  if (!chips.length || bar.hidden) {
    const changed = bmOverflowNodes.length !== 0;
    bmOverflowNodes = [];
    if (wasAnchor) closePanel(folderOverlay);
    else if (changed) refreshOpenOverflowPanel();
    return;
  }

  const styles = getComputedStyle(bar);
  const gap = parseFloat(styles.columnGap || styles.gap) || 6;
  const available = bar.clientWidth;
  const OVERFLOW_BTN_W = 30;

  // First pass: how many chips fit at full width, no button reserved.
  let used = 0;
  let fitCount = chips.length;
  for (let i = 0; i < chips.length; i++) {
    used += chips[i].offsetWidth + (i > 0 ? gap : 0);
    if (used > available) { fitCount = i; break; }
  }

  if (fitCount >= chips.length) {
    // Everything fits — no overflow button needed.
    const changed = bmOverflowNodes.length !== 0;
    bmOverflowNodes = [];
    if (wasAnchor) closePanel(folderOverlay);
    else if (changed) refreshOpenOverflowPanel();
    return;
  }

  // Second pass: some chips must be hidden, so re-walk leaving room for the
  // overflow button itself.
  used = 0;
  let cutoff = 0;
  for (let i = 0; i < chips.length; i++) {
    const w = chips[i].offsetWidth + (i > 0 ? gap : 0);
    if (used + w + gap + OVERFLOW_BTN_W > available) break;
    used += w;
    cutoff = i + 1;
  }

  for (let i = cutoff; i < chips.length; i++) chips[i].style.display = 'none';

  const prevOverflowIds = bmOverflowNodes.map((n) => n.id).join(',');
  bmOverflowNodes = bookmarksState.slice(cutoff);
  const newOverflowIds = bmOverflowNodes.map((n) => n.id).join(',');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bm-chip bm-overflow-btn';
  btn.title = 'More bookmarks';
  btn.setAttribute('aria-label', 'More bookmarks');
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', openPanels.has($('#bm-folder-overlay')) && currentFolderPanelId === BM_OVERFLOW_ID ? 'true' : 'false');
  btn.appendChild(createIcon('chevron-down'));
  btn.addEventListener('click', () => toggleBookmarkFolderPanel(overflowFolderNode(), btn));
  btn.addEventListener('contextmenu', (event) => event.preventDefault());
  bar.appendChild(btn);

  if (prevOverflowIds !== newOverflowIds) refreshOpenOverflowPanel();

  if (wasAnchor) {
    folderOverlay._anchorBtn = btn;
    const entry = openPanels.get(folderOverlay);
    if (entry) entry.anchor = btn;
    btn.setAttribute('aria-expanded', 'true');
    // Re-render (if needed) happens above, before this measures/positions
    // the panel, so a changed overflow count can't leave it sized for
    // stale content.
    if (openPanels.has(folderOverlay)) placeAndShowPanel(folderOverlay, folderOverlay.querySelector('.panel'), btn);
  }
}

// If the overflow dropdown (or a subfolder reached through it) is currently
// open, keep it in sync with the freshly recomputed overflow contents
// instead of letting it go stale or silently point at removed bookmarks.
function refreshOpenOverflowPanel() {
  if (!openPanels.has($('#bm-folder-overlay'))) return;
  if (currentFolderPanelId === BM_OVERFLOW_ID) {
    if (bmOverflowNodes.length) renderFolderPanelBody(overflowFolderNode());
    else closePanel($('#bm-folder-overlay'));
  }
}

new ResizeObserver(() => layoutBookmarksBar()).observe($('#bookmarks-bar'));

window.browser.onBookmarksUpdated((tree) => {
  bookmarksState = tree || [];
  renderBookmarksBar();
  renderToolbar();
  if (openPanels.has($('#bm-folder-overlay')) && currentFolderPanelId != null) {
    if (currentFolderPanelId === BM_OVERFLOW_ID) {
      // layoutBookmarksBar() (called from renderBookmarksBar() above) has
      // already recomputed bmOverflowNodes and refreshed this panel.
    } else {
      const node = findBookmarkNodeLocal(bookmarksState, currentFolderPanelId);
      if (node) renderFolderPanelBody(node);
      else closePanel($('#bm-folder-overlay'));
    }
  }
  if (openPanels.has($('#bookmarks-manager-overlay'))) renderBookmarksManagerPanel();
});

$('#bookmark-btn').addEventListener('click', () => {
  if (tabsState.activeTabId == null) return;
  const active = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
  if (!active) return;
  const existing = findBookmarkByUrlLocal(bookmarksState, active.url);
  if (existing) {
    openBookmarkDialog({ mode: 'edit', node: existing });
  } else {
    openBookmarkDialog({ mode: 'create', title: active.title, url: active.url, favicon: active.favicon });
  }
});

function findBookmarkByUrlLocal(nodes, url) {
  for (const n of nodes || []) {
    if (n.type === 'bookmark' && n.url === url) return n;
    if (n.type === 'folder') {
      const found = findBookmarkByUrlLocal(n.children, url);
      if (found) return found;
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Folder popup (click a folder chip on the bookmark bar, or a sub-folder row
// inside an already-open folder popup — breadcrumb lets you go back up).
// ---------------------------------------------------------------------------
let currentFolderPanelId = null;
let folderPanelStack = []; // [{id, title}] breadcrumb trail, root excluded

function renderFolderPanelBody(folderNode) {
  currentFolderPanelId = folderNode.id;
  $('#bm-folder-title').textContent = folderNode.title;
  const body = $('#bm-folder-body');
  body.innerHTML = '';

  if (folderPanelStack.length) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'tl-row';
    back.appendChild(createIcon('back', 'tl-icon'));
    const lbl = document.createElement('span');
    lbl.className = 'tl-label';
    lbl.textContent = 'Back';
    back.appendChild(lbl);
    back.addEventListener('click', () => {
      // The entry we just popped off IS the folder Back should return to —
      // it was pushed right when we navigated AWAY from it (see the folder
      // row's click handler below: `folderPanelStack.push({id: folderNode.id,
      // ...})` pushes the folder you're leaving, not the one you're
      // entering). The previous version read the stack's new top AFTER
      // popping instead, which is one level further up (that folder's own
      // parent) — so Back always overshot by one level, and from anywhere
      // more than one level deep in the overflow menu it looked like Back
      // was dumping you straight out to the top-level menu instead of
      // stepping up one folder at a time.
      const prevEntry = folderPanelStack.pop();
      const prevId = prevEntry ? prevEntry.id : null;
      const prevNode = prevId === BM_OVERFLOW_ID
        ? overflowFolderNode()
        : prevId == null
          ? { id: null, title: 'Bookmarks Toolbar', type: 'folder', children: bookmarksState }
          : findBookmarkNodeLocal(bookmarksState, prevId);
      if (prevNode) renderFolderPanelBody(prevNode);
    });
    body.appendChild(back);
  }

  if (!folderNode.children.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'This folder is empty';
    body.appendChild(empty);
    return;
  }

  for (const node of folderNode.children) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tl-row';
    row.dataset.bmId = String(node.id);

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tl-icon';
    iconWrap.appendChild(bmChipIcon(node).firstChild);
    row.appendChild(iconWrap);

    const label = document.createElement('span');
    label.className = 'tl-label';
    label.textContent = node.title || (node.url || 'Folder');
    row.appendChild(label);

    if (node.type === 'folder') {
      row.appendChild(createIcon('forward', 'bm-caret'));
      row.addEventListener('click', () => {
        if (suppressNextBmClick) { suppressNextBmClick = false; return; }
        folderPanelStack.push({ id: folderNode.id, title: folderNode.title });
        renderFolderPanelBody(node);
      });
    } else {
      row.addEventListener('click', () => {
        if (suppressNextBmClick) { suppressNextBmClick = false; return; }
        window.browser.navigate(tabsState.activeTabId, node.url);
        closePanel($('#bm-folder-overlay'));
      });
    }
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      // Keep the folder popup itself open underneath the context menu —
      // true regardless of whether this row happens to be showing the
      // synthetic root ("Bookmarks Toolbar", id null) via the breadcrumb
      // Back button, so don't key this off folderNode.id.
      openBookmarkContextMenu(node, folderNode.id, event.clientX, event.clientY, $('#bm-folder-overlay'));
    });
    // folderNode.id is null for the real toolbar root — reuse that same
    // (parentId === null) convention for the synthetic overflow root, since
    // overflowing bookmarks are still, underneath, root-level toolbar
    // bookmarks. Only the overflow root's container shows a partial subset
    // of its parent's real children, so only it needs orderPrefix.
    const dragParentId = folderNode.id === BM_OVERFLOW_ID ? null : folderNode.id;
    const dragOpts = {
      container: body,
      itemSelector: '.tl-row[data-bm-id]',
      orientation: 'vertical',
    };
    if (folderNode.id === BM_OVERFLOW_ID) {
      dragOpts.orderPrefix = bookmarksState
        .slice(0, bookmarksState.length - bmOverflowNodes.length)
        .map((n) => n.id);
    }
    row.addEventListener('pointerdown', (event) => beginBookmarkDrag(event, row, node, dragParentId, dragOpts));
    body.appendChild(row);
  }
}

function toggleBookmarkFolderPanel(node, chip) {
  const overlay = $('#bm-folder-overlay');
  const wasOpenForThis = openPanels.has(overlay) && currentFolderPanelId === node.id;
  document.querySelectorAll('.bm-chip[aria-expanded="true"]').forEach((el) => el.setAttribute('aria-expanded', 'false'));
  if (wasOpenForThis) {
    closePanel(overlay);
    return;
  }
  folderPanelStack = [];
  renderFolderPanelBody(node);
  chip.setAttribute('aria-expanded', 'true');
  openPanel(overlay, chip);
}


// ---------------------------------------------------------------------------
// Right-click context menus: bookmark bar empty space / a bookmark / a
// folder. Built dynamically and shown in the shared #bm-menu element (same
// visual language as the page's #ctx-menu — see openLocalMenu).
// ---------------------------------------------------------------------------
// `keepOverlay`, when given, is left open by closeAllPanels() — used so
// right-clicking a bookmark INSIDE an already-open folder popup doesn't
// close that folder popup out from under the context menu it's opening
// (see openBookmarkContextMenu below, and the "nested bookmark menus
// closing and flickering" fix it's part of).
// ---- Async-open race guard (same fix as home.js's openBookmarkMenu /
// openSubmenu — see HANDOFF-move-menu-freeze-fix.md) -----------------------
// Positioning here happens inside an async step (claimSurface()'s promise
// for the local menu, requestAnimationFrame for the submenu) so it runs
// *after* the pointerenter/click handler that triggered it has returned.
// If the menu/submenu was opened and then closed again before that async
// step ran (e.g. the pointer grazed a different row while crossing from
// "Move" toward its submenu), the stale callback would still fire later and
// unconditionally reopen a menu/submenu that's no longer current, leaving
// the full-viewport overlay marked open while nothing was actually shown or
// positioned — reads as the menu "freezing" / siblings no longer
// highighting or closing the submenu on hover. Every open() mints a token
// that its async callback checks before touching the DOM/state; every
// close() bumps the token so a superseded callback becomes a no-op.
let menuOpenToken = 0;
let submenuOpenToken = 0;

// Leaving a non-submenu row no longer closes an open submenu immediately;
// it schedules a short close, cancelled if the pointer reaches the submenu
// itself or re-enters the row that opened it. This matches the bookmark
// toolbar's own "Move" row and lets the pointer travel diagonally from
// "Move" into its submenu without the submenu vanishing mid-transit.
let submenuCloseTimer = null;
function scheduleCloseSubmenu() {
  if (submenuCloseTimer) return;
  submenuCloseTimer = setTimeout(() => {
    submenuCloseTimer = null;
    closeSubmenu();
  }, 200);
}
function cancelScheduledSubmenuClose() {
  if (submenuCloseTimer) { clearTimeout(submenuCloseTimer); submenuCloseTimer = null; }
}

function openLocalMenu(items, clientX, clientY, keepOverlay) {
  const overlay = $('#bm-menu-overlay');
  const menu = $('#bm-menu');
  closeAllPanels(keepOverlay);
  window.browser.hideContextMenu();
  closeSubmenu();
  // Remember which panel (if any) this local menu was deliberately opened
  // on top of, so the panel's own click-outside handler (below) can tell a
  // click on THIS menu apart from a genuine click outside both — see its
  // use in the document pointerdown listener further down.
  localMenuKeptOverlay = keepOverlay || null;

  menu.innerHTML = '';
  for (const item of items) {
    if (item.type === 'sep') {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      menu.appendChild(hr);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item';
    btn.setAttribute('role', item.submenu ? 'menuitem' : 'menuitem');
    if (item.disabled) btn.disabled = true;
    if (item.danger) btn.classList.add('ctx-item-secondary');
    if (item.checked) btn.classList.add('ctx-item-checked');
    const iconSpan = document.createElement('span');
    iconSpan.className = 'ctx-icon';
    iconSpan.appendChild(createIcon(item.checked ? 'check' : (item.icon || 'file')));
    const labelSpan = document.createElement('span');
    labelSpan.className = 'ctx-label';
    labelSpan.textContent = item.label;
    btn.append(iconSpan, labelSpan);

    if (item.submenu) {
      const arrow = document.createElementNS(SVG_NS, 'svg');
      arrow.setAttribute('class', 'ctx-item-arrow');
      arrow.setAttribute('viewBox', '0 0 16 16');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M5 2.5 10.5 8 5 13.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.8');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      arrow.appendChild(path);
      btn.appendChild(arrow);
      btn.setAttribute('aria-haspopup', 'true');
      const open = () => {
        cancelScheduledSubmenuClose();
        menu.querySelectorAll('.ctx-item-open-submenu').forEach((el) => el.classList.remove('ctx-item-open-submenu'));
        btn.classList.add('ctx-item-open-submenu');
        openSubmenu(item.submenu(), btn);
      };
      btn.addEventListener('pointerenter', open);
      btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    } else if (!item.disabled) {
      btn.addEventListener('pointerenter', () => {
        menu.querySelectorAll('.ctx-item-open-submenu').forEach((el) => el.classList.remove('ctx-item-open-submenu'));
        scheduleCloseSubmenu();
      });
      btn.addEventListener('click', () => {
        closeLocalMenu();
        item.onClick();
      });
    }
    menu.appendChild(btn);
  }

  const token = ++menuOpenToken;
  claimSurface('local-menu').then(() => {
    if (token !== menuOpenToken) return; // superseded by a close/reopen before this resolved
    overlay.classList.add('bm-menu-open');
    overlay.setAttribute('aria-hidden', 'false');
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 80;
    const MARGIN = 8;
    const { w: winW, h: winH } = viewportSize();
    const flippedX = clientX > winW - mw - MARGIN;
    const flippedY = clientY > winH - mh - MARGIN;
    menu.style.left = `${Math.max(MARGIN, Math.min(clientX, winW - mw - MARGIN))}px`;
    menu.style.top = `${Math.max(MARGIN, Math.min(clientY, winH - mh - MARGIN))}px`;
    menu.style.setProperty('--ctx-ox', flippedX ? 'right' : 'left');
    menu.style.setProperty('--ctx-oy', flippedY ? 'bottom' : 'top');
    menu.classList.remove('ctx-hide');
    void menu.offsetWidth;
    menu.classList.add('ctx-show');
    isLocalMenuOpen = true;
  });
}

let isLocalMenuOpen = false;
// The panel (e.g. the tab-list popup) a currently-open local menu was
// opened on top of via keepOverlay, or null. See openLocalMenu above and
// the panel click-outside listener below.
let localMenuKeptOverlay = null;
function closeLocalMenu() {
  const overlay = $('#bm-menu-overlay');
  const menu = $('#bm-menu');
  menuOpenToken++; // invalidate any pending open() still waiting on claimSurface()
  closeSubmenu();
  if (!isLocalMenuOpen) return;
  isLocalMenuOpen = false;
  menu.classList.remove('ctx-show');
  menu.classList.add('ctx-hide');
  overlay.setAttribute('aria-hidden', 'true');
  menu.addEventListener('animationend', () => {
    if (!isLocalMenuOpen) {
      overlay.classList.remove('bm-menu-open');
      menu.classList.remove('ctx-hide');
      releaseSurface('local-menu');
      localMenuKeptOverlay = null;
    }
  }, { once: true });
}
// Reaching the submenu itself always cancels any pending grace-period close
// scheduled while the pointer was still crossing the gap from the anchor row.
$('#bm-submenu').addEventListener('pointerenter', cancelScheduledSubmenuClose);

document.addEventListener('pointerdown', (event) => {
  if (isLocalMenuOpen && !$('#bm-menu').contains(event.target) && !$('#bm-submenu').contains(event.target)) closeLocalMenu();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isLocalMenuOpen) closeLocalMenu();
});

// ---- Submenu (e.g. tab menu's "Move" / "Close Multiple Tabs") -----------
// A second small floating menu anchored beside whichever parent row opened
// it (hover or click — see openLocalMenu above), closing itself whenever
// the parent menu closes, a different submenu opens, or the pointer moves
// onto another top-level row that isn't this one.
let isSubmenuOpen = false;
function openSubmenu(items, anchorBtn) {
  const overlay = $('#bm-submenu-overlay');
  const menu = $('#bm-submenu');
  menu.innerHTML = '';
  for (const item of items) {
    if (item.type === 'sep') {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      menu.appendChild(hr);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item';
    btn.setAttribute('role', 'menuitem');
    if (item.disabled) btn.disabled = true;
    if (item.danger) btn.classList.add('ctx-item-secondary');
    if (item.checked) btn.classList.add('ctx-item-checked');
    const iconSpan = document.createElement('span');
    iconSpan.className = 'ctx-icon';
    iconSpan.appendChild(createIcon(item.checked ? 'check' : (item.icon || 'file')));
    const labelSpan = document.createElement('span');
    labelSpan.className = 'ctx-label';
    labelSpan.textContent = item.label;
    btn.append(iconSpan, labelSpan);
    if (!item.disabled) {
      btn.addEventListener('click', () => {
        closeLocalMenu(); // also closes the submenu
        item.onClick();
      });
    }
    menu.appendChild(btn);
  }

  const token = ++submenuOpenToken;
  requestAnimationFrame(() => {
    if (token !== submenuOpenToken) return; // superseded by a close/reopen before this frame ran
    overlay.classList.add('bm-menu-open');
    overlay.setAttribute('aria-hidden', 'false');
    const rect = anchorBtn.getBoundingClientRect();
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 80;
    const MARGIN = 8;
    const { w: winW, h: winH } = viewportSize();
    // Prefer sliding out to the right of the parent row, flipping to the
    // left if there isn't room; vertically align with the row, clamped to
    // stay on screen.
    const spaceRight = winW - rect.right;
    const openLeft = spaceRight < mw + MARGIN && rect.left > mw + MARGIN;
    const left = openLeft ? rect.left - mw - 2 : Math.min(rect.right + 2, winW - mw - MARGIN);
    const top = Math.max(MARGIN, Math.min(rect.top, winH - mh - MARGIN));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.setProperty('--ctx-ox', openLeft ? 'right' : 'left');
    menu.style.setProperty('--ctx-oy', 'top');
    menu.classList.remove('ctx-hide');
    void menu.offsetWidth;
    menu.classList.add('ctx-show');
    isSubmenuOpen = true;
  });
}
function closeSubmenu() {
  cancelScheduledSubmenuClose();
  submenuOpenToken++; // invalidate any pending openSubmenu() rAF
  const overlay = $('#bm-submenu-overlay');
  const menu = $('#bm-submenu');
  if (!isSubmenuOpen) { overlay.classList.remove('bm-menu-open'); return; }
  isSubmenuOpen = false;
  menu.classList.remove('ctx-show');
  menu.classList.add('ctx-hide');
  overlay.setAttribute('aria-hidden', 'true');
  menu.addEventListener('animationend', () => {
    if (!isSubmenuOpen) {
      overlay.classList.remove('bm-menu-open');
      menu.classList.remove('ctx-hide');
    }
  }, { once: true });
}

function openBookmarkContextMenu(node, parentId, x, y, keepOverlay) {
  const items = [];
  if (node.type === 'bookmark') {
    items.push(
      { label: 'Open', icon: 'open-tab', onClick: () => window.browser.navigate(tabsState.activeTabId, node.url) },
      { label: 'Open in New Tab', icon: 'open-tab', onClick: () => window.browser.newTab(node.url) },
      { type: 'sep' },
      { label: 'Edit…', icon: 'file', onClick: () => openBookmarkDialog({ mode: 'edit', node }) },
      { label: 'Move to Folder…', icon: 'folder', onClick: () => openMoveDialog(node) },
      {
        label: 'Move', icon: 'open-tab',
        submenu: () => [{
          label: 'Home screen',
          icon: 'bookmark',
          onClick: async () => {
            const res = await window.browser.moveBookmarkToHome(node.id);
            if (!res || !res.ok) {
              const msg = res && res.error === 'full'
                ? 'The home screen already has 4 bookmarks. Remove one first, then try again.'
                : 'Couldn\u2019t move that bookmark to the home screen.';
              alert(msg);
            }
          },
        }],
      },
      { type: 'sep' },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => window.browser.removeBookmark(node.id) },
    );
  } else {
    const allBookmarks = [];
    (function collect(n) { for (const c of n.children) { if (c.type === 'bookmark') allBookmarks.push(c); else collect(c); } })(node);
    items.push(
      { label: 'Open All in New Tabs', icon: 'open-tab', onClick: () => allBookmarks.forEach((b) => window.browser.newTab(b.url)) },
      { type: 'sep' },
      { label: 'New Folder Inside…', icon: 'folder', onClick: () => openBookmarkDialog({ mode: 'create-folder', destId: node.id }) },
      { label: 'Rename…', icon: 'file', onClick: () => openPromptDialog({
          title: 'Rename folder', label: 'Folder name', value: node.title,
          onSave: async (name) => { await window.browser.updateBookmark(node.id, { title: name }); },
        }) },
      { label: 'Move to Folder…', icon: 'folder', onClick: () => openMoveDialog(node) },
      { type: 'sep' },
      { label: 'Delete Folder', icon: 'trash', danger: true, onClick: () => {
          if (!node.children.length || confirm(`Delete "${node.title}" and everything inside it?`)) {
            window.browser.removeBookmark(node.id);
          }
        } },
    );
  }
  openLocalMenu(items, x, y, keepOverlay);
}

// ---------------------------------------------------------------------------
// Tab context menu: right-click on a tab, empty tab-strip space, the
// tab-list dropdown button, or a row inside that dropdown. Built with the
// same openLocalMenu() used for bookmarks above, adapting its items to
// whichever of those four targets was actually clicked.
// ---------------------------------------------------------------------------
function openTabContextMenu(targetTabId, x, y, keepOverlay) {
  const tab = targetTabId != null ? tabsState.tabs.find((t) => t.id === targetTabId) : null;
  const items = [];

  // "New Tab" always applies; "New Tab to Right/Left" only make sense
  // relative to an actual target tab.
  items.push({ label: 'New Tab', icon: 'plus', onClick: () => window.browser.newTab() });
  if (tab) {
    items.push(
      { label: 'New Tab to Right', icon: 'plus', onClick: () => window.browser.newTabAdjacent(tab.id, 'right') },
      { label: 'New Tab to Left', icon: 'plus', onClick: () => window.browser.newTabAdjacent(tab.id, 'left') },
    );
  }
  items.push({ type: 'sep' });

  if (tab) {
    items.push(
      { label: 'Duplicate Tab', icon: 'duplicate', onClick: () => window.browser.duplicateTab(tab.id) },
      {
        label: 'Unload Tab',
        icon: 'unload',
        disabled: Boolean(tab.discarded) || tab.id === tabsState.activeTabId,
        onClick: () => window.browser.unloadTab(tab.id),
      },
      { label: 'Reload Tab', icon: 'reload', onClick: () => window.browser.reload(tab.id) },
      { label: 'Print', icon: 'print', onClick: () => window.browser.printTab(tab.id) },
      {
        label: tab.muted ? 'Unmute Tab' : 'Mute Tab',
        icon: 'mute',
        checked: Boolean(tab.muted),
        onClick: () => window.browser.toggleMuteTab(tab.id),
      },
      {
        label: tab.pinned ? 'Unpin Tab' : 'Pin Tab',
        icon: 'pin',
        checked: Boolean(tab.pinned),
        onClick: () => window.browser.togglePinTab(tab.id),
      },
      {
        label: 'Bookmark Tab',
        icon: 'bookmark',
        checked: Boolean(findBookmarkByUrlLocal(bookmarksState, tab.url)),
        disabled: isInternalUrl(tab.url),
        onClick: () => {
          const existing = findBookmarkByUrlLocal(bookmarksState, tab.url);
          if (existing) openBookmarkDialog({ mode: 'edit', node: existing });
          else openBookmarkDialog({ mode: 'create', title: tab.title, url: tab.url, favicon: tab.favicon });
        },
      },
      { type: 'sep' },
      {
        label: 'Move',
        icon: 'move',
        submenu: () => [
          { label: 'Move to New Window', icon: 'window', onClick: () => window.browser.moveTabToNewWindow(tab.id) },
          { type: 'sep' },
          { label: 'Move to Start', icon: 'back', onClick: () => window.browser.moveTabToStart(tab.id) },
          { label: 'Move to End', icon: 'forward', onClick: () => window.browser.moveTabToEnd(tab.id) },
        ],
      },
      {
        label: 'Close Multiple Tabs',
        icon: 'close',
        submenu: () => [
          { label: 'Close Tabs to Right', icon: 'forward', disabled: !hasTabsToRight(tab.id), onClick: () => window.browser.closeTabsToRight(tab.id) },
          { label: 'Close Tabs to Left', icon: 'back', disabled: !hasTabsToLeft(tab.id), onClick: () => window.browser.closeTabsToLeft(tab.id) },
          { label: 'Close Other Tabs', icon: 'close', disabled: tabsState.tabs.length <= 1, onClick: () => window.browser.closeOtherTabs(tab.id) },
        ],
      },
    );
    items.push({ type: 'sep' });
  }

  items.push({
    label: 'Select All Tabs',
    icon: 'select-all',
    onClick: () => selectAllTabs(),
  });
  if (selectedTabIds.size > 1) {
    items.push({
      label: `Close ${selectedTabIds.size} Selected Tabs`,
      icon: 'trash',
      danger: true,
      onClick: () => {
        window.browser.closeMultipleTabs(Array.from(selectedTabIds));
        clearTabSelection();
      },
    });
  }

  openLocalMenu(items, x, y, keepOverlay);
}

function hasTabsToRight(id) {
  const idx = tabsState.tabs.findIndex((t) => t.id === id);
  return idx !== -1 && idx < tabsState.tabs.length - 1;
}
function hasTabsToLeft(id) {
  const idx = tabsState.tabs.findIndex((t) => t.id === id);
  return idx > 0;
}

// Right-click on empty tab-strip space, or the tab-list dropdown button
// itself: no specific tab is the target, so only the target-agnostic rows
// above (New Tab, Select All Tabs, …) show — openTabContextMenu(null, …)
// already adapts for that.
$('#tab-strip').addEventListener('contextmenu', (event) => {
  if (event.target.closest('.tab')) return; // handled per-tab above
  event.preventDefault();
  openTabContextMenu(null, event.clientX, event.clientY);
});
$('#tab-row').addEventListener('contextmenu', (event) => {
  if (event.target !== event.currentTarget) return; // the drag-region remainder only; children handle their own
  event.preventDefault();
  openTabContextMenu(null, event.clientX, event.clientY);
});
$('#tab-list-btn').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openTabContextMenu(null, event.clientX, event.clientY);
});

// The three bookmarks-bar visibility options, shared by the bar's own
// right-click menu (below) and the browser (⋯) menu's "Bookmarks Bar" row —
// the latter is how you reach these once the bar itself is hidden and so
// has nothing left to right-click (see buildBrowserMenu further down).
function bookmarksBarVisibilityItems() {
  const options = [
    { mode: 'always', label: 'Always Show' },
    { mode: 'new-tab-only', label: 'Show Only on New Tab' },
    { mode: 'never', label: 'Never Show' },
  ];
  return options.map((opt) => ({
    label: opt.label,
    icon: 'folder',
    checked: bookmarksBarMode === opt.mode,
    onClick: async () => {
      bookmarksBarMode = opt.mode; // apply immediately; prefs-updated will confirm it
      updateBookmarksBarVisibility();
      await window.browser.setBookmarksBarMode(opt.mode);
    },
  }));
}

$('#bookmarks-bar').addEventListener('contextmenu', (event) => {
  if (event.target.closest('.bm-chip')) return; // handled per-chip above
  event.preventDefault();
  openLocalMenu([
    { label: 'New Folder…', icon: 'folder', onClick: () => openBookmarkDialog({ mode: 'create-folder', destId: null }) },
    { label: 'Add This Page…', icon: 'bookmark', onClick: () => {
        const active = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
        if (active) openBookmarkDialog({ mode: 'create', title: active.title, url: active.url, favicon: active.favicon });
      } },
    { type: 'sep' },
    ...bookmarksBarVisibilityItems(),
  ], event.clientX, event.clientY);
});

// "Move to Folder…" — a lightweight reuse of the same local-menu list, one
// row per folder (including the toolbar root), checkmarking wherever the
// node currently lives isn't tracked here, so it's just a flat pick-list.
function openMoveDialog(node) {
  const items = allFolders()
    .filter((f) => f.id !== node.id) // can't move a folder into itself
    .map((f) => ({
      label: `${'  '.repeat(f.depth)}${f.depth ? '↳ ' : ''}${f.title}`,
      icon: 'folder',
      onClick: () => window.browser.moveBookmark(node.id, f.id, 0),
    }));
  openLocalMenu(items, lastContextX, lastContextY);
}
let lastContextX = 200, lastContextY = 200;
document.addEventListener('contextmenu', (e) => { lastContextX = e.clientX; lastContextY = e.clientY; }, true);


// ---------------------------------------------------------------------------
// Drag-and-drop: reorder bookmarks on the toolbar, or drag one onto a
// folder chip to move it inside. Simpler than the tab-strip's FLIP-animated
// drag (fewer items, lower stakes) — an insertion caret shows where a drop
// will land instead of live-reflowing every neighbor.
// ---------------------------------------------------------------------------
// Shared core: works for the horizontal bookmark bar (.bm-chip rows, left/
// right insertion) and the vertical folder popup list (.tl-row rows, top/
// bottom insertion) — `opts` picks which. Dropping a folder onto another
// folder moves the dragged node INSIDE it; dropping between two items
// reorders/moves-into-this-list at that position. A cancelled drag (Escape,
// drop outside any valid target, pointercancel) always runs the same
// cleanup so nothing is left in the '.bm-dragging' state.
function beginBookmarkDrag(downEvent, el, node, parentId, opts = {}) {
  if (downEvent.button !== 0) return;
  const {
    container = $('#bookmarks-bar'),
    // Excludes .bm-overflow-btn: it carries the .bm-chip class too (for
    // shared chip styling) but isn't a bookmark — it has no dataset.bmId.
    // Including it here used to let it get treated as a real sibling
    // during a drag: hovering it computed a bogus insertionIndex relative
    // to its DOM position, and finish() read `Number(e.dataset.bmId)` for
    // every sibling including it, producing a NaN entry in the order sent
    // to reorderBookmarks(). That corrupted ordering was the actual cause
    // of the overflow button appearing to jump into the middle of the
    // visible chips or move unpredictably after a drag — it isn't
    // positioned by layout alone (see layoutBookmarksBar, which always
    // appends it last), it was being fed bad data.
    itemSelector = '.bm-chip:not(.bm-overflow-btn)',
    orientation = 'horizontal', // 'horizontal' | 'vertical'
  } = opts;
  const pointerId = downEvent.pointerId;
  const startX = downEvent.clientX;
  const startY = downEvent.clientY;
  let moved = false;
  let dropTargetFolder = null; // node currently hovered as a "move into" target
  let insertionIndex = null;   // sibling index to insert at (reorder, not move-into)
  let cancelled = false;

  const insertionEl = document.createElement('span');
  insertionEl.className = orientation === 'horizontal' ? 'bm-insertion' : 'bm-insertion bm-insertion-h';

  function siblingEls() {
    return Array.from(container.querySelectorAll(itemSelector)).filter((e) => e !== el);
  }

  function clearHighlights() {
    siblingEls().forEach((e) => e.classList.remove('bm-drop-target'));
    insertionEl.remove();
  }

  const horizontal = orientation === 'horizontal';

  // Everything below is computed from GEOMETRY (pointer coordinate vs each
  // sibling's rect), not document.elementFromPoint(). The old approach
  // found nothing at all whenever the cursor was over the gap between two
  // chips (the exact spot you aim for to insert "between"), and it also
  // inserted a real indicator element into the flex container, which pushed
  // every following item over and changed what was under the cursor on the
  // next move — so the target oscillated while barely moving. The indicator
  // is now a fixed-position overlay that takes no layout space, so nothing
  // moves while you drag and the target is a pure function of the pointer.
  function resolveTarget(px, py) {
    const cRect = container.getBoundingClientRect();
    const pad = 28;
    if (px < cRect.left - pad || px > cRect.right + pad || py < cRect.top - pad || py > cRect.bottom + pad) {
      return null;
    }
    const all = siblingEls();
    const visible = all.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!visible.length) return null;
    const p = horizontal ? px : py;

    // Dropping INTO a folder only when the pointer is over the middle half
    // of that folder's row/chip; the outer quarters insert before/after it.
    for (const item of visible) {
      const r = item.getBoundingClientRect();
      const start = horizontal ? r.left : r.top;
      const size = horizontal ? r.width : r.height;
      if (p >= start + size * 0.25 && p <= start + size * 0.75) {
        const overId = Number(item.dataset.bmId);
        const overNode = findBookmarkNodeLocal(bookmarksState, overId);
        const wouldCycle = node.type === 'folder' && isNodeOrDescendantLocal(node, overId);
        if (overNode && overNode.type === 'folder' && overId !== node.id && !wouldCycle) {
          return { folder: overNode, item };
        }
      }
    }

    let refItem = null;
    for (const item of visible) {
      const r = item.getBoundingClientRect();
      const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      if (p < mid) { refItem = item; break; }
    }
    // Index within the FULL sibling list (hidden overflow chips included),
    // so the order sent to main always covers every id.
    const index = refItem ? all.indexOf(refItem) : all.indexOf(visible[visible.length - 1]) + 1;
    return { index, refItem, last: visible[visible.length - 1], cRect };
  }

  function placeIndicator(t) {
    const r = (t.refItem || t.last).getBoundingClientRect();
    const c = t.cRect;
    insertionEl.style.position = 'fixed';
    insertionEl.style.pointerEvents = 'none';
    if (horizontal) {
      const x = t.refItem ? r.left - 3 : r.right + 3;
      insertionEl.style.left = `${Math.round(x - 1)}px`;
      insertionEl.style.top = `${Math.round(Math.max(c.top, r.top))}px`;
      insertionEl.style.width = '2px';
      insertionEl.style.height = `${Math.round(r.height)}px`;
    } else {
      const y = t.refItem ? r.top - 1 : r.bottom + 1;
      insertionEl.style.left = `${Math.round(r.left + 8)}px`;
      insertionEl.style.top = `${Math.round(y - 1)}px`;
      insertionEl.style.width = `${Math.round(r.width - 16)}px`;
      insertionEl.style.height = '2px';
    }
    if (!insertionEl.isConnected) document.body.appendChild(insertionEl);
  }

  let startRect = null;
  function onMove(moveEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (!moved) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      startRect = el.getBoundingClientRect();
      el.classList.add('bm-dragging');
    }

    // The dragged item follows the pointer along the list's axis (clamped
    // to the container so it can't inflate its scroll area), while its
    // original slot stays in layout so nothing else shifts under the cursor.
    const cr = container.getBoundingClientRect();
    if (horizontal) {
      const nx = Math.min(Math.max(startRect.left + dx, cr.left), cr.right - startRect.width) - startRect.left;
      el.style.transform = `translate(${nx}px, 0) scale(0.97)`;
    } else {
      const ny = Math.min(Math.max(startRect.top + dy, cr.top), cr.bottom - startRect.height) - startRect.top;
      el.style.transform = `translate(0, ${ny}px) scale(0.98)`;
    }

    clearHighlights();
    dropTargetFolder = null;
    insertionIndex = null;

    const t = resolveTarget(moveEvent.clientX, moveEvent.clientY);
    if (!t) return;
    if (t.folder) {
      dropTargetFolder = t.folder;
      t.item.classList.add('bm-drop-target');
    } else {
      insertionIndex = t.index;
      placeIndicator(t);
    }
  }

  function onUp(upEvent) {
    if (upEvent.pointerId !== pointerId) return;
    finish();
  }

  function onCancel(cancelEvent) {
    if (cancelEvent.pointerId !== pointerId) return;
    cancelled = true;
    finish();
  }

  function onKeydown(keyEvent) {
    if (keyEvent.key === 'Escape') { cancelled = true; finish(); }
  }

  function finish() {
    cleanup();
    el.classList.remove('bm-dragging');
    el.style.transform = '';
    clearHighlights();

    if (!moved || cancelled) return; // plain click, or an aborted drag — no-op
    suppressNextBmClick = true;
    // The click that follows a drag's pointerup is swallowed above; if none
    // arrives (pointer released over something else) don't leave the flag
    // armed to eat the user's next genuine click.
    setTimeout(() => { suppressNextBmClick = false; }, 150);

    if (dropTargetFolder) {
      window.browser.moveBookmark(node.id, dropTargetFolder.id, 0);
    } else if (insertionIndex !== null) {
      const order = siblingEls().map((e) => Number(e.dataset.bmId));
      order.splice(insertionIndex, 0, node.id);
      const currentOrder = Array.from(container.querySelectorAll(itemSelector)).map((e) => Number(e.dataset.bmId));
      if (order.length === currentOrder.length && order.every((id, i) => id === currentOrder[i])) return; // dropped where it already was
      if (parentId === currentDragParentId) {
        // `order` only covers the ids actually present in `container` — for
        // most lists (a folder popup's full children) that's the whole
        // sibling set for parentId, so it's also the full new order. The
        // bookmarks-bar overflow dropdown is the one case where `container`
        // shows just a tail subset of parentId's real children (the ones
        // that didn't fit on the toolbar); opts.orderPrefix carries the
        // still-visible chips that come before that subset so the full
        // order sent to reorderBookmarks() never drops them.
        const prefix = opts.orderPrefix || [];
        const suffix = opts.orderSuffix || [];
        window.browser.reorderBookmarks(parentId, [...prefix, ...order, ...suffix]);
      } else {
        // Dragged in from a different list than it started in — move it
        // into this parent at the resolved position rather than reorder.
        window.browser.moveBookmark(node.id, parentId, insertionIndex);
      }
    }
  }

  function cleanup() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKeydown, true);
    try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
  }

  const currentDragParentId = parentId;
  try { el.setPointerCapture(pointerId); } catch { /* not critical */ }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeydown, true);
}

// Local (renderer-side) cycle check mirroring main.js's isNodeOrDescendant —
// used only to decide whether to show the "drop into folder" affordance;
// main.js is still the source of truth and refuses the IPC call either way.
function isNodeOrDescendantLocal(node, targetId) {
  if (!node) return false;
  if (node.id === targetId) return true;
  if (node.type === 'folder') return node.children.some((c) => isNodeOrDescendantLocal(c, targetId));
  return false;
}

let suppressNextBmClick = false;


// ---------------------------------------------------------------------------
// Bookmark creation / edit dialog
// ---------------------------------------------------------------------------
let bmDialogState = null; // { mode: 'create'|'edit', node?, title, url, favicon, destId }

// Sentinel destId meaning "the independent home-screen collection"
// (home-bookmarks:* in main.js), as distinct from the toolbar tree's own
// destIds, which are either `null` (toolbar root) or a real folder id
// (number). Only offered/handled for mode:'create' — see renderDestList
// and the '#bm-dialog-save' handler below.
const HOME_DEST_ID = '__home_screen__';

function closeBookmarkModal(overlayId) {
  const overlay = $(overlayId);
  const modal = overlay.querySelector('.modal');
  modal.classList.remove('modal-show');
  modal.classList.add('modal-hide');
  overlay.setAttribute('aria-hidden', 'true');
  modal.addEventListener('animationend', () => {
    overlay.classList.remove('modal-overlay-open');
    modal.classList.remove('modal-hide');
    releaseSurface('modal');
  }, { once: true });
}

function openBookmarkModal(overlayId) {
  const overlay = $(overlayId);
  const modal = overlay.querySelector('.modal');
  closeAllPanels();
  closeLocalMenu();
  closeAddressDropdown();
  window.browser.hideContextMenu();
  claimSurface('modal').then(() => {
    if (!surfaceClaims.has('modal')) return; // closed before the surface was ready
    overlay.classList.add('modal-overlay-open');
    overlay.setAttribute('aria-hidden', 'false');
    modal.classList.remove('modal-hide');
    void modal.offsetWidth;
    modal.classList.add('modal-show');
  });
}

function destLabelFor(id) {
  if (id === HOME_DEST_ID) return 'Home Screen';
  const f = allFolders().find((f) => f.id === id);
  return f ? f.title : 'Bookmarks Toolbar';
}

function renderDestList() {
  const list = $('#bm-dest-list');
  list.innerHTML = '';

  // "Home Screen" — only offered when saving a brand-new bookmark for the
  // current page. Not shown for 'edit' (an existing toolbar bookmark moves
  // to the home screen via its own right-click "Move" submenu, which uses
  // the atomic moveBookmarkToHome flow instead) or 'create-folder' (the
  // home screen has no folders). It's a single extra row rather than part
  // of allFolders() because home-screen bookmarks aren't part of that tree
  // at all — see the home-bookmarks:* handlers in main.js.
  if (bmDialogState.mode === 'create') {
    const homeRow = document.createElement('button');
    homeRow.type = 'button';
    homeRow.className = 'dest-row';
    if (bmDialogState.destId === HOME_DEST_ID) homeRow.classList.add('active');
    homeRow.appendChild(createIcon('home'));
    const homeLbl = document.createElement('span');
    homeLbl.textContent = 'Home Screen';
    homeRow.appendChild(homeLbl);
    homeRow.addEventListener('click', () => {
      bmDialogState.destId = HOME_DEST_ID;
      $('#bm-dialog-dest-label').textContent = 'Home Screen';
      list.hidden = true;
      $('#bm-dialog-dest-btn').setAttribute('aria-expanded', 'false');
    });
    list.appendChild(homeRow);
  }

  for (const f of allFolders()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'dest-row';
    if (f.id === bmDialogState.destId) row.classList.add('active');
    row.appendChild(createIcon('folder'));
    const lbl = document.createElement('span');
    lbl.textContent = `${'  '.repeat(f.depth)}${f.title}`;
    row.appendChild(lbl);
    row.addEventListener('click', () => {
      bmDialogState.destId = f.id;
      $('#bm-dialog-dest-label').textContent = f.title;
      list.hidden = true;
      $('#bm-dialog-dest-btn').setAttribute('aria-expanded', 'false');
    });
    list.appendChild(row);
  }
  const newRow = document.createElement('button');
  newRow.type = 'button';
  newRow.className = 'dest-row dest-row-new';
  newRow.appendChild(createIcon('plus'));
  const newLbl = document.createElement('span');
  newLbl.textContent = 'New folder…';
  newRow.appendChild(newLbl);
  newRow.addEventListener('click', () => {
    list.hidden = true;
    $('#bm-dialog-dest-btn').setAttribute('aria-expanded', 'false');
    $('#bm-new-folder-row').hidden = false;
    $('#bm-new-folder-input').value = '';
    $('#bm-new-folder-input').focus();
  });
  list.appendChild(newRow);
}

$('#bm-dialog-dest-btn').addEventListener('click', () => {
  const list = $('#bm-dest-list');
  const willOpen = list.hidden;
  if (willOpen) renderDestList();
  list.hidden = !willOpen;
  $('#bm-dialog-dest-btn').setAttribute('aria-expanded', String(willOpen));
});

$('#bm-new-folder-cancel').addEventListener('click', () => { $('#bm-new-folder-row').hidden = true; });
$('#bm-new-folder-create').addEventListener('click', async () => {
  const name = $('#bm-new-folder-input').value.trim();
  if (!name) return;
  const result = await window.browser.addBookmarkFolder(name, null);
  $('#bm-new-folder-row').hidden = true;
  if (result && typeof result.id === 'number') {
    bmDialogState.destId = result.id;
    $('#bm-dialog-dest-label').textContent = name;
  }
});

// mode: 'create' (bookmark the current/given page), 'edit' (existing
// bookmark), or 'create-folder' (new folder — reuses this exact dialog,
// per the "New Folder…" fix below, instead of the old cramped one-line
// prompt). `destId` optionally preselects where a new bookmark/folder
// lands (e.g. "New Folder Inside…" passes the folder that was
// right-clicked so the field defaults to the right place).
function openBookmarkDialog({ mode, node, title, url, favicon, destId }) {
  bmDialogState = {
    mode,
    node: node || null,
    title: mode === 'edit' ? node.title : (mode === 'create-folder' ? (title || 'New Folder') : (title || url || '')),
    url: mode === 'edit' ? node.url : url,
    favicon: favicon || null,
    destId: destId ?? null,
  };
  $('#bm-dialog-title').textContent =
    mode === 'edit' ? 'Edit Bookmark' : mode === 'create-folder' ? 'New Folder' : 'Bookmark added';
  $('#bm-dialog-name-label').textContent = mode === 'create-folder' ? 'Folder name' : 'Name';
  $('#bm-dialog-name').value = bmDialogState.title;
  $('#bm-dialog-dest-label').textContent =
    mode === 'edit' ? 'Current location' : destLabelFor(bmDialogState.destId);
  $('#bm-dest-list').hidden = true;
  $('#bm-new-folder-row').hidden = true;
  $('#bm-dialog-remove').hidden = mode !== 'edit';
  openBookmarkModal('#bookmark-dialog-overlay');
  $('#bm-dialog-name').focus();
  $('#bm-dialog-name').select();
}

$('#bm-dialog-cancel').addEventListener('click', () => closeBookmarkModal('#bookmark-dialog-overlay'));
$('#bookmark-dialog-overlay').addEventListener('pointerdown', (event) => {
  if (event.target === event.currentTarget) closeBookmarkModal('#bookmark-dialog-overlay');
});
$('#bm-dialog-remove').addEventListener('click', () => {
  if (bmDialogState?.node) window.browser.removeBookmark(bmDialogState.node.id);
  closeBookmarkModal('#bookmark-dialog-overlay');
});
$('#bm-dialog-save').addEventListener('click', async () => {
  if (!bmDialogState) return;
  const title = $('#bm-dialog-name').value.trim() || bmDialogState.url || (bmDialogState.mode === 'create-folder' ? 'New Folder' : 'Untitled');
  if (bmDialogState.mode === 'edit') {
    await window.browser.updateBookmark(bmDialogState.node.id, { title });
    if (bmDialogState.destId !== null) {
      await window.browser.moveBookmark(bmDialogState.node.id, bmDialogState.destId, 0);
    }
  } else if (bmDialogState.mode === 'create-folder') {
    // The selected destination (root toolbar = null, or any existing
    // folder's id, including one just made via the inline "New folder…"
    // row) is what actually determines where this folder is created —
    // same data-flow addBookmark already uses for bookmarks.
    await window.browser.addBookmarkFolder(title, bmDialogState.destId);
  } else if (bmDialogState.destId === HOME_DEST_ID) {
    // Home screen is a separate, independent collection (see
    // home-bookmarks:* in main.js) — this never also creates a toolbar
    // bookmark, and home-bookmarks:add re-validates the URL and the
    // 4-slot limit itself (reading the persisted file fresh), so a stale
    // or hidden grid elsewhere can't be used to sneak past the limit.
    const result = await window.browser.addHomeBookmark(title, bmDialogState.url);
    if (!result || !result.ok) {
      const msg = result && result.error === 'full'
        ? 'The home screen already has 4 bookmarks. Remove one first, then try again.'
        : result && result.error === 'invalid-url'
          ? 'This page can\u2019t be added to the home screen.'
          : 'Couldn\u2019t add that bookmark to the home screen.';
      alert(msg);
      return; // keep the dialog open with the user's input intact so they
               // can pick a different destination or cancel instead
    }
  } else {
    await window.browser.addBookmark(title, bmDialogState.url, bmDialogState.favicon, bmDialogState.destId);
  }
  closeBookmarkModal('#bookmark-dialog-overlay');
});


// ---------------------------------------------------------------------------
// Tiny single-field prompt dialog (New folder / Rename) — reused rather than
// a second bespoke modal implementation.
// ---------------------------------------------------------------------------
let promptDialogState = null;
function openPromptDialog({ title, label, value = '', placeholder = '', onSave }) {
  promptDialogState = { onSave };
  $('#prompt-dialog-title').textContent = title;
  $('#prompt-dialog-label').textContent = label;
  const input = $('#prompt-dialog-input');
  input.value = value;
  input.placeholder = placeholder;
  openBookmarkModal('#prompt-dialog-overlay');
  input.focus();
  input.select();
}
$('#prompt-dialog-cancel').addEventListener('click', () => closeBookmarkModal('#prompt-dialog-overlay'));
$('#prompt-dialog-overlay').addEventListener('pointerdown', (event) => {
  if (event.target === event.currentTarget) closeBookmarkModal('#prompt-dialog-overlay');
});
async function commitPromptDialog() {
  const name = $('#prompt-dialog-input').value.trim();
  if (!name || !promptDialogState) return;
  await promptDialogState.onSave(name);
  closeBookmarkModal('#prompt-dialog-overlay');
}
$('#prompt-dialog-save').addEventListener('click', commitPromptDialog);
$('#prompt-dialog-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') commitPromptDialog();
});


// ---------------------------------------------------------------------------
// Address-bar dropdown: recent searches + bookmarks, shown while the
// address bar has focus. Reuses the shared panel visual language.
// ---------------------------------------------------------------------------
let recentSearches = [];
window.browser.onSearchHistoryUpdated?.((list) => { recentSearches = list || []; });

function flattenBookmarksFlat(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === 'bookmark') out.push(n);
    else flattenBookmarksFlat(n.children, out);
  }
  return out;
}

function placeAddressDropdown() {
  const overlay = $('#address-dropdown-overlay');
  const panel = overlay.querySelector('.panel');
  const anchor = $('.address-wrap');
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.round(rect.left)}px`;
  panel.style.top = `${Math.round(rect.bottom + 8)}px`;
  panel.style.width = `${Math.round(rect.width)}px`;
  panel.style.setProperty('--panel-ox', 'left');
  void panel.offsetWidth;
  panel.classList.add('panel-show');
  overlay.setAttribute('aria-hidden', 'false');
}

// Submitting a query (Enter) records it as a recent search — same rough
// "looks like a search, not a URL" test used elsewhere in this file: no
// scheme and no dot, or it contains a space (nobody types a space in a URL).
function looksLikeSearchQuery(value) {
  if (!value) return false;
  if (value.includes('://')) return false;
  return /\s/.test(value) || !value.includes('.');
}

// Mirrors main.js's looksLikeUrlInput() — used here purely to decide whether
// to show a "Go to address" row, so it stays a client-side copy rather than
// an IPC round-trip per keystroke. Keep in sync with main.js if that ever
// changes.
function looksLikeUrlInput(value) {
  if (!value) return false;
  return (
    /^[a-z]+:\/\//i.test(value) ||
    /^localhost(:\d+)?(\/.*)?$/i.test(value) ||
    /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(value)
  );
}

// Highlights the portion of `label` that matches `query`, case-insensitive.
// Returns a DocumentFragment so callers can just .appendChild() it.
function highlightMatch(label, query) {
  const frag = document.createDocumentFragment();
  if (!query) { frag.appendChild(document.createTextNode(label)); return frag; }
  const idx = label.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) { frag.appendChild(document.createTextNode(label)); return frag; }
  frag.appendChild(document.createTextNode(label.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.className = 'ad-match';
  mark.textContent = label.slice(idx, idx + query.length);
  frag.appendChild(mark);
  frag.appendChild(document.createTextNode(label.slice(idx + query.length)));
  return frag;
}

// ---------------------------------------------------------------------------
// Suggestion fetching: debounced, with stale-response protection on top of
// main.js's own request-replacement (see search:suggest in main.js). Two
// belts, one suspender — the renderer also simply ignores a response whose
// echoed `query` no longer matches what's in the input by the time it
// resolves (covers the case where the user kept typing and then deleted
// back down to an earlier string, which main.js's "one in-flight request"
// replacement alone wouldn't catch).
// ---------------------------------------------------------------------------
let suggestDebounceTimer = null;
let liveSuggestions = [];      // string[] from the current search provider
let suggestLoading = false;
let suggestErrored = false;
const SUGGEST_DEBOUNCE_MS = 150;

function scheduleSuggestionFetch(query) {
  clearTimeout(suggestDebounceTimer);
  if (!query || !looksLikeSearchQuery(query)) {
    // A bare domain-looking string isn't worth asking a search engine to
    // complete — URL completion (below) handles that case instead.
    liveSuggestions = [];
    suggestLoading = false;
    suggestErrored = false;
    return;
  }
  suggestLoading = true;
  suggestErrored = false;
  suggestDebounceTimer = setTimeout(async () => {
    const result = await window.browser.getSearchSuggestions(query);
    // Stale if the input has moved on since we asked.
    if ($('#address-bar').value.trim() !== query) return;
    suggestLoading = false;
    if (!result || result.error) {
      suggestErrored = true;
      liveSuggestions = [];
    } else {
      suggestErrored = false;
      liveSuggestions = result.suggestions || [];
    }
    if (addressDropdownOpen) renderAddressDropdown();
  }, SUGGEST_DEBOUNCE_MS);
}

// Flat, ordered list of every row currently shown, rebuilt each render —
// lets keyboard Up/Down/Enter operate on "whatever's on screen right now"
// without a parallel index into four different source arrays.
let dropdownRows = []; // { value, isSearch, el }
let dropdownActiveIndex = -1;

function setActiveDropdownRow(index) {
  if (dropdownRows[dropdownActiveIndex]) dropdownRows[dropdownActiveIndex].el.classList.remove('ad-row-active');
  dropdownActiveIndex = index;
  const row = dropdownRows[dropdownActiveIndex];
  if (row) {
    row.el.classList.add('ad-row-active');
    row.el.scrollIntoView({ block: 'nearest' });
  }
}

function addDropdownRow(body, { iconName, label, query, value, isSearch }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ad-row';
  row.appendChild(createIcon(iconName));
  const lbl = document.createElement('span');
  lbl.className = 'ad-row-label';
  lbl.appendChild(highlightMatch(label, query));
  row.appendChild(lbl);
  const kind = document.createElement('span');
  kind.className = 'ad-row-kind';
  kind.textContent = isSearch ? 'Search' : 'Visit';
  row.appendChild(kind);
  // mousedown (not click) selects the row: click fires after the input's
  // own blur, and we want the value committed in the same gesture that
  // took focus away, with no window where a stray blur handler elsewhere
  // could race it (see the file header comment above the dropdown section
  // — Requirement #3 — for why this matters).
  row.addEventListener('mousedown', (event) => {
    event.preventDefault(); // don't let the button steal focus before we're done with it
    commitAddressValue(value, isSearch);
  });
  row.addEventListener('pointerenter', () => setActiveDropdownRow(dropdownRows.indexOf(entry)));
  body.appendChild(row);
  const entry = { value, isSearch, el: row };
  dropdownRows.push(entry);
}

function renderAddressDropdown() {
  const body = $('#address-dropdown-body');
  body.innerHTML = '';
  dropdownRows = [];
  dropdownActiveIndex = -1;
  const rawQuery = $('#address-bar').value;
  const query = rawQuery.trim();
  const queryLower = query.toLowerCase();

  const matchingSearches = (query ? recentSearches.filter((s) => s.toLowerCase().includes(queryLower)) : recentSearches).slice(0, 4);
  const matchingBookmarks = flattenBookmarksFlat(bookmarksState)
    .filter((b) => !query || b.title.toLowerCase().includes(queryLower) || b.url.toLowerCase().includes(queryLower))
    .slice(0, 4);
  // De-dupe: don't show the same text as both a live suggestion and a
  // recent search.
  const seenSearch = new Set(matchingSearches.map((s) => s.toLowerCase()));
  const shownSuggestions = query ? liveSuggestions.filter((s) => !seenSearch.has(s.toLowerCase())).slice(0, 5) : [];
  const showUrlCompletion = query && looksLikeUrlInput(query);

  const nothingToShow = !showUrlCompletion && !shownSuggestions.length && !matchingSearches.length
    && !matchingBookmarks.length && !suggestLoading;

  if (nothingToShow) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = query ? (suggestErrored ? 'Suggestions unavailable — you can still press Enter to search' : 'No matches') : 'Start typing to search or enter an address';
    body.appendChild(empty);
    return;
  }

  if (showUrlCompletion) {
    const label = document.createElement('div');
    label.className = 'ad-section-label';
    label.textContent = 'Go to address';
    body.appendChild(label);
    addDropdownRow(body, { iconName: 'globe', label: query, query, value: query, isSearch: false });
  }

  if (query) {
    const label = document.createElement('div');
    label.className = 'ad-section-label';
    label.textContent = `Search with ${SEARCH_ENGINE_NAMES[currentSearchEngine]}`;
    body.appendChild(label);
    addDropdownRow(body, { iconName: 'search', label: query, query: '', value: query, isSearch: true });
    for (const s of shownSuggestions) {
      addDropdownRow(body, { iconName: 'search', label: s, query, value: s, isSearch: true });
    }
    if (suggestLoading) {
      const loading = document.createElement('div');
      loading.className = 'panel-empty ad-loading';
      loading.textContent = 'Loading suggestions…';
      body.appendChild(loading);
    } else if (suggestErrored && shownSuggestions.length === 0) {
      const err = document.createElement('div');
      err.className = 'panel-empty ad-loading';
      err.textContent = 'Couldn\u2019t reach the search provider';
      body.appendChild(err);
    }
  }

  if (matchingSearches.length) {
    const label = document.createElement('div');
    label.className = 'ad-section-label';
    label.textContent = 'Recent searches';
    body.appendChild(label);
    for (const s of matchingSearches) {
      addDropdownRow(body, { iconName: 'search', label: s, query, value: s, isSearch: true });
    }
  }

  if (matchingBookmarks.length) {
    const label = document.createElement('div');
    label.className = 'ad-section-label';
    label.textContent = 'Bookmarks';
    body.appendChild(label);
    for (const b of matchingBookmarks) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ad-row';
      if (b.favicon) {
        const img = document.createElement('img');
        img.src = b.favicon;
        img.alt = '';
        img.addEventListener('error', () => { img.remove(); row.prepend(createIcon('globe')); });
        row.appendChild(img);
      } else {
        row.appendChild(createIcon('globe'));
      }
      const lbl = document.createElement('span');
      lbl.className = 'ad-row-label';
      lbl.appendChild(highlightMatch(b.title || b.url, query));
      row.appendChild(lbl);
      const kind = document.createElement('span');
      kind.className = 'ad-row-kind';
      kind.textContent = 'Visit';
      row.appendChild(kind);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        commitAddressValue(b.url, false);
      });
      body.appendChild(row);
      const entry = { value: b.url, isSearch: false, el: row };
      row.addEventListener('pointerenter', () => setActiveDropdownRow(dropdownRows.indexOf(entry)));
      dropdownRows.push(entry);
    }
  }
}

function commitAddressValue(value, isSearch) {
  const trimmed = (value || '').trim();
  $('#address-bar').value = trimmed;
  window.browser.navigate(tabsState.activeTabId, trimmed);
  if (isSearch) window.browser.addRecentSearch(trimmed);
  $('#address-bar').blur();
  closeAddressDropdown();
}

let addressDropdownOpen = false;
function openAddressDropdown() {
  closeAllPanels();
  window.browser.hideContextMenu();
  // Select-all on focus (Requirement #3): typing a replacement should never
  // require clearing the old URL by hand first. Only on the transition INTO
  // focus — this listener is on 'focus', which doesn't re-fire for
  // additional clicks while already focused, so a click to reposition the
  // caret inside an already-focused bar is left alone (see the pointer-events
  // fix on #address-dropdown-overlay in styles.css for why that click
  // reaches the input at all instead of hitting the dropdown's backdrop).
  $('#address-bar').select();
  renderAddressDropdown();
  scheduleSuggestionFetch($('#address-bar').value.trim());
  addressDropdownOpen = true;
  claimSurface('address-dropdown').then(() => {
    if (!addressDropdownOpen) return; // closed again before the surface was ready
    $('#address-dropdown-overlay').classList.add('panel-overlay-open');
    placeAddressDropdown();
  });
}
function closeAddressDropdown() {
  if (!addressDropdownOpen) return;
  addressDropdownOpen = false;
  clearTimeout(suggestDebounceTimer);
  const overlay = $('#address-dropdown-overlay');
  const panel = overlay.querySelector('.panel');
  panel.classList.remove('panel-show');
  panel.classList.add('panel-hide');
  overlay.setAttribute('aria-hidden', 'true');
  panel.addEventListener('animationend', () => {
    overlay.classList.remove('panel-overlay-open');
    panel.classList.remove('panel-hide');
    releaseSurface('address-dropdown');
  }, { once: true });
}

$('#address-bar').addEventListener('focus', openAddressDropdown);
$('#address-bar').addEventListener('input', () => {
  if (addressDropdownOpen) {
    renderAddressDropdown();
    scheduleSuggestionFetch($('#address-bar').value.trim());
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!addressDropdownOpen) return;
  const overlay = $('#address-dropdown-overlay');
  if (!overlay.contains(event.target) && event.target !== $('#address-bar')) closeAddressDropdown();
});
// ---------------------------------------------------------------------------
// Empty tab-strip space (to the right of the New Tab button): dismiss the
// URL dropdown on a plain click, and move the window on an actual drag.
//
// ROOT CAUSE of "clicking that empty area doesn't close the URL dropdown":
// it used to be plain `-webkit-app-region: drag` (see the old comment this
// replaced), which hands the gesture to the OS as a native window-move
// before Chromium ever dispatches a DOM event for it — a documented
// Electron limitation, not a timing/bubbling quirk. No listener on that
// region, however it's wired, can reliably see the click: there often
// simply isn't a DOM event to see. A previous attempt here tried exactly
// that (a pointerdown listener gated on event.target === event.currentTarget)
// and LOOKED right, but it inherits the same failure — it depends on an
// event the OS may never deliver.
//
// Fix: stop using the OS drag region for this area at all (#tab-row is now
// -webkit-app-region: no-drag — see styles.css) and implement the drag by
// hand, so every press reliably reaches the DOM:
//   - pointerdown on the bare row starts tracking, without yet deciding
//     whether this is a click or a drag.
//   - If the pointer moves past a small threshold before release, treat it
//     as a drag: move the actual OS window by the same pixel delta via
//     window.browser.moveWindowBy (main.js's 'window:moveBy'), one call per
//     pointermove. setPointerCapture keeps delivering those moves to this
//     element even once the window itself starts sliding out from under the
//     cursor.
//   - If the pointer is released without crossing that threshold, it was a
//     plain click: dismiss the URL dropdown exactly like any other outside
//     click (the generic document-level pointerdown listener above already
//     covers every other outside area; this is the one area it couldn't).
const TAB_ROW_DRAG_THRESHOLD_PX = 4;
$('#tab-row').addEventListener('pointerdown', (downEvent) => {
  if (downEvent.target !== downEvent.currentTarget) return; // only the bare drag area, not a child control
  if (downEvent.button !== 0) return;
  const row = downEvent.currentTarget;
  const pointerId = downEvent.pointerId;
  let dragging = false;

  row.setPointerCapture(pointerId);

  function onMove(moveEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    if (!dragging) {
      if (Math.abs(moveEvent.movementX) < TAB_ROW_DRAG_THRESHOLD_PX && Math.abs(moveEvent.movementY) < TAB_ROW_DRAG_THRESHOLD_PX) return;
      dragging = true;
    }
    window.browser.moveWindowBy(moveEvent.movementX, moveEvent.movementY);
  }

  function finish(upEvent) {
    if (upEvent.pointerId !== pointerId) return;
    cleanup();
    if (!dragging && addressDropdownOpen) closeAddressDropdown();
  }

  function cleanup() {
    row.removeEventListener('pointermove', onMove);
    row.removeEventListener('pointerup', finish);
    row.removeEventListener('pointercancel', finish);
    try { row.releasePointerCapture(pointerId); } catch { /* already released */ }
  }

  row.addEventListener('pointermove', onMove);
  row.addEventListener('pointerup', finish);
  row.addEventListener('pointercancel', finish);
});
$('#address-bar').addEventListener('keydown', (event) => {
  // Enter submits regardless of whether the dropdown has finished its
  // open animation yet (addressDropdownOpen flips true a frame or two
  // after focus — see openAddressDropdown's double rAF — so gating Enter
  // on it too could eat a very fast focus-then-Enter and do nothing).
  if (event.key === 'Enter') {
    const value = event.target.value.trim();
    if (dropdownActiveIndex >= 0 && dropdownRows[dropdownActiveIndex]) {
      commitAddressValue(dropdownRows[dropdownActiveIndex].value, dropdownRows[dropdownActiveIndex].isSearch);
    } else {
      if (looksLikeSearchQuery(value)) window.browser.addRecentSearch(value);
      window.browser.navigate(tabsState.activeTabId, value);
      event.target.blur();
      closeAddressDropdown();
    }
    return;
  }
  if (!addressDropdownOpen) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (dropdownRows.length) setActiveDropdownRow((dropdownActiveIndex + 1) % dropdownRows.length);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (dropdownRows.length) setActiveDropdownRow((dropdownActiveIndex - 1 + dropdownRows.length) % dropdownRows.length);
  } else if (event.key === 'Escape') {
    closeAddressDropdown();
    event.target.blur();
  }
});

// ---------------------------------------------------------------------------
// URL bar right-click menu: see the toolbarView.webContents 'context-menu'
// listener in main.js's createWindow(), and the `p.isToolbar` branch of
// buildItems() above. #address-bar now goes through the exact same native
// Electron 'context-menu' event + context-menu:show/action IPC + #ctx-menu
// UI as every tab's page content and the New Tab search bar — no separate
// DOM-level menu or hand-rolled clipboard logic lives here anymore. (The
// previous implementation manually re-read clipboard.readText() into a
// local variable each time the menu opened and tracked Cut/Copy/Paste
// enablement by hand; this is what produced the stale/incorrectly-disabled
// Paste bug. Electron's real editFlags, forwarded unmodified from the
// native event, cannot go stale the same way.)

// ---------------------------------------------------------------------------
// Find-in-page (Cmd/Ctrl+F — see buildAppMenu in main.js, which pushes
// 'toolbar:toggleFind' regardless of which element in the window currently
// has focus). Not part of the anchored-panel family above (openPanel/
// closePanel expect a button to anchor under); this claims/releases the
// same shared full-window toolbar surface directly and positions itself
// fixed at the top-right corner instead, like most browsers' own find bar.
// ---------------------------------------------------------------------------
(function setupFindBar() {
  const overlay = $('#find-bar-overlay');
  const bar = $('#find-bar');
  const input = $('#find-bar-input');
  const countEl = $('#find-bar-count');
  const prevBtn = $('#find-bar-prev');
  const nextBtn = $('#find-bar-next');
  const closeBtn = $('#find-bar-close');

  let isOpen = false;
  let lastQuery = '';

  function setButtonsEnabled(enabled) {
    prevBtn.disabled = !enabled;
    nextBtn.disabled = !enabled;
  }

  function openFindBar() {
    if (isOpen) { input.select(); return; }
    if (typeof closeAllPanels === 'function') closeAllPanels();
    window.browser.hideContextMenu();
    isOpen = true;
    overlay.classList.add('panel-overlay-open');
    overlay.setAttribute('aria-hidden', 'false');
    bar.classList.remove('panel-hide');
    claimSurface('find-bar').then(() => {
      if (!isOpen) return; // closed again before the surface finished expanding
      bar.classList.add('panel-show');
      input.focus({ preventScroll: true });
      input.select();
    });
  }

  function closeFindBar() {
    if (!isOpen) return;
    isOpen = false;
    lastQuery = '';
    countEl.textContent = '';
    bar.classList.remove('find-bar-no-match');
    setButtonsEnabled(false);
    window.browser.findStop('clearSelection');
    bar.classList.remove('panel-show');
    bar.classList.add('panel-hide');
    overlay.setAttribute('aria-hidden', 'true');
    bar.addEventListener('animationend', () => {
      if (!isOpen) {
        overlay.classList.remove('panel-overlay-open');
        bar.classList.remove('panel-hide');
        releaseSurface('find-bar');
      }
    }, { once: true });
  }

  function applyResult(result) {
    if (!result) return;
    const { matches, activeMatchOrdinal } = result;
    bar.classList.toggle('find-bar-no-match', matches === 0);
    setButtonsEnabled(matches > 0);
    countEl.textContent = matches > 0 ? `${activeMatchOrdinal}/${matches}` : (lastQuery ? '0/0' : '');
  }

  // Debounced: a new search on every keystroke (not findNext) so Chromium
  // re-scans for the actual current text instead of continuing a stale one.
  let debounceTimer = null;
  input.addEventListener('input', () => {
    const query = input.value;
    lastQuery = query;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!query) {
      window.browser.findStop('clearSelection');
      countEl.textContent = '';
      bar.classList.remove('find-bar-no-match');
      setButtonsEnabled(false);
      return;
    }
    debounceTimer = setTimeout(() => window.browser.findQuery(query, true), 150);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!lastQuery) return;
      window.browser.findNext(lastQuery, !event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFindBar();
    }
  });

  prevBtn.addEventListener('click', () => { if (lastQuery) window.browser.findNext(lastQuery, false); });
  nextBtn.addEventListener('click', () => { if (lastQuery) window.browser.findNext(lastQuery, true); });
  closeBtn.addEventListener('click', closeFindBar);

  window.browser.onToggleFind(() => { if (isOpen) closeFindBar(); else openFindBar(); });
  window.browser.onFindResult(applyResult);

  // A search is scoped to one tab's own content (Electron's findInPage is
  // per-WebContents) — carrying a stale highlight/count across a tab switch
  // would be misleading, so close instead of leaving it showing numbers
  // that no longer describe what's on screen. onTabsUpdated already fires
  // for every kind of tab-state change; only react when the ACTIVE tab
  // actually changed, not on every navigation/loading tick of that tab.
  let lastActiveTabId = null;
  window.browser.onTabsUpdated((data) => {
    const activeId = data && data.activeTabId;
    if (isOpen && lastActiveTabId !== null && activeId !== lastActiveTabId) closeFindBar();
    lastActiveTabId = activeId;
  });
})();

// ---------------------------------------------------------------------------
// Downloads: button + panel
// ---------------------------------------------------------------------------
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return '';
  const kb = bytesPerSec / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB/s`;
  return `${(kb / 1024).toFixed(1)} MB/s`;
}

function formatBytesLocal(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function downloadFilename(d) {
  if (d.filename) return d.filename;
  try { return decodeURIComponent(d.url.split('/').pop() || 'download'); } catch { return 'download'; }
}

function renderDownloadsBadge() {
  const active = downloadsState.filter((d) => d.state === 'progressing').length;
  const badge = $('#downloads-badge');
  if (active > 0) {
    badge.hidden = false;
    badge.textContent = String(active);
  } else {
    badge.hidden = true;
  }
}

function renderDownloadsPanel() {
  const body = $('#downloads-body');
  body.innerHTML = '';

  if (!downloadsState.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No downloads yet';
    body.appendChild(empty);
    return;
  }

  for (const d of downloadsState) {
    const row = document.createElement('div');
    row.className = `dl-row dl-${d.state}`;

    const icon = document.createElement('span');
    icon.className = 'dl-icon';
    icon.appendChild(createIcon('file'));

    const main = document.createElement('div');
    main.className = 'dl-main';

    const nameRow = document.createElement('div');
    nameRow.className = 'dl-name';
    nameRow.textContent = downloadFilename(d);
    nameRow.title = d.savePath || d.url;

    const meta = document.createElement('div');
    meta.className = 'dl-meta';

    if (d.state === 'progressing') {
      const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : null;
      meta.textContent = pct != null
        ? `${formatBytesLocal(d.receivedBytes)} of ${formatBytesLocal(d.totalBytes)} · ${formatSpeed(d.speedBytesPerSec)}`
        : `${formatBytesLocal(d.receivedBytes)} downloaded`;

      const track = document.createElement('div');
      track.className = 'dl-progress-track';
      const fill = document.createElement('div');
      fill.className = 'dl-progress-fill';
      fill.style.width = pct != null ? `${pct}%` : '35%';
      if (pct == null) fill.classList.add('dl-progress-indeterminate');
      track.appendChild(fill);

      const autoOpenRow = document.createElement('label');
      autoOpenRow.className = 'dl-autoopen';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(d.autoOpen);
      cb.addEventListener('change', () => window.browser.setDownloadAutoOpen(d.id, cb.checked));
      autoOpenRow.append(cb, document.createTextNode(' Open automatically when finished'));

      main.append(nameRow, meta, track, autoOpenRow);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'dl-action-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => window.browser.cancelDownload(d.id));
      row.append(icon, main, cancelBtn);
    } else {
      const stateLabel = {
        completed: 'Completed',
        cancelled: 'Cancelled',
        interrupted: 'Failed',
      }[d.state] || d.state;
      meta.textContent = `${stateLabel}${d.totalBytes ? ' · ' + formatBytesLocal(d.totalBytes) : ''}`;
      main.append(nameRow, meta);

      row.addEventListener('click', (event) => {
        if (event.target.closest('.dl-action-btn')) return;
        if (d.state === 'completed') window.browser.openDownload(d.id);
      });
      if (d.state === 'completed') row.classList.add('dl-clickable');

      const actions = document.createElement('div');
      actions.className = 'dl-actions';
      if (d.state === 'completed') {
        const revealBtn = document.createElement('button');
        revealBtn.type = 'button';
        revealBtn.className = 'dl-action-btn dl-icon-btn';
        revealBtn.title = 'Show in folder';
        revealBtn.appendChild(createIcon('folder'));
        revealBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          window.browser.revealDownload(d.id);
        });
        actions.appendChild(revealBtn);
      }
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'dl-action-btn dl-icon-btn';
      removeBtn.title = 'Remove from list';
      removeBtn.appendChild(createIcon('close'));
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        window.browser.removeDownload(d.id);
      });
      actions.appendChild(removeBtn);

      row.append(icon, main, actions);
    }

    body.appendChild(row);
  }
}

window.browser.onDownloadsUpdated((list) => {
  downloadsState = list || [];
  renderDownloadsBadge();
  renderDownloadsPanel();
});

$('#downloads-btn').addEventListener('click', () => {
  togglePanel($('#downloads-overlay'), $('#downloads-btn'));
});
$('#downloads-clear-btn').addEventListener('click', () => window.browser.clearCompletedDownloads());


// ---------------------------------------------------------------------------
// Shield (native ad/tracker blocker) — toolbar button + popup. Every number
// and toggle state shown here comes straight from window.browser.adblock.*
// (src/adblock/index.js in the main process) — nothing is hardcoded or
// guessed client-side, per the Part 2 brief.
// ---------------------------------------------------------------------------
let adblockStatus = null;      // last-known getStatus() snapshot
let adblockSiteState = null;   // { hostname, disabled } for the active tab
let adblockStatsSnap = null;   // { currentSite, session, allTime }

function activeTab() {
  return tabsState.tabs.find((t) => t.id === tabsState.activeTabId) || null;
}

// Internal pages (home/settings, or an empty new tab) have no real
// "website" to protect — the popup says so instead of pretending there's a
// hostname/exception to toggle.
function activeTabIsFilterable() {
  const tab = activeTab();
  if (!tab || !tab.url) return false;
  if (isInternalUrl(tab.url)) return false;
  return /^https?:\/\//i.test(tab.url);
}

function renderShieldButton() {
  const btn = $('#shield-btn');
  const useEl = $('#shield-btn-icon');
  const badge = $('#shield-btn-badge');
  btn.classList.remove('protected', 'site-disabled', 'globally-disabled');

  const globallyOn = adblockStatus ? Boolean(adblockStatus.enabled) : true;
  const siteOff = Boolean(adblockSiteState && adblockSiteState.disabled);

  if (!globallyOn) {
    btn.classList.add('globally-disabled');
    useEl.setAttribute('href', '#i-shield-off');
    btn.title = 'Ad blocker — protection is off';
  } else if (siteOff && activeTabIsFilterable()) {
    btn.classList.add('site-disabled');
    useEl.setAttribute('href', '#i-shield-off');
    btn.title = 'Ad blocker — paused on this site';
  } else {
    btn.classList.add('protected');
    useEl.setAttribute('href', '#i-shield');
    btn.title = 'Ad blocker — protection is on';
  }

  const count = adblockStatsSnap?.currentSite || 0;
  if (globallyOn && activeTabIsFilterable() && count > 0) {
    badge.hidden = false;
    badge.textContent = count > 99 ? '99+' : String(count);
  } else {
    badge.hidden = true;
  }
}

function renderShieldPopup() {
  if (!openPanels.has($('#adblock-overlay'))) return;

  const globalToggle = $('#shield-global-toggle');
  const siteToggle = $('#shield-site-toggle');
  const hostEl = $('#shield-site-host');
  const statusEl = $('#shield-site-status');
  const errEl = $('#shield-error');
  const listsLine = $('#shield-lists-line');

  globalToggle.checked = Boolean(adblockStatus?.enabled);

  const filterable = activeTabIsFilterable();
  if (!filterable) {
    hostEl.textContent = 'This page';
    statusEl.textContent = "Can't be protected (not a website)";
    siteToggle.checked = false;
    siteToggle.disabled = true;
  } else {
    siteToggle.disabled = !adblockStatus?.enabled;
    const host = adblockSiteState?.hostname || '';
    hostEl.textContent = host || '—';
    const disabled = Boolean(adblockSiteState?.disabled);
    siteToggle.checked = disabled;
    if (!adblockStatus?.enabled) {
      statusEl.textContent = 'Protection is off globally';
    } else {
      statusEl.textContent = disabled ? 'Paused on this site' : 'Protecting this site';
    }
  }

  $('#shield-stat-site').textContent = String(adblockStatsSnap?.currentSite ?? 0);
  $('#shield-stat-session').textContent = String(adblockStatsSnap?.session ?? 0);
  $('#shield-stat-alltime').textContent = String(adblockStatsSnap?.allTime ?? 0);

  const lists = adblockStatus?.lists || [];
  // BUG (found in this audit): this used to also require
  // `!l.lastSuccessfulUpdate` — i.e. only flag a list as "failed" if it
  // had NEVER once succeeded. `lastError` is already cleared to `null` on
  // every successful update (see filterlist-manager.js's updateList), so
  // `l.lastError` truthy already means, precisely, "the most recent
  // update attempt failed" — regardless of whether some earlier attempt,
  // possibly weeks ago, happened to succeed. The extra clause meant a
  // list that updated successfully once and then failed every attempt
  // after that (a stale/renamed source URL, a long-lived network issue)
  // would silently stop surfacing in this shield-panel warning forever,
  // even though Settings' own per-list error text kept being set/updated
  // correctly underneath — exactly the kind of "actual backend status"
  // mismatch between the toolbar panel and Settings this feature exists
  // to prevent.
  const failed = lists.filter((l) => l.enabled && l.lastError);
  if (failed.length) {
    listsLine.textContent = `${failed.length} filter list${failed.length === 1 ? '' : 's'} failed to update — using the last known-good copy.`;
  } else {
    const newest = lists.reduce((max, l) => (l.lastSuccessfulUpdate && l.lastSuccessfulUpdate > max ? l.lastSuccessfulUpdate : max), 0);
    listsLine.textContent = newest
      ? `Filter lists last updated ${formatHistoryTimeLike(newest)}`
      : 'Filter lists not updated yet';
  }

  errEl.hidden = true;
  errEl.textContent = '';
}

// formatHistoryTime (defined further down for the History panel) is
// reused here; declared as a thin forward-safe wrapper since function
// declarations in this file are hoisted, so the later definition applies.
function formatHistoryTimeLike(ms) {
  try { return formatHistoryTime(ms); } catch { return new Date(ms).toLocaleString(); }
}

async function refreshAdblockSiteContext() {
  const tab = activeTab();
  const tabId = tab?.id ?? null;
  if (activeTabIsFilterable()) {
    try { adblockSiteState = await window.browser.adblock.getSiteState(tab.url); }
    catch { adblockSiteState = null; }
  } else {
    adblockSiteState = null;
  }
  try { adblockStatsSnap = await window.browser.adblock.getStats(tabId); }
  catch { adblockStatsSnap = null; }
  renderShieldButton();
  renderShieldPopup();
}

async function refreshAdblockStatus() {
  try {
    adblockStatus = await window.browser.adblock.getStatus();
  } catch {
    adblockStatus = adblockStatus || { enabled: true, lists: [] };
  }
  await refreshAdblockSiteContext();
}

window.browser.adblock.onUpdated((status) => {
  adblockStatus = status;
  refreshAdblockSiteContext();
});

$('#shield-btn').addEventListener('click', () => {
  togglePanel($('#adblock-overlay'), $('#shield-btn'));
  if (openPanels.has($('#adblock-overlay'))) refreshAdblockSiteContext();
});

$('#shield-global-toggle').addEventListener('change', async (event) => {
  const next = event.target.checked;
  event.target.disabled = true;
  try {
    await window.browser.adblock.setEnabled(next);
  } catch {
    event.target.checked = !next; // revert on failure, show the real state
    const errEl = $('#shield-error');
    errEl.hidden = false;
    errEl.textContent = "Couldn't change protection — please try again.";
  } finally {
    event.target.disabled = false;
  }
});

$('#shield-site-toggle').addEventListener('change', async (event) => {
  const tab = activeTab();
  if (!tab || !activeTabIsFilterable()) { event.target.checked = false; return; }
  const next = event.target.checked; // checked = exception ON = protection paused
  event.target.disabled = true;
  try {
    const result = await window.browser.adblock.setSiteException(tab.url, next);
    if (!result?.ok) throw new Error(result?.reason || 'failed');
  } catch {
    event.target.checked = !next;
    const errEl = $('#shield-error');
    errEl.hidden = false;
    errEl.textContent = "Couldn't update this site's exception — please try again.";
  } finally {
    event.target.disabled = false;
  }
});

$('#shield-settings-btn').addEventListener('click', () => {
  closeAllPanels();
  window.browser.openSettings({ page: 'adblock' });
});

// Re-check the shield whenever the active tab/URL changes (new tab, nav,
// switch tab) — reuses the existing tabs-updated pipeline.
window.browser.onTabsUpdated(() => { refreshAdblockSiteContext(); });

refreshAdblockStatus();


// ---------------------------------------------------------------------------
// History panel (browser menu → History, or Settings → Privacy & History →
// "Manage history…"). Same visual family as Downloads (reuses its
// .dl-row/.dl-icon/.dl-main/.dl-name/.dl-meta/.dl-actions classes), kept in
// sync by main.js's history store via 'history-updated'. Part 3A adds:
// search (title + URL, over the already-synced list — no extra IPC round
// trip needed), date grouping, a "select multiple" mode, and range-based
// clearing on top of the single-item remove / clear-all that already
// existed.
// ---------------------------------------------------------------------------
let historyState = [];
let historySearchQuery = '';
let historySelectMode = false;
let historySelectedIds = new Set();

function formatHistoryTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${time}`;
}

// "Today" / "Yesterday" / a real date — used as the group header above runs
// of entries from the same day. historyState is already newest-first (see
// main.js's addHistoryEntry: list.unshift), so a simple "did the day change
// since the last row" walk is enough to group it, no separate sort needed.
function historyDateLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  const startOf = (date) => { const c = new Date(date); c.setHours(0, 0, 0, 0); return c.getTime(); };
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function filteredHistoryList() {
  const q = historySearchQuery.trim().toLowerCase();
  if (!q) return historyState;
  return historyState.filter((h) => (h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q));
}

function updateHistorySelectBar() {
  const bar = $('#history-select-bar');
  bar.hidden = !historySelectMode;
  const visible = filteredHistoryList();
  const visibleIds = visible.map((h) => h.id);
  const selectedVisible = visibleIds.filter((id) => historySelectedIds.has(id));
  $('#history-selected-count').textContent = String(selectedVisible.length);
  $('#history-remove-selected-btn').disabled = selectedVisible.length === 0;
  const allCheck = $('#history-select-all-check');
  allCheck.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  allCheck.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
}

function renderHistoryPanel() {
  const body = $('#history-body');
  body.innerHTML = '';

  const list = filteredHistoryList();

  if (!historyState.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No browsing history yet';
    body.appendChild(empty);
    updateHistorySelectBar();
    return;
  }
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = `No history matches "${historySearchQuery.trim()}"`;
    body.appendChild(empty);
    updateHistorySelectBar();
    return;
  }

  let lastGroup = null;
  for (const h of list) {
    const group = historyDateLabel(h.time);
    if (group !== lastGroup) {
      const header = document.createElement('div');
      header.className = 'hist-group-header';
      header.textContent = group;
      body.appendChild(header);
      lastGroup = group;
    }

    const row = document.createElement('div');
    row.className = historySelectMode ? 'dl-row' : 'dl-row dl-clickable';

    if (historySelectMode) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'hist-row-check';
      check.checked = historySelectedIds.has(h.id);
      check.addEventListener('change', () => {
        if (check.checked) historySelectedIds.add(h.id);
        else historySelectedIds.delete(h.id);
        updateHistorySelectBar();
      });
      row.appendChild(check);
    }

    const icon = document.createElement('span');
    icon.className = 'dl-icon';
    if (h.favicon) {
      const img = document.createElement('img');
      img.src = h.favicon;
      img.alt = '';
      img.style.cssText = 'width:15px;height:15px;border-radius:3px;';
      img.addEventListener('error', () => { img.remove(); icon.appendChild(createIcon('globe')); });
      icon.appendChild(img);
    } else {
      icon.appendChild(createIcon('globe'));
    }

    const main = document.createElement('div');
    main.className = 'dl-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'dl-name';
    nameRow.textContent = h.title || h.url;
    nameRow.title = h.url;
    const meta = document.createElement('div');
    meta.className = 'dl-meta';
    meta.textContent = `${formatHistoryTime(h.time)} · ${h.url}`;
    main.append(nameRow, meta);

    row.addEventListener('click', (event) => {
      if (historySelectMode) {
        // Row click toggles selection too (not just the checkbox itself) —
        // same "whole row is the hit target" affordance select mode UIs
        // normally give you. Clicking the checkbox already fired its own
        // 'change' handler above; avoid double-toggling that one case.
        if (event.target.closest('.hist-row-check')) return;
        const check = row.querySelector('.hist-row-check');
        check.checked = !check.checked;
        check.dispatchEvent(new Event('change'));
        return;
      }
      if (event.target.closest('.dl-action-btn')) return;
      window.browser.newTab(h.url);
      closePanel($('#history-overlay'));
    });

    if (!historySelectMode) {
      const actions = document.createElement('div');
      actions.className = 'dl-actions';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'dl-action-btn dl-icon-btn';
      removeBtn.title = 'Remove from history';
      removeBtn.appendChild(createIcon('close'));
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        window.browser.removeHistoryItem(h.id);
      });
      actions.appendChild(removeBtn);
      row.append(icon, main, actions);
    } else {
      row.append(icon, main);
    }

    body.appendChild(row);
  }

  updateHistorySelectBar();
}

window.browser.onHistoryUpdated?.((list) => {
  historyState = list || [];
  // Dropped entries (cleared elsewhere, e.g. another window, or clear-on-
  // exit) shouldn't leave stale ids selected.
  const liveIds = new Set(historyState.map((h) => h.id));
  for (const id of historySelectedIds) if (!liveIds.has(id)) historySelectedIds.delete(id);
  if (openPanels.has($('#history-overlay'))) renderHistoryPanel();
});

$('#history-search-input').addEventListener('input', (e) => {
  historySearchQuery = e.target.value;
  renderHistoryPanel();
});

$('#history-select-btn').addEventListener('click', () => {
  historySelectMode = !historySelectMode;
  historySelectedIds.clear();
  $('#history-select-btn').textContent = historySelectMode ? 'Done' : 'Select';
  renderHistoryPanel();
});

$('#history-select-all-check').addEventListener('change', (e) => {
  const visibleIds = filteredHistoryList().map((h) => h.id);
  if (e.target.checked) visibleIds.forEach((id) => historySelectedIds.add(id));
  else visibleIds.forEach((id) => historySelectedIds.delete(id));
  renderHistoryPanel();
});

$('#history-remove-selected-btn').addEventListener('click', async () => {
  const ids = Array.from(historySelectedIds);
  if (!ids.length) return;
  if (!window.confirm(`Remove ${ids.length} history ${ids.length === 1 ? 'entry' : 'entries'}? This can't be undone.`)) return;
  historySelectedIds.clear();
  await window.browser.removeHistoryItems(ids);
});

$('#history-range-clear-btn').addEventListener('click', async () => {
  const rangeKey = $('#history-range-select').value;
  const label = $('#history-range-select').selectedOptions[0]?.textContent || 'that range';
  if (!window.confirm(`Clear browsing history for "${label}"? This can't be undone.`)) return;
  await window.browser.clearHistoryRange(rangeKey);
});

$('#history-clear-btn').addEventListener('click', async () => {
  if (!historyState.length) return;
  if (!window.confirm("Clear all browsing history? This can't be undone.")) return;
  await window.browser.clearHistory();
});

// Leaving select mode / clearing the search box whenever the panel is
// closed means reopening it (from either entry point) always starts clean,
// rather than carrying over whatever state it was left in last time.
const historyOverlayEl = $('#history-overlay');
const historyOverlayObserver = new MutationObserver(() => {
  if (historyOverlayEl.getAttribute('aria-hidden') === 'true' && (historySelectMode || historySearchQuery)) {
    historySelectMode = false;
    historySearchQuery = '';
    historySelectedIds.clear();
    $('#history-select-btn').textContent = 'Select';
    $('#history-search-input').value = '';
  }
});
historyOverlayObserver.observe(historyOverlayEl, { attributes: true, attributeFilter: ['aria-hidden'] });

// Settings → Privacy & History → "Manage history…" (a different tab, no
// direct DOM access to this toolbar) asks main.js to relay this instead.
window.browser.onOpenHistoryPanel?.(() => {
  closeAllPanels();
  openPanel($('#history-overlay'), $('#settings-btn'));
});


// ---------------------------------------------------------------------------
// Bookmarks manager panel (browser menu → Bookmarks): every bookmark in the
// tree, flattened with its folder path shown as context, plus a quick way
// to bookmark the page currently open. The bookmarks BAR stays the fast
// drag/drop/right-click surface for day-to-day use; this panel is the
// "see and manage everything at once" surface requested for the menu.
// ---------------------------------------------------------------------------
function flattenBookmarksWithPath(nodes, pathSoFar, out) {
  for (const n of nodes || []) {
    if (n.type === 'bookmark') {
      out.push({ ...n, folderPath: pathSoFar.join(' / ') });
    } else if (n.type === 'folder') {
      flattenBookmarksWithPath(n.children, [...pathSoFar, n.title], out);
    }
  }
  return out;
}

function renderBookmarksManagerPanel() {
  const body = $('#bookmarks-manager-body');
  body.innerHTML = '';

  const flat = flattenBookmarksWithPath(bookmarksState, [], []);

  if (!flat.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No bookmarks yet';
    body.appendChild(empty);
    return;
  }

  for (const b of flat) {
    const row = document.createElement('div');
    row.className = 'dl-row dl-clickable';

    const icon = document.createElement('span');
    icon.className = 'dl-icon';
    if (b.favicon) {
      const img = document.createElement('img');
      img.src = b.favicon;
      img.alt = '';
      img.style.cssText = 'width:15px;height:15px;border-radius:3px;';
      img.addEventListener('error', () => { img.remove(); icon.appendChild(createIcon('globe')); });
      icon.appendChild(img);
    } else {
      icon.appendChild(createIcon('globe'));
    }

    const main = document.createElement('div');
    main.className = 'dl-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'dl-name';
    nameRow.textContent = b.title || b.url;
    nameRow.title = b.url;
    const meta = document.createElement('div');
    meta.className = 'dl-meta';
    meta.textContent = b.folderPath ? `${b.folderPath} · ${b.url}` : b.url;
    main.append(nameRow, meta);

    row.addEventListener('click', (event) => {
      if (event.target.closest('.dl-action-btn')) return;
      window.browser.newTab(b.url);
      closePanel($('#bookmarks-manager-overlay'));
    });

    const actions = document.createElement('div');
    actions.className = 'dl-actions';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'dl-action-btn dl-icon-btn';
    removeBtn.title = 'Remove bookmark';
    removeBtn.appendChild(createIcon('close'));
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      window.browser.removeBookmark(b.id);
    });
    actions.appendChild(removeBtn);

    row.append(icon, main, actions);
    body.appendChild(row);
  }
}

// Re-rendering while open on every bookmarks change (star button, bar edits,
// etc.) is wired into the existing onBookmarksUpdated handler above.
$('#bookmarks-manager-add-btn').addEventListener('click', () => {
  if (tabsState.activeTabId != null) window.browser.toggleBookmarkForTab(tabsState.activeTabId);
});


// ---------------------------------------------------------------------------
// Zoom: reset button in the address bar
// ---------------------------------------------------------------------------
$('#zoom-pill').addEventListener('click', (event) => {
  // Lives inside the <label class="address-wrap"> that wraps #address-bar —
  // stop the click here so it can never be interpreted as "focus the
  // address bar" (interactive content inside a <label> already suppresses
  // that forwarding per spec, but this keeps it explicit and safe).
  event.preventDefault();
  event.stopPropagation();
  if (tabsState.activeTabId != null) window.browser.zoomReset(tabsState.activeTabId);
});


// ---------------------------------------------------------------------------
// Tab-list panel: drag-and-drop reordering.
// ---------------------------------------------------------------------------
// Pointer-based (consistent with the tab strip's own drag, above), but
// simpler: since this list is short and already scrollable, neighbor rows
// don't need to be live-animated out of the way — only the dragged row
// itself moves (tracking the pointer via translateY), with a thin insertion
// indicator showing where it would land. The actual reorder (DOM + the
// shared tabsState used by both this popup and the main tab strip) is
// committed once on pointerup, via the same tabs:reorder channel the tab
// strip's own drag uses (window.browser.reorderTabs) — one underlying tab
// order, two views of it, exactly as the brief asks for.
// ---------------------------------------------------------------------------
const TL_DRAG_THRESHOLD_PX = 4;
let tlDragSuppressClick = false; // set on a drag that moved; consumed by the next 'click'
let tlDragInProgress = false;

function beginTabListDrag(downEvent, rowEl, tabId) {
  if (downEvent.button !== 0) return; // left button only
  if (downEvent.target.closest('.tl-close')) return; // let the close button work normally

  const pointerId = downEvent.pointerId;
  const startY = downEvent.clientY;
  const body = $('#tab-list-body');
  let moved = false;
  let indicator = null;
  let targetIndex = -1;

  // Every OTHER tab row currently in the popup, top-to-bottom, with its
  // layout position captured once up front. Since none of these move during
  // the drag (only the dragged row itself is transformed), these stay valid
  // for the whole gesture — no per-move re-measuring needed.
  const neighbors = Array.from(body.querySelectorAll('.tl-row[data-tab-id]'))
    .filter((el) => el !== rowEl)
    .map((el) => ({
      id: Number(el.dataset.tabId),
      top: el.offsetTop,
      bottom: el.offsetTop + el.offsetHeight,
      mid: el.offsetTop + el.offsetHeight / 2,
    }));
  // Where the dragged row currently sits among those neighbors — used both
  // as the starting targetIndex and to detect "no-op" drops on release.
  const originalIndex = (() => {
    const myTop = rowEl.offsetTop;
    let idx = neighbors.length;
    for (let i = 0; i < neighbors.length; i++) {
      if (myTop < neighbors[i].top) { idx = i; break; }
    }
    return idx;
  })();

  function computeTargetIndex(clientY) {
    const bodyRect = body.getBoundingClientRect();
    const localY = clientY - bodyRect.top + body.scrollTop;
    for (let i = 0; i < neighbors.length; i++) {
      if (localY < neighbors[i].mid) return i;
    }
    return neighbors.length;
  }

  function placeIndicator(idx) {
    if (!indicator) return;
    let top;
    if (!neighbors.length) {
      top = rowEl.offsetTop;
    } else if (idx <= 0) {
      top = Math.max(0, neighbors[0].top - 2);
    } else if (idx >= neighbors.length) {
      top = neighbors[neighbors.length - 1].bottom;
    } else {
      top = neighbors[idx].top - 1;
    }
    indicator.style.top = `${top}px`;
  }

  function onMove(moveEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    const dy = moveEvent.clientY - startY;

    if (!moved) {
      if (Math.abs(dy) < TL_DRAG_THRESHOLD_PX) return;
      moved = true;
      tlDragInProgress = true;
      rowEl.classList.add('tl-dragging');
      body.classList.add('tl-has-drag');
      indicator = document.createElement('div');
      indicator.className = 'tl-insert-indicator';
      body.appendChild(indicator);
      targetIndex = originalIndex;
      placeIndicator(targetIndex);
    }

    rowEl.style.transform = `translateY(${dy}px)`;

    const newTarget = computeTargetIndex(moveEvent.clientY);
    if (newTarget !== targetIndex) {
      targetIndex = newTarget;
      placeIndicator(targetIndex);
    }
  }

  function finishDrag() {
    rowEl.classList.remove('tl-dragging');
    rowEl.style.transform = '';
    body.classList.remove('tl-has-drag');
    if (indicator) { indicator.remove(); indicator = null; }
  }

  function onUp(upEvent) {
    if (upEvent.pointerId !== pointerId) return;
    cleanup();
    tlDragInProgress = false;
    if (!moved) return;

    tlDragSuppressClick = true;

    if (upEvent.type === 'pointercancel' || targetIndex === originalIndex) {
      // Cancelled, or dropped back where it started — nothing to commit.
      finishDrag();
      return;
    }

    // Build the new full tab order: every neighbor in its existing
    // relative order, with the dragged tab spliced in at targetIndex.
    const newOrder = neighbors.map((n) => n.id);
    newOrder.splice(targetIndex, 0, tabId);

    finishDrag();

    // Apply immediately to the shared tab state so the popup AND the main
    // tab strip reflect the new order in the same frame, without waiting
    // on the round trip to the engine — both views read tabsState.tabs, so
    // updating it once here keeps them in lockstep. The active tab is
    // untouched (only order changes), and the authoritative
    // 'tabs-updated' event that follows reorderTabs() below will simply
    // confirm the same order.
    const byId = new Map(tabsState.tabs.map((t) => [t.id, t]));
    const reordered = newOrder.map((id) => byId.get(id)).filter(Boolean);
    // Safety net: if anything in tabsState.tabs wasn't accounted for above
    // (shouldn't happen — newOrder is built from the same live tab set —
    // but never silently drop a tab), append it preserving its old slot.
    for (const t of tabsState.tabs) { if (!newOrder.includes(t.id)) reordered.push(t); }
    tabsState.tabs = reordered;
    render();
    renderTabListPanel();

    window.browser.reorderTabs(newOrder);
  }

  function onKeyDown(keyEvent) {
    if (keyEvent.key !== 'Escape' || !moved) return;
    keyEvent.preventDefault();
    cleanup();
    tlDragInProgress = false;
    finishDrag();
  }
  window.addEventListener('keydown', onKeyDown);

  let rafId = null;
  let pendingMoveEvent = null;
  function queueMove(moveEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    pendingMoveEvent = moveEvent;
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      onMove(pendingMoveEvent);
    });
  }

  function cleanup() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    window.removeEventListener('pointermove', queueMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKeyDown);
    try { rowEl.releasePointerCapture(pointerId); } catch { /* already released */ }
  }

  try { rowEl.setPointerCapture(pointerId); } catch { /* not critical */ }
  window.addEventListener('pointermove', queueMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// ---------------------------------------------------------------------------
// Tab-list panel (button at the far left of the tab strip)
// ---------------------------------------------------------------------------
function renderTabListPanel() {
  const body = $('#tab-list-body');
  body.innerHTML = '';

  const newTabRow = document.createElement('button');
  newTabRow.type = 'button';
  newTabRow.className = 'tl-row tl-new-tab';
  newTabRow.setAttribute('role', 'menuitem');
  const newTabIcon = document.createElement('span');
  newTabIcon.className = 'tl-icon';
  newTabIcon.appendChild(createIcon('plus'));
  const newTabLabel = document.createElement('span');
  newTabLabel.className = 'tl-label';
  newTabLabel.textContent = 'New Tab';
  newTabRow.append(newTabIcon, newTabLabel);
  newTabRow.addEventListener('click', () => {
    window.browser.newTab();
    closePanel($('#tab-list-overlay'));
  });
  body.appendChild(newTabRow);
  const sep = document.createElement('div');
  sep.className = 'tl-sep';
  body.appendChild(sep);

  for (const tab of tabsState.tabs) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tl-row';
    row.classList.toggle('active', tab.id === tabsState.activeTabId);
    row.dataset.tabId = String(tab.id);
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(tab.id === tabsState.activeTabId));

    const icon = document.createElement('span');
    icon.className = 'tl-icon';
    if (!isInternalUrl(tab.url) && tab.favicon) {
      const img = document.createElement('img');
      img.src = tab.favicon;
      img.alt = '';
      img.addEventListener('error', () => { img.remove(); icon.appendChild(createIcon('globe')); });
      icon.appendChild(img);
    } else {
      icon.appendChild(createIcon(iconNameForUrl(tab.url)));
    }

    const label = document.createElement('span');
    label.className = 'tl-label';
    label.textContent = tab.loading ? 'Loading…' : (tab.title || 'New Tab');

    const closeBtn = document.createElement('span');
    closeBtn.className = 'tl-close';
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('aria-label', 'Close tab');
    closeBtn.appendChild(createIcon('close'));
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      window.browser.closeTab(tab.id);
    });

    row.append(icon, label, closeBtn);
    row.addEventListener('click', () => {
      // A drag that actually moved the row still fires a native 'click' on
      // mouseup (browsers don't suppress click-after-drag for mouse input
      // the way they do for touch) — swallow exactly that one click, same
      // pattern as the tab strip's own suppressNextClick.
      if (tlDragSuppressClick) { tlDragSuppressClick = false; return; }
      window.browser.switchTab(tab.id);
      closePanel($('#tab-list-overlay'));
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Pass the tab-list overlay as keepOverlay so opening this context
      // menu doesn't close the popup it was opened from underneath it —
      // see openTabContextMenu/openLocalMenu and the panel click-outside
      // listener above for how the two stay open together.
      openTabContextMenu(tab.id, event.clientX, event.clientY, $('#tab-list-overlay'));
    });
    row.addEventListener('pointerdown', (event) => beginTabListDrag(event, row, tab.id));
    body.appendChild(row);
  }
}

$('#tab-list-btn').addEventListener('click', () => {
  renderTabListPanel();
  togglePanel($('#tab-list-overlay'), $('#tab-list-btn'));
});


// ---------------------------------------------------------------------------
// Browser menu panel (the "⋯" button): Settings, zoom controls, full screen.
// Built once; the zoom row's live bits (percentage, enabled state) are
// refreshed every time the menu opens and whenever tab/zoom state changes.
// ---------------------------------------------------------------------------
let isFullscreenNow = false;

function buildBrowserMenu() {
  const body = $('#browser-menu-body');
  body.innerHTML = '';

  // Two side-by-side columns instead of one long scrolling list — see the
  // .menu-columns/.menu-col rules in styles.css. Every existing option,
  // icon, separator and the zoom row still exist exactly as before; only
  // which column each row is appended into is new, so the whole menu fits
  // without an internal scrollbar at normal window sizes.
  const columnsEl = document.createElement('div');
  columnsEl.className = 'menu-columns';
  const col1 = document.createElement('div');
  col1.className = 'menu-col';
  const divider = document.createElement('div');
  divider.className = 'menu-col-divider';
  divider.setAttribute('aria-hidden', 'true');
  const col2 = document.createElement('div');
  col2.className = 'menu-col';
  columnsEl.append(col1, divider, col2);
  body.appendChild(columnsEl);

  // Every action below acts on the CURRENT active tab, resolved fresh at
  // click time (not when the menu was built) — the menu can stay open
  // across a tab switch in principle, and even if it can't in practice,
  // reading tabsState.activeTabId lazily like this is simply correct.
  const activeTabId = () => tabsState.activeTabId;

  // `target` picks which column a row lands in; defaults to the first
  // column so existing call sites that don't care still work unchanged.
  function addItem({ icon, label, onClick, extra, className, target }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item ctx-item ${className || ''}`.trim();
    btn.setAttribute('role', 'menuitem');
    const iconSpan = document.createElement('span');
    iconSpan.className = 'menu-item-icon ctx-icon';
    if (icon) iconSpan.appendChild(createIcon(icon));
    const labelSpan = document.createElement('span');
    labelSpan.className = 'menu-item-label ctx-label';
    labelSpan.textContent = label;
    btn.append(iconSpan, labelSpan);
    if (extra) btn.appendChild(extra);
    if (onClick) btn.addEventListener('click', onClick);
    (target || col1).appendChild(btn);
    return btn;
  }

  function addSep(target) {
    const sep = document.createElement('div');
    sep.className = 'menu-sep ctx-sep';
    (target || col1).appendChild(sep);
  }

  // ---- New ---- (column 1)
  addItem({
    icon: 'plus',
    label: 'New Tab',
    target: col1,
    onClick: () => {
      window.browser.newTab();
      closeAllPanels();
    },
  });
  addItem({
    icon: 'window',
    label: 'New Window',
    target: col1,
    onClick: () => {
      window.browser.newWindow();
      closeAllPanels();
    },
  });

  addSep(col1);

  // ---- Navigation and browser pages ---- (column 1)
  addItem({
    icon: 'history',
    label: 'History',
    target: col1,
    onClick: () => {
      renderHistoryPanel();
      openPanel($('#history-overlay'), $('#settings-btn'));
    },
  });
  addItem({
    icon: 'download',
    label: 'Downloads',
    target: col1,
    onClick: () => {
      openPanel($('#downloads-overlay'), $('#downloads-btn'));
    },
  });
  addItem({
    icon: 'bookmark',
    label: 'Bookmarks',
    target: col1,
    onClick: () => {
      renderBookmarksManagerPanel();
      openPanel($('#bookmarks-manager-overlay'), $('#settings-btn'));
    },
  });

  addSep(col1);

  // ---- Zoom row: -  100%  + ----
  const zoomRow = document.createElement('div');
  zoomRow.className = 'menu-item menu-zoom-row';
  zoomRow.setAttribute('role', 'group');
  zoomRow.setAttribute('aria-label', 'Zoom');

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.type = 'button';
  zoomOutBtn.className = 'menu-zoom-btn';
  zoomOutBtn.setAttribute('aria-label', 'Zoom out');
  zoomOutBtn.appendChild(createIcon('minus'));
  zoomOutBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tabsState.activeTabId != null) window.browser.zoomOut(tabsState.activeTabId);
  });

  const zoomLabel = document.createElement('button');
  zoomLabel.type = 'button';
  zoomLabel.className = 'menu-zoom-label';
  zoomLabel.id = 'menu-zoom-label';
  zoomLabel.title = 'Reset zoom';
  zoomLabel.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tabsState.activeTabId != null) window.browser.zoomReset(tabsState.activeTabId);
  });

  const zoomInBtn = document.createElement('button');
  zoomInBtn.type = 'button';
  zoomInBtn.className = 'menu-zoom-btn';
  zoomInBtn.setAttribute('aria-label', 'Zoom in');
  zoomInBtn.appendChild(createIcon('plus'));
  zoomInBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tabsState.activeTabId != null) window.browser.zoomIn(tabsState.activeTabId);
  });

  zoomRow.append(zoomOutBtn, zoomLabel, zoomInBtn);
  col1.appendChild(zoomRow);

  addSep(col1);

  const fsBtn = addItem({
    icon: 'fullscreen',
    label: isFullscreenNow ? 'Exit Full Screen' : 'Full Screen',
    target: col1,
    onClick: () => window.browser.fullscreenToggle(),
  });
  fsBtn.id = 'menu-fullscreen-btn';

  addItem({
    icon: 'print',
    label: 'Print',
    target: col1,
    onClick: () => {
      const id = activeTabId();
      closeAllPanels();
      if (id != null) window.browser.printTab(id);
    },
  });

  // ---- Column 2 ----

  // Reachable here regardless of whether the bookmarks bar is currently
  // showing — the "sensible way to access its visibility options" once
  // "Never Show" (or an empty-bookmarks hide) has left nothing on the bar
  // itself to right-click.
  addItem({
    icon: 'folder',
    label: 'Bookmarks Bar',
    extra: createIcon('forward', 'menu-item-caret'),
    target: col2,
    onClick: (e) => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      openLocalMenu(bookmarksBarVisibilityItems(), rect.right, rect.top);
    },
  });

  addSep(col2);

  // ---- Page actions (act on the current tab's actual page) ----
  addItem({
    icon: 'file',
    label: 'Save Page As…',
    target: col2,
    onClick: () => {
      const id = activeTabId();
      if (id != null) window.browser.contextMenuAction('save-page', { tabId: id });
      closeAllPanels();
    },
  });
  addItem({
    icon: 'inspect',
    label: 'Inspect Element',
    target: col2,
    onClick: () => {
      const id = activeTabId();
      if (id != null) window.browser.contextMenuAction('open-devtools', { tabId: id });
      closeAllPanels();
    },
  });
  addItem({
    icon: 'view-source',
    label: 'View Page Source',
    target: col2,
    onClick: () => {
      const id = activeTabId();
      if (id != null) window.browser.contextMenuAction('view-source', { tabId: id });
      closeAllPanels();
    },
  });

  addSep(col2);

  // ---- Window ----
  addItem({
    icon: 'close',
    label: 'Close Current Tab',
    target: col2,
    onClick: () => {
      const id = activeTabId();
      closeAllPanels();
      if (id != null) window.browser.closeTab(id);
    },
  });
  addItem({
    icon: 'close',
    label: 'Exit',
    className: 'menu-item-danger',
    target: col2,
    onClick: () => {
      // Closes THIS window only — same as the window's own close button —
      // which already correctly quits the whole app once it's the last
      // window open (see window-all-closed in main.js). Not app.quit():
      // that would also tear down every OTHER open Gloza window, which
      // "Exit" on a single window should never do.
      window.browser.closeWindow();
    },
  });

  addSep(col2);

  addItem({
    icon: 'settings',
    label: 'Settings',
    target: col2,
    onClick: () => {
      closeAllPanels();
      window.browser.openSettings();
    },
  });
}

function refreshBrowserMenuLive() {
  const zoomLabel = $('#menu-zoom-label');
  if (zoomLabel) {
    const active = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
    zoomLabel.textContent = `${active ? active.zoomPercent ?? 100 : 100}%`;
  }
  const fsBtn = $('#menu-fullscreen-btn');
  if (fsBtn) fsBtn.querySelector('.menu-item-label').textContent = isFullscreenNow ? 'Exit Full Screen' : 'Full Screen';
}

buildBrowserMenu();

$('#settings-btn').addEventListener('click', () => {
  refreshBrowserMenuLive();
  togglePanel($('#browser-menu-overlay'), $('#settings-btn'));
});




// ---------------------------------------------------------------------------
// Tell main.js we're ready. This MUST be the last thing this script does —
// every ipcRenderer.on(...) listener above (onTabsUpdated, onPrefsUpdated,
// onWindowState, onContextMenu/onHideContextMenu) needs to already be
// registered before main.js responds, or whatever it sends back lands with
// nothing listening and is silently dropped. main.js uses this single
// signal — instead of guessing from load timing — to decide the first safe
// moment to create/attach this window's initial tab and push its starting
// prefs/window state. See the 'ui:ready' handler in main.js.
// ---------------------------------------------------------------------------
window.browser.notifyReady();
