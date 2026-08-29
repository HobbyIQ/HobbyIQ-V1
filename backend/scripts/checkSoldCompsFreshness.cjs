// CF-FRESHNESS-CANARY (Drew, 2026-08-07). Cron-driven canary that
// checks freshness of every primary sold_comps ingest source and
// fails loudly if any of them stalls.
//
// Motivating case: 2026-08-03..07 TCA firehose APPLY-fallback bug —
// green workflow runs, zero data writes, no alert for 5 days. First
// version of this canary reported OK because CH runtime API calls
// masked TCA being dead. Per-source check is the correct signal.
//
// D13 (2026-08-29) — alert gates prove delivery. Staleness alone cannot
// tell the firehose from the webhook trickle: while the nightly firehose
// is dead, the 30-minute webhook keeps the last observedAt fresh, so the
// 08-03 outage shape reads "OK" here. Second axis: MIN_ROWS_24H, a
// per-source floor on the trailing-24h row COUNT. Off by default; the
// workflow sets the floor from measured daily counts.
//
// Sources monitored (must all be < MAX_STALENESS_HOURS old):
//   tca-ebay      — nightly TCA firehose cron (primary volume feed)
//   cardhedge     — runtime CH getCardSales calls (deprecated 2026-08-02
//                   but still active until phase 3 lands)
//
// Sources NOT monitored (write sporadically, no alert):
//   holding, user-ebay, portfolio-import, ch-daily-manual, admin-*
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   MAX_STALENESS_HOURS        default 25 (tolerates one full inter-
//                              cron window for nightly sources)
//   MONITOR_SOURCES            comma-separated override; default
//                              "tca-ebay,cardhedge"
//   MIN_ROWS_24H               per-source row floor for the trailing 24h,
//                              "tca-ebay=2300,cardhedge=0" — 0 or absent
//                              disables the axis for that source. Default
//                              off. Fails when COUNT(rows observed in the
//                              last 24h) < floor; always prints the count.
//
// Exit codes: 0 all axes OK · 1 any axis failed / query error · 2 no env.

const { CosmosClient } = require("@azure/cosmos");

const MAX_STALENESS_HOURS = Number(process.env.MAX_STALENESS_HOURS || 25);
const MONITOR_SOURCES = (process.env.MONITOR_SOURCES || "tca-ebay,cardhedge")
  .split(",").map((s) => s.trim()).filter(Boolean);

/**
 * "tca-ebay=2300,cardhedge=0" → Map { "tca-ebay" → 2300, "cardhedge" → 0 }.
 * Blank / malformed entries are ignored; a non-finite or negative floor
 * is ignored; 0 means "axis off for this source".
 */
function parseMinRowsSpec(spec) {
  const out = new Map();
  for (const part of String(spec || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const source = trimmed.slice(0, eq).trim();
    const floor = Number(trimmed.slice(eq + 1).trim());
    if (!source || !Number.isFinite(floor) || floor < 0) continue;
    out.set(source, Math.floor(floor));
  }
  return out;
}

/**
 * counts: { [source]: rowsLast24h }; floors: Map<source, floor>.
 * One verdict per source with a floor > 0. `ok` iff count >= floor.
 */
function rowFloorVerdicts(counts, floors) {
  const verdicts = [];
  for (const [source, floor] of floors) {
    if (!(floor > 0)) continue;
    const count = Number(counts[source] ?? 0);
    verdicts.push({ source, count, floor, ok: count >= floor });
  }
  return verdicts;
}

async function withRetry429(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const code = err && (err.code ?? err.statusCode);
      const throttled = code === 429 || code === "429" || /429|throttl|request rate/i.test(String(err && err.message));
      if (!throttled) throw err;
      const waitMs = Number(err.retryAfterInMs) || Math.min(30_000, 500 * 2 ** attempt);
      console.log(`[freshness-canary] ${label}: 429 — retry ${attempt}/6 in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function latestObservedAtForSource(sc, source) {
  const q = await withRetry429(() => sc.items.query({
    query: "SELECT TOP 1 c.observedAt FROM c WHERE c.source = @source AND IS_DEFINED(c.observedAt) ORDER BY c.observedAt DESC",
    parameters: [{ name: "@source", value: source }],
  }, { maxItemCount: 1 }).fetchAll(), `latest ${source}`);
  return q.resources[0]?.observedAt ?? null;
}

async function rowsLast24hForSource(sc, source, sinceIso) {
  const q = await withRetry429(() => sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = @source AND c.observedAt >= @since",
    parameters: [{ name: "@source", value: source }, { name: "@since", value: sinceIso }],
  }, { maxItemCount: 1 }).fetchAll(), `rows24h ${source}`);
  return Number(q.resources[0] ?? 0);
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  const minRows = parseMinRowsSpec(process.env.MIN_ROWS_24H);

  console.log(`[freshness-canary] monitoring sources: ${MONITOR_SOURCES.join(", ")}`);
  console.log(`[freshness-canary] threshold: ${MAX_STALENESS_HOURS}h`);
  const floorsOn = [...minRows].filter(([, f]) => f > 0);
  console.log(`[freshness-canary] row floors (24h): ${floorsOn.length ? floorsOn.map(([s, f]) => `${s}>=${f}`).join(", ") : "off"}`);

  const now = Date.now();
  const results = [];
  for (const source of MONITOR_SOURCES) {
    const latest = await latestObservedAtForSource(sc, source);
    const stalenessH = latest ? (now - new Date(latest).getTime()) / 3600000 : Infinity;
    results.push({ source, latest, stalenessH });
  }

  console.log("");
  console.log("source              latest observedAt                staleness");
  console.log("------------------  ---------------------------      ---------");
  for (const r of results) {
    const label = r.source.padEnd(18);
    const ts = (r.latest ?? "(never)").padEnd(32);
    const staleness = r.stalenessH === Infinity ? "∞" : `${r.stalenessH.toFixed(1)}h`;
    console.log(`${label}  ${ts}  ${staleness}`);
  }
  console.log("");

  // Row-count axis — always print the count for every floored source.
  let verdicts = [];
  if (floorsOn.length) {
    const sinceIso = new Date(now - 24 * 3600000).toISOString();
    const counts = {};
    for (const [source] of floorsOn) counts[source] = await rowsLast24hForSource(sc, source, sinceIso);
    verdicts = rowFloorVerdicts(counts, minRows);
    console.log("source              rows (last 24h)   floor     verdict");
    console.log("------------------  ---------------   -------   -------");
    for (const v of verdicts) {
      console.log(`${v.source.padEnd(18)}  ${String(v.count).padStart(15)}   ${String(v.floor).padStart(7)}   ${v.ok ? "ok" : "BELOW"}`);
    }
    console.log("");
  }

  let failed = false;
  const stale = results.filter((r) => r.stalenessH > MAX_STALENESS_HOURS);
  if (stale.length) {
    failed = true;
    for (const r of stale) {
      const st = r.stalenessH === Infinity ? "NEVER" : `${r.stalenessH.toFixed(1)}h`;
      console.error(`::error::sold_comps source=${r.source} STALE: last write ${st} ago (threshold ${MAX_STALENESS_HOURS}h)`);
    }
  }
  const below = verdicts.filter((v) => !v.ok);
  if (below.length) {
    failed = true;
    for (const v of below) {
      console.error(`::error::sold_comps source=${v.source} ROWS-24H: ${v.count} rows in the last 24h, floor ${v.floor} — the feed is trickling, not flowing`);
    }
  }
  if (failed) {
    console.error(`::error::Check TCA Firehose Ingest workflow: https://github.com/HobbyIQ/HobbyIQ-V1/actions/workflows/tca-firehose-ingest.yml`);
    process.exit(1);
  }

  console.log(`[freshness-canary] OK — all ${results.length} monitored sources fresh${verdicts.length ? `; ${verdicts.length} row floor(s) met` : ""}`);
}

module.exports = { parseMinRowsSpec, rowFloorVerdicts };

if (require.main === module) {
  main().catch((e) => { console.error("::error::[freshness-canary] FAILED:", e?.message || e); process.exit(1); });
}
