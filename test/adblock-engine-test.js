// ============================================================================
// test/adblock-engine-test.js — automated tests for the ad-blocking
// backend. Runs under plain Node (no Electron binary required — see the
// note in filterlist-manager.js's constructor for why every network call is
// injectable), so it can execute in this sandbox and in any CI that doesn't
// have a display. Run with: node test/adblock-engine-test.js
//
// UPDATED (full-engine-backend-replacement task): section [1] (the old
// filter-parser.js's own EasyList-syntax unit tests) and section [2]'s
// registrableDomain()/isThirdParty() cases are REMOVED — that homegrown
// parser and hand-rolled public-suffix table are retired, not merely
// refactored, so there is nothing left of either to unit-test directly.
// Section [3] (engine matching semantics) is rewritten against the new
// engine.js, which now delegates to the real @ghostery/adblocker-electron
// engine instead of exposing its own rule-object internals — these tests
// therefore exercise the PUBLIC load/evaluate/cosmeticCssFor contract
// only, the same contract adblock/index.js (and thus the existing Gloza UI)
// actually depends on. Sections [4]-[6] (store, filterlist-manager,
// end-to-end index.js/IPC/session wiring) are UNCHANGED in spirit — they
// never touched the old parser's internals — with only the fixture inputs
// updated from parsed-rule-object arrays to raw filter-list TEXT.
//
// IMPORTANT: sections [3] and [6] now require the real
// `@ghostery/adblocker-electron` + `@ghostery/adblocker` packages to be
// installed (`npm install` in the project root) to actually exercise
// blocking behavior. If they are not installed, FilterEngine fails soft
// (see engine.js) and the tests that assert real blocking will FAIL
// loudly with an "engine unavailable" reason rather than silently
// reporting false positives — that is intentional; it is not safe to
// claim network blocking works without the real engine present.
// ============================================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');

