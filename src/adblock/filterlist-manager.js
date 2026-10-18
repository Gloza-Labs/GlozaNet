// ============================================================================
// adblock/filterlist-manager.js — fetching, validating, storing, and
// scheduling updates for filter lists. This is the only file that talks to
// the network; everything it hands back to the rest of the ad-blocker is
// plain parsed-rule data (see filter-parser.js) or plain status objects.
//
// Design constraints from the Part 1B brief, and how each is met:
//  - "Load a maintained initial filter list"        -> bundled seed files
//    (filters/*.txt) are used the very first time a list has no local copy.
//  - "Retrieve updates from legitimate configured
//     sources"                                      -> LIST_DEFINITIONS
//    below points at the real, canonical EasyList/EasyPrivacy URLs.
//  - "Validate downloaded data before activating it" -> validateListText().
//  - "Retain last known working rules if update
//     fails"                                        -> store.js rotates a
//    .bak copy on every successful write, and a failed fetch never touches
//    the live file at all.
//  - "Avoid downloading lists repeatedly during
//     navigation"                                   -> updates only ever
//    happen on a timer or on an explicit manual-update call, never from the
//    webRequest path.
//  - "Avoid blocking browser startup indefinitely"   -> init() always
//    returns using whatever is already on disk/bundled; any network fetch
//    is scheduled afterwards, fire-and-forget, with its own timeout.
//  - "Handle offline operation"                      -> a failed fetch
//    (including "no network at all") just leaves the previously-active
//    list in place and records the error for status reporting.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
// Required lazily (inside fetchUrl) rather than at module scope: this keeps
// every other function in this file — ensureInitialized, getActiveText,
// validateListText, updateList's validation path — runnable in a plain
// Node test environment with no Electron binary installed, which is how
// this module's own test suite (test/adblock-engine-test.js) exercises it
// in this sandbox (see HANDOFF-part-1a.md: Electron isn't installed here).
const store = require('./store');

// REPLACED (full-engine-backend-replacement task): validateListText() used
// to run a downloaded list through the old homegrown filter-parser.js and
// require a minimum number of successfully-parsed rules. That parser is
// retired along with the rest of the old engine, so validation is now done
// with the SAME real engine that will actually compile and run the list
// (@ghostery/adblocker-electron, loaded lazily — see engine.js's
// loadLibrary() for why this is lazy and fails soft rather than throwing
// at require-time), not a second, separate homegrown check. A list that
// the real engine itself can't parse into a non-trivial rule set is
// rejected the same way a too-short or HTML-error-page response already
// was — "retain the last known working rules" if this fails.
let ElectronBlockerClass = null;
let RequestClass = null;
let _engineLoadError = null;
function loadEngineForValidation() {
  if (ElectronBlockerClass || _engineLoadError) return;
  try {
    // eslint-disable-next-line global-require
    ({ ElectronBlocker: ElectronBlockerClass } = require('@ghostery/adblocker-electron'));
    // eslint-disable-next-line global-require
    ({ Request: RequestClass } = require('@ghostery/adblocker'));
    if (!ElectronBlockerClass || !RequestClass) {
      throw new Error('unexpected export shape from @ghostery/adblocker-electron / @ghostery/adblocker');
    }
  } catch (err) {
    _engineLoadError = err;
  }
}

