// CF-LAUNCH-READINESS-100 Phase 3b' — autoscale verification, clean re-run.
//
// Original Phase 3b ran with 6 min overlap against Phase 3a's slow-load
// (test discipline failure on the operator side — Phase 3b should have
// waited for Phase 3a to fully complete + a settle window). The 9,918
// Cosmos 429s observed during the contaminated window were attributable
// to Phase 3a's residual /api/compiq/estimate calls driving
// updatePlayerScoreFromEstimate fire-and-forget upserts against
// player_trends (flat 400 RU/s, not autoscaled), not to the autoscaled
// dailyiq_briefs or portfolio containers.
//
// Phase 3b' restructures around direct-Cosmos load against BOTH
// autoscaled containers. Bypasses the 200 req/min/IP express-rate-limit
// middleware at backend/src/app.ts:28 (which shielded Phase 3b's HTTP
// path traffic from ever reaching dailyiq_briefs at scale).
//
// Track design: 12 simulated sessions, 6 min each, 250ms stagger.
// Per session: 60% dailyiq_briefs reads, 40% portfolio reads. 1-3s
// think time. Realistic 100-user-equivalent pace.
//
// Pass criteria (sharpened from original spec per Drew):
//   - Zero 429s on EITHER autoscaled container during the window
//   - Whether or not RU climbs above 1000 floor is INFORMATIONAL, not
//     pass/fail. Either outcome is honestly framed:
//       * RU > 1000 → autoscale engaged, working as designed
//       * RU stays ≤ 1000 → 100-tier load doesn't naturally stress
//         autoscale; it exists as a safety margin against unexpected
//         spikes, not as an actively-engaging mechanism at this tier.
//   - HALT conditions: any 429 on either autoscaled container, any
//     Sev 1 alert fires during the window.

const { CosmosClient } = require("@azure/cosmos");

const SESSIONS = 12;
const SESSION_DURATION_MIN = 6;
const STAGGER_MS = 250;

const KNOWN_BRIEF_DATES = [
  "2026-05-28", "2026-05-27", "2026-05-26", "2026-05-25", "2026-05-24",
  "2026-05-23", "2026-05-22", "2026-05-21", "2026-05-20", "2026-05-19",
];

const stats = {
  reads: { dailyiq_briefs: 0, portfolio: 0 },
  errors: { dailyiq_briefs: 0, portfolio: 0 },
  totalMs: { dailyiq_briefs: 0, portfolio: 0 },
  maxMs: { dailyiq_briefs: 0, portfolio: 0 },
  errorCodes: { dailyiq_briefs: {}, portfolio: {} },
  startMs: 0,
  endMs: 0,
};

let dailyiqContainer = null;
let portfolioContainer = null;

function initCosmos() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(2); }
  const client = new CosmosClient(conn);
  dailyiqContainer = client.database("hobbyiq").container("dailyiq_briefs");
  portfolioContainer = client.database("hobbyiq").container("portfolio");
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function thinkTime() { return 1000 + Math.floor(Math.random() * 2000); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function record(coll, ms, err) {
  stats.reads[coll] += 1;
  stats.totalMs[coll] += ms;
  if (ms > stats.maxMs[coll]) stats.maxMs[coll] = ms;
  if (err) {
    stats.errors[coll] += 1;
    const code = err.code || err.statusCode || "unknown";
    stats.errorCodes[coll][code] = (stats.errorCodes[coll][code] || 0) + 1;
  }
}

// dailyiq_briefs point-read by date — mirrors briefStore.service.ts:126
// container.item(date, date).read<BriefDoc>(). 1 RU per point read.
async function action_dailyIqBrief() {
  const date = pick(KNOWN_BRIEF_DATES);
  const t0 = Date.now();
  try {
    await dailyiqContainer.item(date, date).read();
    record("dailyiq_briefs", Date.now() - t0, null);
  } catch (err) {
    // 404 is expected for dates with no brief; not an error for autoscale
    // verification purposes (still counts as a read against the container).
    if (err.code === 404) {
      record("dailyiq_briefs", Date.now() - t0, null);
    } else {
      record("dailyiq_briefs", Date.now() - t0, err);
    }
  }
}

// portfolio cross-partition SELECT TOP — mirrors getHoldings shape used
// by Track 2 in the original Phase 3b. ~2-3 RU per query against the
// current dataset.
async function action_portfolioRead() {
  const t0 = Date.now();
  try {
    await portfolioContainer.items
      .query({
        query: "SELECT TOP 20 c.id, c.userId, c.cardYear, c.cardTitle, c.cardName, c.fairMarketValue, c.predictedPrice FROM c WHERE c.status != 'sold' AND c.updatedAt > @cutoff",
        parameters: [{ name: "@cutoff", value: "2026-04-01T00:00:00Z" }],
      })
      .fetchAll();
    record("portfolio", Date.now() - t0, null);
  } catch (err) {
    record("portfolio", Date.now() - t0, err);
  }
}

function pickAction() {
  return Math.random() < 0.60 ? action_dailyIqBrief : action_portfolioRead;
}

async function runSession(durationMs) {
  const endAt = Date.now() + durationMs;
  while (Date.now() < endAt) {
    await pickAction()();
    await sleep(thinkTime());
  }
}

async function main() {
  initCosmos();
  stats.startMs = Date.now();
  console.log(`Phase 3b' direct-Cosmos autoscale verification`);
  console.log(`  start (UTC):       ${new Date(stats.startMs).toISOString()}`);
  console.log(`  sessions:          ${SESSIONS}`);
  console.log(`  session duration:  ${SESSION_DURATION_MIN} min`);
  console.log(`  stagger:           ${STAGGER_MS}ms`);
  console.log(`  targets:           dailyiq_briefs (60%) + portfolio (40%)`);
  console.log(`  pattern:           direct Cosmos, bypassing HTTP rate-limiter`);
  console.log("");

  const sessions = [];
  for (let i = 0; i < SESSIONS; i++) {
    await sleep(STAGGER_MS);
    sessions.push(runSession(SESSION_DURATION_MIN * 60_000));
  }
  await Promise.all(sessions);

  stats.endMs = Date.now();
  console.log("");
  console.log(`Phase 3b' complete.`);
  console.log(`  end (UTC):         ${new Date(stats.endMs).toISOString()}`);
  console.log(`  duration:          ${((stats.endMs - stats.startMs) / 60000).toFixed(1)} min`);
  console.log("");
  for (const coll of ["dailyiq_briefs", "portfolio"]) {
    const r = stats.reads[coll];
    const e = stats.errors[coll];
    const avg = r > 0 ? (stats.totalMs[coll] / r).toFixed(0) : 0;
    const max = stats.maxMs[coll];
    const errCodes = Object.entries(stats.errorCodes[coll]).map(([k, v]) => `${k}:${v}`).join(",") || "none";
    console.log(`  ${coll.padEnd(20)} reads=${r} errors=${e} avg=${avg}ms max=${max}ms errorCodes=${errCodes}`);
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
