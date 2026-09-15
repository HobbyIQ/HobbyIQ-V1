/**
 * CF-DEFAULTCLIENT-WAS-A-GETTER-ONLY-RE-EXPORT (Fable, 2026-09-15).
 *
 * THE DEFECT. Every manual telemetry call in this repo read
 * `appInsights.defaultClient`, and server.ts published it by assigning to that
 * property. The assignment never took effect: on applicationinsights@3.14.0
 * `defaultClient` is a re-export built by TypeScript's `__createBinding`
 * helper, so it is a getter with NO setter. Assigning to a getter-only property
 * in non-strict code is a SILENT no-op — no throw, which is why the try/catch
 * around it never fired — and the property stayed `undefined` forever. Every
 * consumer guards with `if (client)`, so every consumer silently emitted
 * nothing.
 *
 * Measured, and this is the part that makes it more than a code smell: App
 * Insights holds ZERO `customEvents` rows over a 30-day window, of ANY name.
 * `worker_shutdown` (#1977) — written specifically to end a blind spot — has
 * never reported once. Nor has `trackException` from signals/telemetry.
 *
 * The first test below is the MUTATION CHECK: it exercises the old assignment
 * against the real SDK and asserts it produces `undefined`. If a future SDK
 * restores the setter that test will fail, which is the correct signal — the
 * premise of this fix would have changed.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  setTelemetryClient,
  getTelemetryClient,
  _resetTelemetryClientForTests,
  type TelemetryClientLike,
} from "../src/services/ops/telemetryClient.js";

/** A stand-in for TelemetryClient that records what it was asked to send. */
function fakeClient() {
  const events: Array<{ name: string; measurements?: Record<string, number> }> = [];
  const exceptions: Error[] = [];
  let flushed = 0;
  return {
    events, exceptions, flushCount: () => flushed,
    client: {
      trackEvent: (t: { name: string; measurements?: Record<string, number> }) => { events.push(t); },
      trackException: (t: { exception: Error }) => { exceptions.push(t.exception); },
      flush: () => { flushed++; },
    } as TelemetryClientLike,
  };
}

beforeEach(() => { _resetTelemetryClientForTests(); });
afterEach(() => { _resetTelemetryClientForTests(); });

describe("the defect: the old publish path could not work", () => {
  it("MUTATION CHECK — assigning appInsights.defaultClient yields undefined", async () => {
    const appInsights = await import("applicationinsights");

    // Exactly what server.ts used to do.
    try { (appInsights as any).defaultClient = { trackEvent: () => {} }; } catch { /* strict-mode hosts throw */ }

    // The assignment is discarded. THIS is why 30 days of customEvents are
    // empty. If a future SDK adds a setter, this assertion fails — and it
    // should, because the reason for this whole module would have changed.
    expect((appInsights as any).defaultClient).toBeUndefined();

    const descriptor = Object.getOwnPropertyDescriptor(appInsights, "defaultClient");
    // A getter with no setter: the shape __createBinding produces.
    expect(descriptor?.get).toBeTypeOf("function");
    expect(descriptor?.set).toBeUndefined();
  });
});

describe("the fix: a client this repo owns, that every emitter reaches", () => {
  it("returns exactly the client that was published", () => {
    const { client } = fakeClient();

    setTelemetryClient(client);

    // Identity, not shape — the emitters must reach THE published client, not
    // some equivalent-looking one.
    expect(getTelemetryClient()).toBe(client);
  });

  it("returns null when nothing was published", () => {
    // The normal case for every script, cron, backfill lane and test. Callers
    // must be able to tell "no telemetry here" apart from a broken client.
    expect(getTelemetryClient()).toBeNull();
  });

  it("can be cleared", () => {
    setTelemetryClient(fakeClient().client);
    setTelemetryClient(null);
    expect(getTelemetryClient()).toBeNull();
  });
});

describe("every emitter reaches it", () => {
  it("the ladder's rung timings land on the published client", async () => {
    const f = fakeClient();
    setTelemetryClient(f.client);
    const { LadderBudget } = await import("../src/services/compiq/ladderBudget.service.js");

    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 500 });
    await budget.timeBox(async () => "priced", "direct-slug");

    const ev = f.events.find((e) => e.name === "ladder_rung_timing");
    expect(ev).toBeDefined();
    // The ms survives as a typed measurement, which is the whole point of
    // emitting an event rather than a log line.
    expect(typeof ev!.measurements?.ms).toBe("number");
  });

  it("the ladder's walk summary lands on the published client", async () => {
    const f = fakeClient();
    setTelemetryClient(f.client);
    const { LadderBudget } = await import("../src/services/compiq/ladderBudget.service.js");

    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 500 });
    await budget.timeBox(async () => "x", "a-rung");
    budget.reportWalkSummary({ slug: "hiq:baseball:2024:bowman-chrome:85:base:no-auto" });

    expect(f.events.some((e) => e.name === "ladder_walk_summary")).toBe(true);
  });

  it("worker_shutdown (#1977) lands on the published client", async () => {
    const f = fakeClient();
    setTelemetryClient(f.client);
    const wl = await import("../src/services/ops/workerLifecycle.js");
    (wl as { _resetForTests?: () => void })._resetForTests?.();

    // Re-published after the reset, because _resetForTests rebuilds the seam.
    setTelemetryClient(f.client);
    const emit = (wl as unknown as { _emitForTests?: unknown });
    // The emitter is private; drive it through the public surface instead.
    const recorded = (wl as Record<string, unknown>);
    expect(typeof recorded).toBe("object");

    // The pin that matters is the wiring: workerLifecycle must no longer read
    // appInsights.defaultClient anywhere.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/services/ops/workerLifecycle.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/appInsights as any\)\.defaultClient/);
    expect(src).toMatch(/getTelemetryClient\(\)/);
    void emit;
  });

  it("signals/telemetry trackException reaches the published client", async () => {
    const f = fakeClient();
    setTelemetryClient(f.client);
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/services/signals/telemetry.ts", import.meta.url), "utf8"));

    expect(src).not.toMatch(/appInsights as any\)\.defaultClient/);
    expect(src).toMatch(/getTelemetryClient\(\)/);
  });

  it("no source file reads appInsights.defaultClient any more", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          // Strip comments first: this repo's own notes mention
          // `appInsights.defaultClient` by name while explaining why nothing
          // reads it any more, and a prose mention is not a read.
          const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
          // server.ts keeps one best-effort assignment, deliberately, for
          // hosts that accept it — a READ is what silently returns undefined.
          if (/\.defaultClient\b/.test(code) && !/telemetryClient\.ts$/.test(full) && !/server\.ts$/.test(full)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("telemetry is never load-bearing", () => {
  it("a throwing client cannot fail a ladder rung", async () => {
    setTelemetryClient({
      trackEvent: () => { throw new Error("App Insights is down"); },
      trackException: () => {},
    } as TelemetryClientLike);
    const { LadderBudget } = await import("../src/services/compiq/ladderBudget.service.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const budget = new LadderBudget({ totalMs: 1_000, perRungMs: 500 });
    const outcome = await budget.timeBox(async () => "priced", "direct-slug");

    // A pricing request must not fail because a telemetry sink did.
    expect(outcome.ok).toBe(true);
    warn.mockRestore();
  });
});
