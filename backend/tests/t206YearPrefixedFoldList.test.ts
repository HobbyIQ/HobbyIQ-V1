/**
 * THE LIST THAT FOLDS THE 421 STALE 1909-11-T206-BASEBALL CATALOG ROWS ONTO
 * THE CANONICAL `t206` KEY.
 *
 * Companion to CF-T206-BACK-BRAND-IS-NOT-THE-PLAYER (playerIsTheNumber.test.ts):
 * that fix stops NEW sales from splitting a T206 player across back-brand
 * spellings; this list moves the catalog rows that were already minted under
 * the stale year-prefixed key `1909-11-t206-baseball` (the same year-prefix
 * pollution CF-VINTAGE-PRODUCT-RULES documents in hobbyIqCardId.service.ts)
 * onto the canonical `t206` key those sales should have reached.
 *
 * Point-read against card_catalog on 2026-09-22 found 421 stale rows. Of
 * those, exactly 281 pair 1:1 with a canonical t206 checklist row by surname
 * — those are this list's entries, all `reslug` (fold, since both id and
 * destination were confirmed to exist). The other 140 are NOT in this list:
 * 99 pair with MULTIPLE canonical rows (the checklist distinguishes poses
 * the stale row's bare surname cannot choose between) and 41 pair with ZERO
 * canonical rows (genuinely absent from the fixture excerpt this PR could
 * read) — both are named in `excluded` rather than guessed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "catalog-relocations", "2026-09-22-t206-year-prefixed-fold.json"), "utf-8"),
) as {
  forLane: string;
  census: Record<string, number>;
  excluded: Array<{ note: string }>;
  entries: Array<{ id: string; action: string; to: string; reason: string; evidence: string }>;
};

describe("t206 year-prefixed catalog fold list", () => {
  it("names the lane and the measured count", () => {
    expect(DOC.forLane).toBe("relocate-catalog-rows-by-list");
    expect(DOC.entries.length).toBe(281);
    expect(DOC.census.staleRowsTotal).toBe(421);
    expect(DOC.census.unambiguousFold).toBe(281);
    expect(DOC.census.ambiguousMultiplePoseCandidates).toBe(99);
    expect(DOC.census.noCanonicalMatch).toBe(41);
    // The three buckets partition the measured total.
    expect(DOC.census.unambiguousFold + DOC.census.ambiguousMultiplePoseCandidates + DOC.census.noCanonicalMatch)
      .toBe(DOC.census.staleRowsTotal);
  });

  it("every entry is a reslug (fold), with a reason and evidence", () => {
    for (const e of DOC.entries) {
      expect(e.action, e.id).toBe("reslug");
      expect(e.to, `${e.id} has no target`).toBeTruthy();
      expect(e.reason.length, `${e.id} has no reason`).toBeGreaterThan(20);
      expect(e.evidence.length, `${e.id} has no evidence`).toBeGreaterThan(20);
    }
  });

  it("every id comes FROM the stale key and goes TO the canonical key", () => {
    for (const e of DOC.entries) {
      expect(e.id, e.id).toMatch(/^hiq:baseball:1909:1909-11-t206-baseball:/);
      expect(e.to, e.id).toMatch(/^hiq:baseball:1909:t206:/);
    }
  });

  it("no source id is addressed twice", () => {
    const ids = DOC.entries.map((e) => e.id);
    expect(ids.length - new Set(ids).size, "an id addressed twice is two edits racing").toBe(0);
  });

  it("nothing moves onto itself", () => {
    for (const e of DOC.entries) expect(e.to, e.id).not.toBe(e.id);
  });

  it("a destination held by more than one source is always a base row plus its OWN graded child, never two different players", () => {
    // Unlike the BBP Preview lists (one address per rung, so any duplicate
    // target IS a bug there), T206's canonical checklist has no separate
    // graded address -- moveCatalogRow's own documented fold case is a base
    // row and its graded child (":psa-4", ":sgc-6", ...) converging on one
    // destination. That is the ONLY shape a duplicate target may take here.
    const byTo = new Map<string, string[]>();
    for (const e of DOC.entries) {
      if (!byTo.has(e.to)) byTo.set(e.to, []);
      byTo.get(e.to)!.push(e.id);
    }
    const graded = /:(?:psa|sgc|bgs|cgc)-[0-9.]+$/;
    for (const [to, sources] of byTo) {
      if (sources.length < 2) continue;
      const bases = sources.filter((s) => !graded.test(s));
      const gradedChildren = sources.filter((s) => graded.test(s));
      expect(bases.length, `${to}: more than one BASE row folding here (${sources.join(", ")})`).toBe(1);
      expect(gradedChildren.length, `${to}: no graded children among duplicates (${sources.join(", ")})`).toBeGreaterThan(0);
      // Every source sharing this destination must be the SAME player surname.
      const surnames = new Set(sources.map((s) => s.split(":")[3].replace(/:(?:psa|sgc|bgs|cgc)-[0-9.]+$/, "")));
      expect(surnames.size, `${to}: sources disagree on player (${sources.join(", ")})`).toBe(1);
    }
  });

  it("the excluded buckets are named, not silently dropped", () => {
    expect(DOC.excluded.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(DOC.excluded);
    expect(text).toMatch(/99 rows/);
    expect(text).toMatch(/41 rows/);
    expect(text).toMatch(/pose/i);
  });
});