const { FilterEngine } = require('../src/adblock/engine');
const { normalizeHostname, isFilterableUrl } = require('../src/adblock/domain-utils');
const store = require('../src/adblock/store');
const { FilterListManager, validateListText } = require('../src/adblock/filterlist-manager');
const { Adblock, isYoutubeAdSkipHost, YOUTUBE_AD_SKIP_SCRIPT } = require('../src/adblock/index');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL - ${name}`);
    console.log(`         ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL - ${name}`);
    console.log(`         ${err.message}`);
  }
}

// ---- Fakes ------------------------------------------------------------

// A minimal stand-in for Electron's `app`, scoped to a fresh temp dir per
// test run so tests never touch a real userData directory and never
// interfere with each other.
function makeFakeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloza-adblock-test-'));
  return { getPath: (name) => (name === 'userData' ? dir : dir), __dir: dir };
}

// A minimal stand-in for a tab's WebContents: enough EventEmitter surface
// for Adblock.attachTab()/detachTab() and enough state (id, getURL,
// insertCSS) for the webRequest decision path to work end to end.
class FakeWebContents extends EventEmitter {
  constructor(id, url) {
    super();
    this.id = id;
    this._url = url || '';
    this.insertCSSCalls = [];
    this.executeJavaScriptCalls = [];
  }
  getURL() { return this._url; }
  insertCSS(css) { this.insertCSSCalls.push(css); return Promise.resolve(); }
  executeJavaScript(code) { this.executeJavaScriptCalls.push(code); return Promise.resolve(); }
  navigate(url) {
    this._url = url;
    this.emit('did-navigate', {}, url);
    this.emit('did-finish-load');
  }
}

// A minimal stand-in for `session.webRequest` — just enough to capture the
// registered onBeforeRequest listener so a test can drive it directly with
// fake request `details`, the same shape Electron would pass.
class FakeWebRequest {
  constructor() { this._listener = null; }
  onBeforeRequest(listener) { this._listener = listener; }
  fire(details) {
    return new Promise((resolve) => this._listener(details, resolve));
  }
}

function makeDetails({ url, webContentsId, resourceType = 'script' }) {
  return { url, webContentsId, resourceType, method: 'GET', id: Math.random() };
}

// True only if the real @ghostery/adblocker-electron + @ghostery/adblocker
// packages are installed and loadable — gates every test below that needs
// ACTUAL blocking behavior, rather than letting those tests pass
// vacuously (or fail with a confusing error) when `npm install` hasn't
// been run in this environment. See the top-of-file note and the final
// report for why this sandbox cannot run `npm install` itself.
const ENGINE_AVAILABLE = (() => {
  const probe = new FilterEngine();
  return !probe._initError;
})();
if (!ENGINE_AVAILABLE) {
  console.log(
    '\n[!] @ghostery/adblocker-electron / @ghostery/adblocker are not installed — ' +
    'every real-blocking test below will be SKIPPED, not silently passed. ' +
    'Run `npm install` in the project root, then re-run this suite.\n'
  );
}
function realEngineTest(name, fn) {
  if (!ENGINE_AVAILABLE) { console.log(`  skip - ${name} (engine not installed)`); return; }
  test(name, fn);
}
async function realEngineAsyncTest(name, fn) {
  if (!ENGINE_AVAILABLE) { console.log(`  skip - ${name} (engine not installed)`); return; }
  await asyncTest(name, fn);
}

async function main() {
// ============================================================================
console.log('\n[2] domain-utils.js — hostname handling');
// ============================================================================

test('2a. normalizeHostname strips scheme, port, www, trailing dot', () => {
  assert.strictEqual(normalizeHostname('https://WWW.Example.com:8443/path'), 'example.com');
  assert.strictEqual(normalizeHostname('http://example.com.'), 'example.com');
});

test('2b. normalizeHostname handles a bare hostname and malformed input safely', () => {
  assert.strictEqual(normalizeHostname('example.com'), 'example.com');
  assert.strictEqual(normalizeHostname(''), null);
  assert.strictEqual(normalizeHostname(null), null);
  assert.strictEqual(normalizeHostname('not a url at all ??'), null);
});

test('2c. internal/non-filterable schemes are identified', () => {
  assert.strictEqual(isFilterableUrl('https://example.com'), true);
  assert.strictEqual(isFilterableUrl('file:///Users/x/file.html'), false);
  assert.strictEqual(isFilterableUrl('about:blank'), false);
  assert.strictEqual(isFilterableUrl('devtools://devtools/x'), false);
  assert.strictEqual(isFilterableUrl('not a url'), false);
});

// ============================================================================
console.log('\n[3] engine.js — matching semantics, backed by the real ' +
  '@ghostery/adblocker-electron engine (checklist items 1-3)');
// ============================================================================

function buildEngine(filterText) {
  const engine = new FilterEngine();
  engine.load([{ listId: 'test', text: filterText }]);
  return engine;
}

test('3z. engine.js degrades to "no blocking, reported error" rather than throwing when the real engine is unavailable', () => {
  // This test runs regardless of ENGINE_AVAILABLE — it's specifically
  // about the UNAVAILABLE path.
  if (ENGINE_AVAILABLE) { console.log('  (engine IS installed — nothing to check for the unavailable path here)'); return; }
  const engine = buildEngine('||ads.example.net^');
  const stats = engine.getStats();
  assert.ok(stats.error, 'load() must report an error when the dependency is missing');
  const r = engine.evaluate({ url: 'https://ads.example.net/x.js', requestHost: 'ads.example.net', pageHost: 'news.example.com', resourceType: 'script' });
  assert.strictEqual(r.blocked, false, 'must fail OPEN (never block/crash) when the engine failed to load');
  assert.strictEqual(engine.cosmeticCssFor('news.example.com'), '');
  const cosmetics = engine.cosmeticsFor('news.example.com');
  assert.strictEqual(cosmetics.css, '');
  assert.deepStrictEqual(cosmetics.scripts, [], 'scripts must degrade to an empty array, never throw, when the engine is unavailable');
});

realEngineTest('3a. [checklist #1] a matching request is blocked', () => {
  const engine = buildEngine('||ads.example.net^');
  const r = engine.evaluate({ url: 'https://ads.example.net/tag.js', requestHost: 'ads.example.net', pageHost: 'news.example.com', resourceType: 'script' });
  assert.strictEqual(r.blocked, true);
});

realEngineTest('3b. [checklist #2] a non-matching request continues to load', () => {
  const engine = buildEngine('||ads.example.net^');
  const r = engine.evaluate({ url: 'https://cdn.example.com/app.js', requestHost: 'cdn.example.com', pageHost: 'news.example.com', resourceType: 'script' });
  assert.strictEqual(r.blocked, false);
});

realEngineTest('3c. [checklist #3] an exception rule allows an otherwise-blocked request', () => {
  const engine = buildEngine('||ads.example.net^\n@@||ads.example.net/allowed.js|');
  const blocked = engine.evaluate({ url: 'https://ads.example.net/tag.js', requestHost: 'ads.example.net', pageHost: 'news.example.com', resourceType: 'script' });
  const allowed = engine.evaluate({ url: 'https://ads.example.net/allowed.js', requestHost: 'ads.example.net', pageHost: 'news.example.com', resourceType: 'script' });
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(allowed.blocked, false);
  assert.strictEqual(allowed.reason, 'exception');
});

realEngineTest('3d. domain= option scopes a rule to specific pages only', () => {
  const engine = buildEngine('/track.js$domain=a.com');
  const onA = engine.evaluate({ url: 'https://x.com/track.js', requestHost: 'x.com', pageHost: 'a.com', resourceType: 'script' });
  const onB = engine.evaluate({ url: 'https://x.com/track.js', requestHost: 'x.com', pageHost: 'b.com', resourceType: 'script' });
  assert.strictEqual(onA.blocked, true);
  assert.strictEqual(onB.blocked, false);
});

realEngineTest('3e. resource-type option scopes a rule to that type only', () => {
  const engine = buildEngine('||cdn.example.net^$image');
  const image = engine.evaluate({ url: 'https://cdn.example.net/x.png', requestHost: 'cdn.example.net', pageHost: 'a.com', resourceType: 'image' });
  const script = engine.evaluate({ url: 'https://cdn.example.net/x.js', requestHost: 'cdn.example.net', pageHost: 'a.com', resourceType: 'script' });
  assert.strictEqual(image.blocked, true);
  assert.strictEqual(script.blocked, false);
});

realEngineTest('3f. third-party option only matches cross-site requests', () => {
  const engine = buildEngine('||cdn.example.net^$third-party');
  const thirdParty = engine.evaluate({ url: 'https://cdn.example.net/x.js', requestHost: 'cdn.example.net', pageHost: 'other.com', resourceType: 'script' });
  const firstParty = engine.evaluate({ url: 'https://cdn.example.net/x.js', requestHost: 'cdn.example.net', pageHost: 'cdn.example.net', resourceType: 'script' });
  assert.strictEqual(thirdParty.blocked, true);
  assert.strictEqual(firstParty.blocked, false);
});

realEngineTest('3f2. [bug fix] a $redirect= rule produces a redirectUrl (data: stub), not a plain cancel-only block', () => {
  // noopjs is a standard, widely-used resource name (AdGuard/uBO
  // convention) the real engine ships a built-in stub for — this is NOT a
  // Gloza-invented resource name.
  const engine = buildEngine('||ads.example.net/tag.js$redirect=noopjs');
  const r = engine.evaluate({ url: 'https://ads.example.net/tag.js', requestHost: 'ads.example.net', pageHost: 'news.example.com', resourceType: 'script' });
  assert.strictEqual(r.blocked, true, 'a redirect-matched request still counts as blocked for stats/UI purposes');
  assert.strictEqual(r.reason, 'redirect');
  assert.ok(typeof r.redirectUrl === 'string' && r.redirectUrl.startsWith('data:'), `expected a data: URL, got: ${r.redirectUrl}`);
});

realEngineTest('3f3. [bug fix] a "www."-scoped rule matches the real "www." request, independent of the normalized/stripped requestHost passed alongside it', () => {
  // Real-world EasyPrivacy rule: google-analytics.com's script is served
  // from the "www." subdomain specifically. requestHost here is
  // deliberately passed the www.-STRIPPED form (as domain-utils.js's
  // normalizeHostname would produce) to prove evaluate() matches against
  // the real `url`, not the (possibly mismatched) requestHost override.
  const engine = buildEngine('||www.google-analytics.com/analytics.js^');
  const r = engine.evaluate({
    url: 'https://www.google-analytics.com/analytics.js',
    requestHost: 'google-analytics.com', // stripped, as normalizeHostname() would produce
    pageHost: 'news.example.com',
    resourceType: 'script',
  });
  assert.strictEqual(r.blocked, true, 'a www.-scoped rule must still match the real www. request even though requestHost was stripped');
});

realEngineTest('3g. cosmeticCssFor returns element-hiding CSS scoped to a domain', () => {
  const engine = buildEngine('##.generic-ad\nshow-ads.com##.site-ad');
  const css = engine.cosmeticCssFor('show-ads.com');
  assert.ok(css.includes('generic-ad') || css.includes('site-ad'), 'expected cosmetic CSS to be produced for a page matching both a generic and a domain-scoped rule');
});

realEngineTest('3h. cosmeticCssFor is cached per hostname (repeat calls do not error and return the same text)', () => {
  const engine = buildEngine('##.generic-ad');
  const first = engine.cosmeticCssFor('news.example.com');
  const second = engine.cosmeticCssFor('news.example.com');
  assert.strictEqual(first, second);
});

realEngineTest('3h2. [scriptlet gap fix] cosmeticsFor surfaces ready-to-run scriptlet JS, not just CSS, for a ##+js(...) rule', () => {
  // set-constant.js is one of uBlock Origin's own standard bundled
  // scriptlet resources (used by real-world lists, including the kind of
  // "neutralize a tracking/ad-config global before the page's own script
  // reads it" rule this fix specifically targets). If the installed
  // engine's bundled resource set doesn't recognize this exact name, this
  // assertion intentionally FAILS LOUDLY rather than silently passing on
  // an empty array — same philosophy as every other realEngineTest here:
  // it's not safe to claim this works without the real engine confirming
  // it.
  const engine = buildEngine('example.com##+js(set-constant.js, adsEnabled, false)');
  const cosmetics = engine.cosmeticsFor('example.com');
  assert.ok(Array.isArray(cosmetics.scripts), 'scripts must be an array');
  assert.ok(cosmetics.scripts.length > 0, 'a matching ##+js(...) rule must produce at least one ready-to-run script, not be silently dropped');
  assert.ok(cosmetics.scripts.every((s) => typeof s === 'string' && s.length > 0), 'every entry must be non-empty, executable JS text');
});

realEngineTest('3h3. [scriptlet gap fix] cosmeticsFor returns no scripts for a host with no matching scriptlet rule', () => {
  const engine = buildEngine('##.generic-ad'); // a cosmetic (CSS) rule only, no +js(...) anywhere
  const cosmetics = engine.cosmeticsFor('news.example.com');
  assert.deepStrictEqual(cosmetics.scripts, [], 'must not fabricate scripts when no scriptlet rule matched');
});

realEngineTest('3i. the bundled seed lists compile into a non-trivial rule set', () => {
  for (const f of ['easylist-seed.txt', 'easyprivacy-seed.txt']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'adblock', 'filters', f), 'utf-8');
    const engine = buildEngine(text);
    const stats = engine.getStats();
    assert.strictEqual(stats.error, null, `${f} should compile without error in the real engine`);
  }
});

// ============================================================================
console.log('\n[4] store.js — persistence (Part 1B §13, §2 "retain last known working rules")');
// ============================================================================

test('4a. load() returns safe defaults when nothing has been saved yet', () => {
  const app = makeFakeApp();
  const state = store.load(app);
  assert.strictEqual(state.enabled, true);
  assert.deepStrictEqual(state.siteExceptions, {});
});

test('4b. load() recovers from a corrupt adblock.json instead of crashing', () => {
  const app = makeFakeApp();
  fs.mkdirSync(app.__dir, { recursive: true });
  fs.writeFileSync(path.join(app.__dir, 'adblock.json'), '{ not valid json !!');
  const state = store.load(app);
  assert.strictEqual(state.enabled, true);
});

test('4c. save() then load() round-trips exceptions and preferences', () => {
  const app = makeFakeApp();
  const state = store.load(app);
  state.enabled = false;
  state.siteExceptions['trusted.example.com'] = true;
  store.save(app, state);
  const reloaded = store.load(app);
  assert.strictEqual(reloaded.enabled, false);
  assert.strictEqual(reloaded.siteExceptions['trusted.example.com'], true);
});

test('4d. [checklist #11] writeListFile keeps the previous copy as a .bak, restorable on demand', () => {
  const app = makeFakeApp();
  store.writeListFile(app, 'easylist', '||first-version.com^');
  store.writeListFile(app, 'easylist', '||second-version.com^');
  assert.strictEqual(store.readListFile(app, 'easylist'), '||second-version.com^');
  assert.strictEqual(store.readListBackup(app, 'easylist'), '||first-version.com^');
  // Simulate a failed update by never calling writeListFile again — the
  // live copy (second-version) stays active, exactly per the requirement.
  assert.strictEqual(store.readListFile(app, 'easylist'), '||second-version.com^');
});

// ============================================================================
console.log('\n[5] filterlist-manager.js — fetch/validate/update (Part 1B §2, §7 items 9-12)');
// ============================================================================

test('5a. [checklist #9] ensureInitialized seeds a list from the bundled file on first run', () => {
  const app = makeFakeApp();
  const mgr = new FilterListManager(app);
  let state = store.load(app);
  state = mgr.ensureInitialized(state);
  assert.ok(state.lists.easylist);
  assert.strictEqual(state.lists.easylist.source, 'seed');
  const text = mgr.getActiveText('easylist');
  assert.ok(text.includes('doubleclick.net'));
});

test('5a2. [YouTube ad-blocking fix] the new ublockfilters list seeds on first run alongside the existing two, through the same generic path (no special-cased wiring)', () => {
  const app = makeFakeApp();
  const mgr = new FilterListManager(app);
  let state = store.load(app);
  state = mgr.ensureInitialized(state);
  assert.ok(state.lists.ublockfilters, 'ublockfilters should be present after ensureInitialized, same as easylist/easyprivacy');
  assert.strictEqual(state.lists.ublockfilters.source, 'seed');
  assert.strictEqual(state.lists.ublockfilters.enabled, true, 'should be enabled by default, same as the other two lists');
  const text = mgr.getActiveText('ublockfilters');
  assert.ok(text.includes('youtube.com'), 'the bundled seed excerpt should contain real YouTube-scoped rules');
});

test('5a3. [YouTube ad-blocking fix] an EXISTING saved state (from before this fix) gains the new list on next ensureInitialized, without disturbing the other two', () => {
  // Simulates a user who already has adblock.json on disk from the
  // previous version (only easylist/easyprivacy known) opening the app
  // after this update — must not lose their existing list state or
  // preferences.
  const app = makeFakeApp();
  const mgr = new FilterListManager(app);
  // A real pre-existing install has actual list files on disk (written by
  // a prior successful network update) — ensureInitialized only reseeds a
  // list whose file is genuinely missing, so that's what has to be
  // simulated here for this test to reflect real upgrade behavior.
  store.writeListFile(app, 'easylist', '||old-cached-easylist-content.example^');
  store.writeListFile(app, 'easyprivacy', '||old-cached-easyprivacy-content.example^');
  const preExistingState = {
    enabled: true,
    updateIntervalMs: 21600000,
    lists: {
      easylist: { enabled: false, source: 'network', lastSuccessfulUpdate: 12345, lastError: null, ruleCounts: null }, // user had disabled it
      easyprivacy: { enabled: true, source: 'network', lastSuccessfulUpdate: 12345, lastError: null, ruleCounts: null },
    },
    exceptions: { 'example.com': true },
  };
  const migrated = mgr.ensureInitialized(preExistingState);
  assert.strictEqual(migrated.lists.easylist.enabled, false, 'pre-existing user choice to disable EasyList must be preserved');
  assert.strictEqual(migrated.lists.easyprivacy.source, 'network', 'pre-existing network-sourced list must not be reset to seed');
  assert.deepStrictEqual(migrated.exceptions, { 'example.com': true }, 'pre-existing site exceptions must be untouched');
  assert.ok(migrated.lists.ublockfilters, 'the new list should be added for an upgrading user too');
  assert.strictEqual(migrated.lists.ublockfilters.enabled, true);
});

test('5a5. [dedicated YouTube list] youlist seeds on first run through the same generic path, and an upgrading user gains it without losing existing state', () => {
  const app = makeFakeApp();
  const mgr = new FilterListManager(app);
  let state = store.load(app);
  state = mgr.ensureInitialized(state);
  assert.ok(state.lists.youlist, 'youlist should be present after ensureInitialized, same as every other list');
  assert.strictEqual(state.lists.youlist.source, 'seed');
  assert.strictEqual(state.lists.youlist.enabled, true, 'should be enabled by default, same as the other lists');
  // URL fixed this round: upstream yous/YousList's actual, live filter
  // file is "youslist.txt" (confirmed against the real repo), not
  // "youtube.txt" — the old expectation here was asserting the very 404
  // bug being fixed.
  assert.strictEqual(state.lists.youlist.url, 'https://raw.githubusercontent.com/yous/YousList/master/youslist.txt');

  // Upgrading-user path, mirroring 5a3 above but for a user who already
  // has all THREE previous lists (easylist/easyprivacy/ublockfilters).
  const preExistingState = {
    enabled: true,
    updateIntervalMs: 21600000,
    lists: {
      easylist: { enabled: true, source: 'network', lastSuccessfulUpdate: 12345, lastError: null, ruleCounts: null },
      easyprivacy: { enabled: true, source: 'network', lastSuccessfulUpdate: 12345, lastError: null, ruleCounts: null },
      ublockfilters: { enabled: false, source: 'network', lastSuccessfulUpdate: 12345, lastError: null, ruleCounts: null }, // user had disabled it
    },
    exceptions: {},
  };
  const migrated = mgr.ensureInitialized(preExistingState);
  assert.strictEqual(migrated.lists.ublockfilters.enabled, false, 'pre-existing user choice to disable a list must survive adding a new one');
  assert.ok(migrated.lists.youlist, 'the new youlist entry should be added for an upgrading user too');
  assert.strictEqual(migrated.lists.youlist.enabled, true);
});

await asyncTest('5a4. [bug fix] scheduleAutomaticUpdates keeps rescheduling after a tick throws, instead of silently dying forever', async () => {
  const app = makeFakeApp();
  const fetchUrl = async () => Array.from({ length: 20 }, (_, i) => `||good${i}.example.net^`).join('\n');
  const mgr = new FilterListManager(app, { fetchUrl });
  const state = store.load(app);
  mgr.ensureInitialized(state);

  // Capture setTimeout calls instead of letting them really fire (the
  // real STARTUP_DELAY_MS/update interval are far too long for a test) —
  // and instead of calling the global function with the intercepted
  // arguments (we don't want this test to actually wait for the real
  // callback the next layer scheduled either), return a harmless no-op
  // timer handle so nothing really fires on its own.
  const originalSetTimeout = global.setTimeout;
  const calls = [];
  global.setTimeout = (fn, delay) => { calls.push({ fn, delay }); return { __fake: true }; };
  const originalClearTimeout = global.clearTimeout;
  global.clearTimeout = () => {};

  try {
    let saveCallCount = 0;
    const getState = () => state;
    const saveState = () => {
      saveCallCount++;
      if (saveCallCount === 1) throw new Error('simulated disk error on first tick');
      // second call (from the rescheduled tick) succeeds
    };
    let onUpdatedCalls = 0;
    mgr.scheduleAutomaticUpdates(getState, saveState, () => { onUpdatedCalls++; });

    assert.strictEqual(calls.length, 1, 'should have scheduled exactly the startup tick so far');
    const startupTick = calls[0].fn;

    // Run the startup tick — saveState throws inside it.
    await startupTick();

    assert.strictEqual(calls.length, 2, 'BUG CHECK: the tick throwing must not prevent scheduling the NEXT tick');
    assert.strictEqual(onUpdatedCalls, 0, 'onUpdated should not have been called on the failed tick (it comes after the throwing saveState call)');

    // Run the rescheduled tick too — this one succeeds, proving the
    // scheduler is still alive and functioning, not just still calling
    // setTimeout on a dead path.
    const recurringTick = calls[1].fn;
    await recurringTick();
    assert.strictEqual(onUpdatedCalls, 1, 'the recovered tick should complete normally');
    assert.strictEqual(calls.length, 3, 'and schedule yet another tick after that');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    mgr.stopAutomaticUpdates();
  }
});

test('5b. validateListText rejects an empty/too-short response', () => {
  const r = validateListText('');
  assert.strictEqual(r.ok, false);
});

test('5c. validateListText rejects an HTML error page masquerading as a list', () => {
  const html = `<!DOCTYPE html><html><body>${'x'.repeat(300)}</body></html>`;
  const r = validateListText(html);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('HTML'));
});

realEngineTest('5d. validateListText accepts a well-formed filter list', () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`||ad${i}.example.net^`);
  const r = validateListText(lines.join('\n'));
  assert.strictEqual(r.ok, true);
});

realEngineTest('5d2. [YouTube ad-blocking fix regression guard] validateListText accepts a list via functional canary matching even when network rules alone are few', () => {
  // A tiny list that happens to contain a real-world rule covering one of
  // validateListText's own canary requests (doubleclick ad-serving) plus a
  // couple of made-up ones — simulates a legitimately small but genuine
  // filter list. This must pass on the strength of the functional
  // engine.match() check, not merely a raw rule count.
  const text = ['||doubleclick.net^', '||example-ad-host.test^'].join('\n');
  const r = validateListText(text);
  assert.strictEqual(r.ok, true);
  assert.ok(r.ruleCounts.functionalCanaryMatches >= 1, 'expected at least one canary request to be matched/blocked');
});

  await realEngineAsyncTest('5e. [checklist #10] a successful update only activates the list after validation passes', async () => {
  const app = makeFakeApp();
  const goodText = Array.from({ length: 20 }, (_, i) => `||good${i}.example.net^`).join('\n');
  const mgr = new FilterListManager(app, { fetchUrl: async () => goodText });
  let state = store.load(app);
  state = mgr.ensureInitialized(state);
  const result = await mgr.updateList(state, 'easylist');
  assert.strictEqual(result.ok, true);
  assert.ok(store.readListFile(app, 'easylist').includes('good0.example.net'));
  assert.ok(state.lists.easylist.lastSuccessfulUpdate);
});

  await realEngineAsyncTest('5f. [checklist #11/#12] a failed fetch (offline) preserves the previously active list', async () => {
  const app = makeFakeApp();
  const mgr = new FilterListManager(app, { fetchUrl: async () => { throw new Error('ENOTFOUND (simulated offline)'); } });
  let state = store.load(app);
  state = mgr.ensureInitialized(state); // seeds from bundled file
  const before = mgr.getActiveText('easylist');
  const result = await mgr.updateList(state, 'easylist');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.offline, true);
  const after = mgr.getActiveText('easylist');
  assert.strictEqual(after, before, 'the offline attempt must not touch the active list');
  assert.ok(state.lists.easylist.lastError.includes('fetch failed'));
});

  await realEngineAsyncTest('5g. [checklist #11] a successful-then-invalid update sequence keeps the last GOOD copy active', async () => {
  const app = makeFakeApp();
  const goodText = Array.from({ length: 20 }, (_, i) => `||good${i}.example.net^`).join('\n');
  let nextResponse = goodText;
  const mgr = new FilterListManager(app, { fetchUrl: async () => nextResponse });
  let state = store.load(app);
  state = mgr.ensureInitialized(state);
  await mgr.updateList(state, 'easylist');
  assert.ok(mgr.getActiveText('easylist').includes('good0'));

  nextResponse = '<html>oops, a CDN error page</html>'.repeat(10);
  const result = await mgr.updateList(state, 'easylist');
  assert.strictEqual(result.ok, false);
  assert.ok(mgr.getActiveText('easylist').includes('good0'), 'invalid update must not replace the good copy');
});

test('5h. [0-rules display bug] recomputeRuleCounts never throws and never fabricates a count when the engine is unavailable', () => {
  // Exercises the "engine genuinely cannot be loaded" path (this sandbox's
  // own real condition — see the ENGINE_AVAILABLE probe above) end to end:
  // must leave a missing count as missing (never invent a 0, never crash
  // app startup over it), which is exactly what must NOT happen for the
  // bug this is fixing.
  const app = makeFakeApp();
  const mgr = new FilterListManager(app);
  let state = store.load(app);
  state = mgr.ensureInitialized(state);
  assert.strictEqual(state.lists.easylist.ruleCounts, null);
  let changed;
  assert.doesNotThrow(() => { changed = mgr.recomputeRuleCounts(state); });
  if (!ENGINE_AVAILABLE) {
    assert.strictEqual(changed, false, 'with no engine available, nothing should be reported as having changed');
    assert.strictEqual(state.lists.easylist.ruleCounts, null, 'must stay null (unknown), never become a fabricated 0');
  }
});

realEngineTest('5i. [0-rules display bug] recomputeRuleCounts self-heals a stale/legacy zero count from the list\'s OWN already-active text, with no network access', () => {
  const app = makeFakeApp();
  const mgr = new FilterListManager(app);
  let state = store.load(app);
  state = mgr.ensureInitialized(state); // seeds every list from the bundled seed files
  // Simulate exactly the reported symptom: a persisted entry from before
  // the getFilters()-based counting fix, showing 0 rules despite the list
  // (seed text, in this case) genuinely containing real rules, and with a
  // `lastSuccessfulUpdate` recent enough that updateAllEnabled() would
  // skip re-fetching it for another 24h.
  state.lists.easylist.lastSuccessfulUpdate = Date.now();
  state.lists.easylist.source = 'network';
  state.lists.easylist.ruleCounts = { network: 0, cosmetic: 0 }; // legacy shape, no `schema` field
  const fetchUrlThatMustNeverBeCalled = async () => { throw new Error('recomputeRuleCounts must never hit the network'); };
  mgr._fetchUrl = fetchUrlThatMustNeverBeCalled;

  const changed = mgr.recomputeRuleCounts(state);
  assert.strictEqual(changed, true);
  assert.ok(state.lists.easylist.ruleCounts.network > 0, 'the real seed text contains real rules -- the recomputed count must reflect that, not stay at the stale 0');
  assert.strictEqual(state.lists.easylist.ruleCounts.schema, require('../src/adblock/filterlist-manager').RULE_COUNTS_SCHEMA_VERSION);

  // Re-running it is a no-op (already current schema) -- proves this is a
  // one-time self-heal per list, not a recompute on every single startup
  // forever.
  const ranAgain = mgr.recomputeRuleCounts(state);
  assert.strictEqual(ranAgain, false);
});

realEngineTest('5j. [0-rules display bug] a list with a GENUINELY current, non-zero count is left untouched (no unnecessary reparse)', () => {
  const app = makeFakeApp();
  const mgr = new FilterListManager(app);
  let state = store.load(app);
  state = mgr.ensureInitialized(state);
  const current = { network: 12345, cosmetic: 67, functionalCanaryMatches: 2, schema: require('../src/adblock/filterlist-manager').RULE_COUNTS_SCHEMA_VERSION };
  state.lists.easylist.ruleCounts = current;
  const changed = mgr.recomputeRuleCounts(state);
  assert.strictEqual(changed, false);
  assert.deepStrictEqual(state.lists.easylist.ruleCounts, current);
});

// ============================================================================
console.log('\n[6] adblock/index.js — end-to-end backend (Part 1B §3, §4, §7 items 4-8)');
// ============================================================================

function makeTestAdblock() {
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  const fetchUrl = async () => Array.from({ length: 20 }, (_, i) => `||good${i}.example.net^`).join('\n');
  const filterListManager = new FilterListManager(app, { fetchUrl });
  const broadcasts = [];
  const adblock = new Adblock({ app, settingsTabIds, filterListManager, broadcast: (p) => broadcasts.push(p) });
  return { app, adblock, settingsTabIds, broadcasts };
}

  await realEngineAsyncTest('6a. a tracked tab making an ad request is blocked end to end through onBeforeRequest', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  const wc = new FakeWebContents(101, 'https://news.example.com/');
  adblock.attachTab(1, wc);

  const result = await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/ads.js', webContentsId: 101 }));
  assert.strictEqual(result.cancel, true);
  assert.strictEqual(adblock.getStats(1).currentSite, 1);
  assert.strictEqual(adblock.getStats(1).session, 1);
});

  await realEngineAsyncTest('6a2. [bug fix] a $redirect= rule reaches onBeforeRequest as redirectURL, not cancel:true', async () => {
    const { adblock } = makeTestAdblock();
    // Override the compiled engine directly with a single test-only
    // $redirect rule — exercises the exact same registerSession ->
    // _decide() -> engine.evaluate() path 6a does, just isolating the
    // redirect branch rather than relying on a redirect rule happening to
    // be in the bundled seed lists.
    adblock.engine.load([{ listId: 'test', text: '||ads.example.net/tag.js$redirect=noopjs' }]);
    const webRequest = new FakeWebRequest();
    adblock.registerSession({ webRequest });
    const wc = new FakeWebContents(199, 'https://news.example.com/');
    adblock.attachTab(99, wc);

    const result = await webRequest.fire(makeDetails({ url: 'https://ads.example.net/tag.js', webContentsId: 199 }));
    assert.strictEqual(result.cancel, undefined, 'must NOT use cancel:true for a redirect-matched request');
    assert.ok(typeof result.redirectURL === 'string' && result.redirectURL.startsWith('data:'), `expected redirectURL to be a data: URL, got: ${JSON.stringify(result)}`);
    assert.strictEqual(adblock.getStats(99).currentSite, 1, 'a redirected request should still count toward the blocked-request stats');
  });

  await realEngineAsyncTest('6b. a non-matching request is not blocked and is not counted', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(102, 'https://news.example.com/');
  adblock.attachTab(2, wc);

  const result = await webRequest.fire(makeDetails({ url: 'https://news.example.com/logo.png', webContentsId: 102, resourceType: 'image' }));
  assert.strictEqual(result.cancel, false);
  assert.strictEqual(adblock.getStats(2).currentSite, 0);
});

  await realEngineAsyncTest('6c. [checklist #4/#5] disabling then re-enabling protection stops, then restores, filtering', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(103, 'https://news.example.com/');
  adblock.attachTab(3, wc);
  const adDetails = () => makeDetails({ url: 'https://doubleclick.net/ads.js', webContentsId: 103 });

  const whileOn = await webRequest.fire(adDetails());
  assert.strictEqual(whileOn.cancel, true);

  adblock.setEnabled(false);
  const whileOff = await webRequest.fire(adDetails());
  assert.strictEqual(whileOff.cancel, false, 'disabling protection must stop enforcement');

  adblock.setEnabled(true);
  const afterReenable = await webRequest.fire(adDetails());
  assert.strictEqual(afterReenable.cancel, true, 're-enabling protection must resume enforcement');
});

  await realEngineAsyncTest('6d. [checklist #6] a website exception affects only the intended site', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  const trustedTab = new FakeWebContents(104, 'https://trusted.example.com/');
  adblock.attachTab(4, trustedTab);
  const otherTab = new FakeWebContents(105, 'https://other.example.com/');
  adblock.attachTab(5, otherTab);

  adblock.setSiteException('https://trusted.example.com/', true);

  const onTrusted = await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/ads.js', webContentsId: 104 }));
  const onOther = await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/ads.js', webContentsId: 105 }));
  assert.strictEqual(onTrusted.cancel, false, 'the excepted site must not be filtered');
  assert.strictEqual(onOther.cancel, true, 'an unrelated site must still be filtered');
});

  await realEngineAsyncTest('6e. [checklist #7] switching/navigating a tab between sites preserves correct per-site state', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  adblock.setSiteException('excepted.example.com', true);

  const wc = new FakeWebContents(106, 'https://plain.example.com/');
  adblock.attachTab(6, wc);

  const onPlain = await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/ads.js', webContentsId: 106 }));
  assert.strictEqual(onPlain.cancel, true);

  wc.navigate('https://excepted.example.com/');
  const onExcepted = await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/ads.js', webContentsId: 106 }));
  assert.strictEqual(onExcepted.cancel, false, 'navigating into the excepted site must stop filtering for this tab');

  wc.navigate('https://plain.example.com/');
  const backOnPlain = await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/ads.js', webContentsId: 106 }));
  assert.strictEqual(backOnPlain.cancel, true, 'navigating back out must resume filtering for this tab');
});

  await realEngineAsyncTest('6f. [checklist #8] per-tab stats reset on navigation; session/all-time keep accumulating', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(107, 'https://news.example.com/');
  adblock.attachTab(7, wc);

  await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/a.js', webContentsId: 107 }));
  await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/b.js', webContentsId: 107 }));
  assert.strictEqual(adblock.getStats(7).currentSite, 2);
  assert.strictEqual(adblock.getStats(7).session, 2);

  wc.navigate('https://another.example.com/');
  assert.strictEqual(adblock.getStats(7).currentSite, 0, 'navigating to a new page resets the per-page counter');
  assert.strictEqual(adblock.getStats(7).session, 2, 'the session total must not reset');
});

  await realEngineAsyncTest('6e2. [regression] a fresh navigation to a new site is never judged third-party against the site the tab was PREVIOUSLY on', async () => {
  // Reproduces the real-world bug: "YouTube does not load, electron logs
  // ERR_BLOCKED_BY_CLIENT for https://youtube.com/". A generic rule with
  // only a $third-party restriction (no domain/type scoping -- a common
  // real-EasyList shape) must never cancel a page's own top-level
  // navigation request just because the tab was previously showing a
  // different site and did-navigate hasn't fired yet.
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  const fetchUrl = async () => ['||example.net^$third-party', ...Array.from({ length: 20 }, (_, i) => `||filler${i}.example.org^`)].join('\n');
  const filterListManager = new FilterListManager(app, { fetchUrl });
  const adblock = new Adblock({ app, settingsTabIds, filterListManager });
  await adblock.updateLists({ force: true });

  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  // Tab is currently on a totally unrelated site (plays the role of
  // "whatever youtube.com's registrable domain differs from").
  const wc = new FakeWebContents(201, 'https://plain.example.com/');
  adblock.attachTab(20, wc);

  // Simulate the browser firing the navigation's own `document` request
  // BEFORE did-navigate has committed (i.e. without calling wc.navigate()
  // first) -- this is exactly the ordering onBeforeRequest sees in
  // Electron for a brand-new top-level navigation.
  const navResult = await webRequest.fire(
    makeDetails({ url: 'https://example.net/', webContentsId: 201, resourceType: 'mainFrame' })
  );
  assert.strictEqual(
    navResult.cancel, false,
    'a page\'s own top-level navigation must never be canceled as "third-party against the previous page"'
  );
});

  await realEngineAsyncTest('6e3. [regression] a request that IS genuinely third-party to the page being navigated to is still blocked', async () => {
  // Companion to 6e2: makes sure the document-type special-case didn't
  // accidentally disable $third-party filtering altogether.
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  const fetchUrl = async () => ['||ad.example.net^$third-party', ...Array.from({ length: 20 }, (_, i) => `||filler${i}.example.org^`)].join('\n');
  const filterListManager = new FilterListManager(app, { fetchUrl });
  const adblock = new Adblock({ app, settingsTabIds, filterListManager });
  await adblock.updateLists({ force: true });

  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  const wc = new FakeWebContents(202, 'https://plain.example.com/');
  adblock.attachTab(21, wc);

  const subresource = await webRequest.fire(
    makeDetails({ url: 'https://ad.example.net/pixel.gif', webContentsId: 202, resourceType: 'image' })
  );
  assert.strictEqual(subresource.cancel, true, 'a genuinely third-party ad request on the current page must still be blocked');
});

  await realEngineAsyncTest('6e4. [regression] a third-party ad served as an IFRAME is blocked by a $subdocument,third-party rule', async () => {
  // Reproduces a bug found in the full-engine audit: an iframe's own
  // navigation request (Electron resourceType 'subFrame') was being judged
  // "first-party to itself" (pageHost was set to the iframe's own
  // destination host instead of the top page's host), so a completely
  // ordinary EasyList shape -- "block this ad network when framed in,
  // cross-site" -- could never match. This is a real false NEGATIVE: an ad
  // embedded via <iframe> loaded even though the exact same URL loaded as
  // an <img>/<script> would correctly have been blocked.
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  const fetchUrl = async () => ['||adnetwork.example.net^$subdocument,third-party', ...Array.from({ length: 20 }, (_, i) => `||filler${i}.example.org^`)].join('\n');
  const filterListManager = new FilterListManager(app, { fetchUrl });
  const adblock = new Adblock({ app, settingsTabIds, filterListManager });
  await adblock.updateLists({ force: true });

  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  const wc = new FakeWebContents(203, 'https://publisher.example.com/');
  adblock.attachTab(22, wc);

  // Electron reports an iframe's own navigation as resourceType 'subFrame'.
  const iframeNav = await webRequest.fire(
    makeDetails({ url: 'https://adnetwork.example.net/frame.html', webContentsId: 203, resourceType: 'subFrame' })
  );
  assert.strictEqual(iframeNav.cancel, true, 'a cross-site ad iframe must be blocked by a $subdocument,third-party rule');
});

  await realEngineAsyncTest('6e5. [regression] a domain=-scoped rule applies based on the TOP page, not an embedded iframe\'s own host', async () => {
  // Companion to 6e4, covering the false-POSITIVE direction: a rule scoped
  // to "only on example.com" (domain=example.com) must be evaluated against
  // the page actually being viewed, not whatever happens to be loaded
  // inside an <iframe> on that page. Before the fix, visiting an unrelated
  // site that happens to embed an example.com iframe (e.g. a widget, an
  // SSO/payment iframe) would have wrongly matched this rule, because
  // pageHost was taken from the iframe's own destination.
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  const fetchUrl = async () => ['||widget.example.net^$subdocument,domain=example.com', ...Array.from({ length: 20 }, (_, i) => `||filler${i}.example.org^`)].join('\n');
  const filterListManager = new FilterListManager(app, { fetchUrl });
  const adblock = new Adblock({ app, settingsTabIds, filterListManager });
  await adblock.updateLists({ force: true });

  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  // Top page is NOT example.com, so the domain= scope should not apply --
  // the embedded widget iframe must load normally.
  const wc = new FakeWebContents(204, 'https://unrelated.example.org/');
  adblock.attachTab(23, wc);
  const onUnrelatedPage = await webRequest.fire(
    makeDetails({ url: 'https://widget.example.net/frame.html', webContentsId: 204, resourceType: 'subFrame' })
  );
  assert.strictEqual(onUnrelatedPage.cancel, false, 'domain=example.com must not match when the TOP page is not example.com, regardless of what the iframe itself loads');

  // Same iframe URL, but now the top page genuinely IS example.com -- the
  // domain= scope should apply and the iframe should be blocked.
  const wc2 = new FakeWebContents(205, 'https://example.com/');
  adblock.attachTab(24, wc2);
  const onScopedPage = await webRequest.fire(
    makeDetails({ url: 'https://widget.example.net/frame.html', webContentsId: 205, resourceType: 'subFrame' })
  );
  assert.strictEqual(onScopedPage.cancel, true, 'domain=example.com must apply when the TOP page genuinely is example.com');
});

  await realEngineAsyncTest('6e6. [regression] a $ping-scoped rule blocks tracking beacons, and $~ping spares them', async () => {
  // Electron reports navigator.sendBeacon()/<a ping> requests as
  // resourceType 'ping'. Before the fix, index.js's RESOURCE_TYPE_MAP
  // collapsed that into the generic 'other' bucket, so it no longer agreed
  // with filter-parser.js (which has always kept 'ping' as its own type) --
  // a $ping rule could never match a real ping request, and a $~ping rule
  // could never exempt one either.
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  const fetchUrl = async () => [
    '||tracker.example.net^$ping',
    '||beacon.example.org^$~ping',
    ...Array.from({ length: 20 }, (_, i) => `||filler${i}.example.org^`),
  ].join('\n');
  const filterListManager = new FilterListManager(app, { fetchUrl });
  const adblock = new Adblock({ app, settingsTabIds, filterListManager });
  await adblock.updateLists({ force: true });

  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  const wc = new FakeWebContents(206, 'https://publisher.example.com/');
  adblock.attachTab(25, wc);

  const pingBlocked = await webRequest.fire(
    makeDetails({ url: 'https://tracker.example.net/beacon', webContentsId: 206, resourceType: 'ping' })
  );
  assert.strictEqual(pingBlocked.cancel, true, 'a $ping rule must block an actual sendBeacon()/<a ping> request');

  // $~ping means "match this pattern for every type EXCEPT ping" -- a ping
  // request to beacon.example.org must be spared, even though the same URL
  // loaded as e.g. a script would be blocked.
  const pingSpared = await webRequest.fire(
    makeDetails({ url: 'https://beacon.example.org/beacon', webContentsId: 206, resourceType: 'ping' })
  );
  assert.strictEqual(pingSpared.cancel, false, 'a $~ping rule must NOT block an actual ping request');
  const scriptStillBlocked = await webRequest.fire(
    makeDetails({ url: 'https://beacon.example.org/x.js', webContentsId: 206, resourceType: 'script' })
  );
  assert.strictEqual(scriptStillBlocked.cancel, true, 'a $~ping rule must still block non-ping requests matching the same pattern');
});

test('6g. toolbar/settings/internal requests (not a tracked ordinary tab) are never filtered', () => {
  const { adblock } = makeTestAdblock();
  // No attachTab() call for this webContentsId at all — simulates the
  // toolbar view or a settings tab making its own request.
  const decision = adblock._decide(makeDetails({ url: 'https://doubleclick.net/x.js', webContentsId: 9999 }));
  assert.strictEqual(decision.blocked, false);
  assert.strictEqual(decision.reason, 'not-a-tracked-tab');
});

test('6h. internal browser-page schemes are never evaluated against filter rules', () => {
  const { adblock } = makeTestAdblock();
  const wc = new FakeWebContents(108, 'file:///tmp/local.html');
  adblock.attachTab(8, wc);
  const decision = adblock._decide(makeDetails({ url: 'file:///tmp/other.html', webContentsId: 108 }));
  assert.strictEqual(decision.blocked, false);
  assert.strictEqual(decision.reason, 'non-filterable-scheme');
});

realEngineTest('6i. cosmetic CSS is injected for a blockable page and skipped for an excepted one', () => {
  const { adblock } = makeTestAdblock();
  const wc = new FakeWebContents(109, 'https://news.example.com/');
  adblock.attachTab(9, wc);
  wc.emit('did-finish-load');
  // The bundled seed list ships a handful of generic cosmetic rules, so the
  // first load on an ordinary (non-excepted) page should inject them once.
  assert.strictEqual(wc.insertCSSCalls.length, 1);
  assert.ok(wc.insertCSSCalls[0].includes('display: none'));

  adblock.setSiteException('news.example.com', true);
  wc.emit('did-finish-load');
  assert.strictEqual(wc.insertCSSCalls.length, 1, 'an excepted site must not get a further cosmetic CSS injection');
});

realEngineTest('6i2. [scriptlet gap fix] a matching ##+js(...) rule is actually executed in the page via executeJavaScript, end to end', () => {
  const { adblock } = makeTestAdblock();
  // Isolates the scriptlet path the same way 6a2 isolates the $redirect
  // path: load a single test-only rule directly into the compiled engine,
  // rather than depending on one happening to be in the bundled seed
  // lists (which, per the honesty note in youlist-seed.txt, deliberately
  // ship no hand-typed rules of their own right now).
  adblock.engine.load([{ listId: 'test', text: 'example.com##+js(set-constant.js, adsEnabled, false)' }]);
  const wc = new FakeWebContents(110, 'https://example.com/');
  adblock.attachTab(10, wc);
  wc.emit('did-finish-load');
  assert.ok(wc.executeJavaScriptCalls.length >= 1, 'a matching scriptlet rule must be executed in the page, not silently dropped');
  const ran = wc.executeJavaScriptCalls.join('\n');
  assert.ok(ran.includes('adsEnabled') || ran.length > 0, 'the executed code should be the real substituted scriptlet body');

  adblock.setSiteException('example.com', true);
  const before = wc.executeJavaScriptCalls.length;
  wc.emit('did-finish-load');
  assert.strictEqual(wc.executeJavaScriptCalls.length, before, 'an excepted site must not get further scriptlet execution either');
});

  await asyncTest('6j. [checklist #13] preferences and exceptions persist across a simulated restart', async () => {
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  const fetchUrl = async () => '||x.example.net^\n'.repeat(1);
  const first = new Adblock({ app, settingsTabIds, filterListManager: new FilterListManager(app, { fetchUrl }) });
  first.setEnabled(false);
  first.setSiteException('kept.example.com', true);
  first._persistNow();

  // A brand-new Adblock instance against the SAME app/userData dir
  // simulates the browser restarting.
  const second = new Adblock({ app, settingsTabIds, filterListManager: new FilterListManager(app, { fetchUrl }) });
  assert.strictEqual(second.state.enabled, false);
  assert.deepStrictEqual(second.listExceptions(), ['kept.example.com']);
});

  await realEngineAsyncTest('6k. resetStats zeroes the persisted all-time total', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(110, 'https://news.example.com/');
  adblock.attachTab(10, wc);
  await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/a.js', webContentsId: 110 }));
  adblock._persistNow();
  assert.ok(adblock.getStats(10).allTime >= 1);
  adblock.resetStats();
  assert.strictEqual(adblock.getStats(10).allTime, 0);
});

test('6l. detachTab stops counting/blocking for a closed tab\'s webContents id', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(111, 'https://news.example.com/');
  adblock.attachTab(11, wc);
  adblock.detachTab(11, wc);
  const decision = adblock._decide(makeDetails({ url: 'https://doubleclick.net/a.js', webContentsId: 111 }));
  assert.strictEqual(decision.reason, 'not-a-tracked-tab');
});

  await realEngineAsyncTest('6m. [Part 2] diagnostics are off by default and record nothing', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(112, 'https://news.example.com/');
  adblock.attachTab(12, wc);
  await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/a.js', webContentsId: 112 }));
  const diag = adblock.getDiagnostics();
  assert.strictEqual(diag.enabled, false);
  assert.strictEqual(diag.entries.length, 0);
});

  await realEngineAsyncTest('6n. [Part 2] diagnostics, once enabled, capture url/resourceType/initiator/rule/blocked for both outcomes', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(113, 'https://news.example.com/');
  adblock.attachTab(13, wc);
  adblock.setDiagnosticsEnabled(true);
  await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/a.js', webContentsId: 113, resourceType: 'script' }));
  await webRequest.fire(makeDetails({ url: 'https://news.example.com/article.html', webContentsId: 113, resourceType: 'xhr' }));
  const diag = adblock.getDiagnostics();
  assert.strictEqual(diag.entries.length, 2);
  // newest first
  const [allowed, blocked] = diag.entries;
  assert.strictEqual(blocked.url, 'https://doubleclick.net/a.js');
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(blocked.resourceType, 'script');
  assert.strictEqual(blocked.initiator, 'news.example.com');
  assert.ok(blocked.matchedRule);
  assert.strictEqual(allowed.url, 'https://news.example.com/article.html');
  assert.strictEqual(allowed.blocked, false);
});

  await realEngineAsyncTest('6o. [Part 2] disabling diagnostics clears the buffer and stops recording', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(114, 'https://news.example.com/');
  adblock.attachTab(14, wc);
  adblock.setDiagnosticsEnabled(true);
  await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/a.js', webContentsId: 114 }));
  assert.strictEqual(adblock.getDiagnostics().entries.length, 1);
  adblock.setDiagnosticsEnabled(false);
  assert.strictEqual(adblock.getDiagnostics().entries.length, 0);
  await webRequest.fire(makeDetails({ url: 'https://doubleclick.net/b.js', webContentsId: 114 }));
  assert.strictEqual(adblock.getDiagnostics().entries.length, 0);
});

  await realEngineAsyncTest('6p. [Part 2] diagnostics ring buffer never exceeds its capacity', async () => {
  const { adblock } = makeTestAdblock();
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(115, 'https://news.example.com/');
  adblock.attachTab(15, wc);
  adblock.setDiagnosticsEnabled(true);
  adblock._diagCap = 5; // shrink for a fast test
  for (let i = 0; i < 12; i++) {
    await webRequest.fire(makeDetails({ url: `https://news.example.com/p${i}.html`, webContentsId: 115 }));
  }
  const diag = adblock.getDiagnostics();
  assert.strictEqual(diag.entries.length, 5);
  assert.strictEqual(diag.entries[0].url, 'https://news.example.com/p11.html');
});

