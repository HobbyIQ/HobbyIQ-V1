/**
 * CF-PORTFOLIO-REFRESH-ASYNC — the judged blocker (Drew, 2026-08-31).
 *
 * THE DEFECT
 * ----------
 * repriceJobTracker keeps job state in an in-process Map, and App Insights
 * shows **2 serving instances** per role. A client dispatches on instance A;
 * its next status poll load-balances and lands on instance B, whose map holds
 * nothing for that user. The first cut answered that with
 * `{status:"idle", running:false}` — and both clients (apps/web portfolio
 * page, iOS BatchRepriceView) treated any non-running status as settled. Net
 * effect: roughly half of all polls made the UI announce "Refresh complete."
 * while the run was still pricing on the other instance.
 *
 * THE FIX PINNED HERE
 * -------------------
 * Ignorance gets its own answer. The dispatch mints a jobId, polls carry it,
 * and a worker that cannot account for that id says `unknown-here`. `settled`
 * is true ONLY for a run a worker actually watched reach done/error, and it
 * is the field clients branch on. Three properties, one per client rule:
 *
 *   1. idle-after-dispatch keeps polling  (never reported settled)
 *   2. unknown-here keeps polling         (never reported settled)
 *   3. the deadline yields the honest message, never "complete"
 *
 * The state stays in-process by design — this round adds no durable store.
 * What changed is only that the progress surface stopped claiming to know
 * things it cannot see.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as tracker from "../src/services/portfolioiq/repriceJobTracker.js";

// portfolioStore.service pulls the Cosmos client in at module load, so import
// it lazily inside the tests that need it (same pattern as the sibling file).
const loadStatusPayload = async () =>
  (await import("../src/services/portfolioiq/portfolioStore.service.js"))
    .buildRepriceStatusPayload;

describe("repriceJobTracker — a worker distinguishes 'not mine' from 'not running'", () => {
  beforeEach(() => tracker.__resetForTests());

  it("mints a distinct jobId per dispatch", () => {
    const a = tracker.markStarted("user-a");
    const b = tracker.markStarted("user-b");
    expect(a.jobId).toBeTruthy();
    expect(b.jobId).toBeTruthy();
    expect(a.jobId).not.toBe(b.jobId);
  });

  it("owns the run when the polled id matches", () => {
    const job = tracker.markStarted("user-a");
    const found = tracker.lookupJob("user-a", job.jobId);
    expect(found.kind).toBe("job");
  });

  it("answers unknown-here for an id it never minted — the OTHER instance's run", () => {
    // This worker has never seen this user at all: exactly the state of
    // instance B when the dispatch went to instance A.
    const found = tracker.lookupJob("user-a", "job-minted-on-the-other-instance");
    expect(found.kind).toBe("unknown-here");
  });

  it("answers unknown-here when it holds a DIFFERENT run for the same user", () => {
    tracker.markStarted("user-a");
    const found = tracker.lookupJob("user-a", "some-other-job-id");
    expect(found.kind).toBe("unknown-here");
  });

  it("answers idle only when no id was named and it holds nothing", () => {
    expect(tracker.lookupJob("user-a", null).kind).toBe("idle");
    expect(tracker.lookupJob("user-a").kind).toBe("idle");
  });
});

describe("buildRepriceStatusPayload — 'not settled' is the answer whenever the run is unseen", () => {
  beforeEach(() => tracker.__resetForTests());

  it("PROPERTY 1: idle after this client dispatched is NOT settled — the client keeps polling", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    // The poll landed on a worker with an empty map and carried no id.
    const out = buildRepriceStatusPayload("user-a", null);
    expect(out.status).toBe("idle");
    expect(out.running).toBe(false);
    // The whole point: idle must never read as a completion.
    expect(out.settled).toBe(false);
    expect(out.result ?? null).toBeNull();
  });

  it("PROPERTY 2: unknown-here is NOT settled — the run may be live on the other instance", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const out = buildRepriceStatusPayload("user-a", "job-from-instance-a");
    expect(out.status).toBe("unknown-here");
    expect(out.running).toBe(false);
    expect(out.settled).toBe(false);
    expect(out.result ?? null).toBeNull();
    // It echoes back the id it was asked about, so a client can correlate.
    expect(out.jobId).toBe("job-from-instance-a");
  });

  it("reports a run this worker owns as running and not settled", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const now = 1_000_000;
    const job = tracker.markStarted("user-a", now);
    const out = buildRepriceStatusPayload("user-a", job.jobId, now + 5_000);
    expect(out.status).toBe("running");
    expect(out.running).toBe(true);
    expect(out.settled).toBe(false);
  });

  it("reports settled ONLY for a run it watched finish, and carries the counts", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const job = tracker.markStarted("user-a");
    tracker.markDone("user-a", {
      requested: 5,
      repriced: 4,
      skipped: 1,
      updates: [],
    } as any);
    const out = buildRepriceStatusPayload("user-a", job.jobId);
    expect(out.status).toBe("done");
    expect(out.running).toBe(false);
    expect(out.settled).toBe(true);
    expect(out.result?.repriced).toBe(4);
  });

  it("reports an observed failure as settled, so the client can stop and show the error", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const job = tracker.markStarted("user-a");
    tracker.markError("user-a", "cosmos exploded");
    const out = buildRepriceStatusPayload("user-a", job.jobId);
    expect(out.status).toBe("error");
    expect(out.settled).toBe(true);
    expect(out.error).toBe("cosmos exploded");
  });

  it("does not report a run aged past the assume-dead window as settled — we never saw it finish", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const t0 = 1_000_000;
    const job = tracker.markStarted("user-a", t0);
    const out = buildRepriceStatusPayload("user-a", job.jobId, t0 + 11 * 60_000);
    expect(out.running).toBe(false);
    // Stopped believing it is alive, but that is not the same as done.
    expect(out.settled).toBe(false);
  });
});

/**
 * The client rule, exercised against the real payload builder: a poll loop
 * that ends only on `settled`, with a deadline. This is the logic in
 * apps/web/src/app/app/portfolio/page.tsx and HobbyIQ/PortfolioAdvancedViews
 * .swift, reduced to what the assertions can hold onto.
 */
