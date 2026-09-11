/**
 * CF-A-TIERLESS-VARIATION-RESOLVES-BY-UNIQUENESS (Drew ruling 24, 2026-09-11,
 * #2047 follow-up).
 *
 * Bobby Witt Jr.'s holding 2b62a93f-f24c-454e-8d5f-1101eb417358, "2022 Topps
 * Chrome Refractor Image Variation Bobby Witt Jr. #221", re-derived (run
 * 34654838558) to NO-MATCH at confidence 0.3: the title states an image
 * variation with no tier word, which normalizes to the bare `image-variation`
 * slug — Tier 1 (SP)'s own unspelled address, per #2038's fix to stop the
 * leading "Refractor" from minting a third address. Step 1 finds no exact
 * `image-variation` row (the product's checklist never minted an SP row at
 * #221 — Beckett's own SP list has 20 cards, #221 is not one), and Step 2's
 * token equality correctly refuses to fuzz `image-variation` onto a
 * completely different, unrelated tier. The only variation row #221 actually
 * carries is `image-variation-sonic` (Ruling 23, source
 * cardpedia-drew-ruling-2026-09-11) — a real, checklist-backed card that was
 * left unpriced.
 *
 * These pin catalogMatcher's Step 2d: when the claim is tier-blind and
 * exactly one checklist-adjudicable variation tier exists for the card
 * number, resolve to it; when the checklist backs two or more tiers, never
 * guess.
 *
 * CF-A-DETERMINISTIC-UNIQUENESS-CLEARS-THE-REDERIVE-GATE (2026-09-11,
 * follow-up to #2049). Shipped at confidence 0.85, this step's own match
 * (run 34657489782) still reported UNVERIFIED: recheck-holding-identity's
 * re-derive gate (MIN_CONFIDENCE, comp-quality/recheck-holding-identity.ts,
 * default 0.9) sits above 0.85. A uniqueness resolution against a
 * checklist-adjudicable row is a deterministic identity — one candidate,
 * checklist decides — not a fuzzy guess, so the confidence moved to 0.92:
 * above the 0.9 gate, below exact-match's 0.98 and a checklist seed's 0.95.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { readMock, queryMock, ctorMock } = vi.hoisted(() => {
  const readMock = vi.fn();
  const queryMock = vi.fn(() => ({ fetchAll: async () => ({ resources: [] }) }));
  const containerMock = {
    item: vi.fn((id: string) => ({ read: () => readMock(id) })),
    items: { query: queryMock, upsert: vi.fn() },
  };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { readMock, queryMock, ctorMock };
});
vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

import { canonicalize, clearCatalogMatchCache } from "../src/services/catalog/catalogMatcher.service.js";

/** Bobby Witt Jr.'s exact title, as parseTitleIdentity/canonicalize would
 *  present it: no tier word, product context resolved. */
const WITT_221 = {
  sport: "baseball",
  year: 2022,
  setName: "Topps Chrome",
  cardNumber: "221",
  parallel: "Refractor Image Variation",
  isAuto: false,
  player: "Bobby Witt Jr.",
  source: "unknown" as const,
};

/** The four self-derived rows this card actually carries in prod, none of
 *  which may adjudicate (catalogAuthority: ingest-auto-seed* is DERIVED,
 *  ebay-user-purchase is VENDOR). */
const SELF_DERIVED_ROWS = [
  { id: "hiq:baseball:2022:topps-chrome:221:image-variation-refractor:no-auto", parallelSlug: "image-variation-refractor", parallel: "Image Variation Refractor", source: "ingest-auto-seed" },
  { id: "hiq:baseball:2022:topps-chrome:221:image-variation-refractor:no-auto:psa-9", parallelSlug: "image-variation-refractor", parallel: "Image Variation Refractor", source: "ingest-auto-seed-graded" },
  { id: "hiq:baseball:2022:topps-chrome:221:image-variation-refractor:no-auto:psa-10", parallelSlug: "image-variation-refractor", parallel: "Image Variation Refractor", source: "ingest-auto-seed-graded" },
  { id: "hiq:baseball:2022:topps-chrome:221:refractor-image-variation:no-auto", parallelSlug: "refractor-image-variation", parallel: "Refractor Image Variation", source: "ebay-user-purchase" },
];

/** The one checklist-backed variation row #221 actually has (Ruling 23). */
const SONIC_ROW = {
  id: "hiq:baseball:2022:topps-chrome:221:image-variation-sonic:no-auto",
  parallelSlug: "image-variation-sonic",
  parallel: "Image Variation Sonic",
  source: "cardpedia-drew-ruling-2026-09-11",
};

/** Every non-variation parallel row #221 also has (refractors, base, etc.) —
 *  present in Step 2's pool but never matched by it, so pool.length !== 0
 *  and Step 2c's widened search never fires (matching the real prod shape). */