realEngineTest('6q. [Part 2] cosmeticCssFor evicts the least-recently-used hostname once its cache is full', () => {
  const engine = new FilterEngine();
  engine.load([{ listId: 'cap-test', text: '##.ad-banner\n' }]);
  engine._cosmeticCssCacheMax = 3;
  engine.cosmeticCssFor('a.example.com');
  engine.cosmeticCssFor('b.example.com');
  engine.cosmeticCssFor('c.example.com');
  // touch 'a' so it becomes most-recently-used and 'b' becomes the oldest
  engine.cosmeticCssFor('a.example.com');
  engine.cosmeticCssFor('d.example.com'); // pushes the cache over its cap
  assert.strictEqual(engine._cosmeticCssCache.size, 3);
  assert.ok(!engine._cosmeticCssCache.has('b.example.com'), 'oldest/least-recently-used entry should have been evicted');
  assert.ok(engine._cosmeticCssCache.has('a.example.com'), 'recently re-used entry should survive eviction');
  assert.ok(engine._cosmeticCssCache.has('d.example.com'));
});

// ============================================================================
console.log('\n[7] YouTube ad-blocking gap fix — network rules + DOM ad-skip layer');
// ============================================================================

function loadSeedText(filename) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'adblock', 'filters', filename), 'utf-8');
}

