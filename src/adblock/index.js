// ============================================================================
// adblock/index.js — the thin Electron-facing wrapper that ties the pure
// engine (engine.js), the filter-list manager (filterlist-manager.js), the
// on-disk store (store.js), and the stats counters (stats.js) into one
// object main.js can register at the integration point already marked in
// app.whenReady(). See HANDOFF-part-1a.md section 4 for why that spot was
// chosen (single shared session.defaultSession, runs before the first tab).
//
// Everything that needs Node/Electron (fs via store.js, net via
// filterlist-manager.js, session.webRequest, insertCSS) is confined to this
// layer; rule matching itself (engine.js, filter-parser.js, domain-utils.js)
// has none of that and is unit-tested directly.
// ============================================================================

'use strict';

const store = require('./store');
const { FilterEngine } = require('./engine'); // now backed by @ghostery/adblocker-electron — see engine.js header
const { FilterListManager } = require('./filterlist-manager');
const { BlockStats } = require('./stats');
const { isFilterableUrl, normalizeHostname } = require('./domain-utils');

// Electron's webRequest `details.resourceType` strings -> the ABP/EasyList
// type keywords filter-parser.js understands. Unknown/future values map to
// 'other', the same bucket EasyList itself uses as a catch-all.
const RESOURCE_TYPE_MAP = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  object: 'object',
  xhr: 'xmlhttprequest',
  // BUG (found in the full-engine audit): this used to map Electron's
  // `ping` resourceType (navigator.sendBeacon / <a ping> tracking beacons
  // — exactly the kind of request EasyPrivacy's `$ping`-scoped rules exist
  // to catch) to the generic `other` bucket. filter-parser.js's
  // KNOWN_TYPE_OPTIONS has always kept `ping` as its OWN distinct type
  // (never aliased to `other`), so the two sides disagreed about what a
  // ping request's type even was:
  //   - a `$ping`-only rule compared its includeTypes (['ping']) against
  //     the incoming resourceType ('other') and never matched -> tracking
  //     beacons a filter list specifically targeted sailed through
  //     unblocked, a real false negative.
  //   - a `$~ping`-only rule (block everything of this pattern EXCEPT ping
  //     requests — e.g. a redirect-tracker rule written to avoid breaking
  //     a site's own analytics beacon) compared its excludeTypes (['ping'])
  //     against 'other' and found no match, so the exclusion never
  //     applied -> the rule still fired on the very ping requests it was
  //     written to spare, a false positive.
  // Mapping this to the engine's own 'ping' type (which the engine already
  // understands, matching filter-parser.js) fixes both directions.
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  font: 'font',
  other: 'other',
};

// ---- YouTube in-player ad-skip (DOM/cosmetic layer, NOT network blocking)
// --------------------------------------------------------------------------
// Investigation finding (youtube-adblock-gap): a real share of YouTube's
// video ads are delivered server-side-stitched through googlevideo.com —
// the SAME CDN/domain used for ordinary video/audio — so there is no URL
// pattern that reliably tells an ad segment apart from a content segment
// without risking breaking playback (see the long comment in the bundled
// ublock-filters-seed.txt for the full reasoning). Network-level filtering
// (onBeforeRequest, above) therefore cannot be the whole fix for YouTube
// specifically, only for its first-party ad/tracking endpoints
// (youtube.com/pagead/, /api/stats/ads, /ptracking — now in the seed list)
// and its third-party ad partners (doubleclick.net, googlesyndication.com —
// already in easylist-seed.txt).
//
// This is a second, independent layer: a small content script, injected
// only into youtube.com (and its subdomains) tabs, that (a) clicks the
// native "Skip Ad" button the instant it becomes available — exactly what
// a user would otherwise do by hand — and (b) hides known ad-chrome
// overlay elements (the "Ad" badge, in-player ad banner overlays, the ad
// progress bar). It never touches the <video> element, the player
// container, or playback controls, and never prevents/delays an ad from
// starting or finishing — it only removes/skips the parts of an ad already
// being SHOWN. This is cosmetic/UX cleanup on top of network blocking, not
// a replacement for it, and must never be reported as "blocking" in stats
// or diagnostics (it runs independently of _decide()/onBeforeRequest and
// records nothing there).
const YOUTUBE_AD_SKIP_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com']);

function isYoutubeAdSkipHost(hostname) {
  if (!hostname) return false;
  return YOUTUBE_AD_SKIP_HOSTS.has(hostname) || hostname.endsWith('.youtube.com');
}

// ---- YouTube ad-skip for EMBEDDED players (iframes on third-party sites)
// --------------------------------------------------------------------------
// ROOT CAUSE (youtube-iframe-injection-gap): the layer above only ever
// looked at the TOP-LEVEL page's host (`pageHost`, derived from
// `wc.getURL()`/`did-navigate`, both main-frame-only in Electron) and
// injected via `wc.executeJavaScript()`, which runs in the main frame's
// context. When a third-party site (e.g. a news article) embeds a YouTube
// player in a <iframe>, that iframe is a separate frame/origin with its own
// document; `wc.executeJavaScript()` never reaches into it, and the
// `isYoutubeAdSkipHost(pageHost)` check is false anyway because pageHost is
// the embedding site's host, not youtube.com. So embedded players never got
// the script, regardless of how many top-level-URL checks were added.
//
// The fix is frame-scoped, not host-scoped: identify the actual EMBED
// frame's own origin/URL (independent of the parent page) and execute the
// script in THAT frame specifically, using Electron's WebFrameMain API
// (`frame.executeJavaScript()`, stable since Electron 12 — confirmed
// available on the installed Electron 43 in package.json). This also covers
// YouTube's privacy-enhanced embed domain (youtube-nocookie.com), which
// unlike the top-level-page allow-list intentionally does NOT share cookies
// with youtube.com and so is a distinct host that must be checked for on
// its own.
const YOUTUBE_EMBED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

// Matches an actual YouTube *player* document: /embed/<id> (standard and
// privacy-enhanced), plus youtube.com's own iframe_api bootstrap frame.
// Deliberately NOT a bare-hostname check — youtube.com serves plenty of
// other iframe'able surfaces (e.g. login/consent frames) that should not
// receive a script meant for the player UI.
const YOUTUBE_EMBED_PATH_RE = /^\/(embed\/|iframe_api$)/;

function isYoutubeEmbedFrameUrl(rawUrl) {
  if (!rawUrl) return false;
  let u;
  try { u = new URL(rawUrl); } catch (_e) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!YOUTUBE_EMBED_HOSTS.has(u.hostname.toLowerCase())) return false;
  return YOUTUBE_EMBED_PATH_RE.test(u.pathname);
}

