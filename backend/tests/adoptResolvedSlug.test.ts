// CF-CONFIDENCE-MUST-BE-HONOURED (Drew, 2026-08-14: "lets fix it").
//
// canonicalize() has always returned a confidence, and BOTH rebind sites
// ignored it — `if (resolved.found) slug = resolved.slug`. So a 0.55
// family-fallback guess rewrote a sale's identity exactly as authoritatively as
// a 0.98 exact match. That is worse than no score at all: its existence implies
// a check that was never performed.
//
// It also existed in two copies (recordSoldComp and persistVendorSalesToPool),
// which is why the same invariant needed fixing twice. One function now owns
// the decision.

import { describe, expect, it } from "vitest";
import {
  adoptResolvedSlug,
  MIN_REBIND_CONFIDENCE,
  type CatalogMatchResult,
} from "../src/services/catalog/catalogMatcher.service.js";

const COMPUTED = "hiq:baseball:2026:bowman-chrome-sapphire:bcp-69:speckle-refractor:no-auto";
const r = (over: Partial<CatalogMatchResult>): CatalogMatchResult => ({
  slug: COMPUTED, found: true, confidence: 0.98, matchedBy: "exact", ...over,
});

describe("adoptResolvedSlug", () => {
  it("keeps the computed slug when nothing matched", () => {
    const a = adoptResolvedSlug(COMPUTED, r({ found: false, matchedBy: "not-found", confidence: 0.3 }));
    expect(a.slug).toBe(COMPUTED);
    expect(a.rebound).toBe(false);
  });

  it("is a no-op when the resolved slug is the computed one", () => {
    expect(adoptResolvedSlug(COMPUTED, r({})).rebound).toBe(false);
  });

  it("adopts an exact match", () => {
    const other = "hiq:baseball:2026:bowman-chrome:bcp-69:speckle-refractor:no-auto";
    const a = adoptResolvedSlug(COMPUTED, r({ slug: other, confidence: 0.98, matchedBy: "exact" }));
    expect(a.rebound).toBe(true);
    expect(a.slug).toBe(other);
  });

  it("adopts fuzzy-parallel — it is parallel-verified since CF-PARALLEL-IS-IDENTITY", () => {
    // Post-fix, a fuzzy-parallel match can only differ in token ORDER, so the
    // card is the same card. 0.72 sits above the threshold deliberately.
    const other = "hiq:baseball:2026:bowman-chrome:bcp-69:speckle-refractor:no-auto";
    const a = adoptResolvedSlug(COMPUTED, r({ slug: other, confidence: 0.72, matchedBy: "fuzzy-parallel" }));
    expect(a.rebound).toBe(true);
  });

  it("REFUSES family-fallback — Sapphire is not Chrome", () => {
    // family-fallback changes the PRODUCT. bowman-chrome-sapphire and
    // bowman-chrome are different cards at different prices, so collapsing one
    // into the other corrupts both pools exactly like the parallel bug did.
    const parent = "hiq:baseball:2026:bowman-chrome:bcp-69:speckle-refractor:no-auto";
    const a = adoptResolvedSlug(COMPUTED, r({ slug: parent, confidence: 0.55, matchedBy: "family-fallback" }));
    expect(a.rebound).toBe(false);
    expect(a.slug).toBe(COMPUTED);
    expect(a.refusedReason).toContain("family-fallback");
  });

  it("reports WHY it refused, so the skip is visible in logs", () => {
    const a = adoptResolvedSlug(COMPUTED, r({ slug: "hiq:x:1:y:z:base:no-auto", confidence: 0.55, matchedBy: "family-fallback" }));
    expect(a.refusedReason).toContain("0.55");
    expect(a.refusedReason).toContain(String(MIN_REBIND_CONFIDENCE));
  });

  it("puts the threshold between family-fallback and fuzzy-parallel", () => {
    // Pins the intent: if someone retunes the confidences, this fails rather
    // than silently letting family-fallback back in.
    expect(MIN_REBIND_CONFIDENCE).toBeGreaterThan(0.55);
    expect(MIN_REBIND_CONFIDENCE).toBeLessThanOrEqual(0.72);
  });

  it("never drops the sale — a refusal still yields a usable slug", () => {
    // A refused rebind is not a dropped comp. The caller keeps its computed
    // slug and seeds a checklist request.
    const a = adoptResolvedSlug(COMPUTED, r({ slug: "hiq:other", confidence: 0.1, matchedBy: "family-fallback" }));
    expect(a.slug).toBeTruthy();
    expect(a.slug).toBe(COMPUTED);
  });
});

