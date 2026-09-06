/**
 * I9 SAMPLING FRAME — the pins (#1872).
 *
 * CF-A-FRAME-IS-PART-OF-THE-FINDING (2026-09-06). I9's frame was
 * `OFFSET floor((nowMs/86400000) % 50) * 500 LIMIT 2000` over a 16.7M-row pool,
 * and its own comment called that "A RANDOM sample". Three things were wrong and
 * each one gets a pin here:
 *
 *   1. the frame could not reach a row past index 26,500 (0.16% of the corpus)
 *   2. with no ORDER BY, OFFSET walks page order = partition order = cardId
 *      order, so the sample collapsed onto a handful of hot cards
 *   3. nothing compared the sample's class shares against a known-good census,
 *      so a sample with ZERO AGREE rows — against a 47.1% census share —
 *      reported a TRUE-DISAGREEMENT rate that read like a corpus rate
 *
 * The mutation each pin defends: revert to the old offset space and the first
 * test goes red; drop the per-card cap and the second goes red; remove the
 * frame-health flags and the third goes red.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INV = require_(path.join(backend, "scripts", "lib", "corpus-invariants.cjs"));
const SHARD_TABLE = require_(path.join(backend, "data", "rematch-shard-table.json"));

/** The ceiling the OLD frame could never see past: 50 offsets x 500 + 2000. */
const OLD_FRAME_CEILING = 26_500;
const NOW = Date.parse("2026-09-06T07:22:25.176Z");

describe("the frame reaches the corpus, not one page of it", () => {
  it("draws from every measured shard-table slot", () => {
    const frame = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW, target: 2000 });
    expect(frame.plan.length).toBe(SHARD_TABLE.slots.length);
    expect(frame.plan.length).toBe(32);
  });

  it("reaches rows far beyond the old 26,500-row ceiling", () => {
    // THE MUTATION THIS CATCHES: restoring `floor((now/86400000) % 50) * 500`
    // capped the frame at row index 26,500 of 16.7M. The frame now draws from
    // slots whose OWN measured row counts dwarf that ceiling, so the corpus past
    // index 26,500 is reachable at all — most slots are individually bigger than
    // the entire old frame.
    const frame = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW, target: 2000 });
    const reach = frame.plan.map((p: { unitRows: number }) => p.unitRows);
    const beyond = reach.filter((n) => n > OLD_FRAME_CEILING);
    expect(beyond.length).toBeGreaterThan(reach.length / 2);
    expect(Math.max(...reach)).toBeGreaterThan(100_000);
    // Total rows the frame can draw from, vs the old frame's hard 26,500.
    const total = reach.reduce((a: number, b: number) => a + b, 0);
    expect(total).toBeGreaterThan(5_000_000);
  });

  it("SEEKS on soldAt and never pays an OFFSET skip", () => {
    // A large OFFSET is charged for every document it passes over — ~2.2M RU a
    // night on this table. THE MUTATION THIS CATCHES: reintroducing `offset`
    // puts the skip cost back.
    const frame = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW, target: 2000 });
    for (const entry of frame.plan) {
      expect(entry).not.toHaveProperty("offset");
      expect(typeof entry.seekFrom).toBe("string");
      expect(Number.isFinite(Date.parse(entry.seekFrom))).toBe(true);
      expect(Date.parse(entry.seekFrom)).toBeLessThanOrEqual(NOW);
    }
  });

  it("spans many years — the old frame saw one page of one partition", () => {
    const frame = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW, target: 2000 });
    const years = new Set(frame.plan.map((p: { unit: { year: number } }) => p.unit?.year));
    expect(years.size).toBeGreaterThan(8);
  });

  it("is reproducible within a UTC day and sweeps across days", () => {
    const a = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW, target: 2000 });
    const b = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW + 3 * 3600_000, target: 2000 });
    const c = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW + 86_400_000, target: 2000 });
    const seeks = (fr: { plan: { seekFrom: string }[] }) => fr.plan.map((p) => p.seekFrom).join(",");
    // Same day, same rows: a delta between two runs is a CORPUS change, never a
    // frame change.
    expect(seeks(b)).toBe(seeks(a));
    // Next day, different window: the frame sweeps rather than re-reading.
    expect(seeks(c)).not.toBe(seeks(a));
  });

  it("seeks inside the pool's real sale-date span", () => {
    const frame = INV.buildSampleFrame({ shardTable: SHARD_TABLE, nowMs: NOW, target: 2000 });
    const floorMs = Date.parse("2018-01-01T00:00:00Z");
    for (const entry of frame.plan) {
      expect(Date.parse(entry.seekFrom)).toBeGreaterThanOrEqual(floorMs);
    }
    // The seeds must not all collapse onto one date — that would be a frame
    // that reads the same window from every slot.
    const distinct = new Set(frame.plan.map((p: { seekFrom: string }) => p.seekFrom));
    expect(distinct.size).toBeGreaterThan(frame.plan.length / 2);
  });

  it("survives an empty or malformed shard table without throwing", () => {
    expect(INV.buildSampleFrame({ shardTable: null, nowMs: NOW }).plan).toEqual([]);
    expect(INV.buildSampleFrame({ shardTable: { slots: [] }, nowMs: NOW }).plan).toEqual([]);
  });
});

