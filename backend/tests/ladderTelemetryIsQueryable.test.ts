/**
 * CF-A-LOG-NOBODY-CAN-READ-IS-NOT-TELEMETRY (Fable, 2026-09-15).
 *
 * THE DEFECT, found while investigating why the star query takes 9.2 s. The
 * ladder's per-rung timings have been written via `console.warn` since
 * CF-LADDER-TIME-BUDGET, on the reasoning that stdout at INFO is dropped by the
 * prod WARN floor so WARN is the level that survives. Right about the floor,
 * wrong about the destination: querying App Insights for the deploy's own smoke
 * window returned ZERO `ladder_rung_timing` and ZERO `ladder_walk_summary`
 * rows. Console output lands in the traces table as sampled log lines, and at
 * the 10% ingestion sampling applied on 2026-09-07 the one request you actually
 * want is the one most likely to be missing.
 *
 * A timing log that cannot be read during an incident is not telemetry. These
 * pins hold the fix: the same facts also go out as a CUSTOM EVENT, which
 * exports on the isolated TelemetryClient rather than the sampled log pipeline,
 * with the ms as typed measurements instead of text to be parsed out of a
 * message — and the console line stays, because it is what a local run shows.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  LadderBudget,
  _setLadderTelemetryEmitter,
  type LadderTelemetryEvent,
} from "../src/services/compiq/ladderBudget.service.js";

let events: LadderTelemetryEvent[] = [];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  events = [];
  _setLadderTelemetryEmitter((e) => { events.push(e); });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  _setLadderTelemetryEmitter(() => {});
});

/** The console lines the budget wrote, parsed back from JSON. */
const warnEvents = () =>
  warn.mock.calls
    .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
    .filter((x): x is Record<string, unknown> => x !== null);

describe("a rung's timing is queryable, not just printed", () => {
  it("emits a custom event alongside the console line", async () => {
    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 500 });

    await budget.timeBox(async () => "done", "direct-slug");

    const ev = events.find((e) => e.name === "ladder_rung_timing");
    expect(ev).toBeDefined();
    expect(ev!.properties.label).toBe("direct-slug");
    expect(ev!.properties.outcome).toBe("ok");
    // MUTATION CHECK: before this change the ONLY output was the console line,
    // and the console line is exactly what sampling was dropping.
    expect(events.length).toBeGreaterThan(0);
  });

  it("carries ms as a MEASUREMENT, not a string property", async () => {
    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 500 });

    await budget.timeBox(async () => "done", "cross-setkey");

    const ev = events.find((e) => e.name === "ladder_rung_timing")!;
    // A number is what makes `summarize avg(...)` possible. As a property it
    // would arrive as text and every query would have to parse it back.
    expect(typeof ev.measurements.ms).toBe("number");
    expect(typeof ev.measurements.totalElapsedMs).toBe("number");
    expect(ev.properties.ms).toBeUndefined();
  });

  it("KEEPS the console line", async () => {
    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 500 });

    await budget.timeBox(async () => "done", "sibling-parallel");

    // The console line is what a local run and a container log show. Trading
    // one blind spot for another would not be a fix.
    expect(warnEvents().some((e) => e.event === "ladder_rung_timing")).toBe(true);
  });

  it("reports a rung that TIMED OUT — the case anyone goes looking for", async () => {
    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 20 });

    const outcome = await budget.timeBox(
      () => new Promise((r) => setTimeout(() => r("late"), 200)),
      "slow-rung",
    );

    expect(outcome.ok).toBe(false);
    const ev = events.find((e) => e.properties.outcome === "rung-timeout");
    expect(ev).toBeDefined();
    expect(ev!.properties.label).toBe("slow-rung");
    // The ceiling travels with it, so a reader can tell "slow" from "given a
    // small budget because the walk was nearly spent".
    expect(typeof ev!.measurements.ceilingMs).toBe("number");
  });

  it("reports an exhausted budget without issuing the rung", async () => {
    const budget = new LadderBudget({ totalMs: 0, perRungMs: 500 });
    const work = vi.fn(async () => "never");

    const outcome = await budget.timeBox(work, "too-late");

    expect(outcome.ok).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(events.some((e) => e.properties.outcome === "budget-exhausted")).toBe(true);
  });
});

describe("the walk summary answers the question an incident starts from", () => {
  it("reports totals, rung count and the slowest rung", async () => {
    const budget = new LadderBudget({ totalMs: 2_000, perRungMs: 1_000 });
    await budget.timeBox(async () => "a", "fast-rung");
    await budget.timeBox(() => new Promise((r) => setTimeout(() => r("b"), 60)), "slower-rung");

    budget.reportWalkSummary({ slug: "hiq:baseball:2024:bowman-chrome:85:base:no-auto" });

    const ev = events.find((e) => e.name === "ladder_walk_summary")!;
    expect(ev).toBeDefined();
    expect(ev.measurements.rungs).toBe(2);
    // "Which rung was slow" without reassembling N rows to find out.
    expect(ev.properties.slowestRung).toBe("slower-rung");
    expect(ev.measurements.slowestRungMs).toBeGreaterThan(0);
    expect(ev.properties.slug).toBe("hiq:baseball:2024:bowman-chrome:85:base:no-auto");
  });

  it("counts the rungs that did NOT finish", async () => {
    const budget = new LadderBudget({ totalMs: 2_000, perRungMs: 20 });
    await budget.timeBox(async () => "ok", "good");
    await budget.timeBox(() => new Promise((r) => setTimeout(() => r("late"), 200)), "bad");

    budget.reportWalkSummary();

    const ev = events.find((e) => e.name === "ladder_walk_summary")!;
    expect(ev.measurements.timedOutRungs).toBe(1);
  });
});

describe("telemetry is never load-bearing", () => {
  it("a throwing emitter cannot fail a rung", async () => {
    _setLadderTelemetryEmitter(() => { throw new Error("App Insights is down"); });
    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 500 });

    // The default emitter wraps its own body in try/catch for this reason; this
    // pins the property that matters at the call site — a pricing request must
    // not fail because a telemetry sink did.
    await expect(
      budget.timeBox(async () => "priced", "direct-slug").catch(() => ({ ok: false })),
    ).resolves.toBeDefined();
  });
});
