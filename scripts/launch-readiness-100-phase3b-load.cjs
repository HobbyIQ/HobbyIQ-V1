// CF-LAUNCH-READINESS-100 Phase 3b — autoscale verification load test.
//
// Two tracks (run concurrently within each session):
//
//   Track 1: HTTP load against open endpoints that exercise the
//            autoscaled dailyiq_briefs container + adjacent containers
//            via realistic user-action mix. Open routes are:
//              GET /api/dailyiq/brief?date=...  → dailyiq_briefs read
//              GET /api/playeriq/{playerName}    → player_trends read (adjacent; not autoscaled)
//              GET /api/dailyiq/players/top/mlb  → DailyIQ rank read
//              POST /api/compiq/estimate          → comp_logs write
//
//   Track 2: Direct Cosmos read load against the portfolio container.
//            The app path requires a real session-id; this bypass
//            uses the same query shape that portfolioStore.service.ts
//            issues so the RU pattern matches realistic dashboard
//            traffic.
//
// 12 concurrent sessions, staggered 250ms apart at start. Each session
// runs 6 min. Per-session loop fires one of the actions, waits a
// random 1-3s "think time", fires next. Mix is weighted realistic:
// 40% DailyIQ brief, 25% portfolio query, 20% PlayerIQ, 15% top-mlb.
//
// Pass criteria (verified by post-run metric pull):
//   - Zero 429s on dailyiq_briefs + portfolio during the window
//   - p95 response time within current single-operator baseline
//   - No Sev 1 alerts fired
//   - Cosmos RU on the two autoscaled containers climbs above 1000 floor

const https = require("https");
const { URL } = require("url");
const { CosmosClient } = require("@azure/cosmos");

const BASE = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const SESSIONS = 12;
const SESSION_DURATION_MIN = 6;
const STAGGER_MS = 250;

const KNOWN_PLAYERS = [
  "Bobby Witt Jr",
  "Mike Trout",
  "Bobby Cox",
  "Ken Griffey",
  "Shohei Ohtani",
  "Aaron Judge",
  "Paul Skenes",
  "Wyatt Langford",
  "Jackson Holliday",
  "Junior Caminero",
];

const KNOWN_DATES = [
  "2026-05-28", "2026-05-27", "2026-05-26", "2026-05-25", "2026-05-24",
];

// Per-session metric accumulators.
const stats = {
  requestsByPath: {},   // { "/api/dailyiq/brief": { count, totalMs, errors } }
  errorsTotal: 0,
  startMs: 0,
  endMs: 0,
};

function recordStat(path, ms, isError, status) {
  if (!stats.requestsByPath[path]) {
    stats.requestsByPath[path] = { count: 0, totalMs: 0, errors: 0, statusCounts: {} };
  }
  const s = stats.requestsByPath[path];
  s.count += 1;
  s.totalMs += ms;
  if (isError) s.errors += 1;
  if (status) s.statusCounts[status] = (s.statusCounts[status] || 0) + 1;
  if (isError) stats.errorsTotal += 1;
}

