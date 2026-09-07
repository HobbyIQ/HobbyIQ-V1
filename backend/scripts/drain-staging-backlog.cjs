#!/usr/bin/env node
// CF-DRAIN-STAGING-BACKLOG (Drew, 2026-08-01).
//
// One-shot drainer for the 416K pending rows in comps_staging.
// Repeatedly calls the staging pipeline endpoints (data-clean →
// auto-triage → promotion) at the max batch size, in a tight loop,
// until pending drops below a floor OR the max-minutes cap hits.
//
// The 5-minute cron only cycles at ~800 rows/cycle. This drainer
// cycles as fast as the endpoints can respond (~8-15s per cycle
// wall time) so 416K drains in a few hours instead of two weeks.
//
// Env:
//   ADMIN_API_TOKEN            required (fetched from App Service by workflow)
//   API_BASE                   default HobbyIQ3 prod URL
//   RUN_MINUTES                work-loop budget (default 110); RESERVE_MS and
//                              VERIFY_MS override the per-cycle reserve and the
//                              final pending-read cap. BACKFILL_MAX_MINUTES is
//                              GONE -- it capped at the loop top, reserved
//                              nothing, and signalled through RELAUNCH_NEEDED.
//   DRAIN_FLOOR                stop when pending drops below this (default 100)

const path = require("node:path");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const ADMIN = process.env.ADMIN_API_TOKEN;
if (!ADMIN) { console.error("ADMIN_API_TOKEN required"); process.exit(1); }
// CF-RUNNER-FLAG-HYGIENE (D18, 2026-08-29). This read no flag at all, so an
// `apply=false` dispatch drained staging through the live endpoints anyway.
// It honours the runner's BACKFILL_APPLY now: a dry dispatch reports the
// pending count and exits. The endpoints own the write counts (cleaned /
// autoFixed / promoted are what THEY return); this script has no "intended"
// of its own to reconcile against, so it stays outside the reconciliation net.
const APPLY = process.env.BACKFILL_APPLY === "true";
const BASE = process.env.API_BASE || "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const DRAIN_FLOOR = Math.max(0, Number(process.env.DRAIN_FLOOR || 100));

// -- THE CLOCK, AND WHAT IT REPLACES ----------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane drives the staging pipeline
// endpoints (data-clean -> auto-triage -> promotion) as fast as they answer,
// until pending drops below a floor. Its writes are the API's, but the DRAIN
// is its own: it decides how much of the 416K backlog enters the pool tonight.
//
// IT WAS NOT UNCLOCKED. IT WAS CLOCKED WRONG, the same class as its two
// siblings on the same runner gate. It carried a LOCAL `BACKFILL_MAX_MINUTES`
// (default 25) tested at the loop TOP -- so a cycle already in flight, three
// endpoint calls deep, ran on past expiry with nothing reserved for it -- and
// it signalled continuation with `RELAUNCH_NEEDED=true|false`.
//
// THAT PROTOCOL HAS TWO ARMS AND NO THIRD. The runner "Self-relaunch catalog
// expansion" step re-dispatches on `true`, stops on `false`, and sends
// ANYTHING ELSE -- including the empty string a KILLED step leaves, because a
// killed step prints no line at all -- to a `::warning::` that does NOT fail
// the job. So a run killed at the 150-minute ceiling went GREEN with the
// backlog half drained. The lane moves onto the marker and off that gate here.
//
// >>> A PARTIAL RUN HERE IS SHORTER, NOT WRONG. <<<
//
// Nothing is computed across cycles. Each cycle asks the endpoints to process
// their next batch and they answer with what they did; the pending count is
// read, never derived. A stop simply leaves rows pending, which is the state
// the 5-minute cron already handles and the next dispatch resumes from. No
// refusal is owed.
//
// THE UNIT IS ONE CYCLE: three POSTs (800 + 2,000 + 2,000 rows) plus, every
// fifth cycle, a health GET. The file's own header measures a cycle at
// "~8-15s per cycle wall time"; 3 minutes is the ceiling past which a cycle is
// not slow but stuck, and it is what the pre-check reserves.
//
// VERIFY_MS bounds the FINAL pending read -- the one post-loop read this lane
// does. It is a /api/staging/health GET, not a Cosmos aggregate, but it is
// still a network call after the work has finished, which is exactly the
// position #1799 kill occupied. 60 seconds.
// Worst case 110 + 3 + 1 + 1 + 1 = 116m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 3 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function apiPost(path) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ADMIN}` },
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return await r.json();
}

