// This page is loaded straight into a tab like any website, so almost
// everything below is normal web JS. The one exception is window.glozaHome —
// a narrow, privileged bridge exposed by home-preload.js ONLY while this tab
// is actually showing home.html (see that file, and the comment above
// pushHomeData in main.js). It is the real source of truth for the
// home-screen bookmark collection: a SEPARATE, independent set of up to 4
// bookmarks from the bookmark toolbar (bookmarksState in renderer.js) — see
// Section 2 of the Part 1 brief. Theme still arrives the old way, via
// window.__glozaHomeUpdate, pushed from main.js.

'use strict';

// ---- Things you'll probably want to edit ---------------------------------

// Where searches go. The search text is added to the end of this address.
let SEARCH_URL = 'https://www.google.com/search?q=';
try {
  const fromQuery = new URLSearchParams(window.location.search).get('searchUrlPrefix');
  if (fromQuery) SEARCH_URL = fromQuery;
} catch { /* keep default */ }

const MAX_HOME_BOOKMARKS = 4;

// ---- Search ---------------------------------------------------------------

document.getElementById('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  window.location.href = `${SEARCH_URL}${encodeURIComponent(query)}`;
});

// ---- Favicons ---------------------------------------------------------------
// Every tile loads its own icon independently (one <img>'s failure can never
// affect another's) and the card renders immediately with a Gloza-styled
// fallback (the site's first letter) so there is never a broken-image icon
// and favicon loading never blocks the grid from appearing. Successful loads
// are cached by hostname — in memory for this page's lifetime, and in
// localStorage so a hide/show cycle or a fresh home tab reuses them instead
// of re-downloading — so re-rendering (e.g. after an edit elsewhere) doesn't
// re-fetch icons that are already known good or known missing.
const FAVICON_CACHE_KEY = 'gloza:home:favicon-cache:v1';
const FAVICON_CACHE_MAX = 200;
let faviconCache = new Map(); // hostname -> true (known good) | false (known missing)

(function loadFaviconCache() {
  try {
    const raw = localStorage.getItem(FAVICON_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') faviconCache = new Map(Object.entries(obj));
  } catch { /* corrupt/unavailable storage — just start with an empty cache */ }
})();

function persistFaviconCache() {
  try {
    if (faviconCache.size > FAVICON_CACHE_MAX) {
      const entries = Array.from(faviconCache.entries()).slice(-FAVICON_CACHE_MAX);
      faviconCache = new Map(entries);
    }
    localStorage.setItem(FAVICON_CACHE_KEY, JSON.stringify(Object.fromEntries(faviconCache)));
  } catch { /* storage full/unavailable — caching is a pure optimization, safe to skip */ }
}

function faviconUrl(siteUrl) {
  try { return new URL('/favicon.ico', siteUrl).href; } catch { return null; }
}

function hostnameOf(siteUrl) {
  try { return new URL(siteUrl).hostname; } catch { return siteUrl; }
}

// ---- Bookmark tiles ---------------------------------------------------------

function createTile(bookmark, index) {
  const link = document.createElement('a');
  link.className = 'tile';
  link.href = bookmark.url;
  link.style.setProperty('--i', index);
  link.dataset.id = String(bookmark.id);

  const chip = document.createElement('span');
  chip.className = 'tile-icon';

  const letter = document.createElement('span');
  letter.className = 'tile-letter';
  letter.textContent = (bookmark.title || bookmark.url).charAt(0).toUpperCase();

  const img = document.createElement('img');
  img.className = 'tile-favicon';
  img.alt = '';
  img.decoding = 'async';

  const host = hostnameOf(bookmark.url);
  const known = faviconCache.get(host);
  if (known !== false) {
    const url = faviconUrl(bookmark.url);
    if (url) {
      img.addEventListener('load', () => {
        chip.classList.add('has-favicon');
        faviconCache.set(host, true);
        persistFaviconCache();
      });
      img.addEventListener('error', () => {
        img.remove(); // falls back to the letter, never a broken-image icon
        faviconCache.set(host, false);
        persistFaviconCache();
      });
      img.src = url;
    }
  } // else: known missing for this host — skip the network request, show the letter

  chip.append(letter, img);

  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = bookmark.title || bookmark.url;

  link.append(chip, name);

  link.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openBookmarkMenu(bookmark, event.clientX, event.clientY);
  });

  return link;
}