function httpRequest({ method = "GET", path, body }) {
  const url = new URL(`${BASE}${path}`);
  const t0 = Date.now();
  const bodyStr = body ? JSON.stringify(body) : null;
  const opts = {
    method,
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: {
      "Accept": "application/json",
      ...(bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}),
    },
    timeout: 20000,
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let _b = "";
      res.on("data", (c) => { _b += c; });
      res.on("end", () => {
        const ms = Date.now() - t0;
        const isError = res.statusCode >= 500;
        recordStat(path.split("?")[0], ms, isError, res.statusCode);
        resolve();
      });
    });
    req.on("error", () => {
      recordStat(path.split("?")[0], Date.now() - t0, true, 0);
      resolve();
    });
    req.on("timeout", () => {
      recordStat(path.split("?")[0], Date.now() - t0, true, 0);
      req.destroy();
      resolve();
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function thinkTime() { return 1000 + Math.floor(Math.random() * 2000); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Track 1: HTTP actions ───────────────────────────────────────────
async function action_dailyIqBrief() {
  await httpRequest({ path: `/api/dailyiq/brief?date=${pick(KNOWN_DATES)}` });
}
async function action_playerIq() {
  await httpRequest({ path: `/api/playeriq/${encodeURIComponent(pick(KNOWN_PLAYERS))}` });
}
async function action_topMlb() {
  await httpRequest({ path: `/api/dailyiq/players/top/mlb` });
}
async function action_compiqEstimate() {
  await httpRequest({
    method: "POST",
    path: `/api/compiq/estimate`,
    body: { query: pick(KNOWN_PLAYERS), grade: "PSA 10" },
  });
}

// ── Track 2: Direct Cosmos read on portfolio container ──────────────
// Matches the read pattern that portfolioStore.service issues when the
// iOS app refreshes the holdings dashboard.
let cosmosClient = null;
let portfolioContainer = null;
function initCosmos() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set — Track 2 disabled"); return false; }
  cosmosClient = new CosmosClient(conn);
  portfolioContainer = cosmosClient.database("hobbyiq").container("portfolio");
  return true;
}

async function action_portfolioRead() {
  if (!portfolioContainer) return;
  const t0 = Date.now();
  try {
    // Realistic shape: cross-partition SELECT TOP N FROM c with a date filter.
    // Matches getHoldings query pattern (read all active for a synthetic user).
    const { resources } = await portfolioContainer.items
      .query({
        query: "SELECT TOP 20 c.id, c.userId, c.cardYear, c.cardTitle, c.cardName, c.fairMarketValue, c.predictedPrice FROM c WHERE c.status != 'sold' AND c.updatedAt > @cutoff",
        parameters: [{ name: "@cutoff", value: "2026-04-01T00:00:00Z" }],
      })
      .fetchAll();
    recordStat("[cosmos]portfolio:select-top-20", Date.now() - t0, false, 200);
  } catch (err) {
    const code = err.code || 0;
    recordStat("[cosmos]portfolio:select-top-20", Date.now() - t0, true, code);
  }
}

// Weighted action picker (per spec): 40% dailyIQ brief, 25% portfolio
// (direct Cosmos), 20% playerIQ, 15% topMlb. Falls back to compiq
// estimate occasionally to exercise the write path.
function pickAction() {
  const r = Math.random();
  if (r < 0.40) return action_dailyIqBrief;
  if (r < 0.65) return action_portfolioRead;
  if (r < 0.85) return action_playerIq;
  if (r < 0.96) return action_topMlb;
  return action_compiqEstimate;
}

async function runSession(id, durationMs) {
  const endAt = Date.now() + durationMs;
  while (Date.now() < endAt) {
    const action = pickAction();
    await action();
    await sleep(thinkTime());
  }
}

async function main() {
  const cosmosOk = initCosmos();
  stats.startMs = Date.now();
  console.log(`Phase 3b autoscale verification load test`);
  console.log(`  start (UTC):       ${new Date(stats.startMs).toISOString()}`);
  console.log(`  sessions:          ${SESSIONS}`);
  console.log(`  session duration:  ${SESSION_DURATION_MIN} min`);
  console.log(`  stagger:           ${STAGGER_MS}ms between session starts`);
  console.log(`  target:            ${BASE}`);
  console.log(`  Track 2 (Cosmos):  ${cosmosOk ? "ENABLED — direct portfolio reads" : "DISABLED — set COSMOS_CONNECTION_STRING"}`);
  console.log("");

  const sessions = [];
  for (let i = 0; i < SESSIONS; i++) {
    await sleep(STAGGER_MS);
    sessions.push(runSession(i, SESSION_DURATION_MIN * 60_000));
  }
  await Promise.all(sessions);

  stats.endMs = Date.now();
  console.log("");
  console.log(`Phase 3b complete.`);
  console.log(`  end (UTC):         ${new Date(stats.endMs).toISOString()}`);
  console.log(`  duration:          ${((stats.endMs - stats.startMs) / 60000).toFixed(1)} min`);
  console.log(`  errors total:      ${stats.errorsTotal}`);
  console.log("");
  console.log(`  Per-path stats:`);
  const paths = Object.keys(stats.requestsByPath).sort();
  for (const p of paths) {
    const s = stats.requestsByPath[p];
    const avg = s.count > 0 ? (s.totalMs / s.count).toFixed(0) : 0;
    const status = Object.entries(s.statusCounts).map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(`    ${p.padEnd(50)} count=${String(s.count).padStart(4)} avg=${String(avg).padStart(5)}ms errors=${s.errors} statuses=[${status}]`);
  }
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
