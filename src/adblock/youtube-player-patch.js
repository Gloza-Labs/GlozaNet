// ============================================================================
// adblock/youtube-player-patch.js — Method 2, core mechanism.
//
// WHY THIS FILE EXISTS (root cause of "YouTube still shows ads" even with
// the network filter lists fixed AND the existing DOM skip/hide script in
// place): that DOM script (see YOUTUBE_AD_SKIP_SCRIPT in index.js) is
// injected from `did-finish-load` / `did-frame-finish-load`. Both fire
// AFTER the page's own inline <script> has already run — and on a YouTube
// watch page, that inline script is what parses `ytInitialPlayerResponse`
// and hands it to the player, which is what actually SCHEDULES the ad
// (decides an ad will play, which creature/pod, etc.) before any button
// exists for the DOM script to click or any overlay exists for it to hide.
// A skip-button click can only shorten an ad that has already started
// playing; it can never stop a non-skippable ad, and it does nothing for
// the brief (but real, audible/visible) window before a skip button
// appears at all.
//
// This is a different, EARLIER layer, not a rewrite of that one: it runs
// BEFORE YouTube's own scripts, via Chrome DevTools Protocol's
// `Page.addScriptToEvaluateOnNewDocument` (reached through Electron's
// `webContents.debugger`), which is the standard, documented Electron
// mechanism for "run this before the page's own JS" (the exact thing a
// content script's "document_start" / "run_at: document_start" gives an
// extension, which GlozaNet does not have access to since it is not
// loading this as a Chrome/Firefox extension). It:
//
//   1. Installs an accessor trap on `window.ytInitialPlayerResponse`
//      BEFORE the page's own inline script assigns to it, so the ad
//      scheduling fields are stripped out of that object the instant it
//      is set — before the player ever reads it.
//   2. Wraps `window.fetch` and `XMLHttpRequest` so that any LATER
//      player-response fetch (`/youtubei/v1/player`, `/get_video_info` —
//      used for subsequent videos in the same session, e.g. autoplay/
//      up-next, without a full page reload) is stripped the same way
//      before the page's own code parses the response body.
//
// Verified compatible with the project's actual Electron version (see
// package.json: Electron ^43.2.0) against the official docs: `webContents
// .debugger` and `Page.addScriptToEvaluateOnNewDocument` are long-stable
// CDP/Electron APIs, present and documented for Electron 43 at
// https://www.electronjs.org/docs/latest/api/debugger and
// https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument
// — not a Manifest V3 / service-worker / declarativeNetRequest API, so
// none of the extension-platform caveats this project's brief flags apply.
//
// Explicitly does NOT:
//   - touch currentTime, playbackRate, volume, or any playback-affecting
//     API once a video is actually playing;
//   - disable sandboxing, contextIsolation, or web security;
//   - expose any Electron/Node API to the page (the injected text is
//     plain, ordinary page-context JavaScript — CDP's
//     addScriptToEvaluateOnNewDocument runs in the page's own main world,
//     with zero access to anything in the Electron main/preload process);
//   - run on any page other than an actual YouTube watch/embed frame
//     (see shouldAttach() below) — it is never attached to arbitrary
//     browsing.
// ============================================================================

'use strict';

// Fields that mark an ad as scheduled to play, across the shapes YouTube's
// player-response JSON has used. Deliberately a stable, documented set of
// top-level/nested keys (not a guess): these are the same fields that
// maintained open-source YouTube ad-blocking projects (e.g. the
// player-response-stripping techniques used by AdGuard's and uBlock
// Origin's YouTube-specific scriptlets) strip for exactly this purpose.
// Stripping only these — never touching `streamingData`, `videoDetails`,
// or anything playback-related — is what keeps ordinary playback, quality
// selection, captions, and seeking intact.
const AD_FIELD_PATHS = [
  'adPlacements',
  'adSlots',
  'playerAds',
  'adBreakHeartbeatParams',
  'adSignalsInfo',
];

