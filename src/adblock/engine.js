// ============================================================================
// adblock/engine.js — the actual rule-matching engine.
//
// REPLACED (full-engine-backend-replacement task): this used to be a
// homegrown EasyList-syntax matcher (hand-rolled regex compilation, a
// hand-maintained third-party/public-suffix table, its own cosmetic-rule
// scoping). All of that is retired. This file is now a thin adapter around
// @ghostery/adblocker-electron's `ElectronBlocker` — the same matching
// engine (descended from Cliqz's adblocker, pre-dating the deprecated
// @cliqz/adblocker-electron package name but NOT that deprecated package
// itself) used by Ghostery and compatible with uBlock-Origin/EasyList
// filter syntax, including options (`$csp`, `$redirect`, extended CSS
// `:has()`/`:xpath()`, `$removeparam`, ...) the old parser explicitly could
// not support and reported as "unsupported" rather than risk silently
// mis-applying.
//
// Still has zero DIRECT Electron imports (no `require('electron')`) — it
// only touches @ghostery/adblocker's pure matching API — so it stays
// driveable from plain-Node tests the same way the old engine.js was. The
// public shape (load/evaluate/cosmeticCssFor/getStats/isEmpty) is kept
// IDENTICAL to the retired engine on purpose, so adblock/index.js — the
// Electron-facing session/webRequest/IPC wiring that the existing Gloza
// AdBlocker UI and Settings page already talk to — needed only the small,
// targeted changes described in its own header, not a rewrite.
// ============================================================================

'use strict';

// Lazily required (not at module load time) so this file can still be
// `require()`d — and its error-handling paths exercised — in an
// environment where `npm install` hasn't been run yet / the package isn't
// present, without crashing the whole process before `index.js` ever gets
// a chance to log a real status/error through the existing Gloza
// error-feedback mechanism (Settings' list status, `lastError` field, "No,
// never" "every status shown in the UI must reflect the actual engine's
// state" requirement). A missing dependency degrades to "no blocking,
// visible error" (fail open, same philosophy the old onBeforeRequest
// try/catch in index.js already used for a matcher bug), never a crash.
let ElectronBlockerClass = null;
let RequestClass = null;
let _loadError = null;

function loadLibrary() {
  if (ElectronBlockerClass || _loadError) return;
  try {
    // eslint-disable-next-line global-require
    ({ ElectronBlocker: ElectronBlockerClass } = require('@ghostery/adblocker-electron'));
    // eslint-disable-next-line global-require
    ({ Request: RequestClass } = require('@ghostery/adblocker'));
    if (!ElectronBlockerClass || !RequestClass) {
      throw new Error('unexpected export shape from @ghostery/adblocker-electron / @ghostery/adblocker');
    }
  } catch (err) {
    _loadError = err;
  }
}

// adblock/index.js's RESOURCE_TYPE_MAP translates Electron's own
// webRequest `details.resourceType` strings into the ABP/EasyList type
// vocabulary ('document', 'subdocument', 'xmlhttprequest', ...) that the
// RETIRED homegrown filter-parser.js/engine.js used throughout. The real
// @ghostery/adblocker's `Request.fromRawDetails` — per its own published
// README examples (`type: 'main_frame'`, `type: 'script'`) — expects
// Chrome/WebExtension `webRequest`-style type strings instead. Rather than
// touch index.js's RESOURCE_TYPE_MAP (and its hard-won $ping regression
// history — see its own comments) or the diagnostics/stats code that
// reads its output, this one small table translates at the boundary,
// right before handing a request to the real engine.
const ABP_TYPE_TO_WEBREQUEST_TYPE = {
  document: 'main_frame',
  subdocument: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  ping: 'ping',
  media: 'media',
  websocket: 'websocket',
  font: 'font',
  other: 'other',
};

// Best-effort human-readable label for a matched NetworkFilter, used only
// for the Diagnostics panel (Part 2 §2) and stats — never for matching
// logic itself. The library's own `.toString()`/raw-text retention on a
// parsed filter is an internal detail that can vary by version/parse
// options, so this tries a few plausible accessors and falls back to a
// generic label rather than let diagnostics crash or show "[object
// Object]".
function describeFilter(filter) {
  if (!filter) return null;
  try {
    if (typeof filter.toString === 'function') {
      const s = filter.toString();
      if (s && s !== '[object Object]') return s;
    }
  } catch { /* fall through */ }
  try {
    if (typeof filter.getId === 'function') return `filter#${filter.getId()}`;
  } catch { /* fall through */ }
  return 'matched (id unavailable)';
}

