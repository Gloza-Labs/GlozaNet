// Runs inside settings.html. window.settingsAPI comes from settings-preload.js.

'use strict';

const SHAPES = ['rounded-top', 'pill', 'square'];
const THEMES = ['dark', 'light'];
const SEARCH_ENGINES = ['google', 'bing', 'duckduckgo', 'brave'];
const LINK_OPEN_MODES = ['new-tab', 'same-tab'];
const STARTUP_BEHAVIORS = ['blank', 'homepage', 'restore'];
const NEW_TAB_BEHAVIORS = ['blank', 'homepage'];

// Title Bar Mode isn't part of the "Save changes" batch below — it recreates
// every open window the instant you pick it (see window:setTitleBarMode in
// main.js), so it's applied immediately and only its own radio group reads
// it. We still keep it in `loadedPrefs` so Save doesn't accidentally wipe it
// back to the default (prefs:save replaces the whole prefs file, not a
// merge — see savePrefs in main.js).
let loadedPrefs = {
  accent: '#008200', tabShape: 'rounded-top', theme: 'dark', titleBarMode: 'custom',
  searchEngine: 'google', linkOpenMode: 'new-tab',
  // Part 3A — also applied immediately (see their own change handlers
  // below), carried here for the same "Save changes" shouldn't revert them
  // reason as the rest of this list.
  historyEnabled: true,
  clearOnExit: { history: false, downloads: false, cookies: false, cache: false },
  // Part 3B — all applied immediately via their own handlers below, carried
  // here only so "Save changes" (General/Appearance's batched button) can
  // never revert them, same reasoning as the rest of this list.
  homepage: '',
  startupBehavior: 'blank',
  newTabBehavior: 'blank',
  searchSuggestionsEnabled: true,
  defaultZoomPercent: 100,
  downloadDir: '',
  askWhereToSave: false,
  // Home Screen Settings (Part 2) — all applied immediately via their own
  // handlers in refreshHomeScreenPage()'s listeners below, carried here
  // only so this page's batched "Save changes" button (General/Appearance
  // only — Home Screen has none) can never revert them. Not used for
  // anything on this page beyond that bookkeeping.
  showHomeBookmarks: true,
  showTopGradient: true,
  homeBackgroundMode: 'default',
  homeBackgroundColor: 'charcoal',
  // Not shown anywhere on this page directly, but must stay an accurate
  // mirror of the real saved value for the same "Save changes shouldn't
  // revert it" reason as everything else in this object — see the
  // chooseBackgroundImage handler and refreshHomeScreenPage() below, the
  // only two places that know the real current value.
  homeBackgroundImageFile: '',
};

function currentValues() {
  return {
    accent: document.getElementById('accent-input').value,
    tabShape: document.querySelector('input[name="tab-shape"]:checked').value,
    theme: document.querySelector('input[name="theme"]:checked').value,
    titleBarMode: loadedPrefs.titleBarMode,
    searchEngine: document.querySelector('input[name="search-engine"]:checked').value,
    // Applied immediately (see the listener below) — carried along here only
    // so "Save changes" never reverts it.
    linkOpenMode: loadedPrefs.linkOpenMode,
  };
}

// Shows the choice immediately on this page (nothing is saved until you click Save).
// The preview strip's shape comes from theme.css via the data-tab-shape attribute.
function updatePreview(prefs) {
  document.documentElement.style.setProperty('--accent', prefs.accent);
  document.documentElement.dataset.theme = prefs.theme;
  document.getElementById('tab-preview-strip').dataset.tabShape = prefs.tabShape;
  document.getElementById('accent-hex').textContent = prefs.accent;
}

// Segmented controls (tab-shape, theme, title-bar mode — written to work for
// any future `.segmented` group): slides that group's `.segmented-indicator`
// under whichever label is checked, so switching options glides from the
// old position to the new one instead of popping there.
function positionIndicator(group, { animate = true } = {}) {
  const indicator = group.querySelector('.segmented-indicator');
  const checked = group.querySelector('input:checked');
  if (!indicator || !checked) return;
  const label = checked.closest('label');

  indicator.classList.toggle('no-anim', !animate);
  indicator.style.width = `${label.offsetWidth}px`;
  indicator.style.transform = `translateX(${label.offsetLeft}px)`;
  if (!animate) indicator.offsetHeight; // force layout so the next change animates
};

const segmentedGroups = document.querySelectorAll('.segmented');

segmentedGroups.forEach((group) => {
  group.addEventListener('change', (event) => {
    if (event.target.matches('input[type="radio"]')) positionIndicator(group);
  });
});

// Labels can reflow (window resize, font load); keep the indicator honest
// without animating it to its new spot.
window.addEventListener('resize', () => {
  segmentedGroups.forEach((group) => positionIndicator(group, { animate: false }));
});

async function init() {
  const prefs = await window.settingsAPI.get();
  loadedPrefs = { ...loadedPrefs, ...prefs };
  const shape = SHAPES.includes(loadedPrefs.tabShape) ? loadedPrefs.tabShape : 'rounded-top';
  const theme = THEMES.includes(loadedPrefs.theme) ? loadedPrefs.theme : 'dark';
  const titleBarMode = loadedPrefs.titleBarMode === 'native' ? 'native' : 'custom';

  document.getElementById('accent-input').value = loadedPrefs.accent;
  document.querySelector(`input[name="tab-shape"][value="${shape}"]`).checked = true;
  document.querySelector(`input[name="theme"][value="${theme}"]`).checked = true;
  document.querySelector(`input[name="titlebar-mode"][value="${titleBarMode}"]`).checked = true;
  const searchEngine = SEARCH_ENGINES.includes(loadedPrefs.searchEngine) ? loadedPrefs.searchEngine : 'google';
  document.querySelector(`input[name="search-engine"][value="${searchEngine}"]`).checked = true;

  const linkOpenMode = LINK_OPEN_MODES.includes(loadedPrefs.linkOpenMode) ? loadedPrefs.linkOpenMode : 'new-tab';
  document.querySelector(`input[name="link-open-mode"][value="${linkOpenMode}"]`).checked = true;

  // Part 3B — General page additions.
  const homepageMode = loadedPrefs.homepage ? 'custom' : 'gloza';
  document.querySelector(`input[name="homepage-mode"][value="${homepageMode}"]`).checked = true;
  document.getElementById('homepage-url-input').value = loadedPrefs.homepage || '';
  document.getElementById('homepage-url-row').hidden = homepageMode !== 'custom';

  const startupBehavior = STARTUP_BEHAVIORS.includes(loadedPrefs.startupBehavior) ? loadedPrefs.startupBehavior : 'blank';
  document.querySelector(`input[name="startup-behavior"][value="${startupBehavior}"]`).checked = true;

  const newTabBehavior = NEW_TAB_BEHAVIORS.includes(loadedPrefs.newTabBehavior) ? loadedPrefs.newTabBehavior : 'blank';
  document.querySelector(`input[name="newtab-behavior"][value="${newTabBehavior}"]`).checked = true;

  document.getElementById('search-suggestions-toggle').checked = loadedPrefs.searchSuggestionsEnabled !== false;

  // Part 3B — Appearance page addition.
  const zoomOptions = Array.from(document.getElementById('default-zoom-select').options).map((o) => Number(o.value));
  const zoom = zoomOptions.includes(loadedPrefs.defaultZoomPercent) ? loadedPrefs.defaultZoomPercent : 100;
  document.getElementById('default-zoom-select').value = String(zoom);

  updatePreview({ accent: loadedPrefs.accent, tabShape: shape, theme });
  segmentedGroups.forEach((group) => positionIndicator(group, { animate: false }));
}

document.getElementById('accent-input').addEventListener('input', () => {
  updatePreview(currentValues());
});

document.querySelectorAll('input[name="tab-shape"]').forEach((radio) => {
  radio.addEventListener('change', () => updatePreview(currentValues()));
});

document.querySelectorAll('input[name="theme"]').forEach((radio) => {
  radio.addEventListener('change', () => updatePreview(currentValues()));
});

// Title Bar Mode: applied the instant you pick it, independent of the Save
// button — picking it and then navigating away without saving shouldn't
// leave your windows in a mode the settings page itself still shows as
// unsaved.
document.querySelectorAll('input[name="titlebar-mode"]').forEach((radio) => {
  radio.addEventListener('change', async (event) => {
    loadedPrefs.titleBarMode = event.target.value;
    await window.settingsAPI.setTitleBarMode(event.target.value);
  });
});

// Default search engine: applied immediately (not gated behind "Save
// changes") since the URL bar's suggestion/search behavior should update
// the moment you pick a new engine, same reasoning as Title Bar Mode above.
document.querySelectorAll('input[name="search-engine"]').forEach((radio) => {
  radio.addEventListener('change', async (event) => {
    loadedPrefs.searchEngine = event.target.value;
    await window.settingsAPI.save(loadedPrefs);
  });
});

// Open links in a new tab / the same tab: applied immediately, like the
// search engine above. Uses its own merge-on-save IPC so it can't overwrite
// other prefs with this page's possibly-stale snapshot.
document.querySelectorAll('input[name="link-open-mode"]').forEach((radio) => {
  radio.addEventListener('change', async (event) => {
    loadedPrefs.linkOpenMode = event.target.value;
    await window.settingsAPI.setLinkOpenMode(event.target.value);
  });
});