function createPlusTile(index) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tile tile-plus';
  btn.style.setProperty('--i', index);
  btn.setAttribute('aria-label', 'Add bookmark');

  const icon = document.createElement('span');
  icon.className = 'tile-plus-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  const label = document.createElement('span');
  label.className = 'tile-plus-label';
  label.textContent = 'Add bookmark';

  btn.append(icon, label);

  // Open the dialog on click only, and openBookmarkDialog() is itself a
  // no-op while a dialog is already open, so rapid/double clicks can't open
  // two at once or trigger anything underneath.
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openBookmarkDialog({ mode: 'create' });
  });

  return btn;
}

const tileContainer = document.getElementById('quick-links');
tileContainer.classList.add('hb-fixed-grid');

// Renders the ACTUAL saved home-screen collection: always exactly 4 slots,
// filled left-to-right with saved bookmarks (in their saved order) and a
// "+" card in every remaining slot. No full-page rerender needed elsewhere —
// this only swaps #quick-links' own children.
function renderSlots() {
  const frag = document.createDocumentFragment();
  const list = homeBookmarks.slice(0, MAX_HOME_BOOKMARKS);
  list.forEach((b, i) => frag.appendChild(createTile(b, i)));
  for (let i = list.length; i < MAX_HOME_BOOKMARKS; i++) frag.appendChild(createPlusTile(i));
  tileContainer.innerHTML = '';
  tileContainer.appendChild(frag);
}

let homeBookmarks = [];

function applyHomeBookmarks(list) {
  homeBookmarks = Array.isArray(list) ? list.slice(0, MAX_HOME_BOOKMARKS) : [];
  renderSlots();
  // The dialog may be open mid-edit when another window/tab changes the
  // collection (a move, a delete elsewhere) — if the item being edited no
  // longer exists, close the dialog rather than let Save fail against a
  // gone record.
  if (dialogState.open && dialogState.mode === 'edit') {
    const stillExists = homeBookmarks.some((b) => b.id === dialogState.editId);
    if (!stillExists) closeBookmarkDialog();
  }
  if (openMenuNode && !homeBookmarks.some((b) => b.id === openMenuNode.id)) closeBookmarkMenu();
}

// Never leave the page blank if the privileged bridge somehow isn't present
// (it always should be — see home-preload.js and its attachment in main.js).
function renderStarterFallback() {
  tileContainer.innerHTML = '';
  tileContainer.appendChild(createPlusTile(0));
}

if (window.glozaHome) {
  window.glozaHome.list().then(applyHomeBookmarks).catch(() => renderStarterFallback());
  window.glozaHome.onUpdated(applyHomeBookmarks);
} else {
  renderStarterFallback();
}

// ---- Add/Edit bookmark dialog ----------------------------------------------

const dialogOverlay = document.getElementById('hb-dialog-overlay');
const dialogForm = document.getElementById('hb-dialog');
const dialogTitleEl = document.getElementById('hb-dialog-title');
const fieldName = document.getElementById('hb-field-name');
const fieldUrl = document.getElementById('hb-field-url');
const dialogErrorEl = document.getElementById('hb-dialog-error');
const dialogSaveBtn = document.getElementById('hb-dialog-save');
const dialogCancelBtn = document.getElementById('hb-dialog-cancel');

const dialogState = { open: false, mode: 'create', editId: null, busy: false };

function showDialogError(message) {
  dialogErrorEl.textContent = message;
  dialogErrorEl.hidden = false;
}
function clearDialogError() {
  dialogErrorEl.hidden = true;
  dialogErrorEl.textContent = '';
  fieldName.classList.remove('hb-field-invalid');
  fieldUrl.classList.remove('hb-field-invalid');
}

function openBookmarkDialog({ mode, node } = {}) {
  if (dialogState.open) return; // ignore a second open while one is already up
  dialogState.open = true;
  dialogState.mode = mode;
  dialogState.editId = mode === 'edit' && node ? node.id : null;
  dialogState.busy = false;

  clearDialogError();
  dialogTitleEl.textContent = mode === 'edit' ? 'Edit bookmark' : 'Add bookmark';
  fieldName.value = mode === 'edit' && node ? (node.title || '') : '';
  fieldUrl.value = mode === 'edit' && node ? (node.url || '') : '';
  dialogSaveBtn.disabled = false;
  dialogSaveBtn.textContent = 'Save';

  dialogOverlay.classList.add('hb-open');
  dialogForm.classList.remove('hb-hide');
  dialogForm.classList.add('hb-show');
  requestAnimationFrame(() => fieldName.focus());
}