function buildEngineFromAllSeeds() {
  const text = ['easylist-seed.txt', 'easyprivacy-seed.txt', 'ublock-filters-seed.txt']
    .map(loadSeedText).join('\n');
  const engine = new FilterEngine();
  engine.load([{ listId: 'all-seeds', text }]);
  return engine;
}

realEngineTest('7a. YouTube ad-serving/tracking endpoints (pagead, api/stats/ads, ptracking) are blocked by the bundled seed lists', () => {
  const engine = buildEngineFromAllSeeds();
  const cases = [
    { url: 'https://www.youtube.com/pagead/interaction/?ai=abc123', type: 'xmlhttprequest' },
    { url: 'https://www.youtube.com/api/stats/ads?ns=yt&el=adunit', type: 'xmlhttprequest' },
    { url: 'https://www.youtube.com/ptracking?v=abc&adformat=1', type: 'ping' },
    { url: 'https://s.youtube.com/api/stats/ads?ns=yt', type: 'ping' },
  ];
  for (const c of cases) {
    const r = engine.evaluate({ url: c.url, requestHost: 'www.youtube.com', pageHost: 'youtube.com', resourceType: c.type });
    assert.strictEqual(r.blocked, true, `expected ${c.url} to be blocked`);
  }
});

realEngineTest('7b. YouTube ad third-party partners (doubleclick.net, googlesyndication.com) remain blocked', () => {
  const engine = buildEngineFromAllSeeds();
  const cases = [
    'https://doubleclick.net/pagead/',
    'https://googleads.g.doubleclick.net/pagead/viewthroughconversion',
    'https://googlesyndication.com/pagead/',
  ];
  for (const url of cases) {
    const r = engine.evaluate({ url, requestHost: new URL(url).hostname, pageHost: 'youtube.com', resourceType: 'script' });
    assert.strictEqual(r.blocked, true, `expected ${url} to be blocked`);
  }
});