// ROOT CAUSE of "only 0 usable rule(s) parsed by the engine" (see
// HANDOFF-youtube-adblock-fix.md §1-§3 for the full investigation): this
// validator used to gate acceptance SOLELY on
// `engine.networkFilters.size + engine.cosmeticFilters.size`. Those two
// properties are an undocumented INTERNAL storage detail of the installed
// @ghostery/adblocker engine, not a stable public API — the same `parse()`
// call that index.js's live blocking engine (engine.js) has been using
// successfully the whole time (Stahuj.cz and other sites already worked)
// can return a fully-populated, fully-functional engine whose compiled
// rules simply are NOT exposed under those exact field names in the
// installed engine version, which made validateListText reject every
// single real-world download — including perfectly good copies of
// EasyList/EasyPrivacy and the new uBlock-filters YouTube supplement — as
// "0 usable rules", even though the SAME parsed engine would have blocked
// requests correctly if it had ever been allowed to activate. This is why
// the symptom was "still doesn't work on YouTube": the YouTube-specific
// supplement list could never pass validation in the first place, so the
// browser was permanently stuck on the tiny bundled seed-file excerpts.
//
// Fix: validate FUNCTIONALLY, through the exact same `engine.match()` call
// production blocking already depends on (engine.js), using a small set of
// canary requests that any non-trivial real-world copy of EasyList/
// EasyPrivacy/uBlock-filters blocks. This is independent of whichever
// internal field name a given engine version happens to use for its rule
// containers. The old `.size`-based count is kept, but only as a
// diagnostic/fallback, never as the sole gate.
const CANARY_REQUESTS = [
  // In EasyList itself, under virtually every release.
  { url: 'https://pagead2.googlesyndication.com/pagead/show_ads.js', sourceUrl: 'https://example.com/', type: 'script' },
  { url: 'https://securepubads.g.doubleclick.net/gampad/ads', sourceUrl: 'https://example.com/', type: 'xmlhttprequest' },
  // In EasyPrivacy.
  { url: 'https://www.google-analytics.com/analytics.js', sourceUrl: 'https://example.com/', type: 'script' },
  // In uBlockOrigin/uAssets filters.txt (the YouTube-ad-blocking-fix
  // supplement list) — YouTube's own ad-serving path.
  { url: 'https://www.youtube.com/pagead/viewthroughconversion', sourceUrl: 'https://www.youtube.com/', type: 'ping' },
];

function countFunctionalMatches(engine) {
  let matched = 0;
  for (const canary of CANARY_REQUESTS) {
    try {
      const request = RequestClass.fromRawDetails(canary);
      const result = engine.match(request);
      if (result && (result.match || result.redirect || result.exception)) matched += 1;
    } catch {
      // A single bad/incompatible canary must never abort validation of an
      // otherwise-good list.
    }
  }
  return matched;
}

// ROOT CAUSE of "Settings → Ad Blocker shows 0 rules for almost every list
// except one, despite ~149,000 total rules being active" (this round's
// investigation): `entry.ruleCounts` (what settings.js actually renders —
// `list.ruleCounts.network`) is written in EXACTLY ONE place: the success
// path of `updateList()`, below. It is NOT recomputed on every app start,
// and `updateAllEnabled()` deliberately SKIPS re-fetching any list whose
// `lastSuccessfulUpdate` is still within `updateIntervalMs` (24h by
// default) — that "don't redownload a list that's already fresh" behavior
// is correct and required (see this file's own header: "avoid downloading
// lists repeatedly during navigation"). The bug is that ruleCounts was
// entangled with that freshness check: a list whose `adblock.json` entry
// was written by an OLDER build of this code (back when the count was
// computed from the undocumented `.networkFilters?.size` field — see the
// long comment on `validateListText` below for that whole history) keeps
// showing that OLD, wrong value — typically 0 — for up to 24h after the
// getFilters()-based fix shipped, because its `lastSuccessfulUpdate` is
// recent enough that updateAllEnabled() has no reason to touch it again.
// A list that happened to update (e.g. a newly-added list with no prior
// `lastSuccessfulUpdate` at all) gets the correct value immediately, which
// is exactly the "every list shows 0 except the one that's different"
// pattern reported: whichever list's entry predates the fix is stuck,
// whichever one doesn't is fine — not something inherent to any specific
// list, just whichever one(s) happen to have stale persisted state.
//
// Fix: decouple "how many rules does this list's ACTIVE text contain" from
// "did a network fetch happen recently." `RULE_COUNTS_SCHEMA_VERSION`
// tags every ruleCounts object this code produces; `recomputeRuleCounts`
// (on FilterListManager, below) recomputes — from whatever text is
// ALREADY on disk, no network involved — any list whose stored ruleCounts
// is missing or was computed by a different/older schema, so a stale
// value self-heals on the very next app start rather than waiting for the
// next scheduled/manual update. This never re-downloads, re-validates
// against the canary set, deletes, or disables anything — it only
// recomputes a DISPLAY number from text that is already active and
// already blocking.
const RULE_COUNTS_SCHEMA_VERSION = 2;

