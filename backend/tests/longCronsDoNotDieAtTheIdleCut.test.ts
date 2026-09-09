/**
 * CF-LONG-CRONS-DIE-AT-THE-IDLE-CUT (2026-09-09) tests.
 *
 * The incident: three nightly crons called endpoints that do minutes of
 * server-side work and waited on a single HTTP response. App Insights over
 * 14 days (app-id 468bd437-…):
 *
 *   /api/cleanliness/anomalies?force=true   11 requests, ALL ResultCode 0,
 *                                           every one cut at 89.9s. The lane
 *                                           has never received a drift
 *                                           comparison — though the scan
 *                                           itself finished, server-side,
 *                                           every night.
 *   .../personal-prospect-breakout/run      38 × 200, p95 142.5s, max 211.6s.
 *   /api/dailyiq/brief?fresh=true           183 × 200 (p95 182.9s) plus
 *                                           17 × ResultCode 0 at exactly
 *                                           240.0s.
 *
 * 240.0s is the App Service front end's idle cut, not our timeout: it fires
 * when a connection carries no bytes for that long, whatever the client is
 * willing to wait. #1985 raised the anomalies curl ceiling to 900s on the
 * theory the client was impatient; the platform would have cut it at 240
 * regardless. Widening a timeout was never the fix, and these tests exist
 * partly to keep anyone from reaching for one again.
 *
 * What is pinned here:
 *   1. the handoff — a dispatch answers immediately and does NOT wait,
 *      concurrent dispatches collapse onto one run, and the result is
 *      readable by a later poll;
 *   2. the poll — and above all that `unknown-here` (the OTHER instance
 *      answering, which happens on roughly half of all polls with 2 serving
 *      workers) is keep-polling and NEVER a settled verdict.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as longJobs from "../src/services/ops/longJobTracker";

// The poller is CJS and shares the classify contract with the crons.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyStatus } = require("../scripts/poll-admin-job.cjs");

const KIND = "test-lane";
const KEY = "global";

beforeEach(() => {
  longJobs.__resetForTests();
});

describe("the async handoff — a dispatch answers before the work finishes", () => {
  it("returns a job handle immediately rather than awaiting the run", async () => {
    let release: (v: string) => void = () => {};
    const work = () => new Promise<string>((r) => { release = r; });

    const t0 = Date.now();
    const { job, alreadyRunning } = longJobs.dispatch(KIND, KEY, work);
    const elapsed = Date.now() - t0;

    // The whole point: the caller is answered while the work is still going.
    expect(elapsed).toBeLessThan(50);
    expect(job.jobId).toBeTruthy();
    expect(job.status).toBe("running");
    expect(alreadyRunning).toBe(false);
    expect(longJobs.isRunning(KIND, KEY)).toBe(true);

    release("done-payload");
    await longJobs.__awaitSettledForTests(KIND, KEY);
    expect(longJobs.getJob(KIND, KEY)!.status).toBe("done");
  });

  it("collapses a second dispatch onto the run already in flight", async () => {
    let release: (v: number) => void = () => {};
    let starts = 0;
    const work = () => { starts++; return new Promise<number>((r) => { release = r; }); };

    const first = longJobs.dispatch(KIND, KEY, work);
    const second = longJobs.dispatch(KIND, KEY, work);

    // Two rival scans of the same rows is the thing to avoid — the second
    // caller adopts the first run and is told so.
    expect(starts).toBe(1);
    expect(second.alreadyRunning).toBe(true);
    expect(second.job.jobId).toBe(first.job.jobId);

    release(1);
    await longJobs.__awaitSettledForTests(KIND, KEY);
  });

  it("keys runs separately, so the sport matrix does not collapse into one", async () => {
    const started: string[] = [];
    const mk = (sport: string) => () => { started.push(sport); return Promise.resolve(sport); };

    const bb = longJobs.dispatch("prospect", "baseball", mk("baseball"));
    const fb = longJobs.dispatch("prospect", "football", mk("football"));

    expect(bb.job.jobId).not.toBe(fb.job.jobId);
    await longJobs.__awaitSettledForTests("prospect", "baseball");
    await longJobs.__awaitSettledForTests("prospect", "football");
    expect(started.sort()).toEqual(["baseball", "football"]);
  });

  it("captures a failure onto the job instead of throwing into an unhandled rejection", async () => {
    longJobs.dispatch(KIND, KEY, async () => { throw new Error("scan blew up"); });
    await longJobs.__awaitSettledForTests(KIND, KEY);
    const job = longJobs.getJob(KIND, KEY)!;
    expect(job.status).toBe("error");
    expect(job.error).toContain("scan blew up");
  });

  it("makes the finished result readable by a later poll", async () => {
    const { job } = longJobs.dispatch(KIND, KEY, async () => ({ anomalies: [1, 2, 3] }));
    await longJobs.__awaitSettledForTests(KIND, KEY);
    const payload = longJobs.buildStatusPayload(longJobs.lookupJob(KIND, KEY, job.jobId));
    expect(payload.status).toBe("done");
    expect(payload.settled).toBe(true);
    expect(payload.result).toEqual({ anomalies: [1, 2, 3] });
  });
});

describe("the poll surface — a worker may say 'I don't know', never 'done'", () => {
  it("answers unknown-here for an id this worker never issued", () => {
    longJobs.dispatch(KIND, KEY, () => new Promise(() => {}));
    // The id a client minted on the OTHER instance.
    const payload = longJobs.buildStatusPayload(
      longJobs.lookupJob(KIND, KEY, "an-id-from-the-other-worker"),
    );
    expect(payload.status).toBe("unknown-here");
    // Load-bearing: a poller must keep asking.
    expect(payload.settled).toBe(false);
    expect(payload.running).toBe(false);
  });

  it("never reports a settled verdict for a run it cannot see", () => {
    // Nothing dispatched here at all — this worker is cold.
    const payload = longJobs.buildStatusPayload(longJobs.lookupJob(KIND, KEY, "some-id"));
    expect(payload.status).not.toBe("done");
    expect(payload.status).not.toBe("error");
    expect(payload.settled).toBe(false);
  });

  it("reports a running job as unsettled while it works", () => {
    const { job } = longJobs.dispatch(KIND, KEY, () => new Promise(() => {}));
    const payload = longJobs.buildStatusPayload(longJobs.lookupJob(KIND, KEY, job.jobId));
    expect(payload.status).toBe("running");
    expect(payload.running).toBe(true);
    expect(payload.settled).toBe(false);
  });

  it("distinguishes idle (nothing dispatched) from unknown-here (a named id)", () => {
    expect(longJobs.lookupJob(KIND, KEY).kind).toBe("idle");
    expect(longJobs.lookupJob(KIND, KEY, "named-id").kind).toBe("unknown-here");
  });

  it("treats a run older than the dead threshold as no longer in flight", () => {
    const job = longJobs.markStarted(KIND, KEY, Date.now() - 60 * 60 * 1000);
    expect(job.status).toBe("running");
    // A worker killed mid-run must not wedge the lane out of dispatching.
    expect(longJobs.isRunning(KIND, KEY)).toBe(false);
  });
});

describe("the cron poller's classify contract", () => {
  it("keeps polling on unknown-here — this is the load-bearing rule", () => {
    // With 2 serving instances about half of all polls land on the worker
    // that did not dispatch. Reading that as a verdict is the bug that made
    // a web page say "Refresh complete." mid-run (CF-PORTFOLIO-REFRESH-ASYNC).
    const v = classifyStatus({ status: "unknown-here", settled: false });
    expect(v.kind).toBe("keep-polling");
    expect(v.reason).toBe("unknown-here");
  });

  it("keeps polling on idle and on running", () => {
    expect(classifyStatus({ status: "idle" }).kind).toBe("keep-polling");
    expect(classifyStatus({ status: "running" }).kind).toBe("keep-polling");
  });

  it("settles only on an explicit done, and hands back the body", () => {
    const v = classifyStatus({ status: "done", settled: true, report: { anomalies: [] } });
    expect(v.kind).toBe("done");
    expect(v.body.report).toEqual({ anomalies: [] });
  });

  it("reports an explicit error as an error", () => {
    const v = classifyStatus({ status: "error", error: "boom" });
    expect(v.kind).toBe("error");
    expect(v.error).toBe("boom");
  });

  it("keeps polling on an unparseable or unrecognised body rather than guessing", () => {
    expect(classifyStatus(null).kind).toBe("keep-polling");
    expect(classifyStatus({}).kind).toBe("keep-polling");
    expect(classifyStatus({ status: "weird" }).kind).toBe("keep-polling");
  });
});
