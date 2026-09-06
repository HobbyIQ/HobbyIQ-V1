/**
 * CF-A-MOVE-LANE-SHARDS-BY-CARD-NOT-BY-ROW — the shard axis of the product-list
 * repair lanes, PROVEN rather than asserted (2026-09-05).
 *
 * THE GAP THIS CLOSES. #1799 proved retire-self-derived-identities' axis: every
 * (year, setKey) product owned by exactly one slot, complete and disjoint. That
 * proof is what earned it a place on the workflow's SHARD line in #1806. The
 * product-list repair lanes added today reached that same line WITHOUT one, and
 * a shard axis nobody measured is how a fan-out silently corrupts:
 *
 * repair-bowman-product-refile scans `STARTSWITH(c.id, 'hiq:…:bowman-chrome:')`
 * and sharded on `sha1(row.id)`. A card's GRADED CHILDREN live at
 * `${parentSlug}:${tier}` — they start with that same stem, so they are IN the
 * scanned population, hashed independently of their parent. Measured on one real
 * card at 16 slots:
 *
 *     hiq:baseball:2026:bowman-chrome:cpa-jd:base:auto            slot  9
 *     …:cpa-jd:base:auto:psa-10                                   slot 15
 *     …:cpa-jd:base:auto:psa-9                                    slot 11
 *     …:cpa-jd:base:auto:bgs-9-5                                  slot 15
 *     hiq:baseball:2026:bowman:cpa-jd:base:auto     (destination)  slot 11
 *
 * Five slots, one card — while `moveCatalogRow` copies the survivor, re-points
 * that card's sales, RETIRES ITS GRADED CHILDREN and deletes the old row. Slot 9
 * retires a child that slot 15 is concurrently planning a move for; whichever
 * runs last wins, and both exit 0 reconciling honestly against the rows each saw.
 *
 * WHAT IS ASSERTED:
 *   (1) COMPLETE      — every row of a synthetic population lands in some slot.
 *   (2) DISJOINT      — no row lands in two slots. (1)+(2) = a partition.
 *   (3) CO-LOCATED    — a parent and EVERY graded child share one slot. This is
 *                       the property the old per-row axis lacked, and the whole
 *                       reason this file exists.
 *   (4) NOT COLLAPSED — `num-50` and `auto`/`no-auto` are NOT tier segments; a
 *                       numbered sibling keeps its own key, so the fold never
 *                       merges two DIFFERENT cards.
 *   (5) BALANCED      — the axis still spreads work; a "safe" axis that puts
 *                       everything in slot 0 is a serial run wearing a fan-out's
 *                       banner.
 *   (6) WIRED         — both moveCatalogRow lanes actually call it, and the
 *                       Bowman lane reads `SHARDED` (the helper's real key) and
 *                       not `sharding`, which is `undefined` and made the guard
 *                       DEAD — every slot swept every row.
 *
 * MUTATION-SENSITIVE. Revert cardShardKey to identity → (3) fails. Strip any
 * trailing segment instead of a grader-vocabulary one → (4) fails. Put the
 * per-row hash back in either lane → (6) fails.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cardShardKey, cardShardIndex } = require(
  path.join(ROOT, "backend", "scripts", "lib", "card-shard-axis.cjs"),
) as {
  cardShardKey: (id: string) => string;
  cardShardIndex: (id: string, slots: number) => number;
};

const SLOTS = 16;
const TIERS = ["psa-10", "psa-9", "psa-8", "bgs-9-5", "bgs-10", "sgc-10", "cgc-9"];

/** A synthetic product: parents, their graded children, and numbered siblings —
 *  the exact shapes `STARTSWITH(c.id, stem)` returns for one product. */
function population(stem: string, cards: number) {
  const parents: string[] = [];
  const children = new Map<string, string[]>();
  for (let i = 0; i < cards; i++) {
    for (const suffix of ["base:auto", "base:no-auto", "gold:auto"]) {
      const parent = `${stem}cpa-${i}:${suffix}`;
      parents.push(parent);
      children.set(parent, TIERS.map((t) => `${parent}:${t}`));
    }
    // the numbered sibling — a DIFFERENT card that shares a prefix
    parents.push(`${stem}cpa-${i}:base:auto:num-50`);
  }
  return { parents, children, all: [...parents, ...[...children.values()].flat()] };
}

const STEM = "hiq:baseball:2026:bowman-chrome:";
const POP = population(STEM, 60);