// ---- Part 3B: Homepage / Startup / New tab / Search suggestions --------
// All applied immediately (not gated behind "Save changes"), same
// reasoning as search-engine/link-open-mode above.

function setHomepageError(message) {
  const el = document.getElementById('homepage-url-error');
  if (!el) return;
  el.textContent = message || 'Used by Startup and New tab below when either is set to "Homepage". Applies immediately.';
}

document.querySelectorAll('input[name="homepage-mode"]').forEach((radio) => {
  radio.addEventListener('change', async (event) => {
    const row = document.getElementById('homepage-url-row');
    if (event.target.value === 'gloza') {
      row.hidden = true;
      loadedPrefs.homepage = '';
      setHomepageError(null);
      await window.settingsAPI.setHomepage('');
    } else {
      row.hidden = false;
      document.getElementById('homepage-url-input').focus();
      // Nothing to save yet until a URL is actually typed — an empty
      // custom homepage would silently behave like "Gloza new-tab page"
      // anyway (see normalizeHomepageUrl/defaultNewTabUrl in main.js).
    }
  });
});

let homepageSaveTimer = null;
document.getElementById('homepage-url-input').addEventListener('input', (event) => {
  clearTimeout(homepageSaveTimer);
  homepageSaveTimer = setTimeout(async () => {
    try {
      const saved = await window.settingsAPI.setHomepage(event.target.value);
      loadedPrefs.homepage = saved;
      setHomepageError(null);
    } catch (err) {
      setHomepageError(`Couldn't save that URL: ${err.message || 'please try again'}.`);
    }
  }, 500);
});

document.querySelectorAll('input[name="startup-behavior"]').forEach((radio) => {
  radio.addEventListener('change', async (event) => {
    loadedPrefs.startupBehavior = event.target.value;
    await window.settingsAPI.setStartupBehavior(event.target.value);
  });
});

document.querySelectorAll('input[name="newtab-behavior"]').forEach((radio) => {
  radio.addEventListener('change', async (event) => {
    loadedPrefs.newTabBehavior = event.target.value;
    await window.settingsAPI.setNewTabBehavior(event.target.value);
  });
});

document.getElementById('search-suggestions-toggle').addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try {
    await window.settingsAPI.setSearchSuggestionsEnabled(next);
    loadedPrefs.searchSuggestionsEnabled = next;
  } catch {
    e.target.checked = !next;
  } finally {
    e.target.disabled = false;
  }
});

// ---- Part 3B: Default page zoom (Appearance) ----------------------------
document.getElementById('default-zoom-select').addEventListener('change', async (event) => {
  const saved = await window.settingsAPI.setDefaultZoomPercent(event.target.value);
  loadedPrefs.defaultZoomPercent = saved;
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const values = currentValues();
  loadedPrefs = { ...loadedPrefs, ...values };
  await window.settingsAPI.save(loadedPrefs);
  const msg = document.getElementById('saved-msg');
  msg.classList.add('visible');
  setTimeout(() => msg.classList.remove('visible'), 1800);
});

init();

// ============================================================================
// Settings reorganization (sidebar navigation across pages)
// ============================================================================

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Sidebar page navigation. Every existing control above stays exactly where
// it was in the DOM (inside one of the .settings-page sections) — this only
// shows/hides whole sections, it never re-creates or re-wires anything the
// original single-page settings.js already handled.
// ---------------------------------------------------------------------------
const navItems = document.querySelectorAll('.settings-nav-item');
const pages = document.querySelectorAll('.settings-page');

function showPage(name, focusId) {
  let matched = false;
  pages.forEach((p) => {
    const isMatch = p.dataset.page === name;
    p.hidden = !isMatch;
    if (isMatch) matched = true;
  });
  if (!matched) return showPage('general');
  navItems.forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.page === name)));
  // Root cause of the Theme/Tab-shape indicators showing only a sliver:
  // positionIndicator() measures `label.offsetWidth`/`offsetLeft`, which
  // are 0 for any element inside a `hidden` (display:none) ancestor. init()
  // positions every `.segmented-indicator` once, up front, while every page
  // except the initially-shown one is still `hidden` — so a group that
  // lives on a page other than the default ("general") gets permanently
  // stuck at width:0/left:0, no matter what's actually selected. The
  // General page's own segmented controls (search engine, link-open mode,
  // ...) never showed the bug because they're visible at that exact moment.
  // Re-measure every segmented group on the page we just revealed, now that
  // it actually has real layout to measure.
  const revealedPage = document.querySelector(`.settings-page[data-page="${name}"]`);
  revealedPage?.querySelectorAll('.segmented').forEach((group) => positionIndicator(group, { animate: false }));
  // Lazy-refresh the page we just switched to, straight from the real
  // backend — never stale/cached data left over from a previous visit.
  if (name === 'adblock') {
    refreshAdblockPage();
    // Resume polling only if diagnostics were already switched on and the
    // panel is visible — don't silently start polling the backend every
    // time this page merely gets reopened.
    if (!document.getElementById('adblock-diag-panel').hidden) { setDiagPolling(true); refreshDiagnostics(); }
  } else {
    // Leaving the page: stop the diagnostics poll so Settings doesn't keep
    // pulling the ring buffer over IPC while the panel isn't even visible.
    setDiagPolling(false);
  }
  if (name === 'website-appearance') refreshDarkModePage();
  else if (name === 'privacy') refreshPrivacyPage();
  else if (name === 'downloads') refreshDownloadsPage();
  else if (name === 'home-screen') refreshHomeScreenPage();
  else if (name === 'about') refreshAboutPage();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) requestAnimationFrame(() => { el.focus(); el.closest('.ctx-item-block')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  }
}

navItems.forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

// Deep-linking: a freshly-created Settings tab gets its target via the
// page's own query string (?page=…), set by createSettingsTab in main.js —
// no race against any listener here. An already-open tab instead gets a
// live 'settings:navigate' event.
function applyNavOpts(opts) {
  if (!opts || !opts.page) return;
  showPage(opts.page);
}
window.settingsAPI.onNavigate((opts) => applyNavOpts(opts));


// ---------------------------------------------------------------------------
// Initial page: query string (fresh tab, see createSettingsTab in main.js)
// wins over the default General page.
// ---------------------------------------------------------------------------
(() => {
  const params = new URLSearchParams(location.search);
  const initialPage = params.get('page');
  if (initialPage) {
    applyNavOpts({ page: initialPage });
  }
})();

// ============================================================================
// Ad Blocker page — every value here comes straight from
// window.settingsAPI.adblock.* (same main-process backend the shield popup
// in renderer.js talks to), never hardcoded, per the Part 2 brief.
// ============================================================================