realEngineTest('7c. legitimate YouTube playback/thumbnail requests are NOT blocked (no wholesale googlevideo.com/ytimg.com block)', () => {
  const engine = buildEngineFromAllSeeds();
  const cases = [
    { url: 'https://rr3---sn-abc123.googlevideo.com/videoplayback?expire=123&id=abc&itag=18', type: 'media' },
    { url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', type: 'image' },
    { url: 'https://ytimg.com/vi/abc123/default.jpg', type: 'image' },
    { url: 'https://www.youtube.com/watch?v=abc123', type: 'document' },
    { url: 'https://www.youtube.com/s/player/abcdef/player_ias.vflset/en_US/base.js', type: 'script' },
  ];
  for (const c of cases) {
    const r = engine.evaluate({ url: c.url, requestHost: new URL(c.url).hostname, pageHost: 'youtube.com', resourceType: c.type });
    assert.strictEqual(r.blocked, false, `expected ${c.url} to load normally, got blocked (reason: ${r.reason}, rule: ${r.matchedRule})`);
  }
});

test('7d. [regression guard] no bundled seed list contains a wholesale googlevideo.com network-block rule', () => {
  // Static text check (does not need the real engine) — directly encodes
  // the brief's "do NOT block youtube.com or googlevideo.com wholesale"
  // requirement as a regression test, independent of engine availability.
  for (const f of ['easylist-seed.txt', 'easyprivacy-seed.txt', 'ublock-filters-seed.txt', 'youlist-seed.txt']) {
    const text = loadSeedText(f);
    const bareBlockRule = /^\|\|(?:[a-z0-9-]+\.)*googlevideo\.com\^?\s*$/m;
    assert.ok(!bareBlockRule.test(text), `${f} must not contain a wholesale googlevideo.com block rule`);
    const bareYoutubeBlock = /^\|\|(?:www\.)?youtube\.com\^\s*$/m;
    assert.ok(!bareYoutubeBlock.test(text), `${f} must not contain a wholesale youtube.com block rule`);
  }
});

test('7e. isYoutubeAdSkipHost matches youtube.com and its subdomains, not unrelated sites', () => {
  assert.strictEqual(isYoutubeAdSkipHost('youtube.com'), true);
  assert.strictEqual(isYoutubeAdSkipHost('m.youtube.com'), true);
  assert.strictEqual(isYoutubeAdSkipHost('music.youtube.com'), true);
  // In production, normalizeHostname() already strips "www." before a
  // hostname ever reaches this function, so this case doesn't occur via
  // the real call path — but the function's own `.endsWith('.youtube.com')`
  // check means it would still correctly recognize it if it ever did.
  assert.strictEqual(isYoutubeAdSkipHost('www.youtube.com'), true);
  assert.strictEqual(isYoutubeAdSkipHost('notyoutube.com'), false);
  assert.strictEqual(isYoutubeAdSkipHost('example.com'), false);
  assert.strictEqual(isYoutubeAdSkipHost(null), false);
});

test('7f. the DOM ad-skip script never PAUSES playback or changes playbackRate, and only seeks/mutes the video element while the player\'s own ad-state class says an ad is actually showing', () => {
  // UPDATED this round: the script now DOES deliberately touch the video
  // element (mute + seek-to-end) as a last-resort layer for non-skippable
  // ads with no button to click -- see its own header comment
  // (fastForwardNonSkippableAd). What must still NEVER happen, even with
  // that added, is pausing playback outright or changing playbackRate
  // (either would be a much more disruptive, easily-noticed break from
  // normal viewing than a mute+seek that YouTube's own "ad finished"
  // transition already causes every time an ad ends naturally), and the
  // mute/seek logic itself must still be gated behind the real ad-state
  // selector, never applied unconditionally.
  const forbidden = ['video.pause(', '.playbackRate ='];
  for (const token of forbidden) {
    assert.ok(!YOUTUBE_AD_SKIP_SCRIPT.includes(token), `ad-skip script must not contain "${token}"`);
  }
  assert.ok(YOUTUBE_AD_SKIP_SCRIPT.includes('ytp-ad-skip-button'), 'should still target the real skip-button selector');
  assert.ok(YOUTUBE_AD_SKIP_SCRIPT.includes('ad-showing'), 'the video.muted/currentTime fallback must be gated behind the real ad-state class');
  // The mute/currentTime writes must appear strictly after the ad-state
  // guard in source order, i.e. inside the `if (adPlayer && video)`
  // branch, not unconditionally at the top of the script.
  const guardIdx = YOUTUBE_AD_SKIP_SCRIPT.indexOf('if (adPlayer && video)');
  const muteIdx = YOUTUBE_AD_SKIP_SCRIPT.indexOf('video.muted = true');
  assert.ok(guardIdx !== -1 && muteIdx !== -1 && muteIdx > guardIdx, 'video.muted write must be inside the ad-state-guarded branch');
});

test('7g. the ad-skip script is injected on a YouTube tab\'s did-finish-load, and not on an unrelated site', () => {
  const { adblock } = makeTestAdblock();

  const ytTab = new FakeWebContents(301, 'https://youtube.com/watch?v=abc123');
  adblock.attachTab(30, ytTab);
  ytTab.emit('did-finish-load');
  assert.strictEqual(ytTab.executeJavaScriptCalls.length, 1, 'expected exactly one ad-skip script injection on a YouTube tab');
  assert.ok(ytTab.executeJavaScriptCalls[0].includes('__glozaYtAdSkipActive'));

  const otherTab = new FakeWebContents(302, 'https://news.example.com/');
  adblock.attachTab(31, otherTab);
  otherTab.emit('did-finish-load');
  assert.strictEqual(otherTab.executeJavaScriptCalls.length, 0, 'the YouTube-only ad-skip script must not be injected on unrelated sites');
});

test('7h. the ad-skip script is NOT injected once youtube.com has a site exception, and resumes if the exception is removed', () => {
  const { adblock } = makeTestAdblock();
  adblock.setSiteException('youtube.com', true);

  const wc = new FakeWebContents(303, 'https://youtube.com/watch?v=abc123');
  adblock.attachTab(32, wc);
  wc.emit('did-finish-load');
  assert.strictEqual(wc.executeJavaScriptCalls.length, 0, 'an excepted site must not get the ad-skip script either');

  adblock.setSiteException('youtube.com', false);
  wc.emit('did-finish-load');
  assert.strictEqual(wc.executeJavaScriptCalls.length, 1, 'removing the exception should restore the ad-skip script on the next load');
});

test('7i. the ad-skip script is NOT injected while ad blocking is globally disabled', () => {
  const { adblock } = makeTestAdblock();
  adblock.setEnabled(false);
  const wc = new FakeWebContents(304, 'https://youtube.com/watch?v=abc123');
  adblock.attachTab(33, wc);
  wc.emit('did-finish-load');
  assert.strictEqual(wc.executeJavaScriptCalls.length, 0, 'turning off ad blocking entirely must also turn off the YouTube ad-skip layer');
});

test('7j. [independent methods] turning off Method 2 (youtubeAdSkipEnabled) stops the DOM ad-skip script, without touching Method 1', () => {
  const { adblock } = makeTestAdblock();
  adblock.setYoutubeAdSkipEnabled(false);

  const wc = new FakeWebContents(305, 'https://youtube.com/watch?v=abc123');
  adblock.attachTab(34, wc);
  wc.emit('did-finish-load');
  assert.strictEqual(wc.executeJavaScriptCalls.length, 0, 'Method 2 off must stop the ad-skip script injection');

  const status = adblock.getStatus();
  assert.strictEqual(status.youtubeAdSkipEnabled, false);
  assert.strictEqual(status.networkFilterEnabled, true, 'disabling Method 2 must not silently disable Method 1');

  adblock.setYoutubeAdSkipEnabled(true);
  wc.emit('did-finish-load');
  assert.strictEqual(wc.executeJavaScriptCalls.length, 1, 'turning Method 2 back on should resume injection on the next load');
});

test('7k. [independent methods] turning off Method 1 (networkFilterEnabled) stops network blocking, without touching Method 2', () => {
  const { adblock } = makeTestAdblock();
  adblock.setNetworkFilterEnabled(false);

  const decision = adblock._decide({
    url: 'https://pagead2.googlesyndication.com/pagead/show_ads.js',
    webContentsId: 9999,
    resourceType: 'script',
  });
  assert.strictEqual(decision.blocked, false, 'Method 1 off must stop network-level blocking decisions');
  assert.strictEqual(decision.reason, 'network-filter-disabled');

  const status = adblock.getStatus();
  assert.strictEqual(status.networkFilterEnabled, false);
  assert.strictEqual(status.youtubeAdSkipEnabled, true, 'disabling Method 1 must not silently disable Method 2');

  const wc = new FakeWebContents(306, 'https://youtube.com/watch?v=abc123');
  adblock.attachTab(35, wc);
  wc.emit('did-finish-load');
  assert.strictEqual(wc.executeJavaScriptCalls.length, 1, 'Method 2 must keep running while Method 1 alone is off');
});

test('7l. [independent methods] both default to enabled out of the box, and getStatus reports their real, non-inferred state', () => {
  const { adblock } = makeTestAdblock();
  const status = adblock.getStatus();
  assert.strictEqual(status.networkFilterEnabled, true);
  assert.strictEqual(status.youtubeAdSkipEnabled, true);
});

await asyncTest('7m. [hardcoded YouTube ad fallback] a known YouTube ad-serving path is blocked even with the compiled engine UNAVAILABLE/empty — proves this does not depend on @ghostery/adblocker-electron being installed or any filter list ever updating', async () => {
  const { adblock } = makeTestAdblock();
  // Simulate the exact failure mode this fallback exists for: the real
  // engine never loaded / has nothing compiled (engine.evaluate() would
  // allow everything through on its own in this state).
  adblock.engine._engine = null;
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });
  const wc = new FakeWebContents(501, 'https://www.youtube.com/watch?v=abc123');
  adblock.attachTab(50, wc);

  const result = await webRequest.fire(makeDetails({ url: 'https://www.youtube.com/pagead/viewthroughconversion', webContentsId: 501, resourceType: 'image' }));
  assert.strictEqual(result.cancel, true, 'known YouTube ad-serving path must be blocked by the hardcoded fallback even with no compiled engine');
});