// CF-A-GRADE-IS-A-FIELD-NEVER-A-SLUG-SEGMENT (2026-09-05).
//
// card_catalog is grade-EXPLODED (one row per (card, grade), identity in
// `parentSlug`, grade in `gradeTier`); sold_comps is not. The matcher returns
// `best.id` — the catalog ROW's id — so when the only rows for a card were
// exploded graded ones, a grade landed in a sale's slug and split one card into
// a pool per grade.
//
// Measured 2026-09-05 over the whole 16,757,175-row pool: 4,681 rows, 2,633
// distinct cards, all exactly 8 segments, 4,672 tca-ebay, still minting.
// Sampled 25 against card_catalog: 24 were exact grade-explode rows carrying
// `parentSlug` + `gradeTier` (catalogBatch graded-identity-evidence-2026-08-26).
//
// The grade in the slug was the CATALOG ROW's, not the SALE's — of the 1,779
// affected rows carrying grade fields, only 218 agreed with their own slug.
describe("adoptResolvedSlug — a grade is never a slug segment", () => {
  const RAW = "hiq:baseball:2025:panini-phoenix:14:base:no-auto";

  // Real slugs observed in sold_comps on 2026-09-05.
  const CORPUS: Array<[string, string]> = [
    ["hiq:baseball:2025:panini-phoenix:14:base:no-auto:psa-10", RAW],
    ["hiq:basketball:1996:fleer:3:base:no-auto:bgs-9", "hiq:basketball:1996:fleer:3:base:no-auto"],
    ["hiq:baseball:2025:panini-donruss:302:base:no-auto:psa-10", "hiq:baseball:2025:panini-donruss:302:base:no-auto"],
    ["hiq:basketball:1991:skybox:137:base:no-auto:cgc-9", "hiq:basketball:1991:skybox:137:base:no-auto"],
    ["hiq:baseball:1995:skybox-premium:278:base:no-auto:bgs-9", "hiq:baseball:1995:skybox-premium:278:base:no-auto"],
    ["hiq:pokemon:2000:unknown:23:base:no-auto:cgc-10", "hiq:pokemon:2000:unknown:23:base:no-auto"],
    // The two-digit grade — a single-[0-9] regex silently missed every PSA 10
    // and BGS 10, the most valuable rows there are.
    ["hiq:football:2025:panini-score:14:base:no-auto:psa-8", "hiq:football:2025:panini-score:14:base:no-auto"],
    // The half grade, the top two seg8 tokens by volume, and BGS's sub-grade.
    ["hiq:baseball:2020:topps:1:base:no-auto:bgs-9-5", "hiq:baseball:2020:topps:1:base:no-auto"],
    ["hiq:baseball:2020:topps:1:base:no-auto:cgc-8-5", "hiq:baseball:2020:topps:1:base:no-auto"],
  ];

  it.each(CORPUS)("strips the grade from %s", (graded, raw) => {
    const a = adoptResolvedSlug("hiq:some:1:other:x:base:no-auto", r({ slug: graded, confidence: 0.98 }));
    expect(a.slug).toBe(raw);
    expect(a.rebound).toBe(true);
    expect(a.gradeStripped).toBeTruthy();
    // The invariant, stated positionally rather than by substring.
    expect(a.slug.split(":").length).toBe(7);
  });

  it("does NOT rebind when the parent equals the computed slug", () => {
    // The bug's most common shape: the sale already computed the right card,
    // and the only thing the catalog added was a grade. That is a no-op, not a
    // rebind onto a graded key.
    const a = adoptResolvedSlug(RAW, r({ slug: `${RAW}:psa-10`, confidence: 0.98 }));
    expect(a.slug).toBe(RAW);
    expect(a.rebound).toBe(false);
    expect(a.gradeStripped).toBe("psa-10");
  });

  it("PRESERVES a print run — num- is identity, not grade", () => {
    // A Gold /50 is a different CARD from a Refractor /499. Only a grade tier
    // is a pricing dimension.
    const withRun = "hiq:baseball:2024:bowman:9:gold:no-auto:num-50";
    const a = adoptResolvedSlug("hiq:some:1:other:x:base:no-auto", r({ slug: withRun, confidence: 0.98 }));
    expect(a.slug).toBe(withRun);
    expect(a.gradeStripped).toBeUndefined();
  });

  it("does NOT eat a card NUMBER that begins psa- — the recorded false positive", () => {
    // cardIdentityKey.service.ts records this exact trap: a positionally-blind
    // /:(psa|bgs|sgc|cgc)/ regex reported 221 rows, every one a card whose
    // NUMBER starts `PSA-`. Segment 4 is not segment 8.
    const psaCardNumber = "hiq:football:2024:bowman:psa-th2:sky-blue:no-auto:num-499";
    const a = adoptResolvedSlug("hiq:some:1:other:x:base:no-auto", r({ slug: psaCardNumber, confidence: 0.98 }));
    expect(a.slug).toBe(psaCardNumber);
    expect(a.gradeStripped).toBeUndefined();
  });

  it("leaves a bare 7-segment identity alone", () => {
    const a = adoptResolvedSlug("hiq:some:1:other:x:base:no-auto", r({ slug: RAW, confidence: 0.98 }));
    expect(a.slug).toBe(RAW);
    expect(a.gradeStripped).toBeUndefined();
  });

  it("a stripped slug is parseable by the lanes that skipped these rows", () => {
    // identityParts (the rekey lanes) and parseHobbyIqCardId both return null
    // for an 8th segment that is not `num-`, which is why every reslug sweep
    // skipped this population by construction. After the strip they parse.
    const a = adoptResolvedSlug("hiq:some:1:other:x:base:no-auto", r({ slug: `${RAW}:psa-10`, confidence: 0.98 }));
    const parts = a.slug.split(":");
    expect(parts[0]).toBe("hiq");
    expect(parts.length === 7 || (parts.length === 8 && parts[7].startsWith("num-"))).toBe(true);
    expect(parts[6] === "auto" || parts[6] === "no-auto").toBe(true);
  });

  it("still refuses a low-confidence match even after stripping", () => {
    // The strip must not become a back door around the confidence gate.
    const a = adoptResolvedSlug(
      "hiq:baseball:2026:bowman-chrome-sapphire:bcp-69:speckle-refractor:no-auto",
      r({ slug: "hiq:baseball:2026:bowman-chrome:bcp-69:speckle-refractor:no-auto:psa-10", confidence: 0.55, matchedBy: "family-fallback" }),
    );
    expect(a.rebound).toBe(false);
    expect(a.refusedReason).toContain("family-fallback");
  });
});