class FilterEngine {
  constructor() {
    this._engine = null; // the real ElectronBlocker instance, once loaded
    this._lastStats = null;
    // Same bounded LRU-ish cache the old engine used for
    // cosmeticCssFor — the real engine's getCosmeticsFilters() is not
    // free (it re-walks its cosmetic index per call), and did-finish-load
    // fires on every navigation, so repeat visits to the same host within
    // one compiled-rule lifetime should not re-pay that cost.
    this._cosmeticCssCache = new Map();
    this._cosmeticCssCacheMax = 1000;
    loadLibrary();
    this._initError = _loadError ? _loadError.message : null;
  }

  // `compiledLists` is an array of { listId, text } — RAW, unparsed
  // filter-list text for every enabled list. Nothing in this file (or
  // anywhere else in src/adblock/ anymore) parses EasyList/ABP syntax
  // itself — ElectronBlocker.parse() does that, using the real engine's
  // own compiler, not a second homegrown one living alongside it.
  load(compiledLists) {
    this._cosmeticCssCache.clear();

    const combinedStats = {
      engine: '@ghostery/adblocker-electron',
      lists: compiledLists.map((e) => ({ listId: e.listId, bytes: (e.text || '').length })),
      totalNetworkRules: null,
      totalCosmeticRules: null,
      error: null,
    };

    if (this._initError) {
      // Dependency genuinely unavailable (e.g. `npm install` not run in
      // this environment). Recorded so getStats()/Settings can show a real
      // "ad blocker engine failed to load: <reason>" status instead of a
      // silent no-op — see the final report for exactly when this applies.
      combinedStats.error = `engine unavailable: ${this._initError}`;
      this._engine = null;
      this._lastStats = combinedStats;
      return combinedStats;
    }

    const combinedText = compiledLists.map((entry) => entry.text || '').join('\n');
    try {
      this._engine = ElectronBlockerClass.parse(combinedText);
    } catch (err) {
      combinedStats.error = `engine failed to parse filter lists: ${err.message}`;
      this._engine = null;
      this._lastStats = combinedStats;
      return combinedStats;
    }

    // ROOT CAUSE of "filter lists say updated just now, 0 rules" (found
    // this round): `this._engine.networkFilters?.size` /
    // `.cosmeticFilters?.size` were a GUESS at an undocumented internal
    // field name, not the library's actual public API — confirmed against
    // the real @ghostery/adblocker README and its own published usage
    // examples (the preprocessor script in the project's own repo reads
    // counts via `engine.getFilters()`, not `.networkFilters.size`):
    // https://github.com/ghostery/adblocker — `FiltersEngine.getFilters()`
    // returns `{ networkFilters, cosmeticFilters }` as real arrays. On the
    // installed engine version those internal fields are apparently absent
    // (or shaped differently), so the old code always fell through to the
    // `?? null`/`?? 0` fallback — the engine was compiling and genuinely
    // usable (this is exactly why the functional canary checks in
    // filterlist-manager.js already found real matches), but every count
    // shown to the user read zero regardless. Fixed to use the real,
    // documented API.
    try {
      const { networkFilters, cosmeticFilters } = this._engine.getFilters();
      combinedStats.totalNetworkRules = Array.isArray(networkFilters) ? networkFilters.length : null;
      combinedStats.totalCosmeticRules = Array.isArray(cosmeticFilters) ? cosmeticFilters.length : null;
    } catch (err) {
      // getFilters() itself is documented/public, but stay defensive —
      // "rule counts unknown" must never crash compilation.
      combinedStats.totalNetworkRules = null;
      combinedStats.totalCosmeticRules = null;
    }
    this._lastStats = combinedStats;
    return combinedStats;
  }

  getStats() {
    return this._lastStats;
  }

  isEmpty() {
    return !this._engine;
  }