let adblockPageStatus = null;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatRelativeTime(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function setAdblockError(message) {
  const banner = document.getElementById('adblock-error-banner');
  if (!banner) return;
  if (message) { banner.hidden = false; banner.textContent = message; }
  else { banner.hidden = true; banner.textContent = ''; }
}

function renderAdblockPage(status) {
  if (!status) return;
  adblockPageStatus = status;

  const enabledToggle = document.getElementById('adblock-enabled-toggle');
  enabledToggle.checked = Boolean(status.enabled);

  const navBadge = document.getElementById('adblock-nav-badge');
  navBadge.hidden = Boolean(status.enabled);

  // Method 1 / Method 2 — each reflects its OWN real state from the main
  // process (status.networkFilterEnabled / status.youtubeAdSkipEnabled),
  // never inferred from `status.enabled` or from each other. When the
  // master switch is off, both are shown disabled (can't be meaningfully
  // toggled) but keep showing their real underlying value, not a fake
  // "off" — per "avoid falsely displaying an enabled state when the
  // mechanism has failed," the inverse also applies: don't falsely show a
  // real per-method setting as off just because the master switch masks it.
  const method1Toggle = document.getElementById('adblock-method1-toggle');
  const method2Toggle = document.getElementById('adblock-method2-toggle');
  if (method1Toggle) {
    method1Toggle.checked = Boolean(status.networkFilterEnabled);
    method1Toggle.disabled = !status.enabled;
  }
  if (method2Toggle) {
    method2Toggle.checked = Boolean(status.youtubeAdSkipEnabled);
    method2Toggle.disabled = !status.enabled;
  }
  const method1Meta = document.getElementById('adblock-method1-meta');
  if (method1Meta) {
    method1Meta.textContent = !status.enabled
      ? 'Blocks YouTube\u2019s ad/tracking requests at the network level. Turn on \u201cBlock ads and trackers\u201d above to control this.'
      : (status.networkFilterEnabled
        ? 'On \u2014 blocking YouTube\u2019s ad/tracking requests (and third-party ad networks) at the network level, via the filter lists below.'
        : 'Off \u2014 YouTube\u2019s ad/tracking requests are not being blocked at the network level right now.');
  }
  const method2Meta = document.getElementById('adblock-method2-meta');
  if (method2Meta) {
    // The real, observed result of the early (pre-page-script) player-patch
    // layer -- not inferred from the toggle. If it genuinely failed to
    // attach (e.g. the CDP debugger API refused, or something else already
    // has a debugger attached to that tab), say so plainly rather than
    // implying everything is working: Method 2 then falls back to its
    // DOM skip/hide layer only, which is strictly weaker (can't stop a
    // non-skippable ad from starting).
    const eps = status.youtubeEarlyPatchStatus;
    let early = '';
    if (status.enabled && status.youtubeAdSkipEnabled && eps && eps.attempted) {
      early = eps.ok
        ? ' The early player-patch layer (stops most ads before they\u2019re scheduled) is attached and running.'
        : ` The early player-patch layer failed to attach (${eps.error || 'unknown error'}) \u2014 falling back to Skip-button/overlay handling only.`;
    }
    method2Meta.textContent = (!status.enabled
      ? 'Auto-clicks the native Skip button and hides ad overlays on YouTube. Turn on \u201cBlock ads and trackers\u201d above to control this.'
      : (status.youtubeAdSkipEnabled
        ? 'On \u2014 auto-clicking the native Skip button and hiding ad overlays, in the main player and embedded players.'
        : 'Off \u2014 the native Skip button is not being auto-clicked and ad overlays are not being hidden right now.')) + early;
  }

  // Filter lists
  const listsWrap = document.getElementById('adblock-lists');
  listsWrap.innerHTML = '';
  for (const list of status.lists) {
    const row = document.createElement('div');
    row.className = 'set-list-row';
    const metaBits = [];
    if (list.lastError) metaBits.push(`Update failed: ${escapeHtml(list.lastError)}`);
    else metaBits.push(`Updated ${formatRelativeTime(list.lastSuccessfulUpdate)}`);
    // Defensive `?? 0`: ruleCounts.network is expected to always be a
    // number (see filterlist-manager.js's validateListText), but this
    // render must never crash the whole Settings → Ad Blocker page over
    // a single list's possibly-stale/odd-shaped persisted ruleCounts
    // (e.g. an older adblock.json written before this field existed).
    // FIXED this round: the old code only ever appended a "rules" bit when
    // `list.ruleCounts` was truthy — a list whose count genuinely
    // couldn't be computed (ruleCounts still null, e.g. the engine failed
    // to load) silently showed NOTHING here, which read as fine/complete
    // rather than "unknown." Report that state honestly instead (see
    // filterlist-manager.js's recomputeRuleCounts) — only a list with no
    // active text at all (never seeded/downloaded) has nothing to say.
    if (list.ruleCounts) metaBits.push(`${(list.ruleCounts.network ?? 0).toLocaleString()} rules`);
    else if (list.source) metaBits.push('rule count unavailable');
    row.innerHTML = `
      <label class="set-switch">
        <input type="checkbox" data-list-id="${escapeHtml(list.id)}" class="adblock-list-toggle" ${list.enabled ? 'checked' : ''} />
        <span class="set-switch-track" aria-hidden="true"><span class="set-switch-thumb"></span></span>
      </label>
      <div class="set-list-main">
        <span class="set-list-title">${escapeHtml(list.label)}</span>
        <span class="set-list-meta ${list.lastError ? 'set-list-meta-error' : ''}">${metaBits.join(' · ')}</span>
      </div>
      <div class="set-list-actions">
        <button type="button" class="set-text-btn adblock-list-update-btn" data-list-id="${escapeHtml(list.id)}">Update</button>
      </div>`;
    listsWrap.appendChild(row);
  }
  listsWrap.querySelectorAll('.adblock-list-toggle').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const listId = e.target.dataset.listId;
      e.target.disabled = true;
      try {
        const res = await window.settingsAPI.adblock.setListEnabled(listId, e.target.checked);
        if (!res?.ok) throw new Error(res?.reason || 'failed');
        setAdblockError(null);
      } catch (err) {
        e.target.checked = !e.target.checked;
        setAdblockError(`Couldn't change that filter list: ${err.message || 'please try again'}.`);
      } finally {
        e.target.disabled = false;
      }
    });
  });
  listsWrap.querySelectorAll('.adblock-list-update-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const listId = e.target.dataset.listId;
      e.target.disabled = true;
      e.target.textContent = 'Updating…';
      try {
        const results = await window.settingsAPI.adblock.updateLists({ listId, force: true });
        const result = results?.[listId];
        if (result && !result.ok) setAdblockError(`${listId}: ${result.reason || 'update failed'}`);
        else setAdblockError(null);
      } catch (err) {
        setAdblockError(`Couldn't update that list: ${err.message || 'please try again'}.`);
      } finally {
        refreshAdblockPage();
      }
    });
  });

  // Exceptions
  const excWrap = document.getElementById('adblock-exceptions-list');
  renderExceptionList(excWrap, status.exceptions || [], async (host) => {
    const res = await window.settingsAPI.adblock.removeException(host);
    if (!res?.ok) setAdblockError("Couldn't remove that exception — please try again.");
    else { setAdblockError(null); refreshAdblockPage(); }
  });

  // Stats
  const stats = status.stats || {};
  document.getElementById('adblock-stat-session').textContent = String(stats.session ?? 0);
  document.getElementById('adblock-stat-alltime').textContent = String(stats.allTime ?? 0);
  // BUG (found in this audit): this read `status.engineStats?.totalUnsupported`,
  // a field the RETIRED homegrown parser used to populate — the current
  // @ghostery/adblocker-electron-backed engine (engine.js) has no concept
  // of a separate "unsupported rule" bucket and never sets this field, so
  // `?? 0` silently made this stat permanently read "0" regardless of
  // reality, a dead/misleading display. Repurposed to show the real,
  // live total of compiled rules actually active in the engine
  // (network + cosmetic), which engineStats genuinely does report.
  const activeRules = (status.engineStats?.totalNetworkRules ?? 0) + (status.engineStats?.totalCosmeticRules ?? 0);
  document.getElementById('adblock-stat-active-rules').textContent = activeRules.toLocaleString();

  // "Updated X ago" doesn't apply when a list has literally never updated.
  const lastSuccessAny = status.lists.some((l) => l.lastSuccessfulUpdate);
  document.getElementById('adblock-advanced-desc').textContent = lastSuccessAny
    ? 'Cosmetic (element-hiding) rules are applied automatically wherever the active filter lists include them — there\u2019s no separate toggle because there\u2019s nothing extra to turn on.'
    : 'Cosmetic (element-hiding) rules are applied automatically once filter lists finish their first update.';
}

// Shared by both the ad-blocker and dark-mode exception lists: renders a
// sorted list of hostnames with a Remove button per row, or an empty note.
function renderExceptionList(container, hostnames, onRemove) {
  container.innerHTML = '';
  if (!hostnames.length) {
    const note = document.createElement('div');
    note.className = 'set-empty-note';
    note.textContent = 'No exceptions yet.';
    container.appendChild(note);
    return;
  }
  for (const host of hostnames) {
    const row = document.createElement('div');
    row.className = 'set-list-row';
    row.innerHTML = `
      <div class="set-list-main"><span class="set-list-title">${escapeHtml(host)}</span></div>
      <div class="set-list-actions">
        <button type="button" class="set-text-btn set-text-btn-danger set-exc-remove-btn">Remove</button>
      </div>`;
    row.querySelector('.set-exc-remove-btn').addEventListener('click', () => onRemove(host));
    container.appendChild(row);
  }
}

async function refreshAdblockPage() {
  try {
    const [status, exceptions, stats] = await Promise.all([
      window.settingsAPI.adblock.getStatus(),
      window.settingsAPI.adblock.listExceptions(),
      window.settingsAPI.adblock.getStats(null),
    ]);
    renderAdblockPage({ ...status, exceptions, stats });
    setAdblockError(null);
  } catch (err) {
    setAdblockError(`Couldn't load ad blocker status: ${err.message || 'please try again'}.`);
  }
}

document.getElementById('adblock-enabled-toggle').addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try { await window.settingsAPI.adblock.setEnabled(next); setAdblockError(null); }
  catch (err) { e.target.checked = !next; setAdblockError(`Couldn't change protection: ${err.message || 'please try again'}.`); }
  finally { e.target.disabled = false; refreshAdblockPage(); }
});

document.getElementById('adblock-method1-toggle')?.addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try { await window.settingsAPI.adblock.setNetworkFilterEnabled(next); setAdblockError(null); }
  catch (err) { e.target.checked = !next; setAdblockError(`Couldn't change Method 1 (network filter blocking): ${err.message || 'please try again'}.`); }
  finally { refreshAdblockPage(); }
});

document.getElementById('adblock-method2-toggle')?.addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try { await window.settingsAPI.adblock.setYoutubeAdSkipEnabled(next); setAdblockError(null); }
  catch (err) { e.target.checked = !next; setAdblockError(`Couldn't change Method 2 (YouTube-specific blocking): ${err.message || 'please try again'}.`); }
  finally { refreshAdblockPage(); }
});

document.getElementById('adblock-reset-stats-btn').addEventListener('click', async () => {
  if (!window.confirm('Reset ad blocker statistics? This only clears the counts shown here.')) return;
  try { await window.settingsAPI.adblock.resetStats(); setAdblockError(null); }
  catch (err) { setAdblockError(`Couldn't reset statistics: ${err.message || 'please try again'}.`); }
  finally { refreshAdblockPage(); }
});