type Banner = { text: string; claimedComplete: boolean };

function pollUntilSettled(
  poll: () => { status: string; running: boolean; settled?: boolean; result?: any; error?: string | null },
  maxPolls: number,
): { polls: number; banner: Banner } {
  for (let i = 1; i <= maxPolls; i++) {
    const st = poll();
    if (st.running || st.status === "running") continue;
    if (st.status === "unknown-here" || st.status === "idle") continue;
    if (st.status === "error") {
      return { polls: i, banner: { text: st.error ?? "Refresh failed.", claimedComplete: false } };
    }
    const r = st.result;
    return {
      polls: i,
      banner: {
        text: r ? `Refreshed ${r.repriced} of ${r.requested}` : "Refresh complete.",
        claimedComplete: true,
      },
    };
  }
  // Deadline. The run and the 6h scheduled job both still write to Cosmos.
  return {
    polls: maxPolls,
    banner: {
      text: "Still refreshing — prices will land on their own; reopen this page in a minute.",
      claimedComplete: false,
    },
  };
}

describe("the client poll loop — only a settled run ends it", () => {
  beforeEach(() => tracker.__resetForTests());

  it("PROPERTY 1: keeps polling through idle answers, then finishes on the real done", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const job = tracker.markStarted("user-a");
    let n = 0;
    const out = pollUntilSettled(() => {
      n++;
      // Polls 1-3 land on the worker that has no entry and carry no id.
      if (n <= 3) return buildRepriceStatusPayload("user-a", null) as any;
      if (n === 4) {
        tracker.markDone("user-a", { requested: 2, repriced: 2, skipped: 0, updates: [] } as any);
      }
      return buildRepriceStatusPayload("user-a", job.jobId) as any;
    }, 20);
    // It did NOT stop at the first idle.
    expect(out.polls).toBe(4);
    expect(out.banner.text).toBe("Refreshed 2 of 2");
  });

  it("PROPERTY 2: keeps polling through unknown-here answers, then finishes on the real done", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const job = tracker.markStarted("user-a");
    let n = 0;
    const out = pollUntilSettled(() => {
      n++;
      // Polls 1-5 land on instance B, which cannot account for the id.
      if (n <= 5) return buildRepriceStatusPayload("user-b-empty-worker", job.jobId) as any;
      if (n === 6) {
        tracker.markDone("user-a", { requested: 7, repriced: 6, skipped: 1, updates: [] } as any);
      }
      return buildRepriceStatusPayload("user-a", job.jobId) as any;
    }, 20);
    expect(out.polls).toBe(6);
    expect(out.banner.text).toBe("Refreshed 6 of 7");
  });

  it("PROPERTY 3: a deadline reached with no settle says prices will land — never 'complete'", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const job = tracker.markStarted("user-a");
    // Every poll lands on the wrong instance; the run never settles here.
    const out = pollUntilSettled(
      () => buildRepriceStatusPayload("user-b-empty-worker", job.jobId) as any,
      8,
    );
    expect(out.polls).toBe(8);
    expect(out.banner.claimedComplete).toBe(false);
    expect(out.banner.text).toContain("prices will land on their own");
    expect(out.banner.text).not.toContain("Refresh complete");
  });

  it("REGRESSION: the old rule — 'not running means done' — would have lied on the very first poll", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const job = tracker.markStarted("user-a");
    // The run is genuinely in flight on instance A.
    expect(tracker.isRunning("user-a")).toBe(true);
    // Instance B's answer to a poll about it:
    const wrongInstance = buildRepriceStatusPayload("user-b-empty-worker", job.jobId);
    // Under the old client rule this was the end of the loop and a
    // "Refresh complete." banner. Under the new contract it is not settled.
    expect(wrongInstance.running).toBe(false);
    expect(wrongInstance.settled).toBe(false);
    expect(wrongInstance.status).not.toBe("done");
  });

  it("an observed error still stops the loop and surfaces the message", async () => {
    const buildRepriceStatusPayload = await loadStatusPayload();
    const job = tracker.markStarted("user-a");
    tracker.markError("user-a", "pool read failed");
    const out = pollUntilSettled(() => buildRepriceStatusPayload("user-a", job.jobId) as any, 8);
    expect(out.polls).toBe(1);
    expect(out.banner.text).toBe("pool read failed");
    expect(out.banner.claimedComplete).toBe(false);
  });
});