// Plain ES5-ish syntax on purpose (this runs inside the target page via
// executeJavaScript, not through any bundler/transpiler) and wrapped in its
// own try/catch so a layout change on YouTube's side can never throw an
// uncaught error into the page. `window.__glozaYtAdSkipActive` guards
// against double-injection (did-finish-load can fire more than once for a
// single tab across its lifetime).
const YOUTUBE_AD_SKIP_SCRIPT = `(function() {
  try {
    if (window.__glozaYtAdSkipActive) return;
    window.__glozaYtAdSkipActive = true;

    // IMPROVED (YouTube ad-blocking fix, round 2): covers both the
    // in-player skip button AND the newer "Skip" variants/close ("x")
    // buttons YouTube has shipped over time, plus a broader set of known
    // ad-chrome overlay/container elements (masthead, feed, and companion
    // ads, not just in-player overlays). Still strictly UI-only: nothing
    // here ever touches the <video> element, the player container itself,
    // playback rate/currentTime, or any playback-affecting API.
    var SKIP_BUTTON_SELECTORS = [
      '.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button',
      '.ytp-skip-ad-button',
      '.videoAdUiSkipButton',
      'button.ytp-ad-skip-button-slot',
      '.ytp-ad-overlay-close-button',
      '.ytp-ad-overlay-close-icon-button',
      'ytd-enforcement-message-view-model button'
    ];
    // Overlay/chrome/placement containers only — deliberately never the
    // actual video element or player container, or anything also present
    // during normal (non-ad) playback.
    var HIDE_SELECTORS = [
      '.ytp-ad-overlay-container',
      '.ytp-ad-overlay-slot',
      '.ytp-ad-text-overlay',
      '.ytp-ad-persistent-progress-bar-container',
      '.ytp-ad-image-overlay',
      '.ytp-ad-player-overlay-flyout-cta',
      '.ytp-suggested-action',
      'ytd-promoted-video-renderer',
      'ytd-display-ad-renderer',
      'ytd-ad-slot-renderer',
      'ytd-in-feed-ad-layout-renderer',
      'ytd-banner-promo-renderer',
      'ytd-statement-banner-renderer',
      'ytd-companion-slot-renderer',
      'ytd-action-companion-ad-renderer',
      'masthead-ad',
      '#masthead-ad'
    ];
    // PERFORMANCE (ad-to-video transition speed, this round): every tick
    // used to run document.querySelector() once PER ENTRY in
    // SKIP_BUTTON_SELECTORS (8 whole-document traversals) and
    // document.querySelectorAll() once PER ENTRY in HIDE_SELECTORS (16
    // more), on every single poll tick AND every single mutation the
    // observer below woke up for — which, on a DOM as busy as YouTube's
    // (recommendations/comments/chat re-rendering constantly, none of it
    // related to ad state), could fire many times a second. That is pure,
    // repeated main-thread work competing with YouTube's OWN script for
    // the exact same thread during the ad -> video transition — the more
    // of it this script does per tick, the longer YouTube's own transition
    // logic has to wait for a free turn. Joining each selector list into
    // ONE comma-separated selector gets the identical set of matches in a
    // single DOM traversal instead of 8 or 16 — same result, a fraction of
    // the work, every tick.
    var SKIP_BUTTON_SELECTOR = SKIP_BUTTON_SELECTORS.join(',');
    var HIDE_SELECTOR = HIDE_SELECTORS.join(',');

    // Last-resort layer, added this round: for a NON-skippable ad (no
    // button in SKIP_BUTTON_SELECTORS exists to click at all), the only
    // thing left that genuinely shortens it -- rather than just hiding
    // its overlay while the audio/video keeps playing underneath -- is to
    // seek the ad's own <video> element to its end, which makes YouTube's
    // player advance exactly the way it does when an ad finishes playing
    // naturally. This is a well-known, widely used technique (the same
    // approach generic "skip ad" userscripts/extensions use) and is
    // deliberately narrow:
    //   - only acts while the player's own ad-state class
    //     ('.ad-showing'/'.ad-interrupting' on '.html5-video-player') says
    //     an ad is actually playing right now -- never touches the
    //     <video> element during ordinary content playback;
    //   - mutes only for the duration of the ad and restores the
    //     viewer's own previous mute state the instant the ad-state class
    //     clears, so this never permanently changes the user's volume
    //     preference;
    //   - never changes playbackRate or any other setting.
    var AD_STATE_SELECTOR = '.html5-video-player.ad-showing, .html5-video-player.ad-interrupting';
    var _wasMuted = null; // null = not currently intervening
    // PERFORMANCE/CORRECTNESS (this round): the ad <video> element, once
    // found for the ad instance currently showing, is marked with this
    // flag so a burst of ticks during the same still-playing ad (the
    // observer can fire many times while nothing relevant to the skip
    // itself has changed) never repeats the currentTime write once it has
    // already been applied. Repeatedly re-assigning currentTime to the
    // same already-at-the-end position on every tick was pure waste —
    // each assignment is itself a seek, which can re-trigger the player's
    // own "seeking"/buffering handling, i.e. the OPPOSITE of what this
    // layer exists to do. A plain property on the element (reset the
    // instant the ad-state class clears, i.e. a new ad gets a fresh
    // element and therefore a fresh flag) is enough; it never survives
    // past the single ad instance it was set for.
    function fastForwardNonSkippableAd(adPlayer) {
      try {
        var video = adPlayer
          ? (adPlayer.querySelector('video.html5-main-video') || adPlayer.querySelector('video'))
          : (document.querySelector('.html5-video-player video.html5-main-video') || document.querySelector('video.html5-main-video'));
        if (adPlayer && video) {
          // REGRESSION FIX (second/subsequent consecutive ad plays instead
          // of being fast-forwarded): __glozaAdFfDone used to be reset ONLY
          // in the "ad just ended" branch below, which runs when adPlayer
          // becomes falsy (the player's ad-state class clears). That is NOT
          // what happens between two CHAINED ads -- YouTube frequently
          // swaps straight from ad #1 into ad #2 on the SAME <video>
          // element without ever dropping the ad-showing/ad-interrupting
          // class in between, so this branch (and the flag reset inside it)
          // never ran at all between the two ads. The stale "true" value
          // left over from ad #1 then made this function skip ad #2 entirely --
          // it looked "already handled" even though it had barely started
          // and was a different ad. Detecting "this is actually a new ad
          // instance" from the video's own currentTime/src -- rather than
          // only from the ad-state class toggling off -- is what the
          // cleanup branch alone could never do, and it's what makes this
          // keep working across any number of consecutive ads, not just
          // the first.
          var currentSrc = video.currentSrc || video.src || '';
          if (video.__glozaAdFfSrc !== currentSrc || video.currentTime < 0.75) {
            video.__glozaAdFfDone = false;
            video.__glozaAdFfSrc = currentSrc;
          }
          if (_wasMuted === null) _wasMuted = video.muted;
          video.muted = true;
          if (!video.__glozaAdFfDone && isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) {
            video.currentTime = video.duration;
            video.__glozaAdFfDone = true;
          }
          attachAdEndedListener(video);
        } else if (_wasMuted !== null) {
          // Ad just ended -- restore whatever the viewer had set before.
          if (video) { video.muted = _wasMuted; video.__glozaAdFfDone = false; video.__glozaAdFfSrc = null; }
          _wasMuted = null;
        }
      } catch (ffErr) { /* never let this break normal playback */ }
    }

    // PERFORMANCE (detection-to-action latency, this round): forcing the
    // ad video to its end relies on YouTube's own player reacting to that
    // seek/'ended' transition, which this script cannot speed up directly
    // (see the investigation notes in the project's handoff docs) — but
    // the one piece of latency fully under this script's control is HOW
    // LONG AFTER that moment it notices and runs its own cleanup (restoring
    // the viewer's mute state, re-checking for a now-visible skip button on
    // a chained ad, etc). Previously that depended entirely on the next
    // MutationObserver callback or the next 400ms poll tick. Listening for
    // the ad video's own native 'ended'/'playing' events reacts at the
    // moment the browser itself fires them -- not bounded by a poll
    // interval or by waiting for some unrelated DOM mutation to wake the
    // observer. Tracked in a WeakSet so repeat ticks on the SAME video
    // element (extremely common while one ad is still showing) never
    // attach a duplicate listener.
    var _videosWithEndedListener = (typeof WeakSet === 'function') ? new WeakSet() : null;
    function attachAdEndedListener(video) {
      if (!video || !_videosWithEndedListener || _videosWithEndedListener.has(video)) return;
      try {
        video.addEventListener('ended', scheduleTick, { passive: true });
        video.addEventListener('playing', scheduleTick, { passive: true });
        _videosWithEndedListener.add(video);
      } catch (e) {
        // Older WebView without the options-object form of addEventListener
        // -- fall back to the plain two-arg form rather than losing the
        // listener entirely.
        try { video.addEventListener('ended', scheduleTick); video.addEventListener('playing', scheduleTick); _videosWithEndedListener.add(video); } catch (e2) { /* polling fallback still covers it */ }
      }
    }

    function tick() {
      try {
        // Resolve the ad-state container ONCE per tick and reuse it for
        // both the skip-button lookup and fastForwardNonSkippableAd,
        // instead of each querying the whole document for it separately
        // (was: two full-document AD_STATE_SELECTOR lookups per tick).
        var adPlayer = document.querySelector(AD_STATE_SELECTOR);

        // Skip buttons only ever exist inside the ad player's own UI --
        // they cannot render while no ad is showing. The old code ran this
        // 8-selector lookup unconditionally on every tick, whether or not
        // an ad was even present; scoping it to "only when adPlayer exists"
        // AND to adPlayer's own subtree (far smaller than the whole
        // document, which includes the entire comments/recommendations
        // sidebar) removes the single biggest piece of per-tick work that
        // could never have matched anyway outside an ad.
        if (adPlayer) {
          var btn = adPlayer.querySelector(SKIP_BUTTON_SELECTOR);
          if (btn && typeof btn.click === 'function') btn.click();
        }

        // Hiding ad-chrome containers (masthead/feed/companion ads) is NOT
        // limited to active video-ad playback, so this still always runs —
        // but as ONE combined querySelectorAll (one DOM traversal) instead
        // of 16 separate ones for the identical result.
        var nodes = document.querySelectorAll(HIDE_SELECTOR);
        for (var k = 0; k < nodes.length; k++) {
          nodes[k].style.setProperty('display', 'none', 'important');
        }

        fastForwardNonSkippableAd(adPlayer);
      } catch (innerErr) { /* never let one bad tick break the page */ }
    }

    // PERFORMANCE (avoid duplicate/redundant work, this round): the
    // MutationObserver below can legitimately fire many times within the
    // same frame during a burst of unrelated DOM churn (YouTube re-
    // rendering recommendations, chat, etc.) — previously each one called
    // tick() synchronously and immediately, so a single burst could run
    // the full selector-matching work many times over before the next
    // paint, none of the extra runs finding anything new. Coalescing
    // every trigger within a frame into a single tick() via
    // requestAnimationFrame keeps the OBSERVER just as reactive (it still
    // wakes up and schedules work the instant YouTube's own DOM changes,
    // not on a fixed delay) while cutting the actual selector-matching
    // work back down to once per frame, however many mutations fired.
    var _tickScheduled = false;
    function scheduleTick() {
      if (_tickScheduled) return;
      _tickScheduled = true;
      var run = function() { _tickScheduled = false; tick(); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 0);
    }

    tick();
    // Primary mechanism: react the instant YouTube's own player inserts a
    // skip button or ad overlay into the DOM, instead of waiting up to a
    // fixed poll interval — this is what actually shortens how long an ad
    // overlay is visible before being skipped/hidden. Falls back to the
    // interval below if MutationObserver isn't available for any reason;
    // never throws past this try/catch either way.
    try {
      if (typeof MutationObserver === 'function' && document.body) {
        var observer = new MutationObserver(scheduleTick);
        // childList/subtree alone misses a real, common case: YouTube's
        // player frequently signals an ad not by inserting a brand-new
        // element, but by toggling a class (e.g. an "ad showing" state
        // class) on a container that's ALREADY in the DOM. Without
        // watching attribute changes too, that transition was invisible
        // to the observer and fell all the way back to the slower poll
        // below. attributeFilter keeps this cheap (only class/style
        // changes wake it, not every attribute on every element).
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style']
        });
      }
    } catch (observerErr) { /* fall through to interval-only below */ }
    // Belt-and-suspenders fallback only (also covers the brief window
    // before document.body exists, and any mutation the observer's
    // subtree somehow misses) -- the observer plus the native 'ended'/
    // 'playing' listeners above are the primary, near-instant detection
    // paths now, so this interval exists purely as a safety net, not the
    // main detection mechanism it used to be. Tightened from 400ms given
    // each tick is now substantially cheaper (combined selectors, scoped
    // skip-button lookup) — not "run the same work more often", but "the
    // same safety-net cadence now costs less, so a shorter one is
    // affordable without adding CPU pressure back".
    setInterval(scheduleTick, 250);
  } catch (outerErr) { /* fail silently — this must never affect playback */ }
})();`;