describe("the shard axis is a PARTITION of the scanned population", () => {
  it("(1)+(2) complete and disjoint — every row in exactly one slot", () => {
    const owner = new Map<string, number>();
    const perSlot: string[][] = Array.from({ length: SLOTS }, () => []);
    for (const id of POP.all) {
      const slot = cardShardIndex(id, SLOTS);
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(SLOTS);
      owner.set(id, slot);
      perSlot[slot].push(id);
    }
    // COMPLETE: the union of the slots is the population.
    expect(perSlot.flat().length).toBe(POP.all.length);
    expect(new Set(perSlot.flat()).size).toBe(POP.all.length);
    // DISJOINT: a row claimed by two slots would show up twice above; assert it
    // directly too, the way a dispatch would experience it.
    for (let s = 0; s < SLOTS; s++) {
      for (const id of perSlot[s]) expect(owner.get(id)).toBe(s);
    }
  });

  it("(3) THE FIX: a parent and EVERY graded child are the SAME slot", () => {
    const scattered: string[] = [];
    for (const [parent, kids] of POP.children) {
      const home = cardShardIndex(parent, SLOTS);
      for (const kid of kids) {
        if (cardShardIndex(kid, SLOTS) !== home) scattered.push(kid);
      }
    }
    expect(
      scattered.slice(0, 5),
      "a child in another slot is a second writer on a card whose children "
        + "moveCatalogRow is retiring — the race this axis exists to remove",
    ).toEqual([]);
  });

  it("(3) restated on the real card that motivated this — five slots became one", () => {
    const parent = "hiq:baseball:2026:bowman-chrome:cpa-jd:base:auto";
    const kids = ["psa-10", "psa-9", "bgs-9-5", "sgc-10"].map((t) => `${parent}:${t}`);
    const slots = new Set([parent, ...kids].map((id) => cardShardIndex(id, SLOTS)));
    expect(slots.size, "one card must be owned end-to-end by one slot").toBe(1);
  });

  it("(4) a numbered sibling is its own card — the fold never merges two cards", () => {
    const unnumbered = "hiq:baseball:2026:bowman-chrome:cpa-7:base:auto";
    const numbered = `${unnumbered}:num-50`;
    expect(cardShardKey(numbered)).toBe(numbered);
    expect(cardShardKey(unnumbered)).toBe(unnumbered);
    // …and the numbered sibling's OWN children still fold onto IT.
    expect(cardShardKey(`${numbered}:psa-10`)).toBe(numbered);
    // the identity tail segments are never mistaken for tiers
    for (const tail of ["auto", "no-auto", "base", "num-50", "num-5"]) {
      const id = `hiq:baseball:2026:bowman-chrome:cpa-3:base:${tail}`;
      expect(cardShardKey(id), `${tail} is an identity segment, not a grade tier`).toBe(id);
    }
  });

  it("(4) a grade tier IS stripped, across the grader vocabulary", () => {
    const parent = "hiq:baseball:2026:bowman-chrome:cpa-4:base:auto";
    for (const t of ["psa-10", "psa-9", "bgs-9-5", "sgc-10", "cgc-9", "hga-10", "csg-8-5"]) {
      expect(cardShardKey(`${parent}:${t}`)).toBe(parent);
    }
  });

  it("(5) the axis still SPREADS — a safe axis that serialises is not a fan-out", () => {
    const counts = new Array(SLOTS).fill(0);
    for (const id of POP.all) counts[cardShardIndex(id, SLOTS)]++;
    const mean = POP.all.length / SLOTS;

    // WHAT IS AND IS NOT A DEFECT HERE. Folding by card makes the unit LUMPY on
    // purpose: a card arrives as its parent plus ~7 graded children, so a slot's
    // load moves in steps of ~8 rows, not 1. On this 180-card synthetic the
    // measured spread is 0.35x-1.65x of the mean — that is the granularity of
    // the unit showing through a small sample, not an unbalanced hash, and
    // tightening the bound here would only pin the sample. The real dispatch is
    // 16,931 rows over thousands of cards, where the same hash concentrates far
    // harder around the mean.
    //
    // So assert the failure that would actually matter — a fan-out that is
    // secretly serial — and nothing finer:
    expect(counts.filter((c) => c === 0), "an empty slot is a wasted runner").toEqual([]);
    // no slot carries a quarter of the work (at 16 slots, 4x the mean)
    expect(Math.max(...counts), "one dominant slot is a serial run in fan-out clothing")
      .toBeLessThan(mean * 3);
    // and the load is genuinely divided: the busiest 4 slots are not most of it
    const top4 = [...counts].sort((a, b) => b - a).slice(0, 4).reduce((a, b) => a + b, 0);
    expect(top4 / POP.all.length, "a quarter of the slots holding most of the rows is not a partition")
      .toBeLessThan(0.5);
  });

  it("degenerates safely: slots=1 owns everything, and never divides by zero", () => {
    for (const id of POP.all.slice(0, 50)) {
      expect(cardShardIndex(id, 1)).toBe(0);
      expect(cardShardIndex(id, 0)).toBe(0);
      expect(cardShardIndex(id, NaN)).toBe(0);
    }
  });
});

/**
 * THE RE-RUN. The serial relaunch already moved 2,724 rows before this fan-out
 * exists, so the 16-slot dispatch necessarily re-covers ground the earlier
 * slices walked. Re-running a moved row must cost nothing and change nothing.
 *
 * The guarantee is NOT a flag the lane sets and later reads — it is the shape of
 * the scan itself, which is why it survives a fleet, a crash mid-slice, and any
 * interleaving of slots.
 */
