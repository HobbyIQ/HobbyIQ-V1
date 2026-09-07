/**
 * CF-A-SCOPED-APPLY-DOES-NOT-RECLASSIFY-THE-WORLD (2026-09-07).
 *
 * WHAT HAPPENED. Slot 12 of the fleet-1897 ruled-scopes fleet ran
 * `MODE=apply-improve scope=grade-from-title` for its full 120-minute budget,
 * classified 350,267 rows, and wrote NOTHING -- because its census found zero
 * GRADE-FROM-TITLE candidates in the shard. The run then annotated itself
 * "budget hit on an APPLY of slot 12 (written=0) -- re-dispatching as a
 * REPORT", which read as a truncated apply and cost a second two-hour
 * dispatch. It was not truncated. It walked its whole shard and found none of
 * the one class it was armed to write.
 *
 * WHERE THE TIME WENT. Not the classifier -- #1667 already fixed that, and
 * `rematchCensusThroughput` pins it at ~0.02 ms/row. The cost is the I/O the
 * classification needs: a derivation, the `checklistBacked` catalog point read
 * on every derivable row, and the per-product map reads behind the clash and
 * flagship gates. 350,267 rows in 119 minutes is ~49 rows/s, and essentially
 * all of it bought answers about rows that could never be written.
 *
 * THE FIX. A scoped apply arms exactly ONE class, and two of the ruled scopes
 * have a NECESSARY CONDITION that can be read off the stored row alone -- no
 * derivation, no catalog read. GRADE-FROM-TITLE's G1 (the row is field-raw)
 * and G2 (its title names exactly one grader) are both pure field tests, and a
 * row failing either could never have qualified. Measured on the 5,000-row
 * throughput fixture: 76.6% of rows are field-raw and 22.5% name a grader, but
 * only 0.84% are BOTH -- so ~99% of a grade-from-title shard is provably not a
 * candidate before a single byte is read from Cosmos.
 *
 * WHAT THIS FILE PINS
 *
 *   A. THE NECESSARY-CONDITION PROPERTY, which is the entire safety argument:
 *      over both real fixtures, EVERY row the classifier calls a candidate
 *      survives the prefilter. A prefilter that dropped one would silently
 *      shrink an apply's population, which is a correctness bug and not a
 *      speedup.
 *   B. The prefilter is NEVER applied where it would change what is counted:
 *      a multi-kind scope filters nothing, and the two kinds with no cheap
 *      necessary condition are never filtered at all.
 *   C. The selectivity that makes it worth having, on real rows.
 *   D. The lookups a filtered pass avoids are proportional to the SURVIVORS,
 *      not to the shard -- the throughput property, measured over a fake
 *      container so it needs no Cosmos.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;

type Entry = {
  row: Record<string, unknown>; stored: Record<string, unknown> | null;
  derived: Record<string, unknown> | null;
  derivationReasons?: string[]; storedSlug?: string | null; baseDestSlug?: string | null;
};
const fixture = (name: string): Entry[] =>
  JSON.parse(fs.readFileSync(path.join(backend, "tests", "fixtures", name), "utf8")).rows;

const inputFor = (e: Entry) => ({
  row: e.row, stored: e.stored, derived: e.derived, checklistBacked: false,
  derivationReasons: e.derivationReasons ?? [], storedSlug: e.storedSlug ?? null,
  baseDestSlug: e.baseDestSlug ?? null, baseDestBacked: false,
});

const ALL: Entry[] = [
  ...fixture("rematch-throughput-5k.json"),
  ...fixture("rematch-verdict-equality-200.json"),
];

describe("A. the prefilter is a NECESSARY condition -- it never drops a real candidate", () => {
  for (const kind of [K.GRADE_FROM_TITLE, K.YEAR_FROM_TITLE_VINTAGE]) {
    it(`every ${kind} candidate the classifier finds survives the prefilter`, { timeout: 120_000 }, () => {
      const pf = K.applyPrefilterFor(new Set([kind]));
      expect(typeof pf).toBe("function");

      const dropped: string[] = [];
      let candidates = 0;
      for (const e of ALL) {
        const res = K.classifyRow(inputFor(e));
        if (K.applyKindOf(res) !== kind) continue;
        candidates++;
        // THE PROPERTY. A row the apply would WRITE must never be filtered
        // out before it is classified. This is the whole safety argument for
        // skipping the other 99%.
        if (!pf({ row: e.row, stored: e.stored })) {
          dropped.push(String(e.row.id ?? e.row.cardId ?? "?"));
        }
      }
      expect(dropped).toEqual([]);
      // Guard the guard for the kind the fixtures actually exercise: a pin
      // that found no candidates at all would pass vacuously.
      if (kind === K.GRADE_FROM_TITLE) expect(candidates).toBeGreaterThan(0);
    });
  }

  it("the prefilter reads the STORED row only -- never the derivation", () => {
    const pf = K.applyPrefilterFor(new Set([K.GRADE_FROM_TITLE]));
    // Same row, three different derivations: the answer cannot move, because
    // the prefilter decides which rows are LOOKED AT and the classifier
    // decides what they ARE. A prefilter that read the derivation would make
    // a pass's own population depend on the deriver's current opinion, and
    // two runs of one dispatch would disagree.
    const row = { title: "1953 Topps #54 PSA 5", cardId: "hiq:baseball:1953:topps:54:base:no-auto" };
    const stored = { gradeCompany: null, gradeValue: null };
    expect(pf({ row, stored })).toBe(true);
    expect(pf({ row, stored, derived: { setKey: "something-else" } })).toBe(true);
    expect(pf({ row, stored, derived: null })).toBe(true);
  });
});

describe("B. the prefilter is refused wherever it would change what is counted", () => {
  it("a multi-kind scope gets NO prefilter -- the rows are a union of two populations", () => {
    // scope=both arms IMPROVE and BASE-EVICTION; a filter for either would
    // discard the other candidates.
    expect(K.applyPrefilterFor(new Set([K.GRADE_FROM_TITLE, K.IMPROVE]))).toBeNull();
    expect(K.applyPrefilterFor(new Set([K.IMPROVE, K.BASE_EVICTION]))).toBeNull();
    expect(K.applyPrefilterFor(new Set())).toBeNull();
  });

  it("IMPROVE and BASE-EVICTION have no cheap necessary condition and are never filtered", () => {
    // Any row can be either, so there is nothing safe to test off the row
    // alone. scope=improve and scope=both must behave exactly as before.
    expect(K.applyPrefilterFor(new Set([K.IMPROVE]))).toBeNull();
    expect(K.applyPrefilterFor(new Set([K.BASE_EVICTION]))).toBeNull();
  });

  it("the GRADE-FROM-TITLE prefilter implements G1 and G2, and only those", () => {
    const pf = K.applyPrefilterFor(new Set([K.GRADE_FROM_TITLE]));
    const raw = { gradeCompany: null, gradeValue: null };
    // G1: a row that already carries a grade is not this defect.
    expect(pf({ row: { title: "1953 Topps PSA 5" }, stored: { gradeCompany: "PSA", gradeValue: 5 } })).toBe(false);
    // G2: no grader token named at all.
    expect(pf({ row: { title: "1953 Topps #54 Mint" }, stored: raw })).toBe(false);
    // G2: two distinct graders describe two slabs, never one row grade.
    expect(pf({ row: { title: "PSA 5 and BGS 7 lot" }, stored: raw })).toBe(false);
    // Both legs pass -- and the row is only a CANDIDATE here. G3-G7 still run
    // in the classifier; this pin must not be read as claiming it qualifies.
    expect(pf({ row: { title: "1953 Topps #54 PSA 5" }, stored: raw })).toBe(true);
  });
});

describe("C. the selectivity that makes it worth having", () => {
  it("keeps under 5% of real rows for grade-from-title", () => {
    const pf = K.applyPrefilterFor(new Set([K.GRADE_FROM_TITLE]));
    const kept = ALL.filter((e) => pf({ row: e.row, stored: e.stored })).length;
    // Measured 0.81% on these fixtures. The ceiling is loose so ordinary
    // corpus drift does not fail the suite, but a prefilter that stopped
    // filtering -- or was quietly reduced to a constant true -- does.
    expect(kept).toBeLessThan(ALL.length * 0.05);
    expect(kept).toBeGreaterThan(0);
  });
});

describe("D. a filtered pass catalog lookups scale with the SURVIVORS, not the shard", () => {
  it("N rows over a fake container issue lookups proportional to what survived", () => {
    // THE THROUGHPUT PROPERTY, stated as a count rather than a clock: the
    // expensive per-row work is the catalog read, so what must be pinned is
    // that a shard of N rows does not pay N of them. This models the driver
    // loop shape -- prefilter first, then the reads classification needs --
    // over a fake container, so it needs neither Cosmos nor dist/.
    const pf = K.applyPrefilterFor(new Set([K.GRADE_FROM_TITLE]));

    let reads = 0;
    const catalog = { read: (_slug: string) => { reads++; return null; } };

    // The loop the driver runs: a row the prefilter refuses costs no read.
    for (const e of ALL) {
      if (!pf({ row: e.row, stored: e.stored })) continue;
      catalog.read(String(e.row.cardId ?? ""));      // what classification needs
    }

    const survivors = ALL.filter((e) => pf({ row: e.row, stored: e.stored })).length;
    expect(reads).toBe(survivors);
    // The number that matters: the unfiltered pass would have issued one per
    // row. Slot 12 350,267 reads become roughly 2,800.
    expect(reads).toBeLessThan(ALL.length / 20);
  });

  it("the prefilter itself is cheap enough to run on every row", () => {
    const pf = K.applyPrefilterFor(new Set([K.GRADE_FROM_TITLE]));
    const inputs = ALL.map((e) => ({ row: e.row, stored: e.stored }));
    for (let i = 0; i < 200; i++) pf(inputs[i % inputs.length]);   // warm
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) for (const x of inputs) pf(x);
    const ms = performance.now() - t0;
    // 52,000 evaluations. A prefilter that cost as much as the classification
    // it avoids would be pointless; this is two field tests and one regex.
    expect(ms).toBeLessThan(5_000);
  });
});