function closeBookmarkDialog() {
  if (!dialogState.open) return;
  dialogState.open = false;
  dialogForm.classList.remove('hb-show');
  dialogForm.classList.add('hb-hide');
  dialogForm.addEventListener('animationend', () => {
    if (!dialogState.open) {
      dialogOverlay.classList.remove('hb-open');
      dialogForm.classList.remove('hb-hide');
    }
  }, { once: true });
}

dialogCancelBtn.addEventListener('click', () => closeBookmarkDialog()); // never saves or modifies data
dialogOverlay.addEventListener('pointerdown', (event) => {
  if (event.target === dialogOverlay) closeBookmarkDialog();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && dialogState.open) closeBookmarkDialog();
});

// A quick client-side check so obviously-bad input shows an error without a
// round trip — the IPC handler re-validates authoritatively regardless (see
// isSafeBookmarkUrl in main.js), so this is a UX nicety, not the real guard.
function looksLikeUsableUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return false;
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) return false;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

dialogForm.addEventListener('submit', async (event) => {
  event.preventDefault(); // the only form this handler is bound to — no risk of catching an unrelated submit
  if (dialogState.busy) return; // guards against double-submit from a rapid double Enter/click
  clearDialogError();

  const name = fieldName.value.trim();
  const url = fieldUrl.value; // preserved verbatim on failure — never cleared below

  if (!name) {
    fieldName.classList.add('hb-field-invalid');
    showDialogError('Enter a name for this bookmark.');
    fieldName.focus();
    return;
  }
  if (!looksLikeUsableUrl(url)) {
    fieldUrl.classList.add('hb-field-invalid');
    showDialogError('Enter a valid website address (http or https).');
    fieldUrl.focus();
    return;
  }

  dialogState.busy = true;
  dialogSaveBtn.disabled = true;
  dialogSaveBtn.textContent = 'Saving…';
  try {
    const res = dialogState.mode === 'edit'
      ? await window.glozaHome.update(dialogState.editId, { title: name, url })
      : await window.glozaHome.add(name, url);

    if (!res || !res.ok) {
      const messages = {
        'invalid-url': 'Enter a valid website address.',
        'invalid-name': 'Enter a name for this bookmark.',
        'full': 'The home screen already has 4 bookmarks — remove one first.',
        'not-found': 'That bookmark was removed elsewhere. Try again.',
      };
      showDialogError((res && messages[res.error]) || "Couldn't save this bookmark. Try again.");
      if (res && res.list) applyHomeBookmarks(res.list); // reflect reality if capacity/ownership changed under us
      return; // leaves the dialog open, original data untouched
    }

    if (res.list) applyHomeBookmarks(res.list);
    closeBookmarkDialog();
  } catch {
    showDialogError("Couldn't save this bookmark. Try again.");
  } finally {
    dialogState.busy = false;
    dialogSaveBtn.disabled = false;
    dialogSaveBtn.textContent = 'Save';
  }
});

// ---- Toast ------------------------------------------------------------------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('hb-toast');
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('hb-toast-show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('hb-toast-show');
    setTimeout(() => { el.hidden = true; }, 200);
  }, 2600);
}

// ---- Right-click context menu + "Move" submenu -----------------------------
// Same visual language and interaction pattern as the bookmark toolbar's own
// context menu (openLocalMenu/openSubmenu in renderer.js) — necessarily a
// separate implementation, since home.html runs in its own renderer process
// with no shared JS module between the two — but both sides build on the
// same generic "list of rows, one of which can open a slide-out submenu"
// shape, so the two can't drift apart in BEHAVIOR, only in which process
// they execute in.