// Takes an ALREADY-PARSED engine instance (validateListText already has one
// in scope for the functional-canary check, so it reuses this directly —
// no reason to parse the same text twice) and reads its real, documented
// getFilters() API. Returns { network, cosmetic }, both defaulting to 0 —
// never null/undefined — so every caller can safely render/sum them.
function countsFromEngine(engine) {
  try {
    const { networkFilters, cosmeticFilters } = engine.getFilters();
    return {
      network: Array.isArray(networkFilters) ? networkFilters.length : 0,
      cosmetic: Array.isArray(cosmeticFilters) ? cosmeticFilters.length : 0,
    };
  } catch {
    // getFilters() is documented/public, but stay defensive — an
    // unexpected shape here must fall back to 0, never throw.
    return { network: 0, cosmetic: 0 };
  }
}

// Used by `recomputeRuleCounts` for text that's already active and has no
// reason to be re-validated (no canary matching — this is a display-number
// recompute, not a gate on whether to activate anything). Returns { network,
// cosmetic } or null if the engine is unavailable or can't parse this text
// at all — "unknown," which callers must not silently turn into "zero."
function countRuleSetForText(text) {
  loadEngineForValidation();
  if (_engineLoadError) return null;
  let engine;
  try {
    engine = ElectronBlockerClass.parse(text);
  } catch {
    return null;
  }
  return countsFromEngine(engine);
}

const SEED_DIR = path.join(__dirname, 'filters');

const LIST_DEFINITIONS = {
  easylist: {
    label: 'EasyList',
    description: 'General advertising filter list (easylist.to).',
    category: 'ads',
    url: 'https://easylist.to/easylist/easylist.txt',
    seedFile: path.join(SEED_DIR, 'easylist-seed.txt'),
  },
  easyprivacy: {
    label: 'EasyPrivacy',
    description: 'Tracking/analytics filter list (easylist.to), supplements EasyList.',
    category: 'tracking',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    seedFile: path.join(SEED_DIR, 'easyprivacy-seed.txt'),
  },
  // Added for the YouTube ad-blocking fix (see HANDOFF-youtube-adblock-fix.md
  // for the investigation that led here). EasyList + EasyPrivacy alone are
  // a well-documented gap for high-traffic sites' own first-party ad
  // delivery — YouTube's own ad-serving/tracking paths (masthead/promoted
  // placements, ad-progress UI, in-player ad pings) are largely NOT in
  // bare EasyList, by EasyList's own policy; the uBlock Origin project
  // maintains exactly this supplement ("to be used along EasyList") and
  // explicitly commits to fixing "Video Ads" issues on high-traffic sites
  // here even when the issue needs no extended syntax. This is the
  // standard, maintained fix for this class of problem — not a homegrown
  // list and not YouTube-only (it also covers ad issues on other
  // high-traffic sites EasyList hasn't caught up with yet).
  ublockfilters: {
    label: 'uBlock filters',
    description: 'Supplementary ad rules for high-traffic sites not yet covered by EasyList (uBlockOrigin/uAssets), including YouTube.',
    category: 'ads',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    seedFile: path.join(SEED_DIR, 'ublock-filters-seed.txt'),
  },
  // Added in this round, on top of the three lists above. EasyList,
  // EasyPrivacy, and the uBlock-filters high-traffic-site supplement are
  // all GENERAL-PURPOSE lists that only touch YouTube incidentally.
  // YousList is maintained SOLELY to remove ads on YouTube, updates
  // independently and typically faster when YouTube changes its ad
  // delivery, and is a standard, well-known community source for exactly
  // this problem (not a homegrown/guessed list). It plugs in through the
  // exact same generic path every other list already uses — fetch,
  // validate functionally via the real engine, activate only if it
  // passes, keep last-known-good on failure, surface its status in
  // Settings — so no other code needed to change for it to take effect.
  youlist: {
    label: 'YousList',
    description: 'Filter list maintained specifically to remove ads on YouTube (yous/YousList).',
    category: 'ads',
    // BUG FOUND IN THIS ROUND (the reported "YousList: update failed: fetch
    // failed: HTTP 404"): this URL pointed at "youtube.txt". The upstream
    // yous/YousList repository has never had a file by that name — its
    // one and only published filter file, documented in the repo's own
    // README/Usage section and confirmed live at the URL below (HTTP 200,
    // "! Title: YousList" header, real filter rules), is "youslist.txt".
    // "youtube.txt" 404s unconditionally, for every fetch, regardless of
    // network/offline state or validation logic downstream — nothing past
    // fetchUrl() could ever have fixed this; the configured URL itself
    // was wrong. Verified against the live upstream file at the time of
    // this fix (raw.githubusercontent.com/yous/YousList/master/youslist.txt
    // returned real YousList content, "! Version: 20260922").
    url: 'https://raw.githubusercontent.com/yous/YousList/master/youslist.txt',
    seedFile: path.join(SEED_DIR, 'youlist-seed.txt'),
  },
};