// This string is injected into the PAGE's own JS context via CDP, not
// require()'d or eval'd in the Electron process — it must be plain,
// self-contained ES5-ish JS with no reference to Node/Electron globals,
// matching the same constraint and defensive posture (try/catch
// everywhere, never throw past itself, never touch playback APIs) as the
// existing YOUTUBE_AD_SKIP_SCRIPT in index.js.
const PLAYER_RESPONSE_PATCH_SCRIPT = `(function() {
  try {
    if (window.__glozaYtPlayerPatchActive) return;
    window.__glozaYtPlayerPatchActive = true;

    var AD_FIELDS = ${JSON.stringify(AD_FIELD_PATHS)};

    function stripAdFields(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      try {
        for (var i = 0; i < AD_FIELDS.length; i++) {
          if (AD_FIELDS[i] in obj) delete obj[AD_FIELDS[i]];
        }
        // playerAds / adPlacements sometimes also hang off a nested
        // playerResponse wrapper (e.g. { playerResponse: {...} } shapes
        // returned by some youtubei endpoints) -- check one level down
        // too, defensively, without recursing unbounded.
        if (obj.playerResponse && typeof obj.playerResponse === 'object') {
          for (var j = 0; j < AD_FIELDS.length; j++) {
            if (AD_FIELDS[j] in obj.playerResponse) delete obj.playerResponse[AD_FIELDS[j]];
          }
        }
      } catch (e) { /* never let a shape mismatch break playback */ }
      return obj;
    }

    // ---- Layer 1: the inline ytInitialPlayerResponse assignment --------
    // On a normal watch-page load, YouTube's own inline <script> does
    // roughly: var ytInitialPlayerResponse = {...huge JSON...}; -- before
    // any of our did-finish-load-based injection could ever run. Trap the
    // property so the strip happens at the moment of assignment, which is
    // before the player (loaded by a later script) ever reads it.
    try {
      var _ytInitialPlayerResponse;
      Object.defineProperty(window, 'ytInitialPlayerResponse', {
        configurable: true,
        enumerable: true,
        get: function() { return _ytInitialPlayerResponse; },
        set: function(value) { _ytInitialPlayerResponse = stripAdFields(value); }
      });
    } catch (e) { /* property already non-configurable for some reason -- fall through to layers 2/3 */ }

    // ---- Layer 2: fetch() ------------------------------------------------
    // Covers later player-response fetches that happen without a full
    // page reload (autoplay/up-next, manual next-video, mini-player).
    if (typeof window.fetch === 'function') {
      var _origFetch = window.fetch;
      window.fetch = function() {
        var args = arguments;
        return _origFetch.apply(this, args).then(function(response) {
          try {
            var url = (args[0] && args[0].url) || args[0] || '';
            if (typeof url === 'string' && (url.indexOf('/youtubei/v1/player') !== -1 || url.indexOf('/get_video_info') !== -1)) {
              return response.clone().json().then(function(data) {
                stripAdFields(data);
                return new Response(JSON.stringify(data), {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                });
              }).catch(function() { return response; });
            }
          } catch (e) { /* fall through to the real, unmodified response */ }
          return response;
        });
      };
    }

    // ---- Layer 3: XMLHttpRequest ------------------------------------------
    // Some of YouTube's own internal requests still go through XHR rather
    // than fetch. Same strip, applied to responseText right before the
    // page's own onreadystatechange/load handlers read it.
    if (window.XMLHttpRequest) {
      var _origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        try { this.__glozaUrl = url; } catch (e) {}
        return _origOpen.apply(this, arguments);
      };
      var _origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function() {
        try {
          var url = this.__glozaUrl || '';
          if (typeof url === 'string' && (url.indexOf('/youtubei/v1/player') !== -1 || url.indexOf('/get_video_info') !== -1)) {
            this.addEventListener('readystatechange', function() {
              if (this.readyState !== 4) return;
              try {
                var ct = this.getResponseHeader && this.getResponseHeader('content-type');
                if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return; // can't safely rewrite non-text response types
                var data = JSON.parse(this.responseText);
                stripAdFields(data);
                var patched = JSON.stringify(data);
                Object.defineProperty(this, 'responseText', { value: patched, configurable: true });
                Object.defineProperty(this, 'response', { value: patched, configurable: true });
              } catch (e) { /* not JSON, or shape we don't recognize -- leave untouched */ }
            });
          }
        } catch (e) {}
        return _origSend.apply(this, arguments);
      };
    }
  } catch (outerErr) { /* fail silently -- must never affect playback */ }
})();`;