const { attachEarlyInjection, detachEarlyInjection } = require('./youtube-player-patch');

// ---- Built-in YouTube ad-request fallback (network layer, Method 1's
// resilience net) -----------------------------------------------------
//
// WHY THIS EXISTS: every network-level block up to this point depends on
// (a) the @ghostery/adblocker-electron package being installed and
// loading, AND (b) at least one filter list having successfully
// downloaded/validated at some point. If either of those is ever false —
// a fresh install before the first filter-list fetch completes, a
// packaged build missing the dependency, a network outage on first run —
// Method 1 blocks NOTHING, silently, until that's resolved. That is a
// real gap for "block YouTube ads every possible way": the single most
// important category of YouTube ad request (its own first-party
// ad-serving/tracking endpoints) should not be hostage to a successful
// npm install or a successful download.
//
// This is a small, explicit, hand-maintained list of YouTube's own known
// ad-serving/ad-tracking request paths — the same well-documented
// endpoints already covered by the uBlock-Origin/uAssets supplement list
// this project already uses (filters/ublock-filters-seed.txt) and by
// YousList, so it duplicates no new research, just makes the highest-value
// subset of it unconditional. Deliberately:
//   - checked ONLY against requests whose page is youtube.com/
//     youtube-nocookie.com (never applied site-wide);
//   - deliberately narrow and path-specific, never a wholesale block of
//     googlevideo.com/ytimg.com/i.ytimg.com (those serve BOTH ad and
//     legitimate video/thumbnail content — blocking them wholesale is
//     exactly the regression this project's own tests (7d) already guard
//     against);
//   - never applied to a `document`/`subdocument` (navigation) request,
//     so it can never block the page itself the way the earlier
//     third-party staleness bug did;
//   - independent of whether the compiled engine loaded or any filter
//     list ever successfully updated -- it is plain string matching, zero
//     dependencies.
const YOUTUBE_HARDCODED_AD_PATH_SUBSTRINGS = [
  '/pagead/',
  '/api/stats/ads',
  '/ptracking',
  '/get_midroll_',
  '/youtubei/v1/log_event',
  '/annotations_invideo',
];
const YOUTUBE_HARDCODED_AD_THIRD_PARTY_HOSTS = new Set([
  'pagead2.googlesyndication.com',
  'googleads.g.doubleclick.net',
  'static.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'tpc.googlesyndication.com',
]);

