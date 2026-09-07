"use strict";
/**
 * patch-sold-comp-fields.cjs -- the CJS door onto the ONE sold_comps field
 * patcher.
 *
 * CF-A-MUTATOR-PATCHES-FIELDS-NEVER-THE-WHOLE-DOC (Drew, 2026-09-07, #1941
 * follow-up). The rule and all of its reasoning live in
 * `src/services/portfolioiq/soldCompRowOps.service.ts`; this file adds NOTHING
 * to it and deliberately re-implements NOTHING of it.
 *
 * WHY A BRIDGE AND NOT A COPY. This is the seam where a copy would be made and
 * then drift -- the scripts are CJS and the service is ESM-TypeScript -- and
 * the cost of the drift is the exact defect the helper exists to close: a lane
 * with its own slightly-different write shape is a lane that can still upsert a
 * whole document. `source-corroboration.cjs` records the five-way drift a
 * second copy of one predicate already produced here once. So the scripts
 * require the COMPILED build, the same way rekey-product-setkey requires
 * `dist/services/catalog/catalogRowOps.service.js`.
 *
 * The sibling helper `relocate-sold-comp.cjs` moves a row to a new key. This
 * one changes FIELDS on a row that stays where it is. Between them a lane
 * never needs `items.upsert` on an existing sold_comps row at all -- which is
 * what `mutatorsPatchFieldsNeverWholeDoc` asserts.
 *
 * REQUIRES dist/. A script that loads this needs `npm run build` to have run --
 * the same precondition the other row-op consumers carry, and the same failure
 * mode (a clear MODULE_NOT_FOUND naming the missing build) rather than a silent
 * fallback to a stale local copy of the rule.
 */
const path = require("path");

const dist = path.resolve(
  __dirname, "..", "..", "dist", "services", "portfolioiq", "soldCompRowOps.service.js",
);

let mod;
try {
  mod = require(dist);
} catch (e) {
  const err = new Error(
    `patch-sold-comp-fields.cjs: could not load ${dist} -- run \`npm run build\` in backend/.\n` +
    `  The sold_comps field-patch rule has exactly one definition\n` +
    `  (src/services/portfolioiq/soldCompRowOps.service.ts) and this file refuses to keep a second copy of it.\n` +
    `  Original: ${String((e && e.message) || e).slice(0, 200)}`,
  );
  err.code = "SOLD_COMP_ROW_OPS_BUILD_MISSING";
  throw err;
}

module.exports = {
  patchSoldCompFields: mod.patchSoldCompFields,
};