document.getElementById('adblock-update-all-btn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Updating…';
  try { await window.settingsAPI.adblock.updateLists({ force: true }); setAdblockError(null); }
  catch (err) { setAdblockError(`Couldn't update filter lists: ${err.message || 'please try again'}.`); }
  finally { e.target.disabled = false; e.target.textContent = 'Update all now'; refreshAdblockPage(); }
});

document.getElementById('adblock-restore-defaults-btn').addEventListener('click', async () => {
  if (!window.confirm('Restore the default ad blocker configuration? This re-enables every filter list but keeps your site exceptions.')) return;
  try { await window.settingsAPI.adblock.restoreDefaults(); setAdblockError(null); }
  catch (err) { setAdblockError(`Couldn't restore defaults: ${err.message || 'please try again'}.`); }
  finally { refreshAdblockPage(); }
});

document.getElementById('adblock-clear-exceptions-btn').addEventListener('click', async () => {
  if (!window.confirm('Remove all website exceptions? Protection will resume on every site you had paused it on.')) return;
  try { await window.settingsAPI.adblock.clearExceptions(); setAdblockError(null); }
  catch (err) { setAdblockError(`Couldn't clear exceptions: ${err.message || 'please try again'}.`); }
  finally { refreshAdblockPage(); }
});

// ---- Diagnostics (Part 2 §2) -------------------------------------------
// Off by default (zero overhead until a developer opens this page and
// flips it on) — see src/adblock/index.js's _diagEnabled/_diagLog for the
// backend side of the same contract.
let diagPollTimer = null;

function renderDiagTable(entries) {
  const table = document.getElementById('adblock-diag-table');
  const count = document.getElementById('adblock-diag-count');
  count.textContent = `${entries.length} recent request${entries.length === 1 ? '' : 's'}`;
  if (!entries.length) {
    table.innerHTML = '<div class="set-empty-note">No requests recorded yet — browse to a page with protection on.</div>';
    return;
  }
  const rows = entries.map((e) => {
    const verdict = e.blocked ? 'Blocked' : (e.exception ? 'Allowed (exception)' : 'Allowed');
    const verdictClass = e.blocked ? 'set-diag-blocked' : 'set-diag-allowed';
    const time = new Date(e.time).toLocaleTimeString();
    return `
      <div class="set-diag-row">
        <span class="set-diag-verdict ${verdictClass}">${escapeHtml(verdict)}</span>
        <span class="set-diag-url" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</span>
        <span class="set-diag-type">${escapeHtml(e.resourceType || 'other')}</span>
        <span class="set-diag-initiator">${escapeHtml(e.initiator || '—')}</span>
        <span class="set-diag-rule" title="${escapeHtml(e.matchedRule || '')}">${escapeHtml(e.matchedRule || e.reason || '—')}</span>
        <span class="set-diag-time">${escapeHtml(time)}</span>
      </div>`;
  });
  table.innerHTML = rows.join('');
}

async function refreshDiagnostics() {
  try {
    const diag = await window.settingsAPI.adblock.getDiagnostics(200);
    renderDiagTable(diag.entries || []);
  } catch {
    /* best-effort — the panel just stays at whatever it last showed */
  }
}

function setDiagPolling(on) {
  if (diagPollTimer) { clearInterval(diagPollTimer); diagPollTimer = null; }
  if (on) diagPollTimer = setInterval(refreshDiagnostics, 2000);
}

const diagToggle = document.getElementById('adblock-diag-toggle');
const diagPanel = document.getElementById('adblock-diag-panel');
diagToggle.addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try {
    await window.settingsAPI.adblock.setDiagnosticsEnabled(next);
    diagPanel.hidden = !next;
    setDiagPolling(next);
    if (next) refreshDiagnostics();
    else renderDiagTable([]);
  } catch (err) {
    e.target.checked = !next;
    setAdblockError(`Couldn't change diagnostics: ${err.message || 'please try again'}.`);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('adblock-diag-refresh-btn').addEventListener('click', refreshDiagnostics);

document.getElementById('adblock-diag-clear-btn').addEventListener('click', async () => {
  try { await window.settingsAPI.adblock.clearDiagnostics(); renderDiagTable([]); }
  catch (err) { setAdblockError(`Couldn't clear diagnostics: ${err.message || 'please try again'}.`); }
});

// Diagnostics are process-local state (never persisted), so the toggle
// always starts unchecked/hidden on a fresh page load/reopen rather than
// trying to resurrect a prior session's panel.

function wireAddExceptionRow(inputId, addBtnId, addFn) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(addBtnId);
  const submit = async () => {
    const raw = input.value.trim();
    if (!raw) return;
    btn.disabled = true;
    try {
      await addFn(raw);
      input.value = '';
    } catch (err) {
      setAdblockError(`Couldn't add "${raw}": ${err.message || 'please check the address and try again'}.`);
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

wireAddExceptionRow('adblock-exception-input', 'adblock-exception-add-btn', async (host) => {
  const res = await window.settingsAPI.adblock.setSiteException(host, true);
  if (!res?.ok) throw new Error(res?.reason || 'invalid address');
  refreshAdblockPage();
});

window.settingsAPI.adblock.onUpdated(() => {
  // Only re-render if the Ad Blocker page is the one currently visible —
  // cheap guard against doing DOM work on a hidden page.
  const page = document.querySelector('.settings-page[data-page="adblock"]');
  if (page && !page.hidden) refreshAdblockPage();
  const badge = document.getElementById('adblock-nav-badge');
  if (badge) window.settingsAPI.adblock.getStatus().then((s) => { badge.hidden = Boolean(s?.enabled); }).catch(() => {});
});


// ============================================================================
// Website Appearance page — Force dark mode on websites.
// ============================================================================

function setDarkModeError(message) {
  // Reuses the same ad-blocker error banner styling via a tiny inline
  // fallback if this page ever needs its own banner; for now, surface
  // errors the same lightweight way the shield popup does (console +
  // reverted control state), since Force Dark Mode has no destructive
  // network operations the way filter-list updates do.
  if (message) console.warn('[darkmode]', message);
}

async function refreshDarkModePage() {
  try {
    const [status] = await Promise.all([window.settingsAPI.darkmode.getStatus()]);
    document.getElementById('force-dark-toggle').checked = Boolean(status.enabled);
    renderExceptionList(document.getElementById('dark-exceptions-list'), status.exceptions || [], async (host) => {
      await window.settingsAPI.darkmode.removeException(host);
      refreshDarkModePage();
    });
  } catch (err) {
    setDarkModeError(err.message);
  }
}

document.getElementById('force-dark-toggle').addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try { await window.settingsAPI.darkmode.setEnabled(next); }
  catch (err) { e.target.checked = !next; setDarkModeError(err.message); }
  finally { e.target.disabled = false; }
});

wireAddExceptionRow('dark-exception-input', 'dark-exception-add-btn', async (host) => {
  const res = await window.settingsAPI.darkmode.setSiteException(host, true);
  if (!res?.ok) throw new Error(res?.reason || 'invalid address');
  refreshDarkModePage();
});

window.settingsAPI.darkmode.onUpdated(() => {
  const page = document.querySelector('.settings-page[data-page="website-appearance"]');
  if (page && !page.hidden) refreshDarkModePage();
});


// ============================================================================
// Privacy & History page (Part 3A) — history recording toggle, manual
// time-range/full clears, and the clear-on-exit checkboxes. Every value
// here comes from window.settingsAPI.privacy.* (main.js's real prefs +
// history store — see history:* / prefs:setHistoryEnabled /
// prefs:setClearOnExit in main.js), nothing hardcoded.
// ============================================================================

function setPrivacyError(message) {
  const banner = document.getElementById('privacy-error-banner');
  if (!banner) return;
  if (message) { banner.hidden = false; banner.textContent = message; }
  else { banner.hidden = true; banner.textContent = ''; }
}

async function refreshPrivacyPage() {
  try {
    // Fetched independently of `loadedPrefs` (rather than relying on it)
    // so this page is correct even if it's the very first one shown — the
    // query-string deep-link (see the IIFE below) can call showPage()
    // before init()'s own prefs fetch has resolved.
    const [count, clearOnExit, prefs] = await Promise.all([
      window.settingsAPI.privacy.getHistoryCount(),
      window.settingsAPI.privacy.getClearOnExit(),
      window.settingsAPI.get(),
    ]);
    document.getElementById('history-count-desc').textContent =
      count === 0 ? 'No browsing history yet.' : `${count.toLocaleString()} ${count === 1 ? 'entry' : 'entries'} saved.`;

    const co = { history: false, downloads: false, cookies: false, cache: false, ...(clearOnExit || {}) };
    document.querySelectorAll('.exit-clear-check').forEach((input) => {
      input.checked = Boolean(co[input.dataset.key]);
    });
    document.getElementById('history-enabled-toggle').checked = prefs.historyEnabled !== false;
    loadedPrefs.historyEnabled = prefs.historyEnabled !== false; // keep Save in sync too
    setPrivacyError(null);
  } catch (err) {
    setPrivacyError(`Couldn't load privacy settings: ${err.message || 'please try again'}.`);
  }
}

document.getElementById('history-enabled-toggle').addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try {
    await window.settingsAPI.privacy.setHistoryEnabled(next);
    loadedPrefs.historyEnabled = next; // keep "Save changes" from reverting this
    setPrivacyError(null);
  } catch (err) {
    e.target.checked = !next;
    setPrivacyError(`Couldn't change history recording: ${err.message || 'please try again'}.`);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('privacy-manage-history-btn').addEventListener('click', () => {
  window.settingsAPI.privacy.openHistoryPanel();
});

const RANGE_LABELS = {
  hour: 'the last hour',
  today: "today's",
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  all: 'all',
};

document.querySelectorAll('[data-range]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const range = btn.dataset.range;
    const label = RANGE_LABELS[range] || 'that';
    const confirmMsg = range === 'all'
      ? "Clear all browsing history? This can't be undone."
      : `Clear browsing history for ${label} range? This can't be undone.`;
    if (!window.confirm(confirmMsg)) return;
    btn.disabled = true;
    try {
      if (range === 'all') await window.settingsAPI.privacy.clearAllHistory();
      else await window.settingsAPI.privacy.clearHistoryRange(range);
      setPrivacyError(null);
    } catch (err) {
      setPrivacyError(`Couldn't clear history: ${err.message || 'please try again'}.`);
    } finally {
      btn.disabled = false;
      refreshPrivacyPage();
    }
  });
});