describe("one reservoir per cardId — a hot pool cannot fill the sample", () => {
  it("keeps at most the cap from any one card", () => {
    // The 2026-09-06 artifact: 25 retained rows collapsed onto ~6 cardIds, one
    // card contributing 8. THE MUTATION THIS CATCHES: removing the cap lets all
    // 50 rows through.
    const res = INV.makeCardReservoir(4);
    for (let i = 0; i < 50; i++) res.offer({ id: `row-${i}`, cardId: "HOT-CARD" });
    expect(res.rows().length).toBe(4);
    expect(res.droppedToCap()).toBe(46);
    expect(res.distinctCards()).toBe(1);
  });

  it("lets a broad sample through untouched", () => {
    const res = INV.makeCardReservoir(4);
    for (let c = 0; c < 200; c++) for (let i = 0; i < 3; i++) res.offer({ id: `${c}-${i}`, cardId: `CARD-${c}` });
    expect(res.rows().length).toBe(600);
    expect(res.droppedToCap()).toBe(0);
    expect(res.distinctCards()).toBe(200);
  });

  it("falls back to the slug when a row carries no cardId", () => {
    const res = INV.makeCardReservoir(2);
    for (let i = 0; i < 5; i++) res.offer({ id: `r${i}`, hobbyiqCardId: "hiq:baseball:1956:topps:10:base:no-auto" });
    expect(res.rows().length).toBe(2);
  });
});