const SVG_NS = 'http://www.w3.org/2000/svg';
// Copied verbatim (same path data, same 24x24 viewBox) from the bookmark
// toolbar's own icon sprite (#i-file / #i-open-tab / #i-trash / #i-bookmark
// in index.html, used by openBookmarkContextMenu()/openLocalMenu() in
// renderer.js) so the home-screen menu's icons are pixel-for-pixel the same
// glyphs as the toolbar menu for the equivalent action — home.html runs in
// its own renderer process with no shared sprite to <use>, so the markup is
// duplicated here rather than referenced, but the drawn result must match:
// Edit… -> i-file, Move -> i-open-tab (the toolbar bookmark menu's own Move
// row uses this icon, not i-move), Delete -> i-trash, and the submenu's
// "Bookmark toolbar" destination -> i-bookmark (same icon the toolbar menu
// uses for its own "Home screen" destination row).
const ICONS = {
  edit: '<path d="M6.5 3h8l5 5v12a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
  // Same glyph, used both for the "Open"/"Open in New Tab" rows and the
  // "Move" row, exactly as on the bookmark toolbar's own context menu
  // (openBookmarkContextMenu in renderer.js) — see the comment above.
  move: '<rect x="2.5" y="6.5" width="14" height="14" rx="2"/><path d="M8 6.5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1.5"/>',
  'open-tab': '<rect x="2.5" y="6.5" width="14" height="14" rx="2"/><path d="M8 6.5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4A1.3 1.3 0 0 1 14.5 4.8V7M18 7l-.8 12.3a1.5 1.5 0 0 1-1.5 1.4H8.3a1.5 1.5 0 0 1-1.5-1.4L6 7"/>',
  bookmark: '<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.4-7 4.4V4.5a1 1 0 0 1 1-1z"/>',
};
function makeIconSpan(name) {
  const span = document.createElement('span');
  span.className = 'hb-item-icon';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = ICONS[name] || ICONS.edit;
  span.appendChild(svg);
  return span;
}

let openMenuNode = null;
let isMenuOpen = false;
let isSubmenuOpen = false;

// ---- Root cause of the freeze ----------------------------------------------
// openBookmarkMenu()/openSubmenu() do their positioning work inside a
// requestAnimationFrame callback (so offsetWidth/offsetHeight are real,
// post-layout numbers). That callback is asynchronous relative to the
// pointerenter/click handlers below. If the menu was opened, then closed
// again (e.g. the user's pointer grazed a non-submenu row) before that
// rAF had actually run, the *old* rAF callback would still fire later and
// unconditionally flip isSubmenuOpen/isMenuOpen back to true and re-apply
// 'hb-show' — even though the row that triggered it is long gone and the
// overlay had already been hidden. That left the full-viewport
// `.hb-menu-overlay` marked open (it intercepts pointer events) while the
// menu itself was never correctly positioned or visible: clicks landed on
// the invisible overlay and did nothing, which reads as the whole context
// menu "freezing." Rapid hovering across rows (exactly what happens when a
// user moves the pointer from "Move" toward the submenu) was the easiest
// way to trigger it.
//
// Fix: every open() call mints a token; its rAF callback checks the token
// is still current before touching the DOM or state, and every close()
// call bumps the token so any in-flight rAF from a superseded open()
// becomes a no-op instead of resurrecting a stale menu.
let menuOpenToken = 0;
let submenuOpenToken = 0;

// Crossing from the parent row into the submenu means briefly passing back
// over the parent menu's own hit area. Closing the submenu the instant the
// pointer leaves its anchor row (the old behavior) made that crossing feel
// broken — the submenu could vanish before the pointer ever reached it.
// A short grace period, cancelled the moment the pointer actually reaches
// the submenu or re-enters the anchor row, keeps it open for that transit
// without ever letting it linger once the user is clearly elsewhere.
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

