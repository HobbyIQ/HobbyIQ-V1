/**
 * STAMP-FIX BATCH 0926 — defect 5: `identity.setKey` skips the R75 redirect
 * that `slug` already applies.
 *
 * ROOT CAUSE (C:/tmp/mega_ident_1430/RESULT.md, 2026-09-26 investigation).
 * `rematch-derive-identity.cjs`'s `deriveIdentity` builds `identity.setKey`
 * from `spellForEra(normalizeSetKey(setKeyRaw), cardYear)` alone — it never
 * calls `resolveSetKeyForSlug`, the one function carrying R75's 2026 Bowman
 * Mega Box split (`BOWMAN_MEGA_BOX_SPLIT_FROM_YEAR`, hobbyIqCardId.service.ts
 * ~2898-2901: a bare "Bowman Mega Box" title with no "chrome", year >= 2026,
 * resolves to the distinct `bowman-mega` key). `slug`, a few lines down, IS
 * computed via `deps.computeHobbyIqCardId`, which calls `resolveSetKeyForSlug`
 * internally and DOES redirect. One function disagreeing with itself:
 *
 *   "2026 Bowman Mega Box Baseball #52 Shohei Ohtani"
 *     identity.setKey = bowman-chrome-mega-box   <- WRONG (pre-fix)
 *     slug            = hiq:baseball:2026:bowman-mega:52:...   <- always right
 *
 * `identity.setKey` feeds the census/classifier cell and the acquisition
 * worklist generator, so the bug manifests as a phantom "unbacked
 * bowman-chrome-mega-box" population that is actually backed under
 * `bowman-mega` — a reporting artifact of this one seam, per the
 * investigation's section 3.
 *
 * MUTATION CHECK (stated in the fix commit): reverting the redirect call in
 * `rematch-derive-identity.cjs` (restoring the un-redirected
 * `spellForEra(normalizeSetKey(setKeyRaw), cardYear)` as the `setKey` used
 * for `identity`) makes this test's first two cases fail — `identity.setKey`
 * would read `bowman-chrome-mega-box` for the bare Mega Box title and diverge
 * from `slug` again.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  normalizeSetKey,
  computeHobbyIqCardId,
  applySiblingChecklistOverride,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  parseListingIdentity,
  inferSportFromTitle,
  isMultiCardLot,
  isCardNumberAutoSubset,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { extractYearFromTitle } from "../src/services/portfolioiq/slugRederivation.service.js";
import { spellForEra } from "../src/services/catalog/productSetKeys.js";
import { guardSlugInputs, normalizeSportStrict } from "../src/services/portfolioiq/slugGuard.service.js";
import { ingestGradeFromTitle } from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

const require_ = createRequire(import.meta.url);
const { deriveIdentity } = require_("../scripts/lib/rematch-derive-identity.cjs");

function baseDeps() {
  return {
    parseListingIdentity,
    ingestGradeFromTitle,
    inferSportFromTitle,
    normalizeSportStrict,
    extractYearFromTitle,
    inferSetKeyFromTitle: (title: string, cardNumber: string) => {
      // Minimal stand-in mirroring the real export's public contract closely
      // enough for this fixture: real inferSetKeyFromTitle is exercised by
      // parseTitleIdentity.test.ts already, so this test only needs the
      // real title -> product-NAME strings it already returns for these two
      // titles, taken verbatim from parseTitleIdentity.service.ts's own
      // Bowman Mega Box ladder (lines ~4308-4309).
      const t = title.toLowerCase();
      if (/bowman\s+chrome\s+mega\s*box/.test(t)) return "Bowman Chrome Mega Box";
      if (/bowman\s+mega\s*box/.test(t)) return "Bowman Mega Box";
      return "Bowman";
    },
    normalizeSetKey,
    computeHobbyIqCardId,
    applySiblingChecklistOverride,
    spellForEra,
    guardSlugInputs,
    isMultiCardLot,
    isCardNumberAutoSubset,
    resolveSetKeyForSlug,
  };
}

describe("deriveIdentity — identity.setKey carries the R75 redirect (defect 5)", () => {
  it('"2026 Bowman Mega Box Baseball #52 Shohei Ohtani" -> identity.setKey and slug BOTH say bowman-mega', () => {
    const title = "2026 Bowman Mega Box Baseball #52 Shohei Ohtani";
    const der = deriveIdentity({ title, sport: null, cardYear: null, playerName: null }, baseDeps());
    expect(der.ok).toBe(true);
    expect(der.identity.setKey).toBe("bowman-mega");
    expect(der.slug).toContain(":bowman-mega:");
    expect(der.slug.split(":")[3]).toBe(der.identity.setKey);
  });

  it('"2026 Bowman Mega Box #BMA-KW Base" -> identity.setKey and slug BOTH say bowman-mega', () => {
    const title = "2026 Bowman Mega Box #BMA-KW Base";
    // Title carries no explicit sport word, so the row supplies it — same as
    // a real sold_comps row (sport is stamped on ingest, not re-derived from
    // a terse eBay title every time).
    const der = deriveIdentity({ title, sport: "baseball", cardYear: null, playerName: null }, baseDeps());
    expect(der.ok).toBe(true);
    expect(der.identity.setKey).toBe("bowman-mega");
    expect(der.slug.split(":")[3]).toBe(der.identity.setKey);
  });

  it('"2026 Bowman Chrome Mega Box #52 JJ Wetherholt" -> stays bowman-chrome-mega-box on BOTH (unchanged, title says "chrome")', () => {
    const title = "2026 Bowman Chrome Mega Box #52 JJ Wetherholt";
    const der = deriveIdentity({ title, sport: "baseball", cardYear: null, playerName: null }, baseDeps());
    expect(der.ok).toBe(true);
    expect(der.identity.setKey).toBe("bowman-chrome-mega-box");
    expect(der.slug.split(":")[3]).toBe(der.identity.setKey);
  });

  it("an absent resolveSetKeyForSlug dep leaves behavior exactly as before (ONLY-IMPROVE, additive)", () => {
    const { resolveSetKeyForSlug: _drop, ...depsWithoutRedirect } = baseDeps();
    const title = "2026 Bowman Mega Box Baseball #52 Shohei Ohtani";
    const der = deriveIdentity({ title, sport: null, cardYear: null, playerName: null }, depsWithoutRedirect);
    expect(der.ok).toBe(true);
    // Without the redirect dep, identity.setKey falls back to the
    // un-redirected spelling — documenting today's pre-fix behavior for a
    // caller that has not wired the new dep in, so this is additive, not a
    // breaking change to the function's contract.
    expect(der.identity.setKey).toBe("bowman-chrome-mega-box");
  });
});
