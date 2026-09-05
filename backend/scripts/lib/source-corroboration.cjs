"use strict";
/**
 * source-corroboration.cjs -- the CJS door onto the ONE corroboration predicate.
 *
 * CF-HOBBYMONITOR-IS-STRICT-ONLY-WHERE-A-SECOND-SOURCE-AGREES (Drew,
 * 2026-09-05, ruling B). The rule and all of its reasoning live in
 * `src/services/catalog/sourceCorroboration.ts`; this file adds NOTHING to it
 * and deliberately re-implements NOTHING of it.
 *
 * WHY A BRIDGE AND NOT A COPY. `catalogAuthority.service.ts`'s header records
 * what a second copy of one predicate costs: five call sites answered "does
 * this row count as evidence?" five slightly different ways, and one of the
 * differences flipped 51 card-number prefixes from "repair" to "blocked". The
 * scripts are CJS and the service is ESM-TypeScript, and the seam between them
 * is exactly where a copy would be made and then drift. So the scripts require
 * the COMPILED build, the same way rekey-product-setkey requires
 * `dist/services/catalog/catalogRowOps.service.js`.
 *
 * REQUIRES dist/. A script that loads this needs `npm run build` to have run --
 * the same precondition the other row-op consumers carry, and the same failure
 * mode (a clear MODULE_NOT_FOUND naming the missing build) rather than a silent
 * fallback to a stale local copy of the rule.
 */
const path = require("path");

const dist = path.resolve(__dirname, "..", "..", "dist", "services", "catalog", "sourceCorroboration.js");

let mod;
try {
  mod = require(dist);
} catch (e) {
  const err = new Error(
    `source-corroboration.cjs: could not load ${dist} -- run \`npm run build\` in backend/.\n` +
    `  The corroboration rule has exactly one definition (src/services/catalog/sourceCorroboration.ts)\n` +
    `  and this file refuses to keep a second copy of it. Original: ${String((e && e.message) || e).slice(0, 200)}`,
  );
  err.code = "CORROBORATION_BUILD_MISSING";
  throw err;
}

module.exports = {
  CORROBORATION_REQUIRED_SOURCES: mod.CORROBORATION_REQUIRED_SOURCES,
  normalizeCatalogSource: mod.normalizeCatalogSource,
  requiresCorroboration: mod.requiresCorroboration,
  identityCellOf: mod.identityCellOf,
  isCorroboratingSource: mod.isCorroboratingSource,
  corroborationOf: mod.corroborationOf,
  isChecklistBackedWithCorroboration: mod.isChecklistBackedWithCorroboration,
};
