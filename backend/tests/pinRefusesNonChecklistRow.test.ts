/**
 * D35 RC2 — CF-PIN-ONLY-A-CHECKLIST-ROW.
 *
 * Confidence was the only pin gate, and confidence is self-confirming:
 * canonicalize SEEDS a `user-verified` catalog row for an identity it cannot
 * find, and then matches its own seed at 0.95-0.98 (matchedBy "seeded"),
 * because catalogMatcher hands `user-verified` a 0.9 confidence floor by
 * construction. Four of Drew's holdings carry exactly that shape — a vendor
 * row minted by the request that then "found" it, above the gate, pinned.
 *
 * "A match proves nothing unless the row is checklist-backed." So authority is
 * a SECOND, independent gate: above the confidence gate but on a vendor /
 * derived / unknown row, the match parks as a proposal exactly as a sub-gate
 * match does.
 *
 * The table is driven off catalogAuthorityOf so it cannot drift from the
 * authority module — if a source is reclassified there, this test follows.
 */
import { describe, expect, it } from "vitest";
import { applyCatalogMatchToHolding } from "../src/services/portfolioiq/portfolioStore.service.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

const SLUG = "hiq:baseball:2020:bowman-chrome:cpa-mh:base-refractor:auto:num-499";

const ctx = (source: string) => ({
  source: "test",
  userId: "u1",
  holdingId: "h1",
  cardIdRule: "fill" as const,
  readRow: async () => ({ source }),
});

const confidentMatch = { slug: SLUG, found: true, confidence: 0.98, matchedBy: "exact" };

describe("applyCatalogMatchToHolding — authority is a second gate", () => {
  // The sources actually observed on Drew's eight holdings' candidate rows.
  const NON_CHECKLIST = ["user-verified", "ingest-auto-seed", "sold-comps-stub", "cardhedge", "ebay-browse", "cardsight"];

  it.each(NON_CHECKLIST)("refuses to pin a confident match on a %s row", async (source) => {
    expect(catalogAuthorityOf(source)).not.toBe("checklist"); // the table's own premise
    const h: Record<string, unknown> = {};
    const out = await applyCatalogMatchToHolding(h as never, confidentMatch, ctx(source));
    expect(out.pinned).toBe(false);
    expect(h.hobbyiqCardId).toBeUndefined();
    // ...but the match is still recorded as a PROPOSAL, the fields the UI
    // surfaces as proposedIdentity for the user to accept.
    expect(h.catalogMatchSlug).toBe(SLUG);
    expect(h.catalogMatchConfidence).toBe(0.98);
  });

  const CHECKLIST = ["baseballcardpedia", "checklistcenter-2026-08-29", "beckett-checklist", "cardboardchecklist"];

  it.each(CHECKLIST)("pins a confident match on a %s row", async (source) => {
    expect(catalogAuthorityOf(source)).toBe("checklist"); // premise
    const h: Record<string, unknown> = {};
    const out = await applyCatalogMatchToHolding(h as never, confidentMatch, ctx(source));
    expect(out.pinned).toBe(true);
    expect(h.hobbyiqCardId).toBe(SLUG);
    expect(h.cardId).toBe(SLUG); // cardIdRule "fill" and nothing pinned
    expect(h.hobbyiqCardIdSource).toBe("catalog");
  });

  it("still refuses below the CONFIDENCE gate even on a checklist row", async () => {
    // The two gates are independent; neither one substitutes for the other.
    const h: Record<string, unknown> = {};
    const out = await applyCatalogMatchToHolding(
      h as never,
      { slug: SLUG, found: true, confidence: 0.72, matchedBy: "fuzzy-parallel" },
      ctx("baseballcardpedia"),
    );
    expect(out.pinned).toBe(false);
    expect(h.hobbyiqCardId).toBeUndefined();
    expect(h.catalogMatchSlug).toBe(SLUG);
  });

  it("fails closed when the row cannot be read — an unreadable row parks, never pins blind", async () => {
    const h: Record<string, unknown> = {};
    const out = await applyCatalogMatchToHolding(h as never, confidentMatch, {
      source: "test",
      userId: "u1",
      holdingId: "h1",
      cardIdRule: "fill",
      readRow: async () => null,
    });
    expect(out.pinned).toBe(false);
    expect(h.hobbyiqCardId).toBeUndefined();
  });

  it("a not-found match writes no proposal and no identity", async () => {
    const h: Record<string, unknown> = {};
    const out = await applyCatalogMatchToHolding(
      h as never,
      { slug: "", found: false, confidence: 0, matchedBy: "not-found" },
      ctx("baseballcardpedia"),
    );
    expect(out.pinned).toBe(false);
    expect(h.catalogMatchSlug).toBeNull();
  });

  it("keeps an existing pin rather than demoting it when a re-derivation is refused", async () => {
    // The parked-proposal path must never null out an identity already held.
    const h: Record<string, unknown> = { hobbyiqCardId: SLUG, cardId: SLUG };
    const out = await applyCatalogMatchToHolding(
      h as never,
      { slug: "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto", found: true, confidence: 0.98, matchedBy: "exact" },
      { ...ctx("ingest-auto-seed"), cardIdRule: "rebind" },
    );
    expect(out.pinned).toBe(false);
    expect(h.hobbyiqCardId).toBe(SLUG); // the pin stands
  });
});