const NON_VARIATION_ROWS = [
  { id: "hiq:baseball:2022:topps-chrome:221:base:no-auto", parallelSlug: "base", parallel: null, source: "beckett-scraped-2026-08-25" },
  { id: "hiq:baseball:2022:topps-chrome:221:refractor:no-auto", parallelSlug: "refractor", parallel: "Refractor", source: "baseballcardpedia-ladders-2026-08-29" },
];

/** Route the mock by query text: the Step 2 same-set pool query never filters
 *  on `parallelSlug`, while variationCandidatesForCard's query always
 *  CONTAINS 'variation'. */
function mockQueriesFor(variationRows: Array<{ id: string; parallelSlug: string; source: string }>) {
  queryMock.mockImplementation((spec: { query: string }) => {
    if (/CONTAINS\(c\.parallelSlug, 'variation'\)/.test(spec.query)) {
      return { fetchAll: async () => ({ resources: variationRows }) };
    }
    return { fetchAll: async () => ({ resources: NON_VARIATION_ROWS }) };
  });
}

beforeEach(() => {
  clearCatalogMatchCache();
  readMock.mockReset();
  queryMock.mockReset();
  readMock.mockImplementation(async () => ({ resource: undefined })); // Step 1 always misses
  queryMock.mockReturnValue({ fetchAll: async () => ({ resources: [] }) });
});

/** The re-derive gate recheck-holding-identity.ts pins REDERIVE vs UNVERIFIED
 *  on (comp-quality/recheck-holding-identity.ts:99, default). Not imported —
 *  that file is an ops script, not a service module — so the value is
 *  asserted directly against the constant it must clear. */
const REDERIVE_GATE_MIN_CONFIDENCE = 0.9;

describe("canonicalize — a tierless variation resolves by uniqueness (Ruling 24)", () => {
  it("resolves Bobby Witt Jr. #221 to the Sonic row when it is the ONLY checklist-backed variation, at 0.92", async () => {
    mockQueriesFor([...SELF_DERIVED_ROWS, SONIC_ROW]);
    const r = await canonicalize({ ...WITT_221 });
    expect(r.found).toBe(true);
    expect(r.matchedBy).toBe("tierless-variation-unique");
    expect(r.slug).toBe(SONIC_ROW.id);
    // Pinned exactly: above the 0.9 re-derive gate, below exact (0.98) and a
    // checklist seed (0.95) — this is inferred FROM a checklist row, not one.
    expect(r.confidence).toBe(0.92);
  });

  it("clears recheck-holding-identity's re-derive gate (MIN_CONFIDENCE, default 0.9) — the bug this follow-up fixes", async () => {
    // Run 34657489782: Step 2d found the Sonic row at 0.85 and the holding
    // still reported UNVERIFIED, because 0.85 < 0.9. This pins the fix at the
    // boundary the gate actually checks.
    mockQueriesFor([...SELF_DERIVED_ROWS, SONIC_ROW]);
    const r = await canonicalize({ ...WITT_221 });
    expect(r.confidence).toBeGreaterThanOrEqual(REDERIVE_GATE_MIN_CONFIDENCE);
    expect(r.confidence).toBeLessThan(0.95); // still below a checklist seed
    expect(r.confidence).toBeLessThan(0.98); // still below exact-match
  });

  it("does NOT pick Sonic when a real SP row ALSO exists at the same number — never guess between tiers", async () => {
    const spRow = { id: "hiq:baseball:2022:topps-chrome:221:image-variation:no-auto", parallelSlug: "image-variation", source: "beckett-scraped-2026-09-01" };
    mockQueriesFor([...SELF_DERIVED_ROWS, SONIC_ROW, spRow]);
    const r = await canonicalize({ ...WITT_221 });
    expect(r.matchedBy).not.toBe("tierless-variation-unique");
    expect(r.found).toBe(false);
    expect(r.matchedBy).toBe("not-found");
    expect(r.confidence).toBeCloseTo(0.3);
  });

  it("does NOT reroute a title that already states a tier", async () => {
    mockQueriesFor([...SELF_DERIVED_ROWS, SONIC_ROW]);
    const r = await canonicalize({ ...WITT_221, parallel: "Image Variation SSP" });
    expect(r.matchedBy).not.toBe("tierless-variation-unique");
  });

  it("still reports NO-MATCH when every variation row at the number is self-derived", async () => {
    mockQueriesFor(SELF_DERIVED_ROWS);
    const r = await canonicalize({ ...WITT_221 });
    expect(r.found).toBe(false);
    expect(r.matchedBy).toBe("not-found");
    expect(r.confidence).toBeCloseTo(0.3);
  });

  it("still reports NO-MATCH when the product has no variation rows at this number at all", async () => {
    mockQueriesFor([]);
    const r = await canonicalize({ ...WITT_221 });
    expect(r.found).toBe(false);
    expect(r.matchedBy).toBe("not-found");
  });
});