// `isSubmenuRow` is true only for rows built for the submenu panel itself
// (openSubmenu, below) — never for rows on the top-level menu. Those are
// two different things: a top-level row that ISN'T "Move" schedules the
// submenu closed on hover (grace period so the pointer can travel
// diagonally into the submenu — see scheduleCloseSubmenu above). A row
// INSIDE the submenu is the submenu; hovering it must never schedule a
// close of its own panel. Matches the toolbar menu's openSubmenu() in
// renderer.js, which never attaches that listener to its own rows either.
function buildMenuRow(item, menuEl, isSubmenuRow) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hb-item' + (item.danger ? ' hb-item-danger' : '');
  btn.appendChild(makeIconSpan(item.icon));
  const label = document.createElement('span');
  label.className = 'hb-item-label';
  label.textContent = item.label;
  btn.appendChild(label);

  if (item.submenu) {
    const arrow = document.createElementNS(SVG_NS, 'svg');
    arrow.setAttribute('class', 'hb-item-arrow');
    arrow.setAttribute('viewBox', '0 0 16 16');
    arrow.innerHTML = '<path d="M5 2.5 10.5 8 5 13.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
    btn.appendChild(arrow);
    const open = () => {
      cancelScheduledSubmenuClose();
      menuEl.querySelectorAll('.hb-item-arrow-open').forEach((el) => el.classList.remove('hb-item-arrow-open'));
      btn.classList.add('hb-item-arrow-open');
      openSubmenu(item.submenu(), btn);
    };
    btn.addEventListener('pointerenter', open);
    btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  } else {
    if (!isSubmenuRow) {
      btn.addEventListener('pointerenter', () => {
        menuEl.querySelectorAll('.hb-item-arrow-open').forEach((el) => el.classList.remove('hb-item-arrow-open'));
        scheduleCloseSubmenu();
      });
    } else {
      // Entering a row that IS the submenu's own content always cancels
      // any pending grace-period close, same as entering the submenu
      // panel itself (see the #hb-submenu pointerenter listener below).
      btn.addEventListener('pointerenter', cancelScheduledSubmenuClose);
    }
    btn.addEventListener('click', () => {
      cancelScheduledSubmenuClose();
      closeBookmarkMenu();
      item.onClick();
    });
  }
  return btn;
}

function clampPosition(x, y, w, h) {
  const MARGIN = 8;
  const winW = window.innerWidth, winH = window.innerHeight;
  return {
    left: Math.max(MARGIN, Math.min(x, winW - w - MARGIN)),
    top: Math.max(MARGIN, Math.min(y, winH - h - MARGIN)),
  };
}

function openBookmarkMenu(node, x, y) {
  closeSubmenu();
  openMenuNode = node;
  const overlay = document.getElementById('hb-menu-overlay');
  const menu = document.getElementById('hb-menu');
  menu.innerHTML = '';

  // Mirrors the bookmark toolbar's own context menu (openBookmarkContextMenu
  // in renderer.js) item-for-item — same rows, same order, same icons — with
  // only "Move to Folder…" left out (the home screen has no folders).
  const items = [
    { label: 'Open', icon: 'open-tab', onClick: () => { window.location.href = node.url; } },
    { label: 'Open in New Tab', icon: 'open-tab', onClick: () => { window.open(node.url, '_blank'); } },
    { type: 'sep' },
    { label: 'Edit…', icon: 'edit', onClick: () => openBookmarkDialog({ mode: 'edit', node }) },
    {
      label: 'Move', icon: 'move',
      submenu: () => [{
        label: 'Bookmark toolbar',
        icon: 'bookmark',
        onClick: async () => {
          const res = await window.glozaHome.moveToToolbar(node.id);
          if (res && res.ok) {
            showToast(`Moved "${node.title || node.url}" to the bookmark toolbar.`);
            if (res.homeList) applyHomeBookmarks(res.homeList);
          } else {
            showToast("Couldn't move that bookmark. It's still on your home screen.");
          }
        },
      }],
    },
    { type: 'sep' },
    {
      label: 'Delete', icon: 'trash', danger: true,
      onClick: async () => {
        const res = await window.glozaHome.remove(node.id);
        if (res && res.ok && res.list) applyHomeBookmarks(res.list);
      },
    },
  ];

  for (const item of items) {
    if (item.type === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'hb-sep';
      menu.appendChild(sep);
      continue;
    }
    menu.appendChild(buildMenuRow(item, menu));
  }

  overlay.classList.add('hb-open');
  const token = ++menuOpenToken;
  requestAnimationFrame(() => {
    if (token !== menuOpenToken) return; // superseded by a close/reopen before this frame ran
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 80;
    const { left, top } = clampPosition(x, y, mw, mh);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.classList.remove('hb-hide');
    void menu.offsetWidth;
    menu.classList.add('hb-show');
    isMenuOpen = true;
  });
}

function closeBookmarkMenu() {
  closeSubmenu();
  menuOpenToken++; // invalidate any pending open() rAF so it can't resurrect a closed menu
  const overlay = document.getElementById('hb-menu-overlay');
  const menu = document.getElementById('hb-menu');
  if (!isMenuOpen) { overlay.classList.remove('hb-open'); return; }
  isMenuOpen = false;
  openMenuNode = null;
  menu.classList.remove('hb-show');
  menu.classList.add('hb-hide');
  menu.addEventListener('animationend', () => {
    if (!isMenuOpen) { overlay.classList.remove('hb-open'); menu.classList.remove('hb-hide'); }
  }, { once: true });
}

