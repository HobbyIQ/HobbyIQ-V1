// CF-LAUNCH-READINESS-100 Phase 3a — alert-delivery end-to-end test.
//
// Goal: trip the `appservice-response-time-elevated` alert (avg
// AverageResponseTime > 2s over 15 min) so an alert email lands at
// drew@justtheboysandcards.com. The arrival of the email is the
// load-bearing verification — telemetry being captured isn't enough;
// the alert must actually reach a human.
//
// Strategy: hit Cardsight-routed estimate endpoints with unfamiliar /
// no-recent-comps cards. Those paths take 1-3s round trip even under
// no load. Run 8 concurrent workers, each firing 1 request, waiting
// for response, immediately firing again — for 18 min total. That
// covers the 15-min averaging window plus alert-evaluation overhead.
//
// Doesn't matter if responses are empty or error — alert is on
// AverageResponseTime, not success rate. Slow responses are the goal.
//
// Run: node backend/scripts/launch-readiness-100-phase3a-slow-load.cjs

const https = require("https");
const { URL } = require("url");

const BASE = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const DURATION_MIN = 18;
const WORKERS = 8;

// Unfamiliar / sparse-data cards. The estimate path for these returns
// no-recent-comps after Cardsight resolution + comp fetch — typically
// 1.5-3s per call. Mixed years/sets to avoid Redis caching the whole
// fleet of probes after the first few calls.
const PROBES = [
  { q: "Garrett Crochet 2024 Topps Heritage Chrome Purple Refractor /199 PSA 10", year: 2024 },
  { q: "Roman Anthony 2023 Bowman Sterling Purple Refractor Auto /150", year: 2023 },
  { q: "Wyatt Langford 2022 Bowman Chrome Prospect Aqua Refractor /199 BGS 9.5", year: 2022 },
  { q: "Paul Skenes 2024 Topps Chrome Update Orange Wave Refractor /25 PSA 10", year: 2024 },
  { q: "Jackson Holliday 2024 Bowman Chrome Sapphire Edition Aqua /150 PSA 10", year: 2024 },
  { q: "Junior Caminero 2024 Topps Now Auto Variation /99", year: 2024 },
  { q: "Pete Crow-Armstrong 2024 Topps Chrome Sepia Refractor /75 PSA 9", year: 2024 },
  { q: "Jasson Dominguez 2023 Bowman Chrome Prospect Sapphire Auto /99 PSA 10", year: 2023 },
  { q: "Dylan Crews 2024 Bowman Heritage Chrome Refractor Auto SP", year: 2024 },
  { q: "James Wood 2024 Topps Heritage Chrome Aqua Refractor /99 BGS 9", year: 2024 },
];

const startMs = Date.now();
const endMs = startMs + DURATION_MIN * 60_000;
let probeCount = 0;
let errorCount = 0;
let totalLatencyMs = 0;
let maxLatencyMs = 0;

function fireOnce(workerId) {
  const probe = PROBES[probeCount % PROBES.length];
  const t0 = Date.now();
  const body = JSON.stringify({
    query: probe.q,
    cardYear: probe.year,
    grade: probe.q.includes("PSA 10") ? "PSA 10" : (probe.q.includes("BGS 9.5") ? "BGS 9.5" : "Raw"),
  });
  const url = new URL(`${BASE}/api/compiq/estimate`);
  const opts = {
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 30000,
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let _b = "";
      res.on("data", (chunk) => { _b += chunk; });
      res.on("end", () => {
        const dt = Date.now() - t0;
        totalLatencyMs += dt;
        if (dt > maxLatencyMs) maxLatencyMs = dt;
        probeCount += 1;
        if (probeCount % 20 === 0) {
          const elapsedMin = ((Date.now() - startMs) / 60000).toFixed(1);
          const avgMs = (totalLatencyMs / probeCount).toFixed(0);
          console.log(`[${elapsedMin}m] probes=${probeCount} avg=${avgMs}ms max=${maxLatencyMs}ms errors=${errorCount} status=${res.statusCode}`);
        }
        resolve();
      });
    });
    req.on("error", (err) => {
      errorCount += 1;
      probeCount += 1;
      resolve();
    });
    req.on("timeout", () => {
      errorCount += 1;
      probeCount += 1;
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

async function worker(id) {
  while (Date.now() < endMs) {
    await fireOnce(id);
  }
}

async function main() {
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  console.log(`Phase 3a slow-load — induced response-time elevation`);
  console.log(`  start (UTC): ${startIso}`);
  console.log(`  end   (UTC): ${endIso}  (${DURATION_MIN} min duration)`);
  console.log(`  workers:     ${WORKERS}`);
  console.log(`  target:      ${BASE}/api/compiq/estimate`);
  console.log(`  goal:        push AverageResponseTime > 2s sustained`);
  console.log("");

  const workers = [];
  for (let i = 0; i < WORKERS; i++) workers.push(worker(i));
  await Promise.all(workers);

  const finalAvgMs = probeCount > 0 ? (totalLatencyMs / probeCount).toFixed(0) : 0;
  console.log("");
  console.log(`Phase 3a complete.`);
  console.log(`  total probes:    ${probeCount}`);
  console.log(`  errors:          ${errorCount}`);
  console.log(`  avg latency:     ${finalAvgMs}ms`);
  console.log(`  max latency:     ${maxLatencyMs}ms`);
  console.log(`  end (UTC):       ${new Date().toISOString()}`);
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
