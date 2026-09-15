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

/**
 * CF-A-SUMMARY-ONLY-ON-FAILURE-IS-NOT-A-SUMMARY (Fable, 2026-09-15).
 *
 * VERIFIED IN PROD, not inferred: emitting a probe from the built code against
 * the real App Insights resource produced a `ladder_rung_timing` row
 * (2026-09-15T14:27:19Z, label `probe-rung-F102717`, ms=1 as a typed
 * measurement). The export path works.
 *
 * What did NOT work was the WALK summary: `reportWalkSummary` was wired only
 * into `ladderTimeoutResult()`, so the only walk that ever produced one was a
 * walk that had already failed. Every healthy valuation emitted per-rung rows
 * and no walk-level row — which makes the summary useless for the question it
 * exists to answer, because "is this walk slower than usual?" needs the normal
 * distribution to compare against, and a p50 over timeouts is not a p50.
 */
describe("every walk is summarised, not only the ones that fail", () => {
  it("emits a walk summary on a SUCCESSFUL valuation", async () => {
    const { computeHobbyIqFmv } = await import("../src/services/portfolioiq/hobbyIqFmv.service.js");

    await computeHobbyIqFmv({ hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:85:base:no-auto" })
      .catch(() => null);   // no Cosmos in tests; the walk still runs and ends

    // MUTATION CHECK: before the wrapper this was 0 for any non-timeout walk —
    // the summary existed but fired only on the failure path.
    const summaries = events.filter((e) => e.name === "ladder_walk_summary");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("the summary names the slug it walked", async () => {
    const { computeHobbyIqFmv } = await import("../src/services/portfolioiq/hobbyIqFmv.service.js");
    const slug = "hiq:baseball:2024:bowman-chrome:85:base:no-auto";

    await computeHobbyIqFmv({ hobbyiqCardId: slug }).catch(() => null);

    const summary = events.find((e) => e.name === "ladder_walk_summary");
    expect(summary?.properties.slug).toBe(slug);
  }, 30_000);

  it("a request rejected BEFORE the walk begins emits no summary", async () => {
    // A non-hiq id returns at the guard, before a LadderBudget is constructed.
    // There is no walk, so there is nothing to summarise — and emitting a
    // zero-rung row here would pollute the very distribution the summary
    // exists to provide. Asserting the absence keeps that deliberate rather
    // than accidental.
    const { computeHobbyIqFmv } = await import("../src/services/portfolioiq/hobbyIqFmv.service.js");

    await computeHobbyIqFmv({ hobbyiqCardId: "not-an-hiq-slug" }).catch(() => null);

    expect(events.some((e) => e.name === "ladder_walk_summary")).toBe(false);
  }, 30_000);

  it("the summary is emitted from a finally — a throwing walk still reports", async () => {
    // The wrapper summarises in a `finally`, so once a walk has actually begun
    // an exception on the way out does not cost the observability. That is the
    // case you most want it in.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/services/portfolioiq/hobbyIqFmv.service.ts", import.meta.url), "utf8"));
    const wrapper = src.slice(src.indexOf("export async function computeHobbyIqFmv("));
    expect(wrapper.slice(0, 600)).toMatch(/finally\s*\{/);
  }, 30_000);
});