document.querySelectorAll('.exit-clear-check').forEach((input) => {
  input.addEventListener('change', async (e) => {
    const key = e.target.dataset.key;
    const next = e.target.checked;
    e.target.disabled = true;
    try {
      const saved = await window.settingsAPI.privacy.setClearOnExit({ [key]: next });
      // Same reasoning as titleBarMode/searchEngine/linkOpenMode above:
      // this is applied immediately, outside the "Save changes" flow, so
      // loadedPrefs has to be kept in sync or a later click of that button
      // would silently revert it to whatever it was when this page loaded.
      loadedPrefs.clearOnExit = saved;
      setPrivacyError(null);
    } catch (err) {
      e.target.checked = !next;
      setPrivacyError(`Couldn't save that: ${err.message || 'please try again'}.`);
    } finally {
      e.target.disabled = false;
    }
  });
});


// ============================================================================
// Settings search (§6) — finds real, navigable settings only. Each entry
// points at an actual page + control id; picking a result opens that page
// and focuses the real control, never a decorative/dead-end result.
// ============================================================================

const SEARCH_INDEX = [
  { label: 'Search engine', category: 'General', page: 'general', focusId: null },
  { label: 'Open links in a new tab', category: 'General', page: 'general', focusId: null },
  { label: 'Title bar style', category: 'General', page: 'general', focusId: null },
  { label: 'Accent color', category: 'Appearance', page: 'appearance', focusId: 'accent-input' },
  { label: 'Tab shape', category: 'Appearance', page: 'appearance', focusId: null },
  { label: 'Dark / light theme', category: 'Appearance', page: 'appearance', focusId: null },
  { label: 'Force dark mode on websites', category: 'Website Appearance', page: 'website-appearance', focusId: 'force-dark-toggle' },
  { label: 'Dark mode site exceptions', category: 'Website Appearance', page: 'website-appearance', focusId: 'dark-exception-input' },
  { label: 'Save browsing history', category: 'Privacy & History', page: 'privacy', focusId: 'history-enabled-toggle' },
  { label: 'Manage history', category: 'Privacy & History', page: 'privacy', focusId: 'privacy-manage-history-btn' },
  { label: 'Clear browsing history', category: 'Privacy & History', page: 'privacy', focusId: 'privacy-clear-all-btn' },
  { label: 'Clear on exit', category: 'Privacy & History', page: 'privacy', focusId: 'exit-clear-history' },
  { label: 'Clear cookies and website data', category: 'Privacy & History', page: 'privacy', focusId: 'exit-clear-cookies' },
  { label: 'Clear cached website data', category: 'Privacy & History', page: 'privacy', focusId: 'exit-clear-cache' },
  { label: 'Block ads and trackers', category: 'Ad Blocker', page: 'adblock', focusId: 'adblock-enabled-toggle' },
  { label: 'Ad blocker filter lists', category: 'Ad Blocker', page: 'adblock', focusId: null },
  { label: 'Ad blocker website exceptions', category: 'Ad Blocker', page: 'adblock', focusId: 'adblock-exception-input' },
  { label: 'Ad blocker statistics', category: 'Ad Blocker', page: 'adblock', focusId: null },
  { label: 'Restore default filter lists', category: 'Ad Blocker', page: 'adblock', focusId: 'adblock-restore-defaults-btn' },
  { label: 'Ad blocker developer diagnostics', category: 'Ad Blocker', page: 'adblock', focusId: 'adblock-diag-toggle' },
  { label: 'Show bookmarks on home screen', category: 'Home Screen', page: 'home-screen', focusId: 'hsb-show-toggle' },
  { label: 'Home screen bookmark manager', category: 'Home Screen', page: 'home-screen', focusId: 'hsb-add-btn' },
  { label: 'Home screen background', category: 'Home Screen', page: 'home-screen', focusId: 'hsb-bg-image-btn' },
  { label: 'Show top green gradient', category: 'Home Screen', page: 'home-screen', focusId: 'hsb-gradient-toggle' },
  { label: 'Download location', category: 'Downloads', page: 'downloads', focusId: 'download-dir-browse-btn' },
  { label: 'Always ask where to save files', category: 'Downloads', page: 'downloads', focusId: 'ask-save-toggle' },
  { label: 'App version', category: 'About', page: 'about', focusId: null },
  { label: "What's new", category: 'About', page: 'about', focusId: 'about-whats-new-link' },
  { label: 'GlozaNet releases', category: 'About', page: 'about', focusId: 'about-latest-release-link' },
  { label: 'GlozaLabs', category: 'About', page: 'about', focusId: 'about-gloza-labs-link' },
];

const searchInput = document.getElementById('settings-search-input');
const navList = document.getElementById('settings-nav-list');

function renderSearchResults(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    navList.hidden = false;
    const existing = document.querySelector('.settings-search-results');
    if (existing) existing.remove();
    return;
  }
  navList.hidden = true;
  let resultsEl = document.querySelector('.settings-search-results');
  if (!resultsEl) {
    resultsEl = document.createElement('div');
    resultsEl.className = 'settings-search-results';
    navList.insertAdjacentElement('afterend', resultsEl);
  }
  const matches = SEARCH_INDEX.filter((e) => e.label.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
  resultsEl.innerHTML = '';
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-search-empty';
    empty.textContent = 'No matching settings.';
    resultsEl.appendChild(empty);
    return;
  }
  for (const m of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-search-result';
    btn.innerHTML = `<span class="ssr-label">${escapeHtml(m.label)}</span><span class="ssr-category">${escapeHtml(m.category)}</span>`;
    btn.addEventListener('click', () => {
      searchInput.value = '';
      renderSearchResults('');
      showPage(m.page, m.focusId || undefined);
    });
    resultsEl.appendChild(btn);
  }
}

searchInput.addEventListener('input', (e) => renderSearchResults(e.target.value));
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchInput.value = ''; renderSearchResults(''); searchInput.blur(); } });

// ============================================================================
// Downloads page (Part 3B)
// ============================================================================

function setDownloadsError(message) {
  const banner = document.getElementById('downloads-error-banner');
  if (!banner) return;
  if (message) { banner.hidden = false; banner.textContent = message; }
  else { banner.hidden = true; banner.textContent = ''; }
}

// ============================================================================
// About (Part … About GlozaNet)
// ============================================================================
// Version string is fetched fresh every time this page is shown (same
// lazy-refresh-on-navigate pattern as every other page here) rather than
// cached at init() time, so it can never go stale across a long-running
// Settings tab.
const GLOZANET_RELEASES_URL = 'https://github.com/Gloza-Labs/GlozaNet/releases';
const GLOZALABS_ORG_URL = 'https://github.com/Gloza-Labs';
// Matches semver-ish "1.2.3" / "1.2.3-beta.1" strings well enough to catch
// a missing/garbled app.getVersion() result without being a full semver
// parser — good enough to decide "is this safe to build a release URL
// from", which is all this needs.
const VERSION_RE = /^[0-9]+(?:\.[0-9]+){1,2}(?:[-+][0-9A-Za-z.-]+)?$/;

function setAboutError(msg) {
  const el = document.getElementById('about-version-error');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.hidden = true; el.textContent = ''; }
}

// Disables the "What's new" link rather than pointing it at a hardcoded or
// stale release tag — a wrong link is worse than no link.
function disableWhatsNewLink() {
  const link = document.getElementById('about-whats-new-link');
  if (!link) return;
  link.removeAttribute('href');
  link.setAttribute('aria-disabled', 'true');
  delete link.dataset.url;
}