// `signal` is threaded through so a capped read is actually CANCELLED rather
// than merely ignored (#1809): an abandoned fetch keeps a ref'd socket, and a
// ref'd handle is exactly what holds node open past the ceiling.
async function apiGet(path, signal) {
  const r = await fetch(BASE + path, {
    method: "GET",
    headers: { "Authorization": `Bearer ${ADMIN}` },
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return await r.json();
}

async function currentPending(signal) {
  const health = await apiGet("/api/staging/health", signal);
  if (health.error) return -1;
  return health.counts?.pending ?? 0;
}

async function main() {
  console.log(`[drain-staging-backlog] floor=${DRAIN_FLOOR}`);
  console.log(`  ${CLOCK.describe()}`);
  const startPending = await currentPending();
  console.log(`  Starting pending count: ${startPending}`);
  if (startPending <= DRAIN_FLOOR) { console.log("  Below floor — nothing to do."); return { budget: CLOCK }; }
  if (!APPLY) {
    console.log("  DRY-RUN — BACKFILL_APPLY is not \"true\"; no endpoint called. Dispatch with apply=true to drain.");
    return { budget: CLOCK };
  }

  let cycles = 0;
  let cleanedTotal = 0, autoFixedTotal = 0, promotedTotal = 0;

  let stoppedAtBudget = false;
  while (true) {
    // THE PRE-CHECK, before the cycle starts rather than after its three POSTs
    // have been issued. A cycle costing more than the reserve is stopped BEFORE
    // it starts (#1799); a stop here leaves rows pending, which is the state
    // the 5-minute cron already handles.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    cycles++;
    const t0 = Date.now();

    // Data-clean 800 at a time
    const dc = await apiPost("/api/staging/data-clean?limit=800");
    if (dc.error) { console.log(`  cycle=${cycles} data-clean err: ${dc.error}`); }
    else { cleanedTotal += (dc.cleaned || 0); }

    // Auto-triage 2000 at a time
    const at = await apiPost("/api/staging/auto-triage?limit=2000");
    if (at.error) { console.log(`  cycle=${cycles} auto-triage err: ${at.error}`); }
    else { autoFixedTotal += (at.autoFixed || 0); }

    // Promotion 2000 at a time
    const pr = await apiPost("/api/staging/promotion?limit=2000");
    if (pr.error) { console.log(`  cycle=${cycles} promotion err: ${pr.error}`); }
    else { promotedTotal += (pr.promoted || 0); }

    const cycleMs = Date.now() - t0;
    if (cycles % 5 === 0) {
      const pending = await currentPending();
      console.log(`  cycle=${cycles} pending=${pending} cleanedRun=${cleanedTotal} autoFixedRun=${autoFixedTotal} promotedRun=${promotedTotal} cycleMs=${cycleMs}`);
      if (pending <= DRAIN_FLOOR) { console.log("  Reached floor — stopping."); break; }
    }

    // Small breather so we don't hammer the server
    await new Promise(r => setTimeout(r, 500));
  }

  // The one post-loop read, UNDER THE CAP. It is a network call after the work
  // has finished -- the position #1799's kill occupied -- so it answers or it
  // says it could not, and it never holds the step open. `capped` takes its own
  // t0 so the cap is this phase's, not the run's.
  const vt0 = Date.now();
  const finalPending = await CLOCK.capped(vt0, "final pending count", (signal) =>
    currentPending(signal));
  console.log(`\n=== Done ===`);
  console.log(`  cycles run:        ${cycles}`);
  console.log(`  cleaned this slice: ${cleanedTotal}`);
  console.log(`  autoFixed:         ${autoFixedTotal}`);
  console.log(`  promoted:          ${promotedTotal}`);
  console.log(`  pending start:     ${startPending}`);
  // An UNREAD count is never printed as a number, and never as zero
  // (feedback_never_dismiss_small_numbers_as_noise).
  console.log(`  pending now:       ${CLOCK.shown(finalPending, "pending")}`);
  if (finalPending === null) {
    console.log(CLOCK.unreadNote());
    console.log(`  pending drained:   UNCONFIRMED (verify cap) — the endpoints' own counts above are the record`);
  } else {
    console.log(`  pending drained:   ${startPending - finalPending}`);
  }

  // NO reportWrites HERE, DELIBERATELY, and the reason is worth stating rather
  // than leaving as an absence. The writes are the ENDPOINTS' -- cleaned /
  // autoFixed / promoted are what THEY return -- and this lane has no
  // `intended` of its own to reconcile them against. A banner built from three
  // numbers a remote service reported would assert an identity nothing here
  // can check, which is worse than no guard at all: it turns a real shortfall
  // green. everyWriteJobReconciles.test.ts classifies it out of the writer
  // population for the same reason.

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables. This REPLACES the `RELAUNCH_NEEDED=<bool>` line, whose third arm
  // went green on a kill -- see THE CLOCK above.
  //
  // THE CONDITION IS THE STOP, NOT THE PENDING COUNT. The old line required
  // BOTH `finalPending > DRAIN_FLOOR` AND the cap, so a run whose final health
  // GET failed (currentPending returns -1) printed `RELAUNCH_NEEDED=false` and
  // ENDED THE FAN-OUT -- an unreadable count read as "the backlog is drained".
  // A budget stop means work remains whether or not the count came back.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the backlog is NOT drained; the relaunch continues from here`);
    console.log("  the continuation re-reads nothing this pass wrote: the endpoints take their next"
      + " batch of PENDING rows, and a row this run promoted is no longer pending.");
  }
  return { budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
