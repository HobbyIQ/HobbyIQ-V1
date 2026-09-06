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
    const health = INV.frameHealth({
      byClass: { AGREE: 940, IMPROVE: 44, CONFLICT: 412, UNDERIVABLE: 86 },
      distinctCards: 850,
      sampled: 2000,
    });
    expect(health.healthy).toBe(true);
    expect(health.flags).toEqual([]);
    expect(Math.abs(health.drift.AGREE.delta)).toBeLessThan(0.05);
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
    expect(health.drift.CONFLICT.census).toBeCloseTo(0.206, 3);
    expect(health.drift.CONFLICT.delta).toBeGreaterThan(0.4);
  });

  it("carries the census reference it compares against", () => {
    // The reference is slot 31's real full-slot census, not a guess.
    expect(INV.CENSUS_REFERENCE_SHARES.AGREE).toBeCloseTo(0.471, 3);
    expect(INV.CENSUS_REFERENCE_SHARES.source).toMatch(/slot 31/);
    expect(INV.FRAME_MIN_DISTINCT_CARDS).toBe(100);
  });
});