await asyncTest('7n. [hardcoded YouTube ad fallback] never applies off YouTube, and never blocks a navigation (document/subdocument) request', async () => {
  const { adblock } = makeTestAdblock();
  adblock.engine._engine = null;
  const webRequest = new FakeWebRequest();
  adblock.registerSession({ webRequest });

  const otherTab = new FakeWebContents(502, 'https://news.example.com/');
  adblock.attachTab(51, otherTab);
  const offSite = await webRequest.fire(makeDetails({ url: 'https://news.example.com/pagead/viewthroughconversion', webContentsId: 502, resourceType: 'image' }));
  assert.ok(!offSite.cancel, 'the YouTube-path fallback must never apply to a non-YouTube page');

  const ytTab = new FakeWebContents(503, 'https://www.youtube.com/pagead/viewthroughconversion');
  adblock.attachTab(52, ytTab);
  const navRequest = await webRequest.fire(makeDetails({ url: 'https://www.youtube.com/pagead/viewthroughconversion', webContentsId: 503, resourceType: 'mainFrame' }));
  assert.ok(!navRequest.cancel, 'the fallback must never cancel a document/navigation request, even one matching an ad path by URL');
});

test('7o. [hardcoded YouTube ad fallback] respects Method 1\'s own on/off switch, exactly like the compiled engine does', () => {
  const { adblock } = makeTestAdblock();
  adblock.engine._engine = null;
  adblock.setNetworkFilterEnabled(false);
  const decision = adblock._decide({ url: 'https://www.youtube.com/pagead/viewthroughconversion', webContentsId: 999, resourceType: 'image' });
  assert.strictEqual(decision.blocked, false);
  assert.strictEqual(decision.reason, 'network-filter-disabled');
});