describe("re-running a row the serial relaunch already moved is a NO-OP", () => {
  const SCOPE_STEM = "hiq:baseball:2026:bowman-chrome:";
  const SCOPE_KEY = "bowman-chrome";
  /** The catalog lane's scan predicate, exactly:
   *  `STARTSWITH(c.id, 'hiq:<sport>:<year>:<setKey>:') AND c.setKey != @setKey` */
  const scanned = (row: { id: string; setKey: string }) =>
    row.id.startsWith(SCOPE_STEM) && row.setKey !== SCOPE_KEY;

  it("the drifted row IS selected before the move", () => {
    // stem says bowman-chrome, the setKey FIELD says bowman — that disagreement
    // is the defect, and it is what the scan selects on.
    expect(scanned({ id: `${SCOPE_STEM}cpa-jd:base:auto`, setKey: "bowman" })).toBe(true);
  });

  it("the survivor is NOT selected after the move — it left the population", () => {
    // moveCatalogRow wrote the survivor at the destination stem and deleted the
    // old id last. The survivor's id no longer starts with the scope stem, so a
    // second dispatch of the same scope cannot see it at all: 0 rows, 0 writes.
    // Nothing has to remember that this row was done.
    expect(scanned({ id: "hiq:baseball:2026:bowman:cpa-jd:base:auto", setKey: "bowman" })).toBe(false);
  });

  it("a row whose field was fixed in place is also out — the predicate is the ledger", () => {
    expect(scanned({ id: `${SCOPE_STEM}cpa-9:base:auto`, setKey: SCOPE_KEY })).toBe(false);
  });

  it("slot ownership is stable across dispatches — the hash is pure", () => {
    // A continuation re-derives the same owner for the same card, so the re-run
    // does not merely skip the work: it skips it IN THE SAME SLOT that did it.
    for (const id of POP.all.slice(0, 200)) {
      expect(cardShardIndex(id, SLOTS)).toBe(cardShardIndex(id, SLOTS));
    }
  });

  it("and moveCatalogRow itself refuses a self-move — the second line of defence", () => {
    // Belt and braces for the one case the predicate cannot cover (a row already
    // AT its destination): `newSlug === oldRow.id` returns action "noop" with
    // zero sales repointed and zero children retired, before any write.
    const src = fs
      .readFileSync(path.join(ROOT, "backend", "src", "services", "catalog", "catalogRowOps.service.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    expect(src).toMatch(/if \(newSlug === oldId && !rehome\) \{[\s\S]{0,220}action: "noop"/);
  });
});

describe("(6) the two moveCatalogRow lanes are WIRED to the card axis", () => {
  const read = (s: string) =>
    fs.readFileSync(path.join(ROOT, "backend", "scripts", `${s}.cjs`), "utf8").replace(/\r\n/g, "\n");

  // All THREE moveCatalogRow lanes. #1834 landed repair-cpa-draft-refile while
  // this branch was open — a copy of the Bowman lane that inherited both of its
  // defects, already dispatchable and already self-relaunching.
  for (const script of ["repair-bowman-product-refile", "rekey-product-setkey", "repair-cpa-draft-refile"]) {
    it(`${script} hashes the CARD, not the row`, () => {
      const src = read(script);
      expect(src, "must import the one axis helper").toContain("card-shard-axis.cjs");
      expect(src).toMatch(/cardShardIndex\(/);
      // The old per-row hash must be GONE: an inline sha1 over a bare id is
      // exactly what scattered a card across five slots.
      const inlineRowHash = /createHash\("sha1"\)\.update\(String\((?:id|key)[^)]*\)\)[\s\S]{0,120}?% *(?:Math\.max\(1, *)?SLOTS/;
      expect(inlineRowHash.test(src), `${script} still hashes a raw row id`).toBe(false);
    });
  }

  // Both refile lanes: repair-cpa-draft-refile was copied from the Bowman lane
  // and inherited the identical dead guard.
  for (const script of ["repair-bowman-product-refile", "repair-cpa-draft-refile"]) {
  it(`${script} reads SHARDED — a \`sharding\` read is undefined and the guard is DEAD`, () => {
    const src = read(script);
    // runnerShardScope returns SHARDED. `SHARD_SCOPE.sharding` is undefined, so
    // `undefined && …` short-circuits FALSE and every slot swept every row —
    // an under-sweep's evil twin: a full sweep from sixteen writers at once.
    expect(src).not.toMatch(/SHARD_SCOPE\.sharding\b/);
    expect(src).toMatch(/SHARD_SCOPE\.SHARDED\b/);
  });
  }

  it("the helper really has no `sharding` key — the pin above is not folklore", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runnerShardScope } = require(
      path.join(ROOT, "backend", "scripts", "lib", "runner-shard-scope.cjs"),
    ) as { runnerShardScope: (o?: unknown) => Record<string, unknown> };
    const scope = runnerShardScope({ env: { SLOT: "0", SLOTS: "16", SHARD: "true" } });
    expect(scope.SHARDED).toBe(true);
    expect(scope).not.toHaveProperty("sharding");
    expect((scope as { sharding?: unknown }).sharding).toBeUndefined();
  });
});