async function refreshAboutPage() {
  const versionEl = document.getElementById('about-version');
  const whatsNewLink = document.getElementById('about-whats-new-link');
  disableWhatsNewLink();
  if (versionEl) versionEl.textContent = 'Loading version…';
  setAboutError(null);
  try {
    const version = await window.settingsAPI.getVersion();
    if (typeof version !== 'string' || !VERSION_RE.test(version.trim())) {
      throw new Error('The app reported an invalid version string');
    }
    const clean = version.trim();
    if (versionEl) versionEl.textContent = `Version ${clean}`;
    // Mandatory shape: .../releases/tag/GlozaNet/v<version> — the "GlozaNet/"
    // segment and the "v" immediately before the version are both required.
    const releaseUrl = `https://github.com/Gloza-Labs/GlozaNet/releases/tag/GlozaNet/v${encodeURIComponent(clean)}`;
    if (whatsNewLink) {
      whatsNewLink.href = releaseUrl;
      whatsNewLink.dataset.url = releaseUrl;
      whatsNewLink.removeAttribute('aria-disabled');
    }
  } catch (err) {
    if (versionEl) versionEl.textContent = 'Version unavailable';
    disableWhatsNewLink();
    setAboutError(
      `Couldn't determine the installed version, so the "What's new" link has been disabled: ${err.message || 'please try again'}.`
    );
  }
}

// All three About links always open in a brand-new tab in THIS window,
// regardless of the "Open links" (new-tab vs same-tab) preference, and
// never navigate the Settings tab itself away — see openInNewTab() in
// settings-preload.js, which goes through the same internal tabs:new
// channel the toolbar's own "new tab" button uses. preventDefault() stops
// the <a> from also trying to navigate (which inside this sandboxed,
// contextIsolated settings tab would otherwise just fail silently anyway,
// but relying on that would be fragile).
function wireAboutLink(id, fixedUrl) {
  const link = document.getElementById(id);
  if (!link) return;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const url = fixedUrl || link.dataset.url;
    if (!url || link.getAttribute('aria-disabled') === 'true') return;
    window.settingsAPI.openInNewTab(url);
  });
}

wireAboutLink('about-whats-new-link', null);
wireAboutLink('about-latest-release-link', GLOZANET_RELEASES_URL);
wireAboutLink('about-gloza-labs-link', GLOZALABS_ORG_URL);

async function refreshDownloadsPage() {
  try {
    const prefs = await window.settingsAPI.get();
    loadedPrefs.downloadDir = prefs.downloadDir || '';
    loadedPrefs.askWhereToSave = Boolean(prefs.askWhereToSave);
    document.getElementById('download-dir-desc').textContent =
      loadedPrefs.downloadDir || 'Default Downloads folder';
    document.getElementById('ask-save-toggle').checked = loadedPrefs.askWhereToSave;
    setDownloadsError(null);
  } catch (err) {
    setDownloadsError(`Couldn't load download settings: ${err.message || 'please try again'}.`);
  }
}

document.getElementById('download-dir-browse-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const chosen = await window.settingsAPI.chooseDownloadDir();
    if (chosen == null) return; // dialog was canceled — leave the current setting alone
    const result = await window.settingsAPI.setDownloadDir(chosen);
    if (result.error) {
      setDownloadsError(result.error);
    } else {
      loadedPrefs.downloadDir = result.value;
      document.getElementById('download-dir-desc').textContent = result.value || 'Default Downloads folder';
      setDownloadsError(null);
    }
  } catch (err) {
    setDownloadsError(`Couldn't change the download location: ${err.message || 'please try again'}.`);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('ask-save-toggle').addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try {
    await window.settingsAPI.setAskWhereToSave(next);
    loadedPrefs.askWhereToSave = next;
    setDownloadsError(null);
  } catch (err) {
    e.target.checked = !next;
    setDownloadsError(`Couldn't save that: ${err.message || 'please try again'}.`);
  } finally {
    e.target.disabled = false;
  }
});

// ============================================================================
// Home Screen page (Part 2) — bookmark manager, visibility toggle,
// background picker, top-gradient toggle. Every bookmark operation goes
// through window.settingsAPI.homeScreen, which is bound to the exact same
// home-bookmarks:* IPC handlers / data file / 4-slot limit / URL validation
// (isSafeBookmarkUrl / normalizeBookmarkUrl in main.js) that home.html's own
// dialog uses — see settings-preload.js. There is no second collection and
// no separate validation here.
// ============================================================================

// Same built-in palette as main.js's HOME_BG_COLORS — kept as a plain
// id -> hex map here too (same pattern as SEARCH_ENGINES/STARTUP_BEHAVIORS
// above) since there's no IPC round trip needed just to draw swatches.
const HOME_BG_COLORS = {
  charcoal: '#14181a',
  midnight: '#0b1220',
  forest:   '#0e1f16',
  slate:    '#1b222b',
  plum:     '#1d1626',
  sand:     '#2a2420',
};

let hsbBookmarks = [];
const hsbDialogState = { open: false, mode: 'create', editId: null, busy: false };

function setHsbError(message) {
  const banner = document.getElementById('hsb-error-banner');
  if (!banner) return;
  if (message) { banner.hidden = false; banner.textContent = message; }
  else { banner.hidden = true; banner.textContent = ''; }
}

function hsbSvg(name) {
  const icons = {
    edit: '<path d="M11 2.2a1.4 1.4 0 0 1 2 2L5.5 11.7l-2.6.6.6-2.6Z"/>',
    up: '<path d="M3 9.5 7 5.5l4 4"/>',
    down: '<path d="M3 4.5l4 4 4-4"/>',
    trash: '<path d="M2.5 4h9M5.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M5 4v7.2c0 .4.3.8.8.8h2.4c.4 0 .8-.4.8-.8V4"/>',
    // A 2x3 grid of dots — the universal "grab here to drag" affordance.
    grip: '<circle cx="5" cy="3.3" r="1"/><circle cx="9" cy="3.3" r="1"/><circle cx="5" cy="7" r="1"/><circle cx="9" cy="7" r="1"/><circle cx="5" cy="10.7" r="1"/><circle cx="9" cy="10.7" r="1"/>',
  };
  // The grip icon is drawn as filled dots (circles), not strokes — give its
  // <g> a fill so it isn't invisible under the shared fill="none" root.
  const groupAttrs = name === 'grip' ? ' fill="currentColor" stroke="none"' : '';
  return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor"><g${groupAttrs}>${icons[name] || ''}</g></svg>`;
}

// Renders the manager list. Mirrors renderExceptionList's shape (empty-note
// vs. .set-list-row-per-item) so this page looks consistent with Ad
// Blocker/Dark Mode's own lists, just with four actions per row instead of
// one "Remove" button.
function renderHomeBookmarkList(list) {
  hsbBookmarks = Array.isArray(list) ? list : [];
  const container = document.getElementById('hsb-bookmark-list');
  if (!container) return;
  container.innerHTML = '';

  document.getElementById('hsb-count-desc').textContent =
    `${hsbBookmarks.length} of 4 used. Reuses the same list the new-tab page shows.`;
  const addBtn = document.getElementById('hsb-add-btn');
  if (addBtn) addBtn.disabled = hsbBookmarks.length >= 4;

  if (!hsbBookmarks.length) {
    const note = document.createElement('div');
    note.className = 'set-empty-note';
    note.textContent = 'No home screen bookmarks yet.';
    container.appendChild(note);
    return;
  }

  hsbBookmarks.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'set-list-row hsb-row';
    row.dataset.id = String(b.id);
    row.innerHTML = `
      <button type="button" class="hsb-row-grip" aria-label="Drag to reorder, or use the arrow buttons" title="Drag to reorder">${hsbSvg('grip')}</button>
      <div class="set-list-main">
        <span class="set-list-title">${escapeHtml(b.title || b.url)}</span>
        <span class="set-list-meta hsb-row-url">${escapeHtml(b.url)}</span>
      </div>
      <div class="set-list-actions">
        <button type="button" class="hsb-row-actions-btn" data-action="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${hsbSvg('up')}</button>
        <button type="button" class="hsb-row-actions-btn" data-action="down" aria-label="Move down" ${i === hsbBookmarks.length - 1 ? 'disabled' : ''}>${hsbSvg('down')}</button>
        <button type="button" class="hsb-row-actions-btn" data-action="edit" aria-label="Edit bookmark">${hsbSvg('edit')}</button>
        <button type="button" class="hsb-row-actions-btn hsb-row-danger" data-action="delete" aria-label="Delete bookmark">${hsbSvg('trash')}</button>
      </div>`;
    row.querySelector('[data-action="up"]').addEventListener('click', () => hsbMove(b.id, -1));
    row.querySelector('[data-action="down"]').addEventListener('click', () => hsbMove(b.id, 1));
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openHsbDialog({ mode: 'edit', node: b }));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => hsbDelete(b));
    attachHsbDragHandlers(row, b);
    container.appendChild(row);
  });
}