  // request = { url, requestHost, pageHost, resourceType } — SAME shape
  // adblock/index.js's _decide() already built for the old engine (it
  // still does the resourceType mapping, settings-tab skip, site-exception
  // short-circuit, and tab-host tracking itself; only the final
  // "does this match a rule" question is delegated here now).
  //
  // Returns { blocked, matchedRule, reason } — SAME shape as before, so
  // index.js's stats/diagnostics code (which reads decision.blocked,
  // decision.reason, decision.matchedRule) needed no changes.
  evaluate({ url, requestHost, pageHost, resourceType }) {
    if (!this._engine) {
      return { blocked: false, matchedRule: null, reason: this._initError ? 'engine-unavailable' : 'no-match' };
    }

    let request;
    try {
      // Request.fromRawDetails is @ghostery/adblocker's own factory for
      // building a matchable Request from raw fields — it derives
      // hostname/domain from the URL itself (via the tldts-based public
      // suffix handling the real engine ships, replacing the old
      // hand-maintained TWO_LABEL_SUFFIXES table in domain-utils.js) and
      // determines first/third-party status from `sourceUrl` vs `url`
      // internally, replacing the old engine's own isThirdParty() /
      // registrableDomain() logic entirely. `type` uses the same ABP-style
      // type vocabulary ('document'/'subdocument'/'script'/'image'/'ping'/
      // ...) index.js's RESOURCE_TYPE_MAP already produces, so no mapping
      // layer was needed here.
      //
      // BUG (found in this audit): this used to also pass
      // `hostname: requestHost || undefined` — `requestHost` is
      // `domain-utils.js`'s `normalizeHostname(details.url)`, which
      // deliberately strips a leading "www." (correct and desired for the
      // site-exceptions UI and tab-host tracking, where "www.example.com"
      // and "example.com" should be treated as the same site by a human
      // typing/reading a hostname). Feeding that SAME stripped value to
      // the real engine as an explicit hostname override creates a
      // mismatch between it and the request's own, unmodified `url`
      // (e.g. url = "https://www.google-analytics.com/analytics.js" but
      // hostname override = "google-analytics.com") for every request
      // whose real host starts with "www." — which is extremely common,
      // and includes real EasyPrivacy rules written specifically against
      // the "www." form (`||www.google-analytics.com^` is a standard,
      // long-standing EasyPrivacy rule). Depending on which of the two
      // conflicting values the engine's own matching trusted, this risked
      // either false negatives (a www.-scoped rule never matching because
      // the override silently removed the "www.") or false positives (a
      // rule scoped to NOT match www. subdomains still firing because the
      // override made them indistinguishable from the bare domain) â€” on
      // an unknown but potentially large share of all web traffic, since
      // "www." is one of the most common subdomain prefixes in existence.
      // Fix: don't override hostname at all. The real engine's own
      // tldts-based parsing of the exact, unmodified `url` is strictly
      // more correct than re-deriving (and inadvertently mutating) it via
      // a helper written for a different, UI-facing purpose. `requestHost`
      // itself is left as a parameter here (still used by callers for
      // diagnostics) but is no longer fed into request matching.
      request = RequestClass.fromRawDetails({
        url,
        sourceUrl: pageHost ? `https://${pageHost}/` : url,
        type: ABP_TYPE_TO_WEBREQUEST_TYPE[resourceType] || 'other',
      });
    } catch {
      // A malformed URL should never be able to crash the webRequest
      // path — fail open, same as index.js's own top-level try/catch.
      return { blocked: false, matchedRule: null, reason: 'no-match' };
    }

    let result;
    try {
      result = this._engine.match(request);
    } catch {
      return { blocked: false, matchedRule: null, reason: 'no-match' };
    }

    if (result && result.exception) {
      return { blocked: false, matchedRule: describeFilter(result.exception), reason: 'exception' };
    }
    // GAP found in this audit: the real engine's match() can return a
    // `redirect` field — a ready-to-use data: URL "neutering" stub — for
    // filters that use the `$redirect=` option (standard ABP/uBO syntax;
    // present in real-world lists, including the "uBlock filters"
    // supplementary list added for the YouTube ad-blocking fix). This is
    // deliberately NOT the same thing as an outright block: a `$redirect`
    // rule exists specifically for cases where cancelling the request
    // outright would surface as a hard network failure the PAGE'S OWN
    // JavaScript might not handle gracefully (e.g. an ad SDK script that
    // assumes it always gets *some* response and throws/retries/breaks
    // playback if the request is simply cancelled) — redirecting to an
    // inert stub (an empty script, a 1x1 transparent image, ...) lets the
    // page's own code believe the resource loaded normally while doing
    // nothing. Until this fix, `result.redirect` was read from nowhere —
    // any `$redirect=`-scoped rule in an active list compiled correctly
    // but had NO EFFECT AT ALL at request time (neither blocked nor
    // redirected, the real resource just loaded through unmodified).
    if (result && result.redirect) {
      return {
        blocked: true, // counted/reported as blocked — the real resource never loads, same as uBlock Origin's own convention for redirected requests
        matchedRule: describeFilter(result.filter),
        reason: 'redirect',
        redirectUrl: result.redirect,
      };
    }
    if (result && result.match) {
      return { blocked: true, matchedRule: describeFilter(result.filter), reason: 'rule' };
    }
    return { blocked: false, matchedRule: null, reason: 'no-match' };
  }