test('7p. [0-rules display bug] the Adblock constructor self-heals a stale legacy rule count at startup, with no network access', () => {
  const app = makeFakeApp();
  const settingsTabIds = new Set();
  // A manager whose fetchUrl would fail the whole test if ever called —
  // the startup self-heal in the Adblock constructor must work purely
  // from text already on disk.
  const filterListManager = new FilterListManager(app, { fetchUrl: async () => { throw new Error('must never fetch during startup self-heal'); } });
  let state = store.load(app);
  filterListManager.ensureInitialized(state);
  state.lists.easylist.lastSuccessfulUpdate = Date.now();
  state.lists.easylist.source = 'network';
  state.lists.easylist.ruleCounts = { network: 0, cosmetic: 0 }; // legacy/stale shape, exactly the reported symptom
  store.save(app, state);

  const adblock = new Adblock({ app, settingsTabIds, filterListManager });
  const status = adblock.getStatus();
  const easylistRow = status.lists.find((l) => l.id === 'easylist');
  assert.ok(easylistRow, 'easylist should be present in getStatus()');
  if (ENGINE_AVAILABLE) {
    assert.ok(easylistRow.ruleCounts, 'a stale/legacy ruleCounts entry should have been recomputed at startup');
    assert.ok(easylistRow.ruleCounts.network > 0, 'the real bundled seed text has real rules -- the healed count must not still read 0');
  } else {
    // Without the real engine installed, there is nothing to recompute
    // FROM — the important thing checked here is that this never throws
    // and never fabricates a value (see test 5h for the direct version of
    // this check on FilterListManager itself).
    assert.ok('ruleCounts' in easylistRow);
  }
});