// Sends a new order to home-bookmarks:reorder and re-renders from whatever
// it actually saved (not just the order we asked for) — the handler
// reconciles against the real current list, so this stays correct even if
// something else changed the collection a moment earlier.
//
// hsbReorderBusy guards against a real race: a fast drag-drop followed
// immediately by an up/down click (or two fast drags) each build their
// `order` array synchronously from the same in-memory hsbBookmarks before
// their own `await` — so if a second reorder fires while the first is still
// in flight, it's working from a snapshot that doesn't yet include the
// first move, and its result would silently undo it. Ignoring new reorder
// requests while one is in flight (rather than queuing them) means a very
// fast double-action loses its second move, but that's strictly better than
// the previous behavior of possibly losing the FIRST one.
let hsbReorderBusy = false;
async function hsbReorderTo(order) {
  if (hsbReorderBusy) return;
  hsbReorderBusy = true;
  try {
    const res = await window.settingsAPI.homeScreen.reorder(order);
    if (res && res.ok && res.list) renderHomeBookmarkList(res.list);
    setHsbError(null);
  } catch (err) {
    setHsbError(`Couldn't reorder bookmarks: ${err.message || 'please try again'}.`);
  } finally {
    hsbReorderBusy = false;
  }
}

function hsbMove(id, delta) {
  const idx = hsbBookmarks.findIndex((b) => b.id === id);
  if (idx === -1) return;
  const swapWith = idx + delta;
  if (swapWith < 0 || swapWith >= hsbBookmarks.length) return;
  const order = hsbBookmarks.map((b) => b.id);
  [order[idx], order[swapWith]] = [order[swapWith], order[idx]];
  hsbReorderTo(order);
}

// ---- Drag-and-drop reordering -----------------------------------------
// Native HTML5 DnD on each row. A row is dropped relative to whichever row
// it's released over (before/after its vertical midpoint); the final order
// is computed purely from hsbBookmarks (the last-rendered, known-good
// list) and sent once, on drop — not continuously during dragover — so a
// fast/jittery drag can't fire a burst of reorder calls.
let hsbDragId = null;

function hsbClearDropIndicators() {
  document.querySelectorAll('#hsb-bookmark-list .hsb-row').forEach((r) => {
    r.classList.remove('hsb-drop-before', 'hsb-drop-after');
  });
}

function attachHsbDragHandlers(row, bookmark) {
  row.draggable = true;

  row.addEventListener('dragstart', (e) => {
    hsbDragId = bookmark.id;
    row.classList.add('hsb-dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Needed for Firefox/some platforms to treat the row as a valid drag
    // source at all; the actual reorder logic never reads this value back
    // (hsbDragId, a closure variable, is the real source of truth — reading
    // dataTransfer.getData is unreliable before 'drop' in some browsers).
    try { e.dataTransfer.setData('text/plain', String(bookmark.id)); } catch { /* some platforms restrict this outside a real drag gesture */ }
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('hsb-dragging');
    hsbClearDropIndicators();
    hsbDragId = null;
  });

  row.addEventListener('dragover', (e) => {
    if (hsbDragId == null || hsbDragId === bookmark.id) return;
    e.preventDefault(); // required for 'drop' to fire at all
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    hsbClearDropIndicators();
    row.classList.add(before ? 'hsb-drop-before' : 'hsb-drop-after');
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('hsb-drop-before', 'hsb-drop-after');
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    hsbClearDropIndicators();
    const draggedId = hsbDragId;
    hsbDragId = null;
    if (draggedId == null || draggedId === bookmark.id) return;

    const order = hsbBookmarks.map((b) => b.id);
    const fromIdx = order.indexOf(draggedId);
    if (fromIdx === -1) return;
    order.splice(fromIdx, 1);
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    let toIdx = order.indexOf(bookmark.id);
    if (toIdx === -1) return; // defensive — bookmark.id should always still be in `order` here
    if (!before) toIdx += 1;
    order.splice(toIdx, 0, draggedId);
    hsbReorderTo(order);
  });
}

// A drop released past the end of the last row (e.g. in the empty space
// below the list) wouldn't land on any row's own drop handler — this lets
// it still mean "move to the end" instead of silently doing nothing.
document.getElementById('hsb-bookmark-list').addEventListener('dragover', (e) => {
  if (hsbDragId == null) return;
  e.preventDefault();
});
document.getElementById('hsb-bookmark-list').addEventListener('drop', (e) => {
  if (e.target.closest('.hsb-row') || hsbDragId == null) return; // a real row already handled it
  e.preventDefault();
  hsbClearDropIndicators();
  const draggedId = hsbDragId;
  hsbDragId = null;
  const order = hsbBookmarks.map((b) => b.id).filter((id) => id !== draggedId);
  order.push(draggedId);
  hsbReorderTo(order);
});

async function hsbDelete(node) {
  try {
    const res = await window.settingsAPI.homeScreen.remove(node.id);
    if (res && res.ok && res.list) renderHomeBookmarkList(res.list);
    setHsbError(null);
  } catch (err) {
    setHsbError(`Couldn't remove "${node.title || node.url}": ${err.message || 'please try again'}.`);
  }
}

// ---- Add/Edit dialog --------------------------------------------------------
// Same two client-side checks home.js's dialog uses (looksLikeUsableUrl) —
// a UX nicety only; the home-bookmarks:add/update IPC handlers re-validate
// authoritatively via isSafeBookmarkUrl/normalizeBookmarkUrl regardless, so
// this page can't save anything the new-tab page's own dialog wouldn't.
function hsbLooksLikeUsableUrl(raw) {
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

const hsbOverlay = document.getElementById('hsb-dialog-overlay');
const hsbForm = document.getElementById('hsb-dialog');
const hsbTitleEl = document.getElementById('hsb-dialog-title');
const hsbFieldName = document.getElementById('hsb-field-name');
const hsbFieldUrl = document.getElementById('hsb-field-url');
const hsbDialogErrorEl = document.getElementById('hsb-dialog-error');
const hsbSaveBtn = document.getElementById('hsb-dialog-save');
const hsbCancelBtn = document.getElementById('hsb-dialog-cancel');

function hsbShowFieldError(message) {
  hsbDialogErrorEl.textContent = message;
  hsbDialogErrorEl.hidden = false;
}
function hsbClearFieldError() {
  hsbDialogErrorEl.hidden = true;
  hsbDialogErrorEl.textContent = '';
  hsbFieldName.classList.remove('hsb-field-invalid');
  hsbFieldUrl.classList.remove('hsb-field-invalid');
}

function openHsbDialog({ mode, node } = {}) {
  if (hsbDialogState.open) return;
  if (mode === 'create' && hsbBookmarks.length >= 4) return; // belt-and-suspenders; Add button is already disabled at capacity
  hsbDialogState.open = true;
  hsbDialogState.mode = mode;
  hsbDialogState.editId = mode === 'edit' && node ? node.id : null;
  hsbDialogState.busy = false;

  hsbClearFieldError();
  hsbTitleEl.textContent = mode === 'edit' ? 'Edit bookmark' : 'Add bookmark';
  hsbFieldName.value = mode === 'edit' && node ? (node.title || '') : '';
  hsbFieldUrl.value = mode === 'edit' && node ? (node.url || '') : '';
  hsbSaveBtn.disabled = false;
  hsbSaveBtn.textContent = 'Save';

  hsbOverlay.hidden = false;
  requestAnimationFrame(() => hsbFieldName.focus());
}

function closeHsbDialog() {
  if (!hsbDialogState.open) return;
  hsbDialogState.open = false;
  hsbOverlay.hidden = true;
}

hsbCancelBtn.addEventListener('click', () => closeHsbDialog());
hsbOverlay.addEventListener('pointerdown', (e) => { if (e.target === hsbOverlay) closeHsbDialog(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && hsbDialogState.open) closeHsbDialog(); });
document.getElementById('hsb-add-btn').addEventListener('click', () => openHsbDialog({ mode: 'create' }));

hsbForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (hsbDialogState.busy) return;
  hsbClearFieldError();

  const name = hsbFieldName.value.trim();
  const url = hsbFieldUrl.value;

  if (!name) {
    hsbFieldName.classList.add('hsb-field-invalid');
    hsbShowFieldError('Enter a name for this bookmark.');
    hsbFieldName.focus();
    return;
  }
  if (!hsbLooksLikeUsableUrl(url)) {
    hsbFieldUrl.classList.add('hsb-field-invalid');
    hsbShowFieldError('Enter a valid website address (http or https).');
    hsbFieldUrl.focus();
    return;
  }

  hsbDialogState.busy = true;
  hsbSaveBtn.disabled = true;
  hsbSaveBtn.textContent = 'Saving…';
  try {
    const res = hsbDialogState.mode === 'edit'
      ? await window.settingsAPI.homeScreen.update(hsbDialogState.editId, { title: name, url })
      : await window.settingsAPI.homeScreen.add(name, url);

    if (!res || !res.ok) {
      const messages = {
        'invalid-url': 'Enter a valid website address.',
        'invalid-name': 'Enter a name for this bookmark.',
        'full': 'The home screen already has 4 bookmarks — remove one first.',
        'not-found': 'That bookmark was removed elsewhere. Try again.',
      };
      hsbShowFieldError((res && messages[res.error]) || "Couldn't save this bookmark. Try again.");
      if (res && res.list) renderHomeBookmarkList(res.list);
      return;
    }
    if (res.list) renderHomeBookmarkList(res.list);
    closeHsbDialog();
  } catch {
    hsbShowFieldError("Couldn't save this bookmark. Try again.");
  } finally {
    hsbDialogState.busy = false;
    hsbSaveBtn.disabled = false;
    hsbSaveBtn.textContent = 'Save';
  }
});

