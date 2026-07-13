#!/usr/bin/env node
// CF-PREWARM-VENDOR-PRICING (Drew, 2026-07-13) — post-deploy warm-up for the
// L2 Cosmos vendor pricing cache.
//
// PROBLEM: iOS Test 1 timed out on the first Card Detail open after a fresh
// deploy. App Insights (2026-07-13, last hour): POST /api/compiq/price-by-id
// p95 = 21.6s, GET /card-panel p95 = 10s. The in-flight vendor fan-out on
// cold-cache SKUs blows past the iOS URLRequest budget (30s configured, ~15s
// effective for the first render).
//
// FIX: after each deploy, hit /price-by-id for every SKU the user is likely
// to open in the first minute — currently, "every holding in each user's
// portfolio". The first call primes the Cosmos L2 cache; every subsequent
// hit (from any App Service instance) returns in ~90ms.
//
// USAGE:
//   node scripts/prewarm-vendor-pricing.cjs
//
// ENV:
//   PREWARM_API_BASE   Prod URL (default: https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net)
//   PREWARM_USERNAME   Service username (default: HobbyIQ)
//   PREWARM_PASSWORD   Service password — REQUIRED, never checked in
//   PREWARM_CONCURRENCY Number of parallel /price-by-id calls (default: 4)
//   PREWARM_MAX_SKUS   Cap on total SKUs prewarmed (default: 200)
//   PREWARM_TIMEOUT_MS Per-call timeout (default: 45000)
//
// EXIT CODES:
//   0  All prewarms succeeded (or no holdings found)
//   1  Auth failure
//   2  Holdings fetch failure
//   3  Partial failure (some /price-by-id calls errored — still primes the
//      successful ones; retry-safe)
//
// Runs against production against the seeded test session. Warmups are
// no-op-safe: the /price-by-id path already dedupes via Cosmos L2, so a
// re-run costs one cached hit per SKU.

const https = require("https");
const { URL } = require("url");

const API_BASE =
  process.env.PREWARM_API_BASE ||
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const USERNAME = process.env.PREWARM_USERNAME || "HobbyIQ";
const PASSWORD = process.env.PREWARM_PASSWORD;
const CONCURRENCY = Number.parseInt(process.env.PREWARM_CONCURRENCY, 10) || 4;
const MAX_SKUS = Number.parseInt(process.env.PREWARM_MAX_SKUS, 10) || 200;
const TIMEOUT_MS = Number.parseInt(process.env.PREWARM_TIMEOUT_MS, 10) || 45000;

if (!PASSWORD) {
  console.error("PREWARM_PASSWORD env var is required (never checked in)");
  process.exit(1);
}

function request(method, path, body, sessionId) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      protocol: url.protocol,
      port: url.port || 443,
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        ...(sessionId ? { "x-session-id": sessionId } : {}),
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
      },
      timeout: TIMEOUT_MS,
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          const parsed = raw ? JSON.parse(raw) : null;
          resolve({ status: res.statusCode, body: parsed });
        } catch (err) {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function authenticate() {
  const r = await request("POST", "/api/auth/signin", {
    username: USERNAME,
    password: PASSWORD,
  });
  if (r.status !== 200 || !r.body || typeof r.body.sessionId !== "string") {
    console.error(
      JSON.stringify({
        event: "prewarm_auth_failed",
        status: r.status,
        bodyKeys: r.body && typeof r.body === "object" ? Object.keys(r.body) : null,
      }),
    );
    process.exit(1);
  }
  return r.body.sessionId;
}

async function fetchHoldings(sessionId) {
  const r = await request("GET", "/api/portfolio/holdings", null, sessionId);
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.holdings)) {
    console.error(
      JSON.stringify({
        event: "prewarm_holdings_fetch_failed",
        status: r.status,
      }),
    );
    process.exit(2);
  }
  return r.body.holdings;
}

async function prewarmOne(sessionId, holding) {
  const start = Date.now();
  const cardId = holding.cardId || holding.cardsightCardId;
  if (!cardId) {
    return { holdingId: holding.id, status: "skipped_no_cardid", ms: 0 };
  }
  const body = { cardId };
  if (holding.parallelId) body.parallelId = holding.parallelId;
  if (holding.gradeCompany) body.gradeCompany = holding.gradeCompany;
  if (typeof holding.gradeValue === "number") body.gradeValue = holding.gradeValue;
  try {
    const r = await request("POST", "/api/compiq/price-by-id", body, sessionId);
    const ms = Date.now() - start;
    if (r.status !== 200) {
      return { holdingId: holding.id, cardId, status: `http_${r.status}`, ms };
    }
    const fmv =
      (r.body && typeof r.body.fairMarketValueLive === "number")
        ? r.body.fairMarketValueLive
        : null;
    return { holdingId: holding.id, cardId, status: "ok", ms, fmv };
  } catch (err) {
    return {
      holdingId: holding.id,
      cardId,
      status: "error",
      ms: Date.now() - start,
      error: err && err.message ? err.message : String(err),
    };
  }
}

async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function pull() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, pull));
  return results;
}

async function main() {
  console.log(
    JSON.stringify({
      event: "prewarm_start",
      apiBase: API_BASE,
      concurrency: CONCURRENCY,
      maxSkus: MAX_SKUS,
      timeoutMs: TIMEOUT_MS,
    }),
  );
  const sessionId = await authenticate();
  const allHoldings = await fetchHoldings(sessionId);
  const uniqueByCardId = new Map();
  for (const h of allHoldings) {
    const cid = h.cardId || h.cardsightCardId;
    if (cid && !uniqueByCardId.has(cid)) uniqueByCardId.set(cid, h);
    if (uniqueByCardId.size >= MAX_SKUS) break;
  }
  const targets = Array.from(uniqueByCardId.values());
  console.log(
    JSON.stringify({
      event: "prewarm_targets",
      totalHoldings: allHoldings.length,
      uniqueCardIds: targets.length,
    }),
  );
  if (targets.length === 0) {
    console.log(JSON.stringify({ event: "prewarm_done_empty" }));
    process.exit(0);
  }
  const results = await runConcurrent(
    targets,
    (h) => prewarmOne(sessionId, h),
    CONCURRENCY,
  );
  const summary = { ok: 0, error: 0, skipped: 0, http4xx: 0, http5xx: 0 };
  const durations = [];
  for (const r of results) {
    if (r.status === "ok") {
      summary.ok++;
      durations.push(r.ms);
    } else if (r.status && r.status.startsWith("http_4")) {
      summary.http4xx++;
    } else if (r.status && r.status.startsWith("http_5")) {
      summary.http5xx++;
    } else if (r.status === "skipped_no_cardid") {
      summary.skipped++;
    } else {
      summary.error++;
    }
  }
  durations.sort((a, b) => a - b);
  const pctl = (arr, p) =>
    arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  console.log(
    JSON.stringify({
      event: "prewarm_done",
      summary,
      p50Ms: pctl(durations, 0.5),
      p95Ms: pctl(durations, 0.95),
      maxMs: durations.length ? durations[durations.length - 1] : null,
    }),
  );
  for (const r of results) {
    if (r.status !== "ok" && r.status !== "skipped_no_cardid") {
      console.log(JSON.stringify({ event: "prewarm_failed_item", ...r }));
    }
  }
  if (summary.error > 0 || summary.http5xx > 0) {
    process.exit(3);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "prewarm_fatal",
      error: err && err.message ? err.message : String(err),
    }),
  );
  process.exit(3);
});
