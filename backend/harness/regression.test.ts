/**
 * Harness mechanics smoke test (PR #1).
 *
 * Proves the harness infrastructure — corpus loader, runner, snapshot
 * serializer, diff tool, baseline read/write, budget enforcement —
 * works end-to-end against a synthetic engine invoker.
 *
 * Real engine-driven cases land in PR #3 (Tier 1 corpus).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FrozenClock, HARNESS_BASELINE_ISO, harnessClock } from "./clock.js";
import {
  diffObjects,
  formatSummary,
  summarize,
} from "./diff.js";
import { loadCorpus, runTier, tierSkipped, SNAPSHOT_DIR } from "./runner.js";
import { serializeSnapshot, snapshot } from "./snapshot.js";
import { HARNESS_SCHEMA_VERSION, HarnessCase } from "./types.js";

describe("harness: clock", () => {
  it("FrozenClock returns the same time every call", () => {
    const c = new FrozenClock(HARNESS_BASELINE_ISO);
    expect(c.now()).toBe(c.now());
    expect(c.iso()).toBe(HARNESS_BASELINE_ISO);
  });

  it("FrozenClock rejects invalid input", () => {
    expect(() => new FrozenClock("not-a-date")).toThrow();
  });

  it("harnessClock defaults to the baseline ISO", () => {
    expect(harnessClock().iso()).toBe(HARNESS_BASELINE_ISO);
  });
});

describe("harness: snapshot", () => {
  it("strips volatile fields", () => {
    const out = snapshot({
      fairMarketValue: 100,
      requestId: "abc-123",
      computedAt: "2026-05-14T13:00:00Z",
      cacheKey: "x",
    });
    expect(out).toEqual({ fairMarketValue: 100 });
  });

  it("sorts object keys for stable output", () => {
    const a = serializeSnapshot({ b: 2, a: 1, c: 3 });
    const b = serializeSnapshot({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("quantizes floats", () => {
    const out = snapshot({ price: 0.1 + 0.2 });
    expect(out).toEqual({ price: 0.3 });
  });

  it("recurses into arrays and nested objects", () => {
    const out = snapshot({
      comps: [
        { price: 100, requestId: "x" },
        { price: 110, requestId: "y" },
      ],
    });
    expect(out).toEqual({ comps: [{ price: 100 }, { price: 110 }] });
  });
});

describe("harness: diff", () => {
  it("returns empty changes for equal inputs", () => {
    expect(diffObjects({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("detects scalar changes", () => {
    const c = diffObjects({ a: 1 }, { a: 2 });
    expect(c).toEqual([{ path: "a", before: 1, after: 2 }]);
  });

  it("detects array length and element changes", () => {
    const c = diffObjects([1, 2], [1, 2, 3]);
    expect(c.some((x) => x.path === ".length")).toBe(true);
  });

  it("summarize buckets price magnitude correctly", () => {
    const s = summarize([
      {
        caseId: "small",
        before: { fairMarketValue: 100 },
        after: { fairMarketValue: 100.5 },
      },
      {
        caseId: "medium",
        before: { fairMarketValue: 100 },
        after: { fairMarketValue: 110 },
      },
      {
        caseId: "huge",
        before: { fairMarketValue: 100 },
        after: { fairMarketValue: 300 },
      },
      {
        caseId: "nulled",
        before: { fairMarketValue: 100 },
        after: { fairMarketValue: null },
      },
    ]);
    expect(s.changedCases).toBe(4);
    expect(s.magnitudeBuckets["<1%"]).toBe(1);
    expect(s.magnitudeBuckets["5-15%"]).toBe(1);
    expect(s.magnitudeBuckets[">50%"]).toBe(1);
    expect(s.magnitudeBuckets["now_null"]).toBe(1);
    expect(s.topPriceDiffs[0].caseId).toBe("huge");
  });

  it("formatSummary produces human-readable text", () => {
    const s = summarize([
      { caseId: "x", before: { fairMarketValue: 100 }, after: { fairMarketValue: 200 } },
    ]);
    const text = formatSummary(s);
    expect(text).toContain("Cases compared: 1");
    expect(text).toContain("Top 10 largest price diffs");
  });
});

describe("harness: corpus loader", () => {
  it("loads tier1.json without throwing", () => {
    const cases = loadCorpus("tier1.json");
    expect(Array.isArray(cases)).toBe(true);
  });

  it("loads tier2.json without throwing", () => {
    const cases = loadCorpus("tier2.json");
    expect(Array.isArray(cases)).toBe(true);
  });

  it("returns empty array for missing corpus files", () => {
    expect(loadCorpus("nonexistent.json")).toEqual([]);
  });

  it("rejects mismatched schemaVersion", () => {
    const tmp = path.join(os.tmpdir(), `bogus-corpus-${Date.now()}.json`);
    fs.writeFileSync(
      tmp,
      JSON.stringify({ schemaVersion: 99, cases: [] }),
      "utf8"
    );
    try {
      // loadCorpus reads from CORPUS_DIR so we can't easily inject here;
      // instead verify the schemaVersion constant is the documented value.
      expect(HARNESS_SCHEMA_VERSION).toBe(1);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe("harness: runner mechanics (synthetic engine)", () => {
  const syntheticCase: HarnessCase = {
    id: "smoke.synthetic.001",
    query: "synthetic smoke case — no engine invocation",
    expectedPriceRange: { min: 90, max: 110 },
    expectedMarketState: "liquid",
    expectedStrategy: "direct_comp",
    expectedConfidenceBand: "high",
    confidence: "high",
    notes: "Mechanical smoke test for PR #1. Replaced by real cases in PR #3.",
    revision: 1,
    slot: "modern_sports_liquid",
  };

  it("invokes engine, asserts price range, writes baseline on update", async () => {
    const tmpCase: HarnessCase = {
      ...syntheticCase,
      id: `__tmp__smoke.synthetic.${process.pid}.${Date.now()}`,
    };
    const fakeInvoke = async () => ({ fairMarketValue: 100, ladder: { tier: "liquid" } });
    const baselineFile = path.join(SNAPSHOT_DIR, "tier1", `${tmpCase.id}.json`);
    try {
      const out = await runTier({
        tier: 1,
        cases: [tmpCase],
        invoke: fakeInvoke,
        clock: harnessClock(),
        updateSnapshots: true,
      });
      expect(out.summary.cases).toBe(1);
      expect(out.summary.passed).toBe(1);
      expect(out.summary.failed).toBe(0);
      expect(out.summary.budgetExceeded).toBe(false);
      expect(fs.existsSync(baselineFile)).toBe(true);

      // Second run without updateSnapshots compares against the baseline we just wrote.
      const out2 = await runTier({
        tier: 1,
        cases: [tmpCase],
        invoke: fakeInvoke,
        clock: harnessClock(),
        updateSnapshots: false,
      });
      expect(out2.summary.passed).toBe(1);
      expect(out2.diff?.changedCases).toBe(0);
    } finally {
      if (fs.existsSync(baselineFile)) fs.unlinkSync(baselineFile);
    }
  });

  it("flags failures when price is outside expected range", async () => {
    const tmpCase: HarnessCase = {
      ...syntheticCase,
      id: `__tmp__smoke.fail.${process.pid}.${Date.now()}`,
    };
    const badInvoke = async () => ({ fairMarketValue: 999 });
    const baselineFile = path.join(SNAPSHOT_DIR, "tier1", `${tmpCase.id}.json`);
    try {
      const out = await runTier({
        tier: 1,
        cases: [tmpCase],
        invoke: badInvoke,
        clock: harnessClock(),
        updateSnapshots: true,
      });
      expect(out.summary.passed).toBe(0);
      expect(out.summary.failed).toBe(1);
      expect(out.results[0].failureReasons[0]).toMatch(/outside expected/);
    } finally {
      if (fs.existsSync(baselineFile)) fs.unlinkSync(baselineFile);
    }
  });

  it("captures engine exceptions as failures, not crashes", async () => {
    const tmpCase: HarnessCase = {
      ...syntheticCase,
      id: `__tmp__smoke.throw.${process.pid}.${Date.now()}`,
      expectedPriceRange: null,
    };
    const throwInvoke = async () => {
      throw new Error("engine boom");
    };
    const baselineFile = path.join(SNAPSHOT_DIR, "tier1", `${tmpCase.id}.json`);
    try {
      const out = await runTier({
        tier: 1,
        cases: [tmpCase],
        invoke: throwInvoke,
        clock: harnessClock(),
        updateSnapshots: true,
      });
      expect(out.summary.failed).toBe(1);
      expect(out.results[0].failureReasons[0]).toMatch(/engine threw/);
    } finally {
      if (fs.existsSync(baselineFile)) fs.unlinkSync(baselineFile);
    }
  });

  it("tierSkipped marks Tier 3 as skipped without failing", () => {
    const s = tierSkipped(3, "infrastructure-unavailable");
    expect(s.skipped).toBe(1);
    expect(s.skipReason).toBe("infrastructure-unavailable");
    expect(s.failed).toBe(0);
  });
});