function openSubmenu(items, anchorBtn) {
  const overlay = document.getElementById('hb-submenu-overlay');
  const menu = document.getElementById('hb-submenu');
  menu.innerHTML = '';
  for (const item of items) menu.appendChild(buildMenuRow(item, menu, true));

  overlay.classList.add('hb-open');
  const token = ++submenuOpenToken;
  requestAnimationFrame(() => {
    if (token !== submenuOpenToken) return; // superseded by a close/reopen before this frame ran
    const rect = anchorBtn.getBoundingClientRect();
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 60;
    const MARGIN = 8;
    const winW = window.innerWidth;
    const spaceRight = winW - rect.right;
    const openLeft = spaceRight < mw + MARGIN && rect.left > mw + MARGIN;
    const left = openLeft ? rect.left - mw - 2 : Math.min(rect.right + 2, winW - mw - MARGIN);
    const top = Math.max(MARGIN, Math.min(rect.top, window.innerHeight - mh - MARGIN));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.classList.remove('hb-hide');
    void menu.offsetWidth;
    menu.classList.add('hb-show');
    isSubmenuOpen = true;
  });
}

function closeSubmenu() {
  cancelScheduledSubmenuClose();
  submenuOpenToken++; // invalidate any pending openSubmenu() rAF
  const overlay = document.getElementById('hb-submenu-overlay');
  const menu = document.getElementById('hb-submenu');
  if (!isSubmenuOpen) { overlay.classList.remove('hb-open'); return; }
  isSubmenuOpen = false;
  menu.classList.remove('hb-show');
  menu.classList.add('hb-hide');
  menu.addEventListener('animationend', () => {
    if (!isSubmenuOpen) { overlay.classList.remove('hb-open'); menu.classList.remove('hb-hide'); }
  }, { once: true });
}

// Reaching the submenu itself always cancels any pending grace-period close
// scheduled while the pointer was still crossing the gap from the anchor row.
document.getElementById('hb-submenu').addEventListener('pointerenter', cancelScheduledSubmenuClose);

document.addEventListener('pointerdown', (event) => {
  const menu = document.getElementById('hb-menu');
  const submenu = document.getElementById('hb-submenu');
  if (isMenuOpen && !menu.contains(event.target) && !submenu.contains(event.target)) closeBookmarkMenu();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isMenuOpen) closeBookmarkMenu();
});

// ---- Theme, pushed in by main.js (see pushHomeData in main.js) right after
// this page loads, and again any time it changes while this tab is still
// showing the start page. Home-screen bookmarks no longer travel this path
// (see window.glozaHome above) — only theming does now. ---------------------
// Home Screen Settings (Part 2) — applies the three new preferences exactly
// the way home.html's inline anti-FOUC script applies them on first paint
// (see that file), so a tab already sitting on the start page updates
// immediately when a setting changes elsewhere (Settings page, another
// window) without needing a reload. None of this touches homeBookmarks or
// renderSlots() above — visibility/background/gradient are purely cosmetic
// and never alter the saved collection.
function applyHomePreferences(data) {
  const root = document.documentElement;
  if (typeof data.showBookmarks === 'boolean') {
    root.dataset.bookmarksHidden = data.showBookmarks ? '0' : '1';
  }
  if (typeof data.showGradient === 'boolean') {
    root.dataset.gradient = data.showGradient ? 'on' : 'off';
  }
  if (data.bgMode) {
    root.dataset.bgMode = data.bgMode;
    // Only touch the variable actually relevant to the new mode — avoids
    // flashing a stale color under an image (or vice versa) for the one
    // frame before CSS re-evaluates which attribute is active.
    if (data.bgMode === 'color' && data.bgColor) {
      root.style.setProperty('--home-bg-color', data.bgColor);
    } else if (data.bgMode === 'image' && data.bgImageUrl) {
      root.style.setProperty('--home-bg-image', `url("${data.bgImageUrl}")`);
    }
  }
}

window.__glozaHomeUpdate = function (data) {
  if (!data) return;
  if (data.theme) document.documentElement.dataset.theme = data.theme;
  if (data.accent) document.documentElement.style.setProperty('--accent', data.accent);
  if (data.searchUrlPrefix) SEARCH_URL = data.searchUrlPrefix;
  applyHomePreferences(data);
};
