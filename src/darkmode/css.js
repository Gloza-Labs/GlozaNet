// ============================================================================
// darkmode/css.js — builds the stylesheet used to force a dark appearance on
// a page that doesn't provide its own dark theme.
//
// Why not just `filter: invert(1)` on <html>? The brief explicitly rules
// that out, and for good reason: a blind invert also inverts every photo,
// video frame, icon sprite and canvas drawing, turning faces blue and
// photos into film negatives. The standard fix (the same technique real
// "smart invert" dark-mode extensions use) is to invert the WHOLE page
// once, then invert AGAIN everything that's actual image/video/canvas
// content — two inversions cancel out, so that content ends up back at its
// original colors while the surrounding text/background/chrome of the page
// (which the first invert turned light-on-dark) stays inverted.
//
// This is deliberately a page-level CSS injection (wc.insertCSS), not a
// Chromium-internal renderer flag: investigating this sandbox's installed
// Electron/Chromium build found no network access to pull in or verify a
// `--force-dark-mode`/`blink-settings=forceDarkModeEnabled` style internal
// flag's behavior against this exact Electron version without being able to
// actually launch it (same constraint every other handoff in this project
// has hit — see HANDOFF-part-1b.md section 7). A CSS-based approach is also
// strictly more controllable from here: it's per-tab (so a site exception
// can turn it off for exactly one page without a global Chromium flag
// affecting every tab, including Gloza's own internal pages), it can be
// inserted/removed cleanly via insertCSS/removeInsertedCSS without a page
// reload, and its exact behavior doesn't depend on a Chromium version this
// sandbox never actually got to run.
// ============================================================================

'use strict';

// A marker comment so a later run can tell "did I already insert this" (not
// load-bearing for correctness — insertCSS keys are tracked in JS — but
// useful if this stylesheet is ever inspected via devtools).
const MARKER = '/* gloza-force-dark */';

// Selectors that hold real visual *content* (photos, video frames, drawn
// canvases, icon images) rather than page chrome/text. These get a second,
// counter-acting invert so they land back at their original colors instead
// of being shown as a negative. Deliberately broad (errs toward "don't
// invert it twice if unsure" being the safer failure for a logo, but "do
// counter-invert" being the safer failure for a photo) — this is a known,
// documented best-effort heuristic, not a perfect content classifier; see
// HANDOFF-part-2.md's limitations section.
const CONTENT_SELECTORS = [
  'img', 'video', 'canvas', 'svg', 'picture',
  'embed', 'object[type^="image"]',
  'iframe',
  '[style*="background-image"]',
  'input[type="image"]',
  '[data-gloza-image-bg]',
];

function buildForceDarkCss() {
  return `${MARKER}
html {
  background: #1b1d1e !important;
}
html, body {
  background-color: #1b1d1e !important;
}
html {
  filter: invert(1) hue-rotate(180deg) !important;
}
${CONTENT_SELECTORS.join(',\n')} {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* Form controls keep native OS/Chromium chrome (checkboxes, radios, range
   sliders, file pickers) which the blanket invert above would also distort
   twice over with its own filter; un-invert them to their forced-dark-aware
   native rendering instead of fighting Chromium's own theming for them. */
input, select, textarea, button {
  color-scheme: dark;
}
`;
}

module.exports = { buildForceDarkCss, CONTENT_SELECTORS, MARKER };