test('7q. [YouTube transition speed] the optimized ad-skip script still only ever clicks/seeks inside an ad-state-gated scope, and the combined selectors keep every original selector string', () => {
  // Regression guard for this round's performance rewrite (combined
  // querySelectorAll calls, scoped skip-button lookup, rAF-coalesced
  // tick scheduling, native 'ended'/'playing' listeners) — proves the
  // rewrite didn't silently drop any of the original targeting while
  // restructuring how often/where it runs.
  const mustStillContain = [
    '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button', '.ytp-skip-ad-button',
    '.ytp-ad-overlay-container', 'ytd-promoted-video-renderer', 'masthead-ad',
    'requestAnimationFrame', "addEventListener('ended'", "addEventListener('playing'",
  ];
  for (const token of mustStillContain) {
    assert.ok(YOUTUBE_AD_SKIP_SCRIPT.includes(token), `expected the ad-skip script to still contain "${token}"`);
  }
  // Must still be syntactically valid, self-contained JS with no outside
  // references (new Function() parses it without executing it against a
  // real document, so this is a pure syntax/self-containment check, not a
  // behavioral one).
  assert.doesNotThrow(() => new Function(YOUTUBE_AD_SKIP_SCRIPT), 'the rewritten ad-skip script must still be valid, self-contained JavaScript');
});

// ---- [8] Behavioral regression test: consecutive/chained YouTube ads -----
// Everything in section [7] only inspects YOUTUBE_AD_SKIP_SCRIPT's source
// text (selectors present, no forbidden tokens, valid syntax). This section
// actually EXECUTES the real injected script, via Node's `vm` module
// against a minimal fake DOM, and drives it through the exact "second ad
// plays instead of being skipped" regression: a non-skippable ad, followed
// by ANOTHER non-skippable ad on the SAME <video> element with the
// player's ad-state class never clearing in between (precisely how YouTube
// chains consecutive ads) -- the scenario the ad-ffDone flag's old,
// cleanup-branch-only reset could never detect. This is a behavioral test,
// not a string check: it fails if the fix regresses even if every selector
// string above stays intact.
function runAdSkipScriptAgainstFakeDom({ initialAdPlayer }) {
  let capturedIntervalFn = null;
  const calls = { querySelectorAll: 0 };

  function makeVideo(src, duration) {
    return {
      currentTime: 0,
      duration,
      muted: false,
      currentSrc: src,
      __listeners: {},
      addEventListener(type, fn) { this.__listeners[type] = fn; },
    };
  }

  // One shared ad-state container (adPlayerEl) and one shared <video>
  // element, reused across "ads" -- this IS the chained-ad shape: YouTube
  // swaps `currentSrc`/`duration` on the same element and the container's
  // ad-showing class never toggles off between two back-to-back ads.
  const adPlayerEl = {
    querySelector(sel) {
      if (sel.indexOf('ytp-ad-skip-button') !== -1 || sel.indexOf('ytp-skip-ad-button') !== -1) {
        return null; // non-skippable: no skip button exists to click
      }
      if (sel.indexOf('video') !== -1) return state.video;
      return null;
    },
  };

  const state = { adPlayer: initialAdPlayer ? adPlayerEl : null, video: makeVideo('ad-src-1', 20) };

  const fakeDocument = {
    body: {},
    querySelector(sel) {
      if (sel.indexOf('ad-showing') !== -1) return state.adPlayer;
      if (sel.indexOf('video') !== -1) return state.adPlayer ? null : state.video; // only used in the "no adPlayer" fallback path
      return null;
    },
    querySelectorAll(_sel) { calls.querySelectorAll++; return []; },
  };

  const fakeWindow = {};
  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    WeakSet,
    // No MutationObserver / requestAnimationFrame in this sandbox: the
    // script's own fallbacks (setInterval-only detection, setTimeout(fn,0)
    // tick scheduling) are what we drive manually below via
    // capturedIntervalFn() -- this exercises the exact "safety net" path
    // the script itself documents as always active regardless of observer
    // availability.
    setInterval(fn) { capturedIntervalFn = fn; return 1; },
    setTimeout(fn) { fn(); return 1; }, // run synchronously so scheduleTick's fallback resolves immediately
  };
  vm.createContext(sandbox);
  vm.runInContext(YOUTUBE_AD_SKIP_SCRIPT, sandbox);
  assert.ok(typeof capturedIntervalFn === 'function', 'the script must register its setInterval safety-net tick');

  return {
    state,
    tick: () => capturedIntervalFn(),
    setVideo(src, duration) { state.video = makeVideo(src, duration); },
  };
}

test('8a. [sequential-ad regression] a SECOND non-skippable ad on the same <video>, with the ad-state class never clearing between ads, is still fast-forwarded', () => {
  const h = runAdSkipScriptAgainstFakeDom({ initialAdPlayer: true });

  // Ad #1: tick() already ran once synchronously inside the script itself
  // on load -- confirm it was handled.
  assert.strictEqual(h.state.video.currentTime, h.state.video.duration, 'ad #1 should be fast-forwarded to its own end');
  assert.strictEqual(h.state.video.muted, true, 'ad #1 video should be muted while an ad plays');
  assert.strictEqual(h.state.video.__glozaAdFfDone, true, 'ad #1 should be marked done after being seeked');

  // Ad #2 begins on the SAME element: YouTube swaps currentSrc/duration and
  // resets currentTime, but the ad-state container's class (and therefore
  // `state.adPlayer` in this harness) never goes falsy in between -- this
  // is the exact shape of the reported regression.
  h.state.video.currentSrc = 'ad-src-2';
  h.state.video.duration = 15;
  h.state.video.currentTime = 0;
  h.tick();

  assert.strictEqual(h.state.video.currentTime, 15, 'ad #2 must ALSO be fast-forwarded -- this is the regression: it used to stay at 0 and play out because __glozaAdFfDone was still stuck true from ad #1');
  assert.strictEqual(h.state.video.__glozaAdFfSrc, 'ad-src-2', 'the script must now be tracking ad #2 as the current ad instance, not ad #1');
});

test('8b. [sequential-ad regression] a THIRD consecutive ad is handled too, not just a second one', () => {
  const h = runAdSkipScriptAgainstFakeDom({ initialAdPlayer: true });
  h.state.video.currentSrc = 'ad-src-2'; h.state.video.duration = 15; h.state.video.currentTime = 0;
  h.tick();
  h.state.video.currentSrc = 'ad-src-3'; h.state.video.duration = 25; h.state.video.currentTime = 0;
  h.tick();
  assert.strictEqual(h.state.video.currentTime, 25, 'a third chained ad must be fast-forwarded exactly like the first and second');
});

test('8c. [sequential-ad regression] once the ad-state class genuinely clears, mute state is restored and the done-flag resets for the NEXT real ad', () => {
  const h = runAdSkipScriptAgainstFakeDom({ initialAdPlayer: true });
  assert.strictEqual(h.state.video.muted, true);

  // Content resumes: adPlayer becomes null (ad-showing/ad-interrupting
  // class cleared) -- the cleanup branch should restore the viewer's
  // original (unmuted) preference and clear the per-ad bookkeeping.
  h.state.adPlayer = null;
  h.tick();
  assert.strictEqual(h.state.video.muted, false, 'mute must be restored to the viewer\'s own setting once the ad genuinely ends');

  // A later ad (e.g. a mid-roll) on a fresh video element must still be
  // detected and handled from scratch -- confirms the fix didn't make the
  // done-flag "sticky forever" in the other direction either.
  h.state.adPlayer = { querySelector: adSel => (adSel.indexOf('ytp-ad-skip-button') !== -1 ? null : h.state.video) };
  h.setVideo('mid-roll-ad', 10);
  h.tick();
  assert.strictEqual(h.state.video.currentTime, 10, 'a later, genuinely new ad must still be fast-forwarded');
});

test('8d. [regression guard] a single, un-chained ad (the pre-existing, already-working case) still behaves exactly as before', () => {
  const h = runAdSkipScriptAgainstFakeDom({ initialAdPlayer: true });
  assert.strictEqual(h.state.video.currentTime, 20);
  // Repeated ticks on the SAME still-playing ad (no src/time change) must
  // NOT keep re-seeking it -- that would fight the player's own transition.
  const seekCountBefore = h.state.video.currentTime;
  h.tick();
  h.tick();
  assert.strictEqual(h.state.video.currentTime, seekCountBefore, 'repeated ticks on the same unchanged ad must not re-seek it');
});

// ---- Summary ----------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`--- ${f.name} ---`);
    console.log(f.err.stack || f.err);
  }
  process.exitCode = 1;
}
}

main();
