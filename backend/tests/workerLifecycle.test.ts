// #1973: pins worker-shutdown attribution + the unhandled-rejection
// liveness policy. These are the properties the next incident is read
// through, so they are asserted, not assumed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  emitWorkerShutdown,
  installWorkerLifecycleHandlers,
  unhandledRejectionCount,
  _setEmitterForTests,
  _setFlusherForTests,
  _resetForTests,
} from "../src/services/ops/workerLifecycle.js";

type Emitted = { name: string; properties: Record<string, string> };

let events: Emitted[];
let flushes: number;

beforeEach(() => {
  _resetForTests();
  events = [];
  flushes = 0;
  _setEmitterForTests((name, properties) => {
    events.push({ name, properties });
  });
  _setFlusherForTests(() => {
    flushes += 1;
  });
});

afterEach(() => {
  _resetForTests();
});

describe("worker_shutdown attribution", () => {
  it("names the reason and flushes", () => {
    const emitted = emitWorkerShutdown("SIGTERM");
    expect(emitted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("worker_shutdown");
    expect(events[0].properties.reason).toBe("SIGTERM");
    expect(flushes).toBe(1);
  });

  it("records uptime so a recycle is distinguishable from a long-lived exit", () => {
    emitWorkerShutdown("SIGTERM");
    const p = events[0].properties;
    expect(Number(p.uptimeSeconds)).toBeGreaterThanOrEqual(0);
    // A test process is young, so this is the recycle signature.
    expect(p.shortLived).toBe("true");
  });

  it("is idempotent — a worker dies once, and the FIRST reason wins", () => {
    expect(emitWorkerShutdown("SIGTERM")).toBe(true);
    expect(emitWorkerShutdown("uncaughtException", new Error("late"))).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].properties.reason).toBe("SIGTERM");
  });

  it("carries a bounded detail string for error reasons", () => {
    emitWorkerShutdown("uncaughtException", new Error("boom"));
    expect(events[0].properties.detail).toContain("boom");
    expect(events[0].properties.detail.length).toBeLessThanOrEqual(500);
  });

  it("truncates a very long detail rather than shipping it whole", () => {
    emitWorkerShutdown("uncaughtException", new Error("x".repeat(5000)));
    expect(events[0].properties.detail.length).toBe(500);
  });

  it("never throws when the emitter fails", () => {
    _setEmitterForTests(() => {
      throw new Error("App Insights down");
    });
    expect(() => emitWorkerShutdown("SIGTERM")).not.toThrow();
  });
});

describe("unhandled rejection liveness policy", () => {
  it("absorbs an unhandled rejection instead of killing the worker", async () => {
    installWorkerLifecycleHandlers();
    expect(unhandledRejectionCount()).toBe(0);

    // A genuinely unhandled rejection, delivered via the real process event.
    void Promise.reject(new Error("stray promise"));
    await new Promise((r) => setTimeout(r, 50));

    expect(unhandledRejectionCount()).toBe(1);
    const rej = events.filter((e) => e.name === "worker_unhandled_rejection");
    expect(rej).toHaveLength(1);
    expect(rej[0].properties.detail).toContain("stray promise");
    // The decisive assertion: absorbing a rejection is NOT a shutdown.
    expect(events.some((e) => e.name === "worker_shutdown")).toBe(false);
  });

  it("reset detaches real process listeners — install/reset cycles must not accumulate", () => {
    const before = process.listenerCount("unhandledRejection");
    installWorkerLifecycleHandlers();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    _resetForTests();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("installing twice does not double-register handlers", async () => {
    installWorkerLifecycleHandlers();
    installWorkerLifecycleHandlers();

    void Promise.reject(new Error("once only"));
    await new Promise((r) => setTimeout(r, 50));

    expect(unhandledRejectionCount()).toBe(1);
    expect(events.filter((e) => e.name === "worker_unhandled_rejection")).toHaveLength(1);
  });
});
