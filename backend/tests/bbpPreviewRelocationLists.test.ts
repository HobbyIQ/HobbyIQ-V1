/**
 * THE FOUR LISTS THAT MOVE THE BOWMAN'S BEST PREVIEW ONTO ITS RULED KEY.
 *
 * Two catalog lists (`relocate-catalog-rows-by-list`) and two pool lists
 * (`relocate-pool-rows-by-list`), all four measured read-only against prod on
 * 2026-09-06 and all four report-only until dispatched.
 *
 * THE FINDING THAT REWROTE TWO OF THEM. #1858's baseball list named 60 ids for
 * RETIRE and #1851's basketball list named 40 `sub-`-segment ids for reslug.
 * Re-measured for this PR, NONE of the 60 and NONE of the 40 still exists: the
 * fold and dedup lanes that merged since (#1838, #1876) consolidated those
 * rows. A list is a list of IDS, so a list whose ids are gone is not a
 * conservative list -- it is a no-op that reconciles cleanly and reports
 * success. Both were rebuilt from what is actually stored, and the count each
 * one carries is the count that was measured, not the count that was expected.
 *
 * WHAT THESE TESTS ARE FOR. They cannot check prod -- they run offline. What
 * they CAN hold is every property that has to be true of the lists themselves
 * for a dispatch to be safe: the shapes the lanes accept, one shape per entry,
 * no id addressed twice, no from == to, every target on the ruled key at a
 * legal BBP rung, and the one place a naive list would double-count a sale.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = join(__dirname, "..", "data");
const read = (p: string) => JSON.parse(readFileSync(join(DATA, p), "utf-8"));

const CATALOG_BASEBALL = read("catalog-relocations/2026-09-06-bbp-preview-baseball.json");
const CATALOG_BASKETBALL = read("catalog-relocations/2026-09-06-bbp-preview-basketball.json");
const POOL_BASEBALL = read("pool-relocations/2026-09-06-bbp-preview-baseball-pool.json");
const POOL_BASKETBALL = read("pool-relocations/2026-09-06-bbp-basketball-rung-repoint.json");

const RUNG = "(?:base|refractor|atomic-refractor)";
const ruledAddress = (sport: string) =>
  new RegExp(`^hiq:${sport}:1997:bowmans-best-preview:bbp([1-9]|1[0-9]|20):${RUNG}:no-auto$`);

// ── the catalog lists ────────────────────────────────────────────────────────

describe("the catalog lists move every stored Preview row onto the ruled key", () => {
  const cases: Array<[string, Record<string, unknown>, string, number]> = [
    ["baseball", CATALOG_BASEBALL, "baseball", 19],
    ["basketball", CATALOG_BASKETBALL, "basketball", 60],
  ];

  it.each(cases)("%s: the list names the lane and the count it measured", (_n, doc, _sport, expected) => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect((doc.entries as unknown[]).length).toBe(expected);
    // The rebuild is stated in the file, not only in the PR body -- a reader
    // who opens this list must see that an earlier revision named other ids.
    expect(String(doc.supersedes)).toMatch(/2026-09-06T05:45:00Z/);
    expect(String(doc.supersedes)).toMatch(/no longer exist|NONE of those 60 ids still exists/i);
  });

  it.each(cases)("%s: every entry states ONE shape, with a reason and its evidence", (_n, doc) => {
    for (const e of doc.entries as Array<Record<string, string>>) {
      expect(["retire", "reslug"], `${e.id} has action ${e.action}`).toContain(e.action);
      // `reslug` needs a destination; `retire` must NOT carry one, or the lane
      // is one field away from applying the shape nobody asked for.
      if (e.action === "reslug") expect(e.to, `${e.id} reslug with no target`).toBeTruthy();
      else expect(e.to, `${e.id} retire must not name a target`).toBeUndefined();
      expect(String(e.reason).length, `${e.id} has no reason`).toBeGreaterThan(20);
      expect(String(e.evidence).length, `${e.id} has no evidence`).toBeGreaterThan(20);
    }
  });

  it.each(cases)("%s: every reslug target is a legal BBP rung on the ruled key", (_n, doc, sport) => {
    const re = ruledAddress(sport as string);
    for (const e of (doc.entries as Array<Record<string, string>>).filter((x) => x.action === "reslug")) {
      expect(e.to, `${e.to} is not a legal ruled address`).toMatch(re);
      // The `sub-` segment was a collision work-around for a clash that does
      // not exist in this product. It must not survive the move.
      expect(e.to).not.toMatch(/:sub-/);
    }
  });

  it.each(cases)("%s: no id is addressed twice, and nothing moves onto itself", (_n, doc) => {
    const entries = doc.entries as Array<Record<string, string>>;
    const ids = entries.map((e) => e.id);
    expect(ids.length - new Set(ids).size, "an id addressed twice is two edits racing").toBe(0);
    const tos = entries.filter((e) => e.to).map((e) => e.to);
    // TWO ROWS ONTO ONE ADDRESS IS A MERGE, and the lane refuses rather than
    // merges -- so a list that asks for one is a list that will half-apply.
    expect(tos.length - new Set(tos).size, "two rows reslugging onto one address").toBe(0);
    for (const e of entries) expect(e.to, `${e.id} moves onto itself`).not.toBe(e.id);
  });

  it("baseball: 19 rows, and the list says plainly that the checklist has 20 cards it does not mint", () => {
    // The honest gap. Only 19 of the 60 rows the incident wrote survive, and
    // they are uneven across rungs. A list that quietly named 60 would be
    // claiming rows nobody measured; the RE-MINT fills the gap, not this list.
    const entries = CATALOG_BASEBALL.entries as Array<Record<string, string>>;
    expect(entries).toHaveLength(19);
    expect(entries.every((e) => e.action === "reslug")).toBe(true);
    expect(JSON.stringify(CATALOG_BASEBALL.rulings)).toMatch(/never mints/i);
  });

  it("basketball: all 60 move, base rung included -- leaving it is the split pool", () => {
    const entries = CATALOG_BASKETBALL.entries as Array<Record<string, string>>;
    expect(entries).toHaveLength(60);
    const rungs = entries.reduce<Record<string, number>>((o, e) => {
      const k = /:(base|refractor|atomic-refractor):/.exec(e.to)?.[1] ?? "?";
      o[k] = (o[k] || 0) + 1;
      return o;
    }, {});
    expect(rungs).toEqual({ base: 20, refractor: 20, "atomic-refractor": 20 });
    // Three rungs for each of the twenty cards, and no card missing one.
    const perCard = new Map<string, Set<string>>();
    for (const e of entries) {
      const m = /:(bbp\d+):(base|refractor|atomic-refractor):/.exec(e.to);
      if (!m) continue;
      if (!perCard.has(m[1])) perCard.set(m[1], new Set());
      perCard.get(m[1])!.add(m[2]);
    }
    expect(perCard.size).toBe(20);
    for (const [card, set] of perCard) expect(set.size, `${card} does not have three rungs`).toBe(3);
  });

  it("A TITLE NAMING ATOMIC NEVER LANDS ON THE PLAIN RUNG", () => {
    // #1846's rule, re-asserted on the lists that carry it into prod.
    for (const doc of [CATALOG_BASEBALL, CATALOG_BASKETBALL]) {
      for (const e of doc.entries as Array<Record<string, string>>) {
        if (!e.to) continue;
        if (/atomic/i.test(String(e.evidence))) {
          expect(e.to, `${e.id} says Atomic and lands on ${e.to}`).toMatch(/:atomic-refractor:/);
        }
      }
    }
  });
});

// ── the pool lists ───────────────────────────────────────────────────────────

describe("the pool lists put the sales on the same addresses the catalog lists create", () => {
  it("both name the pool lane, and neither moves a partition", () => {
    for (const doc of [POOL_BASEBALL, POOL_BASKETBALL]) {
      // The committed lists spell this both ways (`...-by-list` and
      // `...-by-list.cjs`); the lane reads neither, and #1851's own pin
      // asserts the `.cjs` spelling on the list it shipped. Accept both
      // rather than churn a field nothing consumes.
      expect(String(doc.forLane)).toMatch(/^relocate-pool-rows-by-list(\.cjs)?$/);
      for (const e of doc.entries as Array<Record<string, string>>) {
        // A repoint or a retire-marker. Never `toCardId`, which is the shape
        // that moves a document between partitions.
        expect(e.toCardId, `${e.id} names a partition move`).toBeUndefined();
        expect(Boolean(e.repointHobbyiqCardId) !== Boolean(e.retireSupersededBy), `${e.id} must name exactly one shape`).toBe(true);
        expect(String(e.evidence).length, `${e.id} has no evidence`).toBeGreaterThan(30);
      }
    }
  });

  it("every target is a legal address on the ruled key -- both sports", () => {
    for (const [doc, sport] of [[POOL_BASEBALL, "baseball"], [POOL_BASKETBALL, "basketball"]] as const) {
      const re = ruledAddress(sport);
      for (const e of doc.entries as Array<Record<string, string>>) {
        const target = e.repointHobbyiqCardId ?? e.retireSupersededBy;
        expect(target, `${e.id} -> ${target}`).toMatch(re);
      }
    }
  });

  it("the basketball list is the SAME 30 sales, repointed onto the new product", () => {
    // Only the product segment moved. The rows, the rungs and the evidence
    // are #1851's, because only the product was ever in question.
    expect(POOL_BASKETBALL.entries).toHaveLength(30);
    expect(String(POOL_BASKETBALL.supersedes)).toMatch(/topps-stadium-club/);
    const rungs = (POOL_BASKETBALL.entries as Array<Record<string, string>>).reduce<Record<string, number>>((o, e) => {
      const k = /:(base|refractor|atomic-refractor):/.exec(e.repointHobbyiqCardId)![1];
      o[k] = (o[k] || 0) + 1;
      return o;
    }, {});
    // #1851's measured split: base 15 / refractor 11 / atomic 4.
    expect(rungs).toEqual({ base: 15, refractor: 11, "atomic-refractor": 4 });
  });

  it("the baseball list carries all 16 sales, off BOTH host keys", () => {
    const entries = POOL_BASEBALL.entries as Array<Record<string, string>>;
    expect(entries).toHaveLength(16);
    expect(entries.filter((e) => /:bowman:/.test(e.fromCardId))).toHaveLength(12);
    expect(entries.filter((e) => /:bowmans-best:/.test(e.fromCardId))).toHaveLength(4);
    // Every from-address is a 1997 Preview address on one of the two hosts --
    // never a later product that merely reuses the BBP prefix.
    for (const e of entries) {
      expect(e.fromCardId).toMatch(/^hiq:baseball:1997:(bowman|bowmans-best):bbp\d+:/);
    }
  });

  it("ONE SALE, ONE ADDRESS -- the doubly-stored Jeter is repointed once and retired once", () => {
    // `tca-ebay::314237835656` is stored under two partitions with the same
    // document id. Repointing both would land one $65 sale on one address
    // twice, which is a double count dressed as a fix.
    const entries = POOL_BASEBALL.entries as Array<Record<string, string>>;
    const twins = entries.filter((e) => e.id === "tca-ebay::314237835656");
    expect(twins).toHaveLength(2);
    expect(twins.filter((e) => e.repointHobbyiqCardId)).toHaveLength(1);
    expect(twins.filter((e) => e.retireSupersededBy)).toHaveLength(1);
    // The title says Atomic, so that is the copy that survives.
    expect(twins.find((e) => e.repointHobbyiqCardId)?.repointHobbyiqCardId).toMatch(/:atomic-refractor:/);
    expect(twins.find((e) => e.retireSupersededBy)?.fromCardId).toMatch(/:base:/);

    // ...and stated as the invariant it protects: no document id is repointed
    // onto the same address more than once, anywhere in the list.
    const pairs = entries.filter((e) => e.repointHobbyiqCardId).map((e) => `${e.id}@@${e.repointHobbyiqCardId}`);
    expect(pairs.length - new Set(pairs).size).toBe(0);
  });

  it("THE TITLE DECIDES THE RUNG -- a title saying Atomic never lands on the plain rung", () => {
    for (const e of POOL_BASEBALL.entries as Array<Record<string, string>>) {
      const target = e.repointHobbyiqCardId ?? e.retireSupersededBy;
      const title = /Title: "(.*)"$/.exec(String(e.evidence))?.[1] ?? String(e.evidence);
      if (/atomic/i.test(title)) expect(target, `${e.id}: ${title}`).toMatch(/:atomic-refractor:/);
    }
  });

  it("the scope EXCLUDES the later products that reuse the BBP prefix, and says so", () => {
    // 2011 `hiq:baseball:2011:bowman:bbp9:base:no-auto` alone holds 53 sales
    // of a DIFFERENT insert. A rule keyed on the prefix would have taken them.
    const ex = JSON.stringify(POOL_BASEBALL.excluded);
    expect(ex).toMatch(/2011/);
    expect(ex).toMatch(/1996/);
  });
});

// ── the four lists agree with each other ─────────────────────────────────────

describe("the catalog and pool lists agree on the end state", () => {
  it("every pool target is an address a catalog list creates, or one the re-mint will", () => {
    // The sequencing claim, made checkable. A pool target that no catalog list
    // creates is only safe because the SCC re-mint mints the full 20-card
    // ladder first -- so it must at least be a legal address of THIS product.
    const catalogTargets = new Set(
      [...(CATALOG_BASEBALL.entries as Array<Record<string, string>>), ...(CATALOG_BASKETBALL.entries as Array<Record<string, string>>)]
        .filter((e) => e.to)
        .map((e) => e.to),
    );
    for (const [doc, sport] of [[POOL_BASEBALL, "baseball"], [POOL_BASKETBALL, "basketball"]] as const) {
      for (const e of doc.entries as Array<Record<string, string>>) {
        const target = e.repointHobbyiqCardId ?? e.retireSupersededBy;
        const legal = ruledAddress(sport).test(target);
        expect(legal, `${target} is not a legal ruled address`).toBe(true);
        if (!catalogTargets.has(target)) {
          // Allowed, but only because the re-mint creates it. The lists say so.
          expect(JSON.stringify(doc.rulings)).toMatch(/re-mint|RE-MINT/);
        }
      }
    }
  });

  it("every list states the required order, so nobody dispatches them backwards", () => {
    // A sale repointed at an address the catalog has not created is a sale
    // pointing at nothing.
    for (const doc of [CATALOG_BASKETBALL, POOL_BASEBALL, POOL_BASKETBALL]) {
      expect(JSON.stringify(doc), "the list must state its sequencing").toMatch(/re-mint|requiredOrder|RUN THE CATALOG LIST/i);
    }
  });
});