function isHardcodedYoutubeAdRequest(url, requestHost, pageHost, resourceType) {
  if (resourceType === 'document' || resourceType === 'subdocument') return false; // never block a navigation itself
  if (requestHost && YOUTUBE_HARDCODED_AD_THIRD_PARTY_HOSTS.has(requestHost)) {
    // Only when the initiating PAGE is actually YouTube -- a general
    // site-wide block of these hosts is already Method 1's job (filter
    // lists); this fallback only has to guarantee YouTube specifically.
    if (pageHost && /(^|\.)youtube(-nocookie)?\.com$/i.test(pageHost)) return true;
  }
  if (pageHost && /(^|\.)youtube(-nocookie)?\.com$/i.test(pageHost) && requestHost && /(^|\.)youtube(-nocookie)?\.com$/i.test(requestHost)) {
    let path;
    try { path = new URL(url).pathname + new URL(url).search; } catch { path = url; }
    for (const sub of YOUTUBE_HARDCODED_AD_PATH_SUBSTRINGS) {
      if (path.indexOf(sub) !== -1) return true;
    }
  }
  return false;
}

class Adblock {
  constructor({ app, settingsTabIds, broadcast, filterListManager }) {
    this.app = app;
    this.settingsTabIds = settingsTabIds; // Set<tabId> — never filter/cosmetic-inject these
    this.broadcast = broadcast || (() => {}); // (payload) => notify every window's UI

    this.state = store.load(app);
    // Tests inject a FilterListManager built with a fake transport (see its
    // constructor) so they never need the real `electron` module.
    this.manager = filterListManager || new FilterListManager(app);
    this.manager.ensureInitialized(this.state);
    // Self-heal any stale/zero per-list rule counts left over from before
    // the getFilters()-based counting fix (see filterlist-manager.js's
    // RULE_COUNTS_SCHEMA_VERSION comment for the root cause) — purely a
    // recompute from text already on disk, no network, never touches
    // which lists are enabled or what they contain.
    try {
      if (this.manager.recomputeRuleCounts(this.state)) store.save(this.app, this.state);
    } catch (err) {
      try { console.error('[adblock] rule-count recompute failed:', err); } catch { /* ignore */ }
    }

    this.engine = new FilterEngine();
    this.stats = new BlockStats({
      getPersistedTotal: () => this.state.stats.totalBlockedAllTime,
      onPersistedTotalChange: (total) => {
        this.state.stats.totalBlockedAllTime = total;
        // Persisting on every single blocked request would be excessive
        // I/O on an ad-heavy page; batch it with a short debounce instead.
        this._schedulePersist();
      },
    });

    this._wcIdToTabId = new Map();
    this._tabHosts = new Map(); // tabId -> current page hostname (or null)
    this._persistTimer = null;
    this._engineError = null; // see _recompileEngine() / getStatus()

    // ---- Diagnostics (Part 2 §2) ----------------------------------------
    // A small in-memory ring buffer of recent filtering DECISIONS (not raw
    // traffic): url, resource type, initiating site, which rule (if any)
    // matched, whether an exception applied, and the final allow/block
    // outcome. Deliberately:
    //  - in-memory only (never written to disk) and capped at a fixed size,
    //    so it can't grow without bound over a long session or leak
    //    browsing history into a file;
    //  - only reachable from the privileged Settings renderer via the IPC
    //    handlers below (never exposed to web content, which only ever
    //    sees whatever the page itself can already observe — whether its
    //    own request was blocked); this is what "without exposing
    //    unnecessary browsing data to websites or other unintended
    //    recipients" means in practice here.
    this._diagEnabled = false; // off by default: zero overhead unless a developer opens Settings → Ad Blocker → Diagnostics
    this._diagLog = [];
    this._diagCap = 500;

    // Method 2's early (CDP-based) layer reports back whether it actually
    // attached/injected successfully -- see youtube-player-patch.js's
    // attachEarlyInjection(). Surfaced through getStatus() so Settings can
    // show a REAL failure instead of the toggle silently claiming success
    // while nothing actually ran (this project's own stated requirement).
    // Keeps only the most recent result; this is a coarse health signal,
    // not a per-tab log.
    this._ytEarlyPatchStatus = { attempted: false, ok: null, error: null, lastAt: null };

    this._recompileEngine();
  }

  // ---- Compilation ----------------------------------------------------

