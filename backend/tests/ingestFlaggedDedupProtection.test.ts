import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scoreForCanonical } from "../src/services/portfolioiq/soldCompsStore.service.js";

/**
 * CF-A-FLAGGED-ROW-IS-NOT-A-DEDUP-PARTNER (2026-09-01).
 *
 * The ingest-time contentHash dedup compared an incoming sale against EVERY
 * same-hash row in the partition, including rows already ruled wrong. Both
 * outcomes destroyed data:
 *
 *   (a) the flagged row outscores the incoming sale -> the REAL sale is
 *       dropped and never enters the pool;
 *   (b) the incoming sale outscores it -> the flagged row is HARD DELETED,
 *       destroying the dedupSupersededBy provenance trail.
 *
 * These pin the fix on both the queries and the scorer. The query assertions
 * are source-level for the same reason the superseded gap test was: the
 * service's module graph races portfolioStore's readCache under a parallel
 * run. The SCORER is executed directly -- it is pure arithmetic.
 */

const REPO = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8").replace(/\r\n/g, "\n");

const STORE = "backend/src/services/portfolioiq/soldCompsStore.service.ts";
const VENDOR = "backend/src/services/portfolioiq/persistVendorSalesToPool.service.ts";

const FLAG_PREDICATE = "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)";

describe("ingest dedup: the queries exclude flagged rows", () => {
  it("the pre-write contentHash dedup filters flaggedWrong for a live incoming doc", () => {
    const src = read(STORE);
    const q =
      "SELECT * FROM c WHERE ARRAY_CONTAINS(@h, c.contentHash) AND " + FLAG_PREDICATE;
    expect(src).toContain(q);
  });

  it("a FLAGGED incoming doc still dedups against flagged rows (no resurrection)", () => {
    // The cardsight $0.99 / outlier guards mint flaggedWrong on the incoming
    // doc itself. If that write were also filtered to live-only rows it would
    // miss its own stored twin and re-write the duplicate those guards exist
    // to suppress. The unfiltered form must therefore survive, selected by
    // the incomingIsFlagged branch.
    const src = read(STORE);
    expect(src).toContain("const incomingIsFlagged");
    expect(src).toMatch(
      /incomingIsFlagged\s*\?\s*"SELECT \* FROM c WHERE ARRAY_CONTAINS\(@h, c\.contentHash\)"/,
    );
  });

  it("the vendor-pool dedup filters flaggedWrong unconditionally", () => {
    const src = read(VENDOR);
    const q =
      "SELECT c.id FROM c WHERE c.hobbyiqCardId = @hiq AND c.contentHash = @ch AND " +
      FLAG_PREDICATE;
    expect(src).toContain(q);
  });

  it("the vendor path mints no flag, so it needs no flagged-incoming branch", () => {
    // Pins the premise of the asymmetry above: if this file ever starts
    // writing flaggedWrong, the unconditional predicate must be revisited.
    const src = read(VENDOR);
    const writes = [...src.matchAll(/flaggedWrong\s*[=:]/g)].filter(
      (m) => !/!=/.test(src.slice((m.index ?? 0) - 2, (m.index ?? 0) + 14)),
    );
    expect(writes.length).toBe(0);
  });
});

