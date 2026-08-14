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