  _recompileEngine() {
    // REPLACED (full-engine-backend-replacement task): this used to run
    // every enabled list's text through the old homegrown
    // filter-parser.js before handing parsed rule objects to engine.js.
    // That parser is retired. engine.js's load() now takes the RAW text
    // directly and compiles it itself via @ghostery/adblocker-electron —
    // this method's job is unchanged (gather the currently-enabled lists'
    // active text and hand it to the engine), it just no longer does any
    // EasyList-syntax parsing of its own on the way there.
    const compiled = [];
    for (const [listId, entry] of Object.entries(this.state.lists)) {
      if (!entry.enabled) continue;
      const text = this.manager.getActiveText(listId);
      compiled.push({ listId, text });
    }
    const stats = this.engine.load(compiled);
    if (stats && stats.error) {
      // Surface a real engine failure (e.g. dependency not installed, or
      // every enabled list failed to parse) through the same status
      // object the UI already reads engineStats off of, rather than
      // leaving Settings showing a healthy-looking state while nothing is
      // actually being blocked.
      this._engineError = stats.error;
    } else {
      this._engineError = null;
    }
    return stats;
  }

  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try { store.save(this.app, this.state); } catch { /* best-effort */ }
    }, 2000);
  }

  _persistNow() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    try { store.save(this.app, this.state); } catch { /* best-effort */ }
  }

  // ---- Session / webRequest registration -------------------------------

  registerSession(sess) {
    sess.webRequest.onBeforeRequest((details, callback) => {
      try {
        const decision = this._decide(details);
        if (decision.blocked) {
          const tabId = this._wcIdToTabId.get(details.webContentsId);
          this.stats.recordBlocked(tabId);
        }
        if (this._diagEnabled) this._recordDiagnostic(details, decision);
        // BUG fixed in this audit (see engine.js's evaluate() for the
        // full explanation): a `$redirect=`-matched request must be
        // redirected to the engine's own neutering stub, not cancelled —
        // cancelling it outright is exactly the failure mode `$redirect`
        // rules exist to avoid (a page's own script choking on a hard
        // network failure instead of silently getting back an inert
        // response). `redirectURL` and `cancel` are mutually exclusive in
        // Electron's callback — only one is ever set here.
        if (decision.redirectUrl) {
          callback({ redirectURL: decision.redirectUrl });
        } else {
          callback({ cancel: decision.blocked });
        }
      } catch {
        // A bug in the matcher must never be able to break browsing —
        // fail open.
        callback({ cancel: false });
      }
    });
  }

  _recordDiagnostic(details, decision) {
    this._diagLog.push({
      time: Date.now(),
      url: details.url,
      resourceType: decision.resourceType || details.resourceType || 'other',
      initiator: decision.pageHost || null,
      blocked: Boolean(decision.blocked),
      reason: decision.reason || null,
      matchedRule: decision.matchedRule || null,
      exception: decision.reason === 'exception' || decision.reason === 'site-exception',
    });
    // Ring buffer: drop the oldest entries once the cap is hit, rather than
    // letting a long, ad-heavy browsing session grow this without bound.
    if (this._diagLog.length > this._diagCap) {
      this._diagLog.splice(0, this._diagLog.length - this._diagCap);
    }
  }

  _decide(details) {
    const resourceType = RESOURCE_TYPE_MAP[details.resourceType] || 'other';
    if (!this.state.enabled) return { blocked: false, reason: 'globally-disabled', resourceType };
    // Method 1 (network filter blocking) independent switch — see store.js.
    // Method 2 (the YouTube DOM ad-skip script) is gated separately, in
    // _applyCosmeticFiltering/_injectYoutubeEmbedScript below, so turning
    // either one off here never silently turns off the other.
    if (!this.state.networkFilterEnabled) return { blocked: false, reason: 'network-filter-disabled', resourceType };

    const tabId = this._wcIdToTabId.get(details.webContentsId);
    if (tabId === undefined) return { blocked: false, reason: 'not-a-tracked-tab', resourceType }; // toolbar/settings/internal UI
    if (this.settingsTabIds.has(tabId)) return { blocked: false, reason: 'internal-page', resourceType };

    if (!isFilterableUrl(details.url)) return { blocked: false, reason: 'non-filterable-scheme', resourceType };

    const requestHost = normalizeHostname(details.url);

    // ROOT CAUSE (YouTube won't load / GitHub renders as plain text):
    // `this._tabHosts` is only updated by the `did-navigate` listener in
    // attachTab(), which fires on *commit* -- strictly after this very
    // request (the navigation request itself, for `document` resourceType)
    // has already been evaluated. So the top-level request to e.g.
    // https://youtube.com/ was being judged "third-party" against whatever
    // site the tab was PREVIOUSLY on (or null on a fresh tab), because
    // _tabHosts still held the old value. isThirdParty() then returned true
    // for a request that is, by definition, never third-party relative to
    // itself, letting a plain `$third-party` rule (no further domain/type
    // scoping -- common in real EasyList) cancel the page's own navigation,
    // exactly matching the reported ERR_BLOCKED_BY_CLIENT on
    // https://youtube.com/. The same staleness made early subresources on a
    // just-navigated page (GitHub's CSS/JS/fonts, which load before
    // did-navigate's listener runs) evaluate against the wrong page host
    // too.
    //
    // Fix: a top-level `document` request IS the page -- its own host is
    // always the correct "pageHost" for first/third-party purposes, never
    // whatever the tab happened to be showing a moment ago.
    //
    // SECOND BUG found in the later full-engine audit (not part of the
    // original YouTube/GitHub fix): a `subdocument` request is an IFRAME's
    // own navigation -- it is a SUB-RESOURCE of the top page, not the page
    // itself. Treating it the same as `document` (pageHost = the iframe's
    // own destination host) made an iframe's own load request first-party
    // *to itself* by construction, so:
    //   - a `$third-party`-scoped rule aimed at third-party ad/tracking
    //     iframes (an extremely common EasyList shape, e.g.
    //     "||doubleclick.net^$subdocument,third-party") could never match
    //     the iframe's own navigation request, since requestHost and
    //     pageHost were always identical -- a real false negative (ads
    //     embedded via <iframe> were not blocked even though the same URL
    //     loaded as an <img>/<script> would have been).
    //   - a `domain=` option scoped to the TOP site (e.g. a cosmetic or
    //     network rule meant "only on example.com") would instead be
    //     evaluated against the iframe's own host, so it could wrongly
    //     apply/not-apply depending on what happened to be embedded --
    //     a real false positive risk for iframe-heavy flows (OAuth/SSO
    //     sign-in widgets, payment processors, video embeds), which lines
    //     up with the reported "breaking... authentication... video
    //     playback" beyond just YouTube/GitHub.
    // Fix: only `document` (an actual top-level navigation) uses its own
    // host as pageHost. `subdocument` (iframe) falls through to the same
    // path as every other sub-resource: the current tab's TOP-level host
    // from `_tabHosts`, which is exactly what ABP/uBlock-style engines use
    // for first/third-party and domain= evaluation of framed content.
    const pageHost = (resourceType === 'document')
      ? requestHost
      : (this._tabHosts.get(tabId) || null);

    if (pageHost && this.state.siteExceptions[pageHost]) {
      return { blocked: false, reason: 'site-exception', resourceType, pageHost };
    }

    // Hardcoded YouTube ad-request fallback (see its definition above):
    // runs BEFORE the compiled-engine check so it still blocks YouTube's
    // own known ad-serving paths even if the engine failed to load or no
    // filter list has ever successfully updated. Never overrides an
    // explicit site exception (handled above, already returned by this
    // point) and never touches a navigation request.
    if (isHardcodedYoutubeAdRequest(details.url, requestHost, pageHost, resourceType)) {
      return { blocked: true, reason: 'hardcoded-youtube-ad-fallback', resourceType, pageHost, matchedRule: 'built-in YouTube ad endpoint' };
    }

    const result = this.engine.evaluate({ url: details.url, requestHost, pageHost, resourceType });
    return {
      blocked: result.blocked,
      reason: result.reason,
      matchedRule: result.matchedRule,
      resourceType,
      pageHost,
      redirectUrl: result.redirectUrl || null, // see registerSession() below and engine.js's evaluate()
    };
  }

  // ---- Tab lifecycle hooks (called from main.js's createTab et al.) ----

  // Mirrors the other attach*(id, wc) helpers already used in main.js
  // (trackFavicon, trackHistory, attachContextMenu, ...).
  attachTab(tabId, wc) {
    this._wcIdToTabId.set(wc.id, tabId);
    this._tabHosts.set(tabId, normalizeHostname(wc.getURL() || '') || null);

    // Method 2, early layer (youtube-player-patch.js): attach the CDP
    // debugger and register the document-start script NOW, before this
    // tab has navigated anywhere, so it is armed in time for the tab's
    // very first navigation -- including a brand-new tab opened directly
    // to a youtube.com URL. Cheap/idle until a document actually loads;
    // gated by the same youtubeAdSkipEnabled switch as the rest of
    // Method 2, and re-checked on every navigation start below so a tab
    // that starts elsewhere and later browses to YouTube still gets it,
    // and so toggling the setting on after a tab is already open still
    // takes effect on that tab's next navigation.
    if (this.state.youtubeAdSkipEnabled && !this.settingsTabIds.has(tabId)) {
      attachEarlyInjection(wc, (ok, error) => this._recordYtEarlyPatchResult(ok, error));
    }

    // Update _tabHosts as early as possible -- at navigation *start*, not
    // just at commit (did-navigate below). Chromium can begin requesting a
    // new page's render-blocking subresources before did-navigate's
    // listener runs, so relying on did-navigate alone left a window where
    // those early subresource requests were still judged against the
    // PREVIOUS page's host (see the detailed note in _decide()). This is
    // belt-and-suspenders on top of _decide()'s own document/subdocument
    // special-case, covering ordinary subresources too.
    wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      this._tabHosts.set(tabId, normalizeHostname(url) || null);
      // Re-arm (idempotent -- see __glozaYtPatchAttached guard inside
      // attachEarlyInjection) on every top-level navigation start, not
      // just once at tab creation: covers a tab that was created before
      // the setting was last turned on, and a tab that starts on a
      // non-YouTube page and later navigates to one.
      if (this.state.youtubeAdSkipEnabled && !this.settingsTabIds.has(tabId)) {
        attachEarlyInjection(wc, (ok, error) => this._recordYtEarlyPatchResult(ok, error));
      }
    });

    // did-navigate fires only for top-level (main-frame) navigations in
    // Electron, which is exactly the granularity "blocked on this site"
    // stats should reset at — an in-page anchor jump or an iframe
    // navigating underneath shouldn't zero the counter.
    wc.on('did-navigate', (_event, url) => {
      this._tabHosts.set(tabId, normalizeHostname(url) || null);
      this.stats.resetTab(tabId);
    });

    wc.on('did-finish-load', () => this._applyCosmeticFiltering(tabId, wc));

    // ---- Embedded YouTube players (iframes) ---------------------------
    // `did-frame-finish-load` fires for EVERY frame in the page (main and
    // sub), unlike `did-finish-load` (main frame only) — exactly the
    // lifecycle hook needed to catch embeds that load after the initial
    // page load, embeds created dynamically later (e.g. a "play" click
    // that inserts a fresh <iframe>), and an existing embed frame that
    // navigates/reloads in place (that frame fires its own
    // did-frame-finish-load again; Electron does not re-fire it for
    // unrelated sibling frames, so this does not re-scan the whole page on
    // every embed's reload).
    wc.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) return; // main-frame top-level YouTube pages are handled by did-finish-load above
      this._injectYoutubeEmbedScript(tabId, wc, frameProcessId, frameRoutingId);
    });
  }

  detachTab(tabId, wc) {
    if (wc) this._wcIdToTabId.delete(wc.id);
    this._tabHosts.delete(tabId);
    this.stats.forgetTab(tabId);
  }

  _applyCosmeticFiltering(tabId, wc) {
    if (!this.state.enabled) return;
    if (this.settingsTabIds.has(tabId)) return;
    const url = wc.getURL();
    if (!isFilterableUrl(url)) return;
    const pageHost = this._tabHosts.get(tabId);
    if (!pageHost || this.state.siteExceptions[pageHost]) return;
    const cosmetics = this.engine.cosmeticsFor(pageHost);
    if (cosmetics.css) wc.insertCSS(cosmetics.css).catch(() => { /* page may have already navigated away */ });

    // GAP fixed in this audit (see engine.js's cosmeticsFor()/`_cosmeticsFor`
    // for the full explanation): `.scripts` from the same compiled
    // cosmetics result was being silently discarded here, so any fetched
    // filter-list rule written as a scriptlet (`##+js(...)`) had zero
    // effect no matter how correctly it parsed and compiled. These are
    // run the same way the existing YOUTUBE_AD_SKIP_SCRIPT already is
    // (page-context `executeJavaScript`, independent per-script try/catch
    // boundary implicit in each one being its own statement, and the same
    // "never let one bad script break the page" fail-open posture as
    // everywhere else in this file) — this is a general mechanism for
    // EVERY site's compiled scriptlets, not YouTube-specific, but it is
    // specifically what lets maintained lists patch a site's own
    // JavaScript (e.g. stripping ad markers out of a response object
    // before the page's own code reads it) — the standard technique for
    // exactly the class of ad delivery (server-stitched, can't be told
    // apart from content by URL) this project's own comments already
    // document plain network blocking and CSS hiding can't reach.
    for (const script of cosmetics.scripts) {
      wc.executeJavaScript(script).catch(() => { /* a single scriptlet failing/erroring must never block the rest of the page or other scriptlets */ });
    }

    // Separate, independent layer — see YOUTUBE_AD_SKIP_SCRIPT's own header
    // comment. Still gated by the master "protection is on" switch and the
    // per-site exception (turning off the ad blocker entirely, or adding a
    // site exception for youtube.com, turns this off too), but — new this
    // round — ALSO gated by its own youtubeAdSkipEnabled switch, independent
    // of networkFilterEnabled/Method 1. This is what makes "Method 2 —
    // YouTube-specific blocking" a real, separately-testable on/off control
    // in Settings rather than permanently tied to Method 1's switch.
    if (this.state.youtubeAdSkipEnabled && isYoutubeAdSkipHost(pageHost) && typeof wc.executeJavaScript === 'function') {
      wc.executeJavaScript(YOUTUBE_AD_SKIP_SCRIPT).catch(() => { /* page may have already navigated away */ });
    }
  }

  // Frame-scoped counterpart to _applyCosmeticFiltering, for YouTube players
  // embedded in a sub-frame of a third-party page (see the long comment
  // above isYoutubeEmbedFrameUrl() for why this has to be separate from the
  // host-based main-frame check).
  _injectYoutubeEmbedScript(tabId, wc, frameProcessId, frameRoutingId) {
    if (!this.state.enabled) return;
    // Method 2's own independent switch — see the comment above the
    // top-level-frame injection in _applyCosmeticFiltering for why this is
    // separate from networkFilterEnabled/Method 1.
    if (!this.state.youtubeAdSkipEnabled) return;
    if (this.settingsTabIds.has(tabId)) return;
    if (wc.isDestroyed()) return;

    // Respect the same per-site opt-out the top-level script honors: if the
    // user disabled adblock for the EMBEDDING page, the embedded player's
    // ad-skip is part of that same toggle, not a hidden separate one.
    const pageHost = this._tabHosts.get(tabId);
    if (pageHost && this.state.siteExceptions[pageHost]) return;

    // Resolve the specific frame that just finished loading. `fromId` looks
    // it up by (processId, routingId) — the pair `did-frame-finish-load`
    // hands back — rather than walking `framesInFrameTree`, so a page with
    // many unrelated iframes (ads, widgets, comment embeds, etc.) is never
    // scanned; only the one frame that actually just loaded is touched.
    let frame;
    try {
      frame = require('electron').webFrameMain.fromId(frameProcessId, frameRoutingId);
    } catch (_e) {
      frame = null;
    }
    if (!frame) return; // frame already navigated away/closed between the event and here

    const frameUrl = frame.url;
    if (!isYoutubeEmbedFrameUrl(frameUrl)) return; // not a YouTube player frame -- leave it alone

    if (typeof frame.executeJavaScript !== 'function') return; // defensive; WebFrameMain.executeJavaScript (Electron 12+)

    // window.__glozaYtAdSkipActive (set inside YOUTUBE_AD_SKIP_SCRIPT) is a
    // per-DOCUMENT flag, so it already prevents double-injection for THIS
    // frame across repeated did-frame-finish-load firings (e.g. a reload).
    // Because fromId() resolves a single concrete frame, a page with
    // multiple embedded players each gets its own frame/document/flag, so
    // one player's script never blocks another's.
    frame.executeJavaScript(YOUTUBE_AD_SKIP_SCRIPT).catch(() => {
      // Frame navigated away or was torn down between resolution and
      // execution -- not an error worth surfacing.
    });
  }

  _recordYtEarlyPatchResult(ok, error) {
    this._ytEarlyPatchStatus = { attempted: true, ok: Boolean(ok), error: ok ? null : (error || 'unknown error'), lastAt: Date.now() };
  }

  // ---- Public operations (used by IPC handlers below, and directly from
  // any future UI code running in the main process) ---------------------

  getStatus() {
    const lists = this.manager.listDefinitions();
    return {
      enabled: this.state.enabled,
      // Independent per-method state (YouTube ad-blocking fix, this round)
      // — see store.js's DEFAULT_STATE comment. Settings renders these as
      // two separate switches ("Method 1 — Network filter blocking",
      // "Method 2 — YouTube-specific blocking"); neither is implied by the
      // other, and both are reported here as their OWN real on/off state,
      // never inferred or defaulted in the renderer.
      networkFilterEnabled: this.state.networkFilterEnabled,
      youtubeAdSkipEnabled: this.state.youtubeAdSkipEnabled,
      // True engine-level health: distinct from `enabled` (the user's own
      // on/off toggle). If @ghostery/adblocker-electron failed to load or
      // failed to parse every enabled list, requests are NOT actually
      // being filtered even though the toggle may show "on" — the
      // existing Settings page's status/error display is expected to
      // surface this rather than the UI silently claiming protection is
      // active. See requirement: "Every status shown in the UI must
      // reflect the actual engine's state."
      engineError: this._engineError || null,
      updateIntervalMs: this.state.updateIntervalMs,
      lists: Object.entries(this.state.lists).map(([id, entry]) => ({
        id,
        label: lists[id]?.label || id,
        description: lists[id]?.description || '',
        category: lists[id]?.category || 'other',
        enabled: entry.enabled,
        url: entry.url,
        source: entry.source,
        lastSuccessfulUpdate: entry.lastSuccessfulUpdate,
        lastAttempt: entry.lastAttempt,
        lastError: entry.lastError,
        ruleCounts: entry.ruleCounts,
      })),
      engineStats: this.engine.getStats(),
      // Real, observed outcome of Method 2's early (CDP) player-patch
      // layer -- not inferred from the toggle being on. { attempted:
      // false } means no YouTube tab has loaded yet this session (nothing
      // to report); { attempted: true, ok: false, error } means it tried
      // and actually failed (e.g. CDP debugger unavailable in this
      // build/packaging), in which case Method 2 is still running on its
      // DOM-level fallback only (see YOUTUBE_AD_SKIP_SCRIPT).
      youtubeEarlyPatchStatus: this._ytEarlyPatchStatus,
    };
  }

  setEnabled(enabled) {
    this.state.enabled = Boolean(enabled);
    this._persistNow();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return this.state.enabled;
  }

  // Method 1 — network filter blocking — independent on/off switch.
  setNetworkFilterEnabled(enabled) {
    this.state.networkFilterEnabled = Boolean(enabled);
    this._persistNow();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return this.state.networkFilterEnabled;
  }

  // Method 2 — YouTube-specific (DOM ad-skip script) blocking — independent
  // on/off switch. Deliberately does NOT touch the engine/compiled filter
  // lists at all; it only changes whether _applyCosmeticFiltering/
  // _injectYoutubeEmbedScript inject YOUTUBE_AD_SKIP_SCRIPT on the next
  // did-finish-load / did-frame-finish-load. An already-injected script in
  // an already-open tab keeps running until that tab next navigates or
  // reloads (the same "no page handle is kept around to retroactively
  // un-inject a content script" constraint every other toggle in this file
  // already has — e.g. turning off `enabled` doesn't retroactively remove
  // already-inserted cosmetic CSS from an open tab either).
  setYoutubeAdSkipEnabled(enabled) {
    this.state.youtubeAdSkipEnabled = Boolean(enabled);
    this._persistNow();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return this.state.youtubeAdSkipEnabled;
  }

  // hostname may be a full URL (toolbar passes the active tab's URL) or a
  // bare hostname — normalizeHostname() accepts either.
  getSiteState(urlOrHost) {
    const host = normalizeHostname(urlOrHost);
    return { hostname: host, disabled: Boolean(host && this.state.siteExceptions[host]) };
  }

  setSiteException(urlOrHost, disabled) {
    const host = normalizeHostname(urlOrHost);
    if (!host) return { ok: false, reason: 'could not determine a hostname for that URL' };
    if (disabled) this.state.siteExceptions[host] = true;
    else delete this.state.siteExceptions[host];
    this._persistNow();
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
      this._persistNow();
      // Was previously missing here — meant removing a single exception
      // from Settings left the shield popup (and any other open window)
      // showing stale protection state for that site until something else
      // triggered a refresh. Found while wiring the Part 2 Settings page.
      this.broadcast({ type: 'status', status: this.getStatus() });
    }
    return { ok: true, removed: existed };
  }

  clearExceptions() {
    this.state.siteExceptions = {};
    this._persistNow();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return { ok: true };
  }

  getStats(tabId) {
    return this.stats.snapshot(tabId);
  }

  // ---- Diagnostics (Part 2 §2) ------------------------------------------
  setDiagnosticsEnabled(enabled) {
    this._diagEnabled = Boolean(enabled);
    if (!this._diagEnabled) this._diagLog = [];
    return { ok: true, enabled: this._diagEnabled };
  }

  getDiagnostics(limit) {
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, this._diagLog.length) : this._diagLog.length;
    // Newest first — that's what a developer scanning for "why was this
    // just blocked/allowed" wants to see without scrolling.
    return {
      enabled: this._diagEnabled,
      capacity: this._diagCap,
      entries: this._diagLog.slice(-n).reverse(),
    };
  }

  clearDiagnostics() {
    this._diagLog = [];
    return { ok: true };
  }

  resetStats() {
    this.state.stats.totalBlockedAllTime = 0;
    this._persistNow();
    // Session + per-tab counters are in-memory only; rebuild them fresh.
    this.stats = new BlockStats({
      getPersistedTotal: () => this.state.stats.totalBlockedAllTime,
      onPersistedTotalChange: (total) => {
        this.state.stats.totalBlockedAllTime = total;
        this._schedulePersist();
      },
    });
    return { ok: true };
  }

  async setListEnabled(listId, enabled) {
    if (!this.state.lists[listId]) return { ok: false, reason: `unknown list "${listId}"` };
    this.state.lists[listId].enabled = Boolean(enabled);
    this._persistNow();
    this._recompileEngine();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return { ok: true };
  }

  async updateLists({ force = false, listId = null } = {}) {
    let results;
    if (listId) {
      results = { [listId]: await this.manager.updateList(this.state, listId) };
    } else {
      results = await this.manager.updateAllEnabled(this.state, { force });
    }
    this._recompileEngine();
    this._persistNow();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return results;
  }

  // "Provide a way to restore the default configuration" (Settings → Ad
  // Blocker → Filter lists). Re-enables every known list and resets the
  // update interval; deliberately leaves site exceptions and already-
  // downloaded list text alone (see filterlist-manager.js's
  // resetToDefaults for why).
  restoreDefaults() {
    this.manager.resetToDefaults(this.state);
    this._recompileEngine();
    this.broadcast({ type: 'status', status: this.getStatus() });
    return { ok: true };
  }

  startScheduledUpdates() {
    this.manager.scheduleAutomaticUpdates(
      () => this.state,
      () => this._persistNow(),
      () => {
        this._recompileEngine();
        this.broadcast({ type: 'status', status: this.getStatus() });
      },
    );
  }

  stopScheduledUpdates() {
    this.manager.stopAutomaticUpdates();
  }

  shutdown() {
    this.stopScheduledUpdates();
    this._persistNow();
  }

  // ---- IPC wiring --------------------------------------------------------
  // Called once from main.js with the app's real ipcMain. Mirrors the
  // existing ipcMain.handle(...) style used throughout main.js; kept here
  // instead so main.js itself stays a thin "register and go" call, per the
  // Part 1A handoff note.
  registerIpc(ipcMain) {
    ipcMain.handle('adblock:getStatus', () => this.getStatus());
    ipcMain.handle('adblock:setEnabled', (_e, enabled) => this.setEnabled(enabled));
    ipcMain.handle('adblock:setNetworkFilterEnabled', (_e, enabled) => this.setNetworkFilterEnabled(enabled));
    ipcMain.handle('adblock:setYoutubeAdSkipEnabled', (_e, enabled) => this.setYoutubeAdSkipEnabled(enabled));

    ipcMain.handle('adblock:getSiteState', (_e, urlOrHost) => this.getSiteState(urlOrHost));
    ipcMain.handle('adblock:setSiteException', (_e, { urlOrHost, disabled }) => this.setSiteException(urlOrHost, disabled));
    ipcMain.handle('adblock:listExceptions', () => this.listExceptions());
    ipcMain.handle('adblock:removeException', (_e, hostname) => this.removeException(hostname));
    ipcMain.handle('adblock:clearExceptions', () => this.clearExceptions());

    ipcMain.handle('adblock:getStats', (_e, tabId) => this.getStats(tabId));
    ipcMain.handle('adblock:resetStats', () => this.resetStats());

    ipcMain.handle('adblock:setListEnabled', (_e, { listId, enabled }) => this.setListEnabled(listId, enabled));
    ipcMain.handle('adblock:updateLists', (_e, opts) => this.updateLists(opts || {}));
    ipcMain.handle('adblock:restoreDefaults', () => this.restoreDefaults());

    ipcMain.handle('adblock:setDiagnosticsEnabled', (_e, enabled) => this.setDiagnosticsEnabled(enabled));
    ipcMain.handle('adblock:getDiagnostics', (_e, limit) => this.getDiagnostics(limit));
    ipcMain.handle('adblock:clearDiagnostics', () => this.clearDiagnostics());
  }
}

module.exports = { Adblock, RESOURCE_TYPE_MAP, isYoutubeAdSkipHost, isYoutubeEmbedFrameUrl, YOUTUBE_AD_SKIP_SCRIPT };