// Was 15000. The YouTube ad-blocking fix added a third list
// (`ublockfilters`, ~1 MB and growing over time) fetched with this exact
// same shared timeout — 15s is comfortably enough for EasyList/EasyPrivacy
// on an ordinary connection but is tight for an extra ~1 MB download on a
// slow/metered one, where a perfectly fine fetch could get needlessly
// aborted and treated as "offline" for that list. Bumped modestly; still a
// firm bound (never indefinite), per "avoid blocking browser startup
// indefinitely" / "handle offline operation" — a slow-but-working fetch
// now has realistic headroom, a genuinely dead connection still times out
// in well under a minute.
const FETCH_TIMEOUT_MS = 45000;
// Defense-in-depth cap on a single list's response body (found while
// reviewing fetchUrl for this audit: it had no upper bound at all —
// `response.on('data', ...)` just kept accumulating chunks forever). A
// compromised/misbehaving server or a redirect to the wrong kind of
// resource could otherwise have this buffer an unbounded amount of data
// into memory before validateListText() ever got a chance to reject it.
// Real filter lists here top out in the low single-digit megabytes; 25 MB
// leaves generous headroom while still being a real bound.
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MIN_VALID_LIST_BYTES = 200; // a real list is many KB; this just rejects empty/truncated bodies
const MIN_VALID_RULE_COUNT = 5; // sanity floor so a non-filter-list response can't "validate"

function readSeed(listId) {
  const def = LIST_DEFINITIONS[listId];
  try {
    return fs.readFileSync(def.seedFile, 'utf-8');
  } catch {
    return '! (seed file missing)\n';
  }
}