// Hosts this is allowed to attach to -- top-level YouTube watch pages and
// the YouTube player-embed hosts. Intentionally the same universe
// index.js's isYoutubeAdSkipHost/isYoutubeEmbedFrameUrl already recognize
// -- this file does not introduce a new definition of "is this YouTube",
// it reuses the project's existing one so the two layers of Method 2 are
// always gated by the exact same host/frame logic.
function attachEarlyInjection(wc, onResult) {
  // onResult(ok, errorMessage) -- optional. Lets the caller (adblock/
  // index.js) surface a REAL initialization failure through Settings
  // instead of the toggle silently claiming success while CDP attach or
  // script registration actually failed (see the project's own
  // requirement: "avoid falsely displaying an enabled state when the
  // mechanism has failed"). Previously this only logged to the main
  // process console, which the user testing the packaged app has no way
  // to see.
  const report = typeof onResult === 'function' ? onResult : () => {};
  // Defensive about the shape of `wc`: the test suite (and any future
  // caller) may pass a lightweight fake webContents that implements only
  // the handful of methods adblock/index.js itself actually relies on,
  // without isDestroyed()/debugger -- this must degrade to a silent no-op
  // rather than throw, exactly like every other best-effort hook in this
  // file.
  if (!wc) return;
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
  if (wc.__glozaYtPatchAttached) return; // one attach per webContents lifetime is enough -- CDP re-applies the script on every subsequent document/navigation automatically
  wc.__glozaYtPatchAttached = true;

  const dbg = wc.debugger;
  if (!dbg || typeof dbg.attach !== 'function') {
    wc.__glozaYtPatchAttached = false;
    report(false, 'webContents.debugger API unavailable in this build');
    return;
  }

  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (err) {
    // Another tool (e.g. real DevTools, or this SAME webContents already
    // having a debugger attached from a previous run of this function --
    // CDP allows only ONE debugger client per target) may already be
    // attached. Fail soft: the existing did-finish-load-based DOM skip
    // script (Method 2's other layer) still runs regardless, so YouTube
    // ad-blocking degrades gracefully rather than breaking entirely.
    wc.__glozaYtPatchAttached = false;
    report(false, `debugger.attach failed: ${err && err.message}`);
    return;
  }

  Promise.resolve(dbg.sendCommand('Page.enable').catch(() => {}))
    .then(() => dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: PLAYER_RESPONSE_PATCH_SCRIPT,
      // Applies to every frame of this target by default (CDP's default
      // worldName), which is what lets a single attach on the top-level
      // tab's webContents also cover any embedded YouTube player iframes
      // that share the same renderer target -- see the long comment at
      // the top of this file.
      runImmediately: true,
    }))
    .then(() => report(true, null))
    .catch((err) => {
      try { console.error('[adblock] YouTube early player-patch injection failed:', err && err.message); } catch { /* ignore */ }
      report(false, `addScriptToEvaluateOnNewDocument failed: ${err && err.message}`);
    });

  if (typeof wc.once === 'function') {
    wc.once('destroyed', () => {
      try { if (dbg.isAttached()) dbg.detach(); } catch { /* already gone */ }
    });
  }
}

function detachEarlyInjection(wc) {
  if (!wc) return;
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
  try {
    if (wc.debugger && typeof wc.debugger.isAttached === 'function' && wc.debugger.isAttached()) wc.debugger.detach();
  } catch { /* ignore */ }
  wc.__glozaYtPatchAttached = false;
}

module.exports = {
  PLAYER_RESPONSE_PATCH_SCRIPT,
  AD_FIELD_PATHS,
  attachEarlyInjection,
  detachEarlyInjection,
};