// Keeps this page in sync if a bookmark is added/edited/moved from
// home.html (or another window) while Settings happens to be open — same
// live-update contract home.js's own applyHomeBookmarks() has.
window.settingsAPI.homeScreen.onUpdated((list) => {
  if (hsbDialogState.open && hsbDialogState.mode === 'edit' && !list.some((b) => b.id === hsbDialogState.editId)) {
    closeHsbDialog();
  }
  renderHomeBookmarkList(list);
});

// ---- Show bookmarks / top gradient toggles ---------------------------------
document.getElementById('hsb-show-toggle').addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try {
    await window.settingsAPI.homeScreen.setShowBookmarks(next);
    loadedPrefs.showHomeBookmarks = next;
    setHsbError(null);
  } catch (err) {
    e.target.checked = !next;
    setHsbError(`Couldn't update that setting: ${err.message || 'please try again'}.`);
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('hsb-gradient-toggle').addEventListener('change', async (e) => {
  const next = e.target.checked;
  e.target.disabled = true;
  try {
    await window.settingsAPI.homeScreen.setShowGradient(next);
    loadedPrefs.showTopGradient = next;
    setHsbError(null);
  } catch (err) {
    e.target.checked = !next;
    setHsbError(`Couldn't update that setting: ${err.message || 'please try again'}.`);
  } finally {
    e.target.disabled = false;
  }
});

// ---- Background -------------------------------------------------------------
// Color swatches are built once (the palette never changes at runtime);
// "active" highlighting is re-applied every refresh from the real saved
// preference, not from whichever swatch was last clicked, so a reload or a
// change made elsewhere is always reflected accurately.
(function buildHsbColorSwatches() {
  const wrap = document.getElementById('hsb-bg-options');
  if (!wrap) return;
  for (const [id, hex] of Object.entries(HOME_BG_COLORS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hsb-bg-swatch';
    btn.dataset.bgValue = id;
    btn.title = id.charAt(0).toUpperCase() + id.slice(1);
    btn.innerHTML = `<span class="hsb-bg-swatch-fill" style="background:${hex};" aria-hidden="true"></span><span class="hsb-bg-swatch-label">${id.charAt(0).toUpperCase() + id.slice(1)}</span>`;
    btn.addEventListener('click', () => hsbSetBackgroundColor(id));
    wrap.appendChild(btn);
  }
})();

function hsbMarkActiveSwatch(mode, colorId) {
  document.querySelectorAll('#hsb-bg-options .hsb-bg-swatch').forEach((btn) => {
    const isActive = mode === 'color' ? btn.dataset.bgValue === colorId : (mode === 'default' && btn.dataset.bgValue === 'default');
    btn.classList.toggle('hsb-bg-active', isActive);
  });
}

async function hsbSetBackgroundColor(colorId) {
  try {
    await window.settingsAPI.homeScreen.setBackgroundColor(colorId);
    loadedPrefs.homeBackgroundMode = 'color';
    loadedPrefs.homeBackgroundColor = colorId;
    hsbMarkActiveSwatch('color', colorId);
    hsbUpdateBackgroundPreview({ mode: 'color', color: HOME_BG_COLORS[colorId] });
    setHsbError(null);
  } catch (err) {
    setHsbError(`Couldn't change the background: ${err.message || 'please try again'}.`);
  }
}

document.getElementById('hsb-bg-default-btn').addEventListener('click', async () => {
  try {
    await window.settingsAPI.homeScreen.setBackgroundDefault();
    loadedPrefs.homeBackgroundMode = 'default';
    hsbMarkActiveSwatch('default', null);
    hsbUpdateBackgroundPreview({ mode: 'default' });
    setHsbError(null);
  } catch (err) {
    setHsbError(`Couldn't change the background: ${err.message || 'please try again'}.`);
  }
});

function hsbUpdateBackgroundPreview(bg) {
  const wrap = document.getElementById('hsb-bg-preview-wrap');
  const img = document.getElementById('hsb-bg-preview');
  const status = document.getElementById('hsb-bg-custom-status');
  if (bg.mode === 'image' && bg.imageUrl) {
    img.src = bg.imageUrl;
    wrap.hidden = false;
    status.hidden = false;
    status.textContent = 'Custom picture applied.';
  } else {
    wrap.hidden = true;
    img.removeAttribute('src');
    status.hidden = bg.mode !== 'image'; // only show a status line when a custom picture SHOULD be active but its file is missing
    if (bg.mode === 'image') status.textContent = "That picture can't be found anymore — showing the default background instead.";
  }
  // "Use this picture" — a shortcut back to a previously-chosen custom image
  // without reopening the native file picker. Only makes sense when (a) a
  // custom picture is actually saved on disk (loadedPrefs.homeBackgroundImageFile,
  // kept accurate by chooseBackgroundImage's success handler and
  // refreshHomeScreenPage below) and (b) it isn't already the active
  // background — showing it while mode is already 'image' would be a
  // no-op button with nothing useful to do.
  const useBtn = document.getElementById('hsb-bg-use-custom-btn');
  if (useBtn) useBtn.hidden = !(loadedPrefs.homeBackgroundImageFile && bg.mode !== 'image');
}

document.getElementById('hsb-bg-use-custom-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await window.settingsAPI.homeScreen.setBackgroundImageMode();
    if (!res || res.error === 'no-image') {
      // The file vanished between page loads (deleted/moved on disk) —
      // the backend already refused to switch mode, so nothing was
      // corrupted; just reflect reality instead of claiming success.
      loadedPrefs.homeBackgroundImageFile = '';
      setHsbError("That picture can't be found anymore. Choose a picture to set a new one.");
      hsbMarkActiveSwatch(loadedPrefs.homeBackgroundMode, loadedPrefs.homeBackgroundColor);
      hsbUpdateBackgroundPreview({ mode: loadedPrefs.homeBackgroundMode });
      return;
    }
    loadedPrefs.homeBackgroundMode = 'image';
    const bg = await window.settingsAPI.homeScreen.getBackgroundPreview();
    hsbMarkActiveSwatch('image', null);
    hsbUpdateBackgroundPreview(bg);
    setHsbError(null);
  } catch (err) {
    setHsbError(`Couldn't switch to that picture: ${err.message || 'please try again'}.`);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('hsb-bg-image-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await window.settingsAPI.homeScreen.chooseBackgroundImage();
    if (!res || res.error === 'canceled') return; // user closed the picker — leave everything as-is
    if (!res.ok) {
      const messages = {
        'unsupported-format': 'Pick a PNG, JPG, GIF, or WEBP image.',
        'unreadable': "That file couldn't be read — it may be missing or you may not have permission to open it.",
        'copy-failed': "Couldn't save a copy of that picture. Check available disk space and try again.",
        'persist-failed': "Couldn't save that as your background. Your previous background is unchanged.",
      };
      setHsbError(messages[res.error] || "Couldn't set that picture as your background.");
      return;
    }
    loadedPrefs.homeBackgroundMode = 'image';
    // Keep the local mirror accurate — see the field's own comment in
    // loadedPrefs' initializer. Without this, a later click of the
    // General page's "Save changes" (a full prefs replace, not a merge)
    // would write back whatever stale value was loaded at init() and
    // silently revert the background to default.
    loadedPrefs.homeBackgroundImageFile = res.fileName || loadedPrefs.homeBackgroundImageFile;
    hsbMarkActiveSwatch('image', null);
    hsbUpdateBackgroundPreview({ mode: 'image', imageUrl: res.imageUrl });
    setHsbError(null);
  } catch (err) {
    setHsbError(`Couldn't open the file picker: ${err.message || 'please try again'}.`);
  } finally {
    btn.disabled = false;
  }
});

async function refreshHomeScreenPage() {
  try {
    const prefs = await window.settingsAPI.get();
    loadedPrefs.showHomeBookmarks = prefs.showHomeBookmarks !== false;
    loadedPrefs.showTopGradient = prefs.showTopGradient !== false;
    loadedPrefs.homeBackgroundMode = prefs.homeBackgroundMode || 'default';
    loadedPrefs.homeBackgroundColor = prefs.homeBackgroundColor || 'charcoal';
    // Re-sync from the real saved value every time this page is opened —
    // the authoritative fix for staleness; chooseBackgroundImage's own
    // handler (above) covers the one in-session path that changes it
    // without a full page refresh.
    loadedPrefs.homeBackgroundImageFile = prefs.homeBackgroundImageFile || '';

    document.getElementById('hsb-show-toggle').checked = loadedPrefs.showHomeBookmarks;
    document.getElementById('hsb-gradient-toggle').checked = loadedPrefs.showTopGradient;

    const bg = await window.settingsAPI.homeScreen.getBackgroundPreview();
    hsbMarkActiveSwatch(bg.mode, prefs.homeBackgroundColor);
    hsbUpdateBackgroundPreview(bg);

    const list = await window.settingsAPI.homeScreen.list();
    renderHomeBookmarkList(list);
    setHsbError(null);
  } catch (err) {
    setHsbError(`Couldn't load Home Screen settings: ${err.message || 'please try again'}.`);
  }
}