describe("frame health — a rate whose frame is broken is not a corpus rate", () => {
  it("flags the real 2026-09-06 sample: zero AGREE and six cards", () => {
    // The artifact that started this: 2,000 rows, CONFLICT 1,178 +
    // UNDERIVABLE 822, ZERO AGREE, ~6 distinct cards — against a census that is
    // 47.1% AGREE. THE MUTATION THIS CATCHES: dropping the flags reports this
    // as a clean 15.4% TRUE-DISAGREEMENT rate.
    const health = INV.frameHealth({
      byClass: { CONFLICT: 1178, UNDERIVABLE: 822 },
      distinctCards: 6,
      sampled: 2000,
    });
    expect(health.healthy).toBe(false);
    expect(health.flags.join(" ")).toMatch(/zero-AGREE/);
    expect(health.flags.join(" ")).toMatch(/too-few-cards/);
  });

  it("passes a sample that reproduces the census shares", () => {
    // Reproduces the 32-SLOT weighted corpus average (AGREE 0.424, IMPROVE
    // 0.034, CONFLICT 0.408, UNDERIVABLE 0.082), not slot 31's.
    const health = INV.frameHealth({
      byClass: { AGREE: 848, IMPROVE: 69, CONFLICT: 816, UNDERIVABLE: 165 },
      distinctCards: 850,
      sampled: 2000,
    });
    expect(health.healthy).toBe(true);
    expect(health.flags).toEqual([]);
    expect(Math.abs(health.drift.AGREE.delta)).toBeLessThan(0.05);
    expect(Math.abs(health.drift.CONFLICT.delta)).toBeLessThan(0.05);
  });

  it("reports drift against the census for every class, breach or not", () => {
    const health = INV.frameHealth({
      byClass: { AGREE: 200, IMPROVE: 10, CONFLICT: 700, UNDERIVABLE: 90 },
      distinctCards: 400,
      sampled: 1000,
    });
    // Drift is a NOTE — the corpus legitimately moves. What matters is that the
    // movement is visible rather than assumed.
    expect(health.healthy).toBe(true);
    expect(health.drift.CONFLICT.sampled).toBeCloseTo(0.7, 3);
    // The corpus number, not slot 31's 0.206.
    expect(health.drift.CONFLICT.census).toBeCloseTo(0.408, 2);
    expect(health.drift.CONFLICT.delta).toBeGreaterThan(0.25);
  });

  it("carries the census reference it compares against", () => {
    // CF-THE-REFERENCE-IS-THE-WHOLE-CORPUS-NOT-ONE-SLOT (2026-09-06). The
    // reference is the ROW-WEIGHTED average over all 32 census slots
    // (16,716,343 rows), not slot 31 alone.
    expect(INV.CENSUS_REFERENCE_SHARES.slots).toBe(32);
    expect(INV.CENSUS_REFERENCE_SHARES.AGREE).toBeCloseTo(0.424, 2);
    expect(INV.CENSUS_REFERENCE_SHARES.CONFLICT).toBeCloseTo(0.408, 2);
    expect(INV.CENSUS_REFERENCE_SHARES.source).toMatch(/32\/32 slots/);
    expect(INV.FRAME_MIN_DISTINCT_CARDS).toBe(100);
  });

  // ── THE 32-SLOT REFERENCE, AND WHAT A SINGLE-SLOT ONE COSTS ──────────────

  it("MUTATION: a single-slot reference is red — slot 31 is not the corpus", () => {
    // THE DEFECT THIS PR EXISTS FOR. The reference used to be slot 31 alone:
    // 509,224 rows, 3.1% of the corpus, all vintage year-buckets (1989, 1995,
    // 1975, 1978, 1909). The #1874 frame draws all 32 slots, which are modern-
    // and pokemon-heavy, so "CONFLICT 55% vs 20.6%" in the 2026-09-06 artifact
    // measured a STRUCTURAL MISMATCH and read as a corpus-wide regression.
    //
    // Reverting to slot 31's numbers makes this test red: its CONFLICT share is
    // less than HALF the corpus's, which is the whole error.
    const slot31 = INV.censusSharesForSlot(31);
    expect(slot31.CONFLICT).toBeCloseTo(0.206, 2);
    expect(INV.CENSUS_REFERENCE_SHARES.CONFLICT).toBeGreaterThan(slot31.CONFLICT * 1.8);
    // And the table is genuinely 32 slots, not one repeated.
    expect(INV.CENSUS_TABLE.slots).toHaveLength(32);
    expect(new Set(INV.CENSUS_TABLE.slots.map((r) => r.slot)).size).toBe(32);
    expect(INV.CENSUS_TABLE.classifiedTotal).toBeGreaterThan(16_000_000);
  });

  it("holds each slot's OWN shares, and they differ enormously", () => {
    // A per-slot reference is only worth holding if the slots actually differ.
    // They differ by 20x on AGREE: slot 7 (pokemon) is 3.3%, slot 6 is 63.6%.
    const s7 = INV.censusSharesForSlot(7);
    const s6 = INV.censusSharesForSlot(6);
    expect(s7.AGREE).toBeLessThan(0.05);
    expect(s6.AGREE).toBeGreaterThan(0.60);
    for (let i = 0; i < 32; i++) {
      const sh = INV.censusSharesForSlot(i);
      expect(sh, `slot ${i} has no census shares`).toBeTruthy();
      for (const k of ["AGREE", "IMPROVE", "CONFLICT", "UNDERIVABLE"]) {
        expect(sh[k]).toBeGreaterThanOrEqual(0);
        expect(sh[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("compares each slot's draw to that slot's own census, not to the average", () => {
    // A draw that is entirely slot 7 (pokemon, census CONFLICT 0.605) at 60%
    // CONFLICT is NORMAL for slot 7 and would look like a catastrophe against
    // the corpus average of 0.408. The per-slot line is what says so.
    const verdicts = [
      ...Array.from({ length: 60 }, () => ({ klass: "CONFLICT", __frameSlot: 7 })),
      ...Array.from({ length: 24 }, () => ({ klass: "UNDERIVABLE", __frameSlot: 7 })),
      ...Array.from({ length: 12 }, () => ({ klass: "IMPROVE", __frameSlot: 7 })),
      ...Array.from({ length: 4 }, () => ({ klass: "AGREE", __frameSlot: 7 })),
    ];
    const health = INV.frameHealth({
      byClass: { CONFLICT: 60, UNDERIVABLE: 24, IMPROVE: 12, AGREE: 4 },
      distinctCards: 400,
      sampled: 100,
      verdicts,
    });
    const slot7 = health.bySlot.find((s) => s.slot === 7);
    expect(slot7).toBeTruthy();
    expect(slot7.sampled).toBe(100);
    // Against slot 7's OWN census this is a near-perfect reproduction...
    expect(Math.abs(slot7.drift.CONFLICT.delta)).toBeLessThan(0.05);
    // ...while against the corpus average it looks like a 20pp regression.
    expect(health.drift.CONFLICT.delta).toBeGreaterThan(0.15);
  });

  it("MUTATION: dropping the slot tag loses the per-slot comparison entirely", () => {
    // The verdicts carry `__frameSlot` because the reservoir pools every slot's
    // draw into one list. Remove that tag and `bySlot` is empty -- the exact
    // state the auditor was in, where 32 populations were scored as one.
    const health = INV.frameHealth({
      byClass: { CONFLICT: 60, AGREE: 40 },
      distinctCards: 400,
      sampled: 100,
      verdicts: [
        ...Array.from({ length: 60 }, () => ({ klass: "CONFLICT" })),
        ...Array.from({ length: 40 }, () => ({ klass: "AGREE" })),
      ],
    });
    expect(health.bySlot).toEqual([]);
    expect(health.bySportClass).toEqual([]);
  });

  // ── PER-CLASS FRAME HEALTH ───────────────────────────────────────────────

  it("reports frame health per sportClass so a hard draw is not a regression", () => {
    // The classes have very different CONFLICT rates, and that is the whole
    // reason a mix statement is needed:
    //     pokemon 0.596   modern 0.418   vintage 0.319
    const pokemon = INV.censusSharesForClass("pokemon");
    const vintage = INV.censusSharesForClass("vintage");
    const modern = INV.censusSharesForClass("modern");
    expect(pokemon.CONFLICT).toBeGreaterThan(0.55);
    expect(vintage.CONFLICT).toBeLessThan(0.35);
    expect(modern.CONFLICT).toBeGreaterThan(vintage.CONFLICT);
    // A pokemon-heavy draw reports its class mix, so the reader can see that a
    // high CONFLICT share is the FRAME and not corpus movement.
    const verdicts = [
      ...Array.from({ length: 70 }, () => ({ klass: "CONFLICT", __frameSlot: 7 })),
      ...Array.from({ length: 30 }, () => ({ klass: "AGREE", __frameSlot: 7 })),
    ];
    const health = INV.frameHealth({
      byClass: { CONFLICT: 70, AGREE: 30 }, distinctCards: 400, sampled: 100, verdicts,
    });
    const classes = health.bySportClass.map((c) => c.sportClass);
    expect(classes).toContain("pokemon");
    // Slot 7's frame is dominated by pokemon, so the expected shares blended
    // from its own mix are far from the corpus average.
    expect(health.expectedForThisMix).toBeTruthy();
    expect(health.expectedForThisMix.CONFLICT)
      .toBeGreaterThan(INV.CENSUS_REFERENCE_SHARES.CONFLICT);
  });

  it("a slot's class mix is apportioned BY ROWS, not counted whole into each", () => {
    // Slot 0 is 484,940 pokemon rows + 39,000 rows of 1953 -- 93/7, not 50/50.
    // Weighting a slot's whole draw into every class it touches (the first cut)
    // made modern and vintage almost identical, which is the same structural
    // blindness the single-slot reference had.
    const mix = INV.censusClassMixForSlot(0);
    expect(mix.pokemon).toBeGreaterThan(0.9);
    expect(mix.vintage).toBeLessThan(0.1);
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
  });

  it("every shard-table slot has a census row, and vice versa", () => {
    // A slot with no reference silently falls back to the corpus average, which
    // is the failure this PR removes. The two tables must stay aligned.
    const censusSlots = new Set(INV.CENSUS_TABLE.slots.map((r) => Number(r.slot)));
    for (const s of SHARD_TABLE.slots) {
      expect(censusSlots.has(Number(s.slot)), `slot ${s.slot} has no census row`).toBe(true);
    }
    expect(censusSlots.size).toBe(SHARD_TABLE.slots.length);
  });

  // ── THE ALARM IS DRIFT, NOT LEVEL (Drew ruling, 2026-09-06) ──────────────
  //
  // I9 used to breach on an ABSOLUTE rate: TRUE-DISAGREEMENT over 35%. That
  // number cannot tell "the corpus got worse last night" from "the frame drew a
  // harder part of the corpus". The 2026-09-06 artifact is the proof -- 50.28%
  // reported as a breach, on a corpus whose own CONFLICT share is 40.8% and
  // whose pokemon slots sit at 59.6%. A pokemon-weighted draw is over 35% by
  // construction and always would be.

  /** A frame-health class row, the shape `frameHealth().bySportClass` emits. */
  const classRow = (sportClass: string, sampled: number, census: number, n = 300) => ({
    sportClass,
    sampledApprox: n,
    shareOfFrame: 0.33,
    conflict: { sampled, census, delta: Number((sampled - census).toFixed(6)) },
  });

  const CENSUS_OF = (cls: string) => INV.censusSharesForClass(cls).CONFLICT;

  it("a night that matches its reference is CLEAN, at any absolute level", () => {
    // Every class exactly on its own census. Pokemon's census CONFLICT is
    // 59.6%, so this night's overall level is far above the old 35% threshold
    // and is nonetheless the healthiest night possible: nothing moved.
    const drift = INV.evaluateDrift("I9", {
      byClassFrame: [
        classRow("pokemon", CENSUS_OF("pokemon"), CENSUS_OF("pokemon")),
        classRow("modern", CENSUS_OF("modern"), CENSUS_OF("modern"), 600),
        classRow("vintage", CENSUS_OF("vintage"), CENSUS_OF("vintage")),
      ],
      sample: 1764,
      breaches: 887,
    });
    expect(drift).toBeNull();
  });

  it("+6 points in one class BREACHES, and the message names that class", () => {
    const drift = INV.evaluateDrift("I9", {
      byClassFrame: [
        classRow("pokemon", CENSUS_OF("pokemon"), CENSUS_OF("pokemon")),
        classRow("modern", CENSUS_OF("modern") + 0.06, CENSUS_OF("modern"), 600),
        classRow("vintage", CENSUS_OF("vintage"), CENSUS_OF("vintage")),
      ],
      sample: 1764,
      breaches: 887,
    });
    expect(drift).toBeTruthy();
    expect(drift.worstClass).toBe("modern");
    expect(drift.thresholdKind).toBe("drift-points");
    expect(drift.message).toMatch(/modern/);
    // The class that did NOT move must not be blamed for the one that did.
    expect(drift.classes).toHaveLength(1);
    expect(drift.message).not.toMatch(/pokemon/);
  });

  it("an absolute 44% with ZERO drift is CLEAN — the level is a trend line", () => {
    // 44% is well over the retired 35% threshold. Every class sits on its own
    // reference, so nothing moved and nothing breaches. THE MUTATION THIS
    // CATCHES: restoring the absolute gate turns this night red.
    const byClassFrame = [
      classRow("pokemon", CENSUS_OF("pokemon"), CENSUS_OF("pokemon")),
      classRow("modern", CENSUS_OF("modern"), CENSUS_OF("modern"), 600),
      classRow("vintage", CENSUS_OF("vintage"), CENSUS_OF("vintage")),
    ];
    expect(INV.evaluateDrift("I9", { byClassFrame, sample: 1000, breaches: 440 })).toBeNull();
    // ...and the absolute evaluator refuses to gate I9 at all now.
    expect(INV.evaluateThreshold("I9", { breaches: 440, sample: 1000 })).toBeNull();
  });

  it("MUTATION: the absolute threshold is GONE as a gate, kept only as a note", () => {
    // Reverting `driftPoints` to `rate: 0.35` makes evaluateThreshold fire
    // again, and every one of these becomes a breach on level alone.
    const inv = INV.INVARIANT_BY_ID.get("I9");
    expect(inv.driftPoints).toBeCloseTo(0.05, 5);
    expect(inv.rate).toBeUndefined();
    // The 35% figure survives as a REPORTED reference point, never evaluated.
    expect(inv.reportRate).toBeCloseTo(0.35, 5);
    for (const breaches of [440, 887, 1200, 1764]) {
      expect(
        INV.evaluateThreshold("I9", { breaches, sample: 1764 }),
        `absolute level ${breaches}/1764 must not gate`,
      ).toBeNull();
    }
  });

  it("MUTATION: the real 2026-09-06 night — a breach on level, clean on drift", () => {
    // The artifact reported 50.28% TRUE-DISAGREEMENT against a 35% threshold
    // and called it a breach. Rebuild a night of that shape -- every slot
    // reproducing its OWN census -- and the drift alarm passes it, because
    // nothing moved: the level was the frame's composition all along.
    const verdicts: any[] = [];
    for (const row of INV.CENSUS_TABLE.slots) {
      const n = 55;
      for (const k of ["AGREE", "IMPROVE", "CONFLICT", "UNDERIVABLE"]) {
        for (let i = 0; i < Math.round(n * row.shares[k]); i++) {
          verdicts.push({ klass: k, __frameSlot: row.slot });
        }
      }
    }
    const byClass: Record<string, number> = {};
    for (const v of verdicts) byClass[v.klass] = (byClass[v.klass] ?? 0) + 1;
    const health = INV.frameHealth({
      byClass, distinctCards: 1321, sampled: verdicts.length, verdicts,
    });
    // The night's absolute CONFLICT level is well over the retired threshold...
    expect(health.drift.CONFLICT.sampled).toBeGreaterThan(0.35);
    // ...and every class is within a couple of points of its own reference.
    for (const c of health.bySportClass) {
      expect(Math.abs(c.conflict.delta), `${c.sportClass} moved`).toBeLessThan(0.05);
    }
    expect(INV.evaluateDrift("I9", {
      byClassFrame: health.bySportClass, sample: verdicts.length, breaches: 887,
    })).toBeNull();
  });

  it("only a class ABOVE its reference breaches — improvement is not an alarm", () => {
    // A night 20 points BETTER than its census is a repair landing. An alarm
    // that fires on getting better trains people to silence it.
    const drift = INV.evaluateDrift("I9", {
      byClassFrame: [classRow("pokemon", CENSUS_OF("pokemon") - 0.20, CENSUS_OF("pokemon"))],
      sample: 1000, breaches: 200,
    });
    expect(drift).toBeNull();
  });

  it("a class below the row floor is reported but never gates", () => {
    // A 5-point move on nine rows is one row, and the frame draws unevenly
    // across classes. Below MIN_CLASS_ROWS the class is carried in `belowFloor`
    // for the reader and cannot raise a breach on its own.
    const thin = INV.evaluateDrift("I9", {
      byClassFrame: [classRow("pokemon", CENSUS_OF("pokemon") + 0.20, CENSUS_OF("pokemon"), 9)],
      sample: 100, breaches: 50,
    });
    expect(thin).toBeNull();
    // The same move on a real sample DOES breach, so the floor is a floor and
    // not a silencer.
    const thick = INV.evaluateDrift("I9", {
      byClassFrame: [classRow("pokemon", CENSUS_OF("pokemon") + 0.20, CENSUS_OF("pokemon"), INV.MIN_CLASS_ROWS)],
      sample: 1000, breaches: 500,
    });
    expect(thick).toBeTruthy();
    expect(thick.worstClass).toBe("pokemon");
  });

  it("the drift reference is the per-class census from #1888, not a constant", () => {
    // The alarm is only as good as what it compares against. Each class must
    // resolve to its own row-weighted census share.
    for (const cls of ["pokemon", "modern", "vintage"]) {
      const sh = INV.censusSharesForClass(cls);
      expect(sh, `${cls} has no census reference`).toBeTruthy();
      expect(sh.CONFLICT).toBeGreaterThan(0);
      expect(sh.CONFLICT).toBeLessThan(1);
    }
    // And they must genuinely differ, or a per-class alarm is a global one.
    expect(CENSUS_OF("pokemon")).toBeGreaterThan(CENSUS_OF("modern") + 0.1);
    expect(CENSUS_OF("modern")).toBeGreaterThan(CENSUS_OF("vintage"));
  });

  it("the drift is measured CONFLICT-to-CONFLICT, not against a subset", () => {
    // THE SUBTLE ONE. The census emits `counts.CONFLICT` and does NOT split
    // TRUE-DISAGREEMENT from NEEDS-CHECKLIST; the nightly audit does. Comparing
    // the audit's TRUE-DISAGREEMENT against a census CONFLICT would compare a
    // subset to its superset and understate drift by the NEEDS-CHECKLIST share
    // -- 5.1pp on the 2026-09-06 artifact (887 TRUE-DIS + 90 NEEDS-CL = 977
    // CONFLICT of 1,764), which is the entire 5pp threshold. A silent swap to
    // the subset would therefore hide exactly one threshold's worth of drift.
    //
    // The alarm reads `conflict.sampled` off the frame-health class rows, so a
    // class sitting 6pp over on CONFLICT breaches REGARDLESS of what the
    // `breaches` (TRUE-DISAGREEMENT) count says.
    const over = INV.evaluateDrift("I9", {
      byClassFrame: [classRow("modern", CENSUS_OF("modern") + 0.06, CENSUS_OF("modern"), 600)],
      sample: 1764,
      breaches: 0,          // no true disagreements at all
    });
    expect(over).toBeTruthy();
    expect(over.worstClass).toBe("modern");
    // ...and a class ON its CONFLICT reference is clean even when the
    // TRUE-DISAGREEMENT count is enormous.
    const on = INV.evaluateDrift("I9", {
      byClassFrame: [classRow("modern", CENSUS_OF("modern"), CENSUS_OF("modern"), 600)],
      sample: 1764,
      breaches: 1700,
    });
    expect(on).toBeNull();
  });

  it("the frame-health line is kept — the alarm needs the frame it reads", () => {
    // The drift alarm consumes `frameHealth().bySportClass`. Removing the frame
    // health line does not merely lose a diagnostic, it disarms the alarm, so
    // the two are pinned together.
    const verdicts = [
      ...Array.from({ length: 60 }, () => ({ klass: "CONFLICT", __frameSlot: 7 })),
      ...Array.from({ length: 40 }, () => ({ klass: "AGREE", __frameSlot: 7 })),
    ];
    const health = INV.frameHealth({
      byClass: { CONFLICT: 60, AGREE: 40 }, distinctCards: 400, sampled: 100, verdicts,
    });
    expect(health.bySportClass.length).toBeGreaterThan(0);
    expect(health.drift).toBeTruthy();
    expect(health.flags).toEqual([]);
    expect(health.referenceSlots).toBe(32);
  });

  it("the four classes are shares of the same denominator, not a partition", () => {
    // The fleet reports UNDERIVABLE-for-subset under byTier and leaves it out
    // of counts, so the four shares sum to ~0.95 corpus-wide and to ~0.74 on
    // slot 31. Anything that treats them as a partition is wrong, and this pin
    // records that so a future reader does not "fix" the sum.
    const w = INV.CENSUS_REFERENCE_SHARES;
    const sum = w.AGREE + w.IMPROVE + w.CONFLICT + w.UNDERIVABLE;
    expect(sum).toBeLessThan(1);
    expect(sum).toBeGreaterThan(0.9);
  });
});