  // Builds (and caches) the element-hiding <style> contents for a hostname,
  // via the real engine's own cosmetic-filter index (getCosmeticsFilters) —
  // replacing the old engine's hand-rolled per-domain selector scoping,
  // exception handling, and generic-vs-domain-scoped logic. The real
  // engine already returns ready-to-inject CSS text in `.styles`, so this
  // wrapper no longer has to assemble a `selector,selector { display:
  // none !important }` block by hand.
  cosmeticCssFor(hostname) {
    const result = this._cosmeticsFor(hostname);
    return result.css;
  }

  // GAP found in this audit: cosmeticCssFor has always called
  // getCosmeticsFilters() and read ONLY its `.styles` field. The same
  // result also carries `.scripts` — ready-to-run JS strings for any
  // matched filter written with uBO/AdGuard's `##+js(...)` scriptlet
  // syntax, with the scriptlet's resource body already substituted in by
  // the engine itself (same resource-substitution mechanism already
  // relied on for `$redirect=`, which engine.evaluate() above already
  // reads from `result.redirect` without any extra resource-loading step
  // — scriptlets use the same bundled resource set). `.scripts` has never
  // been read anywhere in this file, so any fetched filter-list rule using
  // this syntax parses successfully and compiles into the engine, but has
  // ZERO effect at runtime — nothing ever executes it. This matters
  // specifically for YouTube: the DOM-level skip/hide layer in
  // adblock/index.js already documents that server-side-stitched ad
  // segments can't be told apart from content by URL alone, and
  // scriptlets (patching the page's OWN JS — e.g. stripping ad markers out
  // of a player-response object before the page's own code reads it) are
  // the standard technique maintained filter lists use for exactly that
  // class of problem, which pure network blocking and CSS hiding cannot
  // reach. `cosmeticsFor` is the new shared helper; `cosmeticCssFor` above
  // is kept as a thin wrapper so every existing caller/test of it is
  // unaffected, and index.js separately calls this new method to also get
  // `.scripts` for execution (see its own comment for why that has to be
  // a real page-context execution, not something engine.js can do itself
  // — this file has no Electron/webContents access on purpose).
  cosmeticsFor(hostname) {
    return this._cosmeticsFor(hostname);
  }

  _cosmeticsFor(hostname) {
    if (!hostname || !this._engine) return { css: '', scripts: [] };
    if (this._cosmeticCssCache.has(hostname)) {
      const cached = this._cosmeticCssCache.get(hostname);
      this._cosmeticCssCache.delete(hostname);
      this._cosmeticCssCache.set(hostname, cached);
      return cached;
    }

    let entry = { css: '', scripts: [] };
    try {
      const url = `https://${hostname}/`;
      const result = this._engine.getCosmeticsFilters({ url, hostname, domain: hostname });
      entry = {
        css: (result && typeof result.styles === 'string') ? result.styles : '',
        // Defensive: `.scripts` is only present on engine versions/builds
        // that actually compiled scriptlet resources. Treated as "none"
        // rather than thrown on if absent/wrong-shaped, same philosophy
        // as every other internal-ish field access in this file (see the
        // `networkFilters?.size ?? null` pattern above).
        scripts: (result && Array.isArray(result.scripts))
          ? result.scripts.filter((s) => typeof s === 'string' && s.length > 0)
          : [],
      };
    } catch {
      entry = { css: '', scripts: [] };
    }

    if (this._cosmeticCssCache.size >= this._cosmeticCssCacheMax) {
      const oldestKey = this._cosmeticCssCache.keys().next().value;
      this._cosmeticCssCache.delete(oldestKey);
    }
    this._cosmeticCssCache.set(hostname, entry);
    return entry;
  }
}

module.exports = { FilterEngine };