describe("scoreForCanonical: a flagged row loses to every live row", () => {
  // ---- the EXACT measured case from the triage ---------------------------
  it("the measured case flips: flagged real-id row no longer beats a genuine ch-daily:: sale", () => {
    const flaggedExisting = scoreForCanonical({
      sourceExternalId: "888777",
      parallel: "Uncommon Refractor",
      observedAt: "2026-08-01T00:00:00Z",
      flaggedWrong: true,
    });
    const genuineIncoming = scoreForCanonical({
      sourceExternalId: "ch-daily::991",
      parallel: "Uncommon Refractor",
      observedAt: "2026-09-01T00:00:00Z",
    });
    // measured before the fix: 95.855424 > 85.882208 -> the real sale dropped
    expect(genuineIncoming).toBeGreaterThan(flaggedExisting);
  });

  it("a flagged row loses even at maximum strength against the weakest live row", () => {
    const strongestFlagged = scoreForCanonical({
      verifiedByUser: true,
      sourceExternalId: "v1|999999999999",
      parallel: "Superfractor Red Ink Shimmer 1/1",
      observedAt: "2030-01-01T00:00:00Z",
      flaggedWrong: true,
    });
    const weakestLive = scoreForCanonical({ sourceExternalId: null });
    expect(strongestFlagged).toBeLessThan(weakestLive);
  });

  it("flaggedWrong:false and an absent flag score identically", () => {
    const a = scoreForCanonical({ sourceExternalId: "123", parallel: "Gold" });
    const b = scoreForCanonical({ sourceExternalId: "123", parallel: "Gold", flaggedWrong: false });
    expect(a).toBe(b);
  });

  // ---- ranking WITHIN the flagged group is preserved ---------------------
  it("among flagged rows the richer row still wins", () => {
    const richer = scoreForCanonical({
      verifiedByUser: true,
      sourceExternalId: "v1|123",
      parallel: "Refractor",
      flaggedWrong: true,
    });
    const poorer = scoreForCanonical({
      sourceExternalId: "holding::abc",
      flaggedWrong: true,
    });
    expect(richer).toBeGreaterThan(poorer);
  });

  // ---- the pre-existing winner cases still hold (regression) ------------
  it("PRESERVED: a real id still outranks a holding:: key", () => {
    expect(
      scoreForCanonical({ verifiedByUser: true, sourceExternalId: "v1|123456789012", parallel: "Refractor" }),
    ).toBeGreaterThan(
      scoreForCanonical({ verifiedByUser: true, sourceExternalId: "holding::abc", parallel: "Refractor" }),
    );
  });

  it("PRESERVED: verification still dominates keying", () => {
    expect(
      scoreForCanonical({ verifiedByUser: true, sourceExternalId: "holding::abc" }),
    ).toBeGreaterThan(
      scoreForCanonical({ verifiedByUser: false, sourceExternalId: "123456789012" }),
    );
  });

  it("PRESERVED: ch-daily:: outranks holding::, and a bare real id outranks both", () => {
    const holding = scoreForCanonical({ sourceExternalId: "holding::abc" });
    const chDaily = scoreForCanonical({ sourceExternalId: "ch-daily::991" });
    const realId = scoreForCanonical({ sourceExternalId: "888777" });
    expect(chDaily).toBeGreaterThan(holding);
    expect(realId).toBeGreaterThan(chDaily);
  });

  it("PRESERVED: a longer parallel and a newer observedAt still break ties upward", () => {
    expect(
      scoreForCanonical({ sourceExternalId: "1", parallel: "Gold Refractor" }),
    ).toBeGreaterThan(scoreForCanonical({ sourceExternalId: "1", parallel: "Gold" }));
    expect(
      scoreForCanonical({ sourceExternalId: "1", observedAt: "2026-09-01T00:00:00Z" }),
    ).toBeGreaterThan(
      scoreForCanonical({ sourceExternalId: "1", observedAt: "2026-08-01T00:00:00Z" }),
    );
  });

  it("the penalty clears the whole live scale rather than merely tipping it", () => {
    // A flagged row must lose by construction, not by arithmetic luck: the
    // gap has to exceed the largest score a live row can reach.
    const maxLive = scoreForCanonical({
      verifiedByUser: true,
      sourceExternalId: "v1|1",
      parallel: "x".repeat(120),
      observedAt: "2035-01-01T00:00:00Z",
    });
    const anyFlagged = scoreForCanonical({
      verifiedByUser: true,
      sourceExternalId: "v1|1",
      parallel: "x".repeat(120),
      observedAt: "2035-01-01T00:00:00Z",
      flaggedWrong: true,
    });
    expect(maxLive - anyFlagged).toBeGreaterThan(maxLive);
  });
});