// Returns { ok: true } or { ok: false, reason: string }. Deliberately
// simple and conservative: better to reject a borderline response and keep
// last-known-good than to activate something malformed.
function validateListText(text) {
  if (typeof text !== 'string' || text.length < MIN_VALID_LIST_BYTES) {
    return { ok: false, reason: 'response too short to be a real filter list' };
  }
  const head = text.slice(0, 200).toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype')) {
    return { ok: false, reason: 'response looks like an HTML page, not a filter list (likely an error/redirect page)' };
  }

  loadEngineForValidation();
  if (_engineLoadError) {
    // The real engine isn't installed/loadable in this environment (see
    // the note above). Fail the validation honestly rather than silently
    // "passing" a list that nothing can actually compile — the caller
    // (updateList) already treats a failed validation as "keep the
    // previous good copy," which is the correct behavior here too.
    return { ok: false, reason: `ad-blocking engine unavailable: ${_engineLoadError.message}` };
  }

  let engine;
  try {
    engine = ElectronBlockerClass.parse(text);
  } catch (err) {
    return { ok: false, reason: `engine could not parse this list: ${err.message}` };
  }

  // Diagnostic-only from here on — see the long comment above
  // CANARY_REQUESTS for why this is no longer the pass/fail gate by
  // itself.
  // Kept as 0 (not null) on purpose: this flows straight into
  // `entry.ruleCounts`, which `settings.js` reads directly
  // (`list.ruleCounts.network.toLocaleString()`) to render the Settings →
  // Ad Blocker list rows. A `null` here — exactly the case this whole fix
  // is designed to tolerate (the internal `.size` field missing/renamed on
  // some engine version) — would otherwise crash that render entirely.
  // `settings.js` is also hardened separately as belt-and-suspenders (see
  // its own comment), but this is the one place that actually produces
  // the value, so it should never hand out something its only real
  // consumer can't safely display.
  // FIXED this round: `.networkFilters?.size` / `.cosmeticFilters?.size`
  // was a guess at an undocumented internal field, confirmed against the
  // real published API to be wrong for the installed engine version (see
  // the matching fix + citation in engine.js's _recompile/compile stats).
  // `getFilters()` is the library's actual, documented way to retrieve the
  // compiled rule arrays — this is what made every single list "validate"
  // (functional canaries did find real matches) while still displaying
  // "0 rules" to the user, which looked like total failure even when the
  // list was genuinely compiled and working.
  // Reuses the exact same counting helper `recomputeRuleCounts` uses for
  // already-active text (see RULE_COUNTS_SCHEMA_VERSION's comment above) —
  // one counting implementation, not two that could drift apart again —
  // against the `engine` already parsed just above, so this text is never
  // parsed twice.
  const counts = countsFromEngine(engine);
  const networkCount = counts.network;
  const cosmeticCount = counts.cosmetic;
  const sizeBasedUsable = networkCount + cosmeticCount;

  // The real gate: does this compiled engine actually block known
  // real-world ad/tracker requests, through engine.match() — the exact
  // call production blocking uses?
  const functionalMatches = countFunctionalMatches(engine);

  if (functionalMatches === 0 && sizeBasedUsable < MIN_VALID_RULE_COUNT) {
    return {
      ok: false,
      reason: `only ${sizeBasedUsable} usable rule(s) parsed by the engine (0/${CANARY_REQUESTS.length} functional canary checks matched)`,
    };
  }
  return {
    ok: true,
    ruleCounts: {
      network: networkCount,
      cosmetic: cosmeticCount,
      functionalCanaryMatches: functionalMatches,
      schema: RULE_COUNTS_SCHEMA_VERSION,
    },
  };
}

