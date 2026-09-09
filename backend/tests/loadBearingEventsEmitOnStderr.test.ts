// THE STREAM IS PART OF THE CONTRACT (2026-09-09, #1982 fallout).
//
// #1982 set the App Insights console subscriber to `logSendingLevel: WARN`.
// That subscriber tags telemetry records by STREAM, not by content:
//
//     stderr (console.error, console.warn) -> SeverityNumber.WARN   KEPT
//     stdout (console.log,   console.info) -> SeverityNumber.INFO   DROPPED
//
// So a structured event emitted on stdout is invisible to every KQL reader no
// matter how faithfully its payload is built. #2018 found this the expensive
// way: the deal-scanner heartbeat went out on console.log, and its canary read
// a perfectly healthy job as dead for 24h. Asserting the JSON alone passed
// throughout that outage — which is exactly why these pins assert the STREAM.
//
// Measured against hobbyiq-insights on 2026-09-09: every structured event
// arriving in the trailing 6h carried SeverityLevel 2 (WARN). Nothing on
// stdout arrived at all, fleet-wide.
//
// THIS FILE PINS the events that have a READER — a canary, a runbook, or a
// live KQL dashboard. Each must appear on console.warn and must NOT appear on
// console.log. Ordinary diagnostic console.log noise is deliberately NOT
// promoted: dropping it is the #1982 cost saving, and it has no reader.
//
//   sub_raw_inversion_observed        -> the DailyIQ hot-prospects S1 KQL, fed
//                                        by sub-raw-inversion-scan-nightly.yml
//   cross_grader_inversion_observed   -> docs/observability/
//                                        sub-raw-and-cross-grader-inversion-queries.md
//   ch_call                           -> docs/observability/ch-cost-tracking.md
//                                        (the CardHedge spend dashboard)
//   sold_comps_prewrite_dedup_replaced-> docs/runbooks/post-launch-oncall.md

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logSubRawInversionObserved,
  logCrossGraderInversionObserved,
  type SubRawInversionEvent,
  type CrossGraderInversionEvent,
} from "../src/services/compiq/marketRead.service.js";

let logSpy: ReturnType<typeof vi.spyOn>;   // stdout — must stay EMPTY
let warnSpy: ReturnType<typeof vi.spyOn>;  // stderr — the stream that survives

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

function eventsOn(spy: ReturnType<typeof vi.spyOn>, name: string): any[] {
  return spy.mock.calls
    .map((c) => { try { return JSON.parse(c[0] as string); } catch { return null; } })
    .filter((p) => p && p.event === name);
}

const SUB_RAW: SubRawInversionEvent = {
  grader: "PSA", grade: "9", gradeMedian: 80, gradeCount: 4,
  rawMedian: 100, marginPct: 20, marginUSD: 20,
};

const CROSS_GRADER: CrossGraderInversionEvent = {
  higherGrader: "PSA", lowerGrader: "SGC", numericGrade: "10",
  higherMedian: 120, higherCount: 6,
  lowerMedian: 100, lowerCount: 5,
  marginPct: 20,
};

describe("load-bearing telemetry goes out on stderr, never stdout", () => {
  it("sub_raw_inversion_observed — the DailyIQ pipe — is on stderr", () => {
    logSubRawInversionObserved({
      source: "buildGradeBreakdown", player: "Witt", cardId: "hp-1", event: SUB_RAW,
    });
    expect(eventsOn(warnSpy, "sub_raw_inversion_observed")).toHaveLength(1);
    expect(eventsOn(logSpy, "sub_raw_inversion_observed")).toHaveLength(0);
  });

  it("cross_grader_inversion_observed is on stderr", () => {
    logCrossGraderInversionObserved({
      source: "buildGradeBreakdown", player: "Trout", cardId: "hp-2", event: CROSS_GRADER,
    });
    expect(eventsOn(warnSpy, "cross_grader_inversion_observed")).toHaveLength(1);
    expect(eventsOn(logSpy, "cross_grader_inversion_observed")).toHaveLength(0);
  });

  // The payload must survive the move byte-for-byte: the readers parse these
  // fields, so a promotion that quietly reshaped the JSON would break them in a
  // different way than the stream did.
  it("the promoted payload keeps every field its readers parse", () => {
    logSubRawInversionObserved({
      source: "buildGradeBreakdown", player: "Witt", cardId: "hp-1", event: SUB_RAW,
    });
    const p = eventsOn(warnSpy, "sub_raw_inversion_observed")[0];
    expect(p.source).toBe("buildGradeBreakdown");
    expect(p.player).toBe("Witt");
    expect(p.cardId).toBe("hp-1");
    expect(p.grader).toBe("PSA");
    expect(p.grade).toBe("9");
    expect(p.gradeMedian).toBe(80);
    expect(p.gradeCount).toBe(4);
    expect(p.rawMedian).toBe(100);
    expect(p.marginPct).toBe(20);
    expect(p.marginUSD).toBe(20);
    expect(typeof p.timestamp).toBe("string");
  });
});

// A SOURCE-LEVEL PIN, not a behavioural one. ch_call fires inside a fetch
// wrapper and sold_comps_prewrite_dedup_replaced inside a Cosmos write path;
// standing either up here would mean mocking the network or the DB for what is
// a one-token property. Reading the emitter is the honest check, and it fails
// exactly when someone moves the call back to console.log.
describe("the remaining read events are emitted on stderr at their call sites", () => {
  const CASES: Array<{ file: string; event: string; reader: string }> = [
    { file: "backend/src/services/compiq/cardhedge.client.ts",
      event: "ch_call", reader: "docs/observability/ch-cost-tracking.md" },
    { file: "backend/src/services/compiq/cardhedgeDailyExport.client.ts",
      event: "ch_call", reader: "docs/observability/ch-cost-tracking.md" },
    { file: "backend/src/services/portfolioiq/soldCompsStore.service.ts",
      event: "sold_comps_prewrite_dedup_replaced",
      reader: "backend/docs/runbooks/post-launch-oncall.md" },
  ];

  it.each(CASES)("$event in $file is emitted on console.warn", async ({ file, event }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", file), "utf8");
    const lines = src.split("\n");

    const idxs = lines
      .map((l, i) => (l.includes(`event: "${event}"`) ? i : -1))
      .filter((i) => i >= 0);
    expect(idxs.length).toBeGreaterThan(0);

    for (const i of idxs) {
      // Walk back to the console call that opened this JSON.stringify block.
      let j = i;
      while (j > 0 && !/console\.(log|warn|error)\(JSON\.stringify\(\{/.test(lines[j]!)) j--;
      expect(lines[j]).toMatch(/console\.(warn|error)\(JSON\.stringify\(\{/);
      expect(lines[j]).not.toMatch(/console\.log\(/);
    }
  });
});
