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
//   BACKFILL_MAX_MINUTES       default 25 (workflow slice cap; self-relaunches if hit)
//   DRAIN_FLOOR                stop when pending drops below this (default 100)

const ADMIN = process.env.ADMIN_API_TOKEN;
if (!ADMIN) { console.error("ADMIN_API_TOKEN required"); process.exit(1); }
const BASE = process.env.API_BASE || "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const DRAIN_FLOOR = Math.max(0, Number(process.env.DRAIN_FLOOR || 100));

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function apiPost(path) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ADMIN}` },
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return await r.json();
}

async function apiGet(path) {
  const r = await fetch(BASE + path, {
    method: "GET",
    headers: { "Authorization": `Bearer ${ADMIN}` },
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return await r.json();
}

async function currentPending() {
  const health = await apiGet("/api/staging/health");
  if (health.error) return -1;
  return health.counts?.pending ?? 0;
}

async function main() {
  console.log(`[drain-staging-backlog] maxMinutes=${MAX_MINUTES} floor=${DRAIN_FLOOR}`);
  const startPending = await currentPending();
  console.log(`  Starting pending count: ${startPending}`);
  if (startPending <= DRAIN_FLOOR) { console.log("  Below floor — nothing to do."); return; }

  let cycles = 0;
  let cleanedTotal = 0, autoFixedTotal = 0, promotedTotal = 0;

  while (!timeExpired()) {
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

  const finalPending = await currentPending();
  console.log(`\n=== Done ===`);
  console.log(`  cycles run:        ${cycles}`);
  console.log(`  cleaned this slice: ${cleanedTotal}`);
  console.log(`  autoFixed:         ${autoFixedTotal}`);
  console.log(`  promoted:          ${promotedTotal}`);
  console.log(`  pending start:     ${startPending}`);
  console.log(`  pending now:       ${finalPending}`);
  console.log(`  pending drained:   ${startPending - finalPending}`);
  console.log(`RELAUNCH_NEEDED=${(finalPending > DRAIN_FLOOR && timeExpired()) ? "true" : "false"}`);
}

main().catch(e => { console.error(e); process.exit(1); });
