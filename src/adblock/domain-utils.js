// ============================================================================
// adblock/domain-utils.js — hostname/URL helpers shared by the Electron
// integration layer (tab tracking, site exceptions). No Electron APIs here
// on purpose: everything in this file is pure and unit-testable without a
// running app.
//
// REPLACED (full-engine-backend-replacement task): this file used to also
// export registrableDomain()/hostMatches()/isThirdParty() — a hand-rolled,
// hand-maintained eTLD+1/public-suffix approximation (a ~25-entry
// TWO_LABEL_SUFFIXES table) that the old homegrown engine.js used for
// first/third-party classification and `domain=` rule-option matching.
// That responsibility now belongs to @ghostery/adblocker-electron itself
// (via its tldts-based Request.fromRawDetails — see engine.js), which is
// an actively maintained Public Suffix List implementation rather than a
// small hand-picked subset of one. What's left here is only the generic
// "is this URL even filterable / what's its normalized hostname" plumbing
// adblock/index.js's tab-tracking and site-exception code uses — neither
// of those is part of the blocking engine itself.
// ============================================================================

'use strict';

// Schemes the ad-blocking engine is allowed to evaluate. Everything else
// (file:, data:, blob:, about:, devtools:, chrome:, filesystem:, etc.) is
// passed through untouched — per the integration note left in main.js and
// the Part 1B spec ("internal browser pages safely"), we never want a
// malformed or internal-scheme URL to be run through the filter engine.
const FILTERABLE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

function isFilterableUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return FILTERABLE_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

// Returns a lowercase hostname with no port, no trailing dot, no userinfo,
// and no leading "www." — or null if the URL can't be parsed / has no host
// (internal pages, data: URLs, malformed input, etc).
function normalizeHostname(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  let u;
  try {
    // Allow bare hostnames too (used by the exceptions UI in Part 2), by
    // retrying with a scheme if the first parse fails.
    u = new URL(rawUrl);
  } catch {
    try {
      u = new URL(`http://${rawUrl}`);
    } catch {
      return null;
    }
  }
  let host = (u.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4);
  return host || null;
}

module.exports = {
  FILTERABLE_SCHEMES,
  isFilterableUrl,
  normalizeHostname,
};