function fetchUrl(url, timeoutMs) {
  const { net } = require('electron');
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url, redirect: 'follow' });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { request.abort(); } catch { /* already gone */ }
      reject(new Error('timed out'));
    }, timeoutMs);

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { request.abort(); } catch { /* ignore */ }
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          settled = true;
          clearTimeout(timer);
          try { request.abort(); } catch { /* already gone */ }
          reject(new Error(`response exceeded ${MAX_RESPONSE_BYTES} byte cap`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      response.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
    request.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

class FilterListManager {
  // opts.fetchUrl: injectable (url, timeoutMs) => Promise<string> transport,
  // defaulting to the real Electron `net`-based implementation below. Tests
  // (see test/adblock-engine-test.js) supply a fake here specifically so
  // they never need `require('electron')`, which isn't installed in this
  // sandbox — see the note above fetchUrl's real definition.
  constructor(app, opts = {}) {
    this.app = app;
    this._timers = new Map();
    this._fetchUrl = opts.fetchUrl || fetchUrl;
  }

  // Ensures adblock.json has an entry for every known list and that every
  // list has SOME text on disk (seed, if nothing else). Synchronous and
  // network-free — safe to call during startup. Returns the updated state.
  ensureInitialized(state) {
    let changed = false;
    for (const [listId, def] of Object.entries(LIST_DEFINITIONS)) {
      if (!state.lists[listId]) {
        state.lists[listId] = {
          enabled: true,
          url: def.url,
          lastSuccessfulUpdate: null,
          lastAttempt: null,
          lastError: null,
          source: null, // 'seed' | 'network'
          ruleCounts: null,
        };
        changed = true;
      } else if (state.lists[listId].url !== def.url) {
        state.lists[listId].url = def.url; // keep in sync if the canonical URL ever changes in code
        changed = true;
      }
      const existing = store.readListFile(this.app, listId);
      if (existing === null) {
        store.writeListFile(this.app, listId, readSeed(listId));
        state.lists[listId].source = 'seed';
        changed = true;
      }
    }
    if (changed) store.save(this.app, state);
    return state;
  }

  // Reads whatever is currently the "active" text for a list (does not
  // touch the network). Always returns a string (falls back to the bundled
  // seed if, somehow, nothing is on disk at all).
  getActiveText(listId) {
    return store.readListFile(this.app, listId) ?? readSeed(listId);
  }

  // Self-heals the Settings → Ad Blocker "0 rules" display bug (see the
  // long comment above RULE_COUNTS_SCHEMA_VERSION) WITHOUT any network
  // access: for every list whose persisted `ruleCounts` is missing or was
  // computed by an older/different schema, recompute it from whatever
  // text is ALREADY ACTIVE for that list (seed or previously-downloaded —
  // `getActiveText`, same text the compiled engine is already using to
  // block requests). Never touches the network, never re-validates,
  // never deletes/disables a list, and never overwrites a GOOD existing
  // count with a failure — if the recompute itself fails (engine
  // unavailable, text unparseable), the entry is left exactly as it was
  // so a working count is never clobbered by an "unknown."
  //
  // Synchronous and cheap enough to run on every app start: this parses
  // each list's own (already on-disk) text once, not the combined
  // multi-megabyte corpus _recompileEngine() builds — the per-list counts
  // settings.js renders were always meant to be per-list in the first
  // place.
  //
  // Returns true if any list's stored ruleCounts actually changed (so the
  // caller knows whether a `store.save()` is worth doing).
  recomputeRuleCounts(state) {
    let changed = false;
    for (const listId of Object.keys(state.lists)) {
      const entry = state.lists[listId];
      if (!entry) continue;
      if (entry.ruleCounts && entry.ruleCounts.schema === RULE_COUNTS_SCHEMA_VERSION) continue; // already current
      let text;
      try {
        text = this.getActiveText(listId);
      } catch {
        continue; // nothing to recompute from; leave the stored value untouched
      }
      const counts = countRuleSetForText(text);
      if (!counts) continue; // "unknown" — never overwrite a real value with a guess, and never invent a fresh 0
      entry.ruleCounts = {
        network: counts.network,
        cosmetic: counts.cosmetic,
        // No functional-canary data here — this is a display recompute of
        // text that's already active, not a fresh validation pass — but
        // keep the field present (undefined is fine) so settings.js's
        // existing `list.ruleCounts.network` read path needs no changes.
        functionalCanaryMatches: entry.ruleCounts ? entry.ruleCounts.functionalCanaryMatches : undefined,
        schema: RULE_COUNTS_SCHEMA_VERSION,
      };
      changed = true;
    }
    return changed;
  }

  listDefinitions() {
    return LIST_DEFINITIONS;
  }

  // "Restore default configuration" (Settings → Ad Blocker): re-enables
  // every known list (the shipped default) and resets the update interval,
  // without touching anything already downloaded — a user who disabled a
  // list, or narrowed the update interval, gets back to the out-of-the-box
  // setup without losing already-fetched filter-list text or their site
  // exceptions (those are a separate, deliberate choice this action
  // shouldn't silently wipe).
  resetToDefaults(state) {
    for (const [listId, def] of Object.entries(LIST_DEFINITIONS)) {
      if (!state.lists[listId]) {
        state.lists[listId] = {
          enabled: true, url: def.url, lastSuccessfulUpdate: null,
          lastAttempt: null, lastError: null, source: null, ruleCounts: null,
        };
      } else {
        state.lists[listId].enabled = true;
        state.lists[listId].url = def.url;
      }
    }
    state.updateIntervalMs = 24 * 60 * 60 * 1000;
    store.save(this.app, state);
    return state;
  }

  // Fetches + validates + (if valid) activates a fresh copy of one list.
  // Never throws — always resolves to a status object, since callers (the
  // scheduler, the manual-update IPC handler) need a result either way.
  async updateList(state, listId) {
    const def = LIST_DEFINITIONS[listId];
    if (!def) return { ok: false, reason: `unknown list "${listId}"` };
    const entry = state.lists[listId] || (state.lists[listId] = { enabled: true, url: def.url, lastSuccessfulUpdate: null, lastAttempt: null, lastError: null, source: null, ruleCounts: null });

    entry.lastAttempt = Date.now();
    let text;
    try {
      text = await this._fetchUrl(def.url, FETCH_TIMEOUT_MS);
    } catch (err) {
      entry.lastError = `fetch failed: ${err.message}`;
      store.save(this.app, state);
      return { ok: false, reason: entry.lastError, offline: true };
    }

    const validation = validateListText(text);
    if (!validation.ok) {
      entry.lastError = `validation failed: ${validation.reason}`;
      store.save(this.app, state);
      return { ok: false, reason: entry.lastError };
    }

    store.writeListFile(this.app, listId, text);
    entry.lastSuccessfulUpdate = Date.now();
    entry.lastError = null;
    entry.source = 'network';
    // Counts now come straight from the real engine's own compiled filter
    // containers (see validateListText above) rather than a second
    // homegrown parse pass — there's no separate "unsupported" bucket to
    // report anymore, because there's no second, less-capable parser that
    // could fail to support something the real engine handles.
    entry.ruleCounts = validation.ruleCounts;
    store.save(this.app, state);
    return { ok: true, ruleCounts: entry.ruleCounts };
  }

  async updateAllEnabled(state, { force = false } = {}) {
    const results = {};
    for (const [listId, entry] of Object.entries(state.lists)) {
      if (!entry.enabled) continue;
      if (!force && entry.lastSuccessfulUpdate && Date.now() - entry.lastSuccessfulUpdate < state.updateIntervalMs) {
        results[listId] = { ok: true, skipped: true, reason: 'up to date' };
        continue;
      }
      results[listId] = await this.updateList(state, listId);
    }
    return results;
  }

  // Schedules recurring background updates without ever blocking startup:
  // the first check is deliberately delayed, and every check after that is
  // re-scheduled relative to the CONFIGURED interval, not a tight loop.
  scheduleAutomaticUpdates(getState, saveState, onUpdated) {
    this.stopAutomaticUpdates();
    const STARTUP_DELAY_MS = 10000;
    const tick = async () => {
      // BUG (found in this audit): the next tick was only ever scheduled
      // as the LAST line of this function. updateAllEnabled() itself
      // can't throw (every per-list failure is caught and turned into a
      // result object — see updateList above), but saveState()/onUpdated()
      // are caller-supplied (in practice: store.save() — a real fs write —
      // and a callback that recompiles the engine and broadcasts to every
      // window). If either of those threw on a given tick — a transient
      // disk error, a full disk, anything — this function would throw,
      // the `setTimeout(tick, next)` call below it would never run, and
      // automatic filter-list updates would silently stop firing for the
      // rest of the app's lifetime (no error surfaced anywhere, no retry,
      // nothing — just quietly never checking again). A background update
      // job failing once should never be able to cancel itself forever.
      // Fix: always schedule the next tick, in a `finally`, regardless of
      // whether this one succeeded.
      try {
        const state = getState();
        const results = await this.updateAllEnabled(state);
        saveState(state);
        if (onUpdated) onUpdated(results);
      } catch (err) {
        // Best-effort logging only — this is a background job; a failed
        // tick must never crash the app or stop future ticks (see above).
        try { console.error('[adblock] scheduled filter-list update failed:', err); } catch { /* ignore */ }
      } finally {
        const next = Math.max(60000, getState().updateIntervalMs);
        this._timers.set('recurring', setTimeout(tick, next));
      }
    };
    this._timers.set('startup', setTimeout(tick, STARTUP_DELAY_MS));
  }

  stopAutomaticUpdates() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }
}

module.exports = {
  FilterListManager, LIST_DEFINITIONS, validateListText,
  RULE_COUNTS_SCHEMA_VERSION, countRuleSetForText,
};
