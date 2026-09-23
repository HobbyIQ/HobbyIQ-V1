/**
 * THE LIST THAT RETIRES THE 281 STALE 1909-11-T206-BASEBALL CATALOG ROWS
 * WHOSE CANONICAL `t206` TWIN ALREADY EXISTS.
 *
 * Companion to CF-T206-BACK-BRAND-IS-NOT-THE-PLAYER (playerIsTheNumber.test.ts):
 * that fix stops NEW sales from splitting a T206 player across back-brand
 * spellings; this list retires the catalog rows that were already minted
 * under the stale year-prefixed key `1909-11-t206-baseball` (the same
 * year-prefix pollution CF-VINTAGE-PRODUCT-RULES documents in
 * hobbyIqCardId.service.ts), since the canonical `t206` row for the same
 * player already exists and prices the card.
 *
 * ACTION IS "retire", NOT "reslug". The first revision of this list named
 * these 281 ids for `reslug` (fold onto the canonical row) — the lane's
 * REPORT run (35808409522) refused all 281 with "refused — occupied: a
 * different card holds the target address": relocate-catalog-rows-by-list.cjs
 * refuses a reslug onto any occupied destination, and every one of these
 * destinations is occupied by the SAME card (that occupancy is exactly what
 * proved the 1:1 surname match in the first place). The fix is the same
 * shape as 2026-09-21-bcp-lava-refractor-bowman-duplicate.json: RETIRE the
 * duplicate, leave the canonical row untouched.
 *
 * Every entry was RE-VERIFIED by fresh point read on 2026-09-22: (a) the
 * stale row exists, (b) the canonical row exists with a checklist-grade
 * source (sportscardchecklist-2026-09-05) and the same player surname,
 * (c) sold_comps has ZERO sales resident at the stale id (hobbyiqCardId = id
 * OR cardId = id) — all 281 passed all three checks, so none needed to be
 * excluded and handed to the rematch separately.
 *
 * The other 140 of the original 421 stale rows are NOT in this list: 99 pair
 * with MULTIPLE canonical rows (the checklist distinguishes poses the stale
 * row's bare surname cannot choose between) and 41 pair with ZERO canonical
 * rows (genuinely absent from the fixture excerpt available to this PR) —
 * both are named in `excluded` rather than guessed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "catalog-relocations", "2026-09-22-t206-year-prefixed-fold.json"), "utf-8"),
) as {
  forLane: string;
  supersedes: string;
  census: Record<string, number>;
  excluded: Array<{ note: string }>;
  entries: Array<{ id: string; action: string; to?: string; reason: string; evidence: string }>;
};

describe("t206 year-prefixed catalog retire list", () => {
  it("names the lane, the refusal it fixes, and the measured count", () => {
    expect(DOC.forLane).toBe("relocate-catalog-rows-by-list");
    expect(DOC.entries.length).toBe(281);
    expect(String(DOC.supersedes)).toMatch(/refused/i);
    expect(String(DOC.supersedes)).toMatch(/occupied/i);
    expect(String(DOC.supersedes)).toMatch(/reslug/i);
    expect(DOC.census.staleRowsTotal).toBe(421);
    expect(DOC.census.retiredThisList).toBe(281);
    expect(DOC.census.ambiguousMultiplePoseCandidates).toBe(99);
    expect(DOC.census.noCanonicalMatch).toBe(41);
    // The three buckets partition the measured total.
    expect(DOC.census.retiredThisList + DOC.census.ambiguousMultiplePoseCandidates + DOC.census.noCanonicalMatch)
      .toBe(DOC.census.staleRowsTotal);
  });

  it("every entry is a retire, names no target, and carries a reason and evidence", () => {
    for (const e of DOC.entries) {
      expect(e.action, e.id).toBe("retire");
      // A retire that names a "to" is a list author reaching for a reslug
      // they were told not to write -- classifyEntry in
      // relocate-catalog-rows-by-list.cjs refuses this shape outright.
      expect(e.to, `${e.id} retire must not name a target`).toBeUndefined();
      expect(e.reason.length, `${e.id} has no reason`).toBeGreaterThan(20);
      expect(e.evidence.length, `${e.id} has no evidence`).toBeGreaterThan(20);
    }
  });

  it("every id is the stale year-prefixed key, never the canonical one", () => {
    for (const e of DOC.entries) {
      expect(e.id, e.id).toMatch(/^hiq:baseball:1909:1909-11-t206-baseball:/);
    }
  });

  it("no id is addressed twice", () => {
    const ids = DOC.entries.map((e) => e.id);
    expect(ids.length - new Set(ids).size, "an id addressed twice is two edits racing").toBe(0);
  });

  it("every entry's evidence names its canonical twin, a checklist-grade source, and zero resident sales", () => {
    for (const e of DOC.entries) {
      expect(e.evidence, e.id).toMatch(/hiq:baseball:1909:t206:/);
      expect(e.evidence, e.id).toMatch(/sportscardchecklist-2026-09-05/);
      expect(e.evidence, e.id).toMatch(/ZERO sales resident/i);
    }
  });

  it("the census says zero sales were resident at any retired address", () => {
    expect(DOC.census.salesResidentAtRetiredAddresses).toBe(0);
  });

  it("the excluded buckets are named, not silently dropped", () => {
    expect(DOC.excluded.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(DOC.excluded);
    expect(text).toMatch(/99 rows/);
    expect(text).toMatch(/41 rows/);
    expect(text).toMatch(/pose/i);
  });
});
