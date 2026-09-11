// CF-DEAL-SCANNER-CANARY (GO-LIVE P2-4, checklist §Alerts item 3). The
// BuyerIQ deal scanner runs IN-PROCESS on App Service — `setInterval` in
// backend/src/jobs/buyerIqDealScanner.job.ts, armed from server.ts:111 —
// so a crash today is silent. There is no workflow run to go red, no red X
// on any run-history page, and nothing pages anybody.
//
// WHY A HEARTBEAT ON TRACES AND NOT A ROW COUNT. The scanner's Cosmos
// writes are CONDITIONAL: `buyeriq_deals_sent` gets a row only when a deal
// clears the threshold AND a push actually delivers (`if (push.sent > 0)`
// → recordSent, buyerIqDealScanner.service.ts:330). A scan that finds no
// deal — the normal outcome on a 4-target corpus — writes nothing at all.
// Counting rows would therefore read a perfectly healthy quiet hour and a
// process that died three days ago as the same number: zero.
//
// The ONE thing every completed run emits unconditionally is its summary
// line (buyerIqDealScanner.service.ts:342):
//
//   console.log(JSON.stringify({ event: "buyeriq_deal_scan_summary", ... }))
//
// server.ts:39 arms `setAutoCollectConsole(true, true)`, so that line lands
// in App Insights `traces`. THAT is the source of truth this canary reads:
// the heartbeat is the summary trace, not a container.
//
// WHY THE ERROR AXIS EXISTS TOO. `tick()` swallows every throw into a
// console.error and the summary still prints, so "ran" is not "worked".
// Worse, every Cosmos accessor in the service returns null on failure
// (lines 79, 92, 122) and `listAllWantedTargets` returns [] on any query
// error — so a total Cosmos outage produces a fully-zeroed, error-free
// summary that is byte-for-byte identical to a quiet night. Two axes:
//
//   HEARTBEAT   the newest summary trace must be younger than
//               MAX_SILENCE_HOURS. Default 2x the job's own 60-minute
//               interval (schedule x 2, per the task), so one missed
//               cycle is tolerated and two is not.
//
//   ERRORS      the `errors` counter summed across the window. The
//               scanner increments it per target that threw
//               (service.ts:336). A run that reports errors on every
//               target it scanned is a broken scan wearing a green hat.
//
// WHY NOT ALSO ALARM ON targetsScanned == 0. Because zero wanted targets
// is a legitimate product state (nobody has saved a target yet), and the
// corpus is 4 targets today. Alarming on it would train the reader to
// ignore the canary before there is anything to protect. The scanned count
// is PRINTED on every run so the operator sees the corpus shrink, but it
// does not fire. Revisit when the target corpus is reliably non-trivial.
//
// MEASURED 2026-09-07 (read-only App Insights, this canary's own query):
//   7-day window: 3 summary traces, ALL on 09-07 between 15:17Z and 15:45Z,
//   clustered around an App Service restart ("scheduler armed" at 15:21:37Z
//   and 15:22:56Z, two workers, one taking the single-flight lock). The six
//   days before carry NOTHING. That is precisely the shape this canary
//   exists to name: the job only runs while a process stays warm, and
//   nobody was told when it stopped.
//
// THE DOC IS NOW THE PRIMARY SOURCE (2026-09-11). App Insights ingestion
// sampling on hobbyiq-insights is 10%. This heartbeat fires once an hour, so
// a 24h window holds ~2.4 raw trace rows on average and P(zero rows) is ~9%
// BY CONSTRUCTION — the canary was failing on sampling noise against a
// healthy scanner, not measuring a dead one. A point-read cannot be sampled
// away, so buyerIqDealScanner.service.ts now also upserts a single durable
// heartbeat doc (container `rematch_control`, id
// `heartbeat::buyeriq.deal.scanner`) on every exit from runBuyerIqDealScan —
// ok, disabled AND error. This checker reads that doc FIRST and decides
// staleness from its `lastRunAt`; the App Insights trace path below runs only
// when the doc could not be read at all (no COSMOS_CONNECTION_STRING, a
// missing container, a thrown query) — see readHeartbeatDoc / main.
//
// Env:
//   COSMOS_CONNECTION_STRING  the doc-first path. When set, this script reads
//                         the heartbeat doc directly and TRACE_JSON is not
//                         required. A MISSING doc (container reachable, doc
//                         absent) is read as "no scan yet" and still fails
//                         heartbeatOk — it does not fall back to the trace,
//                         because the doc being absent is itself the answer.
//                         Only an unreachable read (no connection string,
//                         thrown query) falls back to TRACE_JSON.
//   TRACE_JSON            fallback path. The App Insights query result, as
//                         JSON, on a path or on stdin ("-"). The workflow
//                         pipes `az monitor app-insights query` into it.
//                         Keeping the fetch OUTSIDE this script is
//                         deliberate: it needs no Azure SDK, stays
//                         unit-testable against fixtures, and the query text
//                         lives in the workflow where an operator can re-run
//                         it by hand.
//   MAX_SILENCE_HOURS     default 2 (= 2x the 60-minute job interval).
//   MAX_ERROR_RATE        default 0.5. Fires when errors/targetsScanned
//                         across the window exceeds it. 0 disables. Only
//                         meaningful on the trace path — the doc carries one
//                         cycle's counters, not a window's, so the doc path
//                         reports the latest cycle's own error count instead.
//   WINDOW_HOURS          default 24. Reported, and used for the rate axis on
//                         the trace path.

const fs = require("node:fs");
const path = require("node:path");
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const HEARTBEAT_CONTAINER = String(process.env.COSMOS_REMATCH_CONTROL_CONTAINER || "rematch_control").trim();
const HEARTBEAT_DOC_ID = "heartbeat::buyeriq.deal.scanner";

const MAX_SILENCE_HOURS = numEnv(process.env.MAX_SILENCE_HOURS, 2);
const MAX_ERROR_RATE = numEnv(process.env.MAX_ERROR_RATE, 0.5);
const WINDOW_HOURS = numEnv(process.env.WINDOW_HOURS, 24);

/** Env numbers must be finite and non-negative to override the default. */
function numEnv(raw, dflt) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * Two CLIs, two shapes. `az monitor app-insights query -o json` (the classic
 * per-app API, table `traces`) returns
 * { tables: [ { columns: [{name}], rows: [[...]] } ] }.
 * `az monitor log-analytics query -o json` (the workspace API, table
 * `AppTraces` — the source of truth since #2027, 2026-09-11: see the
 * workflow header for why the classic API stopped being trustworthy here)
 * returns a flat array of row objects already keyed by column name:
 * [ { TimeGenerated, Message, ... }, ... ].
 *
 * Both are normalized to the same array-of-objects-by-column-name shape so
 * parseSummaries never has to know which CLI produced its input — it already
 * reads `message ?? Message` and `timestamp ?? Timestamp` for exactly this
 * reason. The classic shape is read BY COLUMN NAME, never by position, so a
 * reordered projection in the workflow cannot silently shift the reading.
 * An unparseable or shapeless payload yields null, which main() reports as a
 * FETCH FAILURE rather than as zero runs: "the query did not answer" and
 * "the job is dead" are different incidents and must not share an error
 * message.
 */
function parseAiTable(raw) {
  let doc;
  try { doc = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }

  // Workspace shape: log-analytics query's JSON output is already a flat
  // array of row objects. An empty array is a real answer (zero rows), not
  // a parse failure.
  if (Array.isArray(doc)) return doc;

  // Classic shape: { tables: [ { columns, rows } ] }.
  const table = doc && Array.isArray(doc.tables) ? doc.tables[0] : null;
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
  const names = table.columns.map((c) => (c && c.name) || "");
  return table.rows.map((row) => {
    const obj = {};
    names.forEach((n, i) => { if (n) obj[n] = row[i]; });
    return obj;
  });
}

/**
 * Each trace row carries the summary line in `message`. Pull the JSON
 * object out of it and keep the counters this canary reasons about.
 *
 * The message is the WHOLE JSON document (console.log(JSON.stringify(...))),
 * but a trace can arrive with a prefix or with the object embedded, so the
 * first `{` through the last `}` is taken rather than assuming the line is
 * pure JSON. A row whose message does not parse is counted as unparsed and
 * reported — never silently dropped.
 *
 * Field names are read across all three shapes this canary has queried:
 * `message`/`timestamp` (classic API, as projected), `Message`/`Timestamp`
 * (classic API, PascalCase), and `Message`/`TimeGenerated` (workspace API's
 * AppTraces column name — #2027, 2026-09-11).
 */
function parseSummaries(rows) {
  const parsed = [];
  let unparsed = 0;
  for (const r of rows || []) {
    const msg = String((r && (r.message ?? r.Message)) ?? "");
    const a = msg.indexOf("{");
    const b = msg.lastIndexOf("}");
    if (a < 0 || b <= a) { unparsed++; continue; }
    let obj;
    try { obj = JSON.parse(msg.slice(a, b + 1)); } catch { unparsed++; continue; }
    if (!obj || obj.event !== "buyeriq_deal_scan_summary") { unparsed++; continue; }
    parsed.push({
      timestamp: (r && (r.timestamp ?? r.Timestamp ?? r.TimeGenerated)) ?? obj.finishedAt ?? obj.startedAt ?? null,
      targetsScanned: Number(obj.targetsScanned ?? 0),
      dealsFound: Number(obj.dealsFound ?? 0),
      notificationsSent: Number(obj.notificationsSent ?? 0),
      errors: Number(obj.errors ?? 0),
      durationMs: Number(obj.durationMs ?? 0),
    });
  }
  return { parsed, unparsed };
}

/**
 * The two verdicts, computed from the parsed summaries alone so the pins
 * can drive them without App Insights.
 *
 * heartbeat: hours since the newest summary. NO run at all in the window is
 * Infinity, not 0 — an empty result set is the loudest possible signal and
 * must never round to "fresh".
 *
 * errorRate: total errors / total targets scanned across the window. The
 * denominator is the scanned count, not the run count: one run that threw
 * on 4 of 4 targets is a total failure, and dividing by runs would call it
 * "4 errors" without saying 4 out of what. A window that scanned nothing
 * has no rate (null) and cannot fire this axis — it is the heartbeat's job
 * to notice silence, and a rate of 0/0 must not read as healthy.
 */
function verdicts(summaries, { now, maxSilenceHours, maxErrorRate }) {
  const times = summaries
    .map((s) => Date.parse(s.timestamp))
    .filter((t) => Number.isFinite(t));
  const latestMs = times.length ? Math.max(...times) : null;
  const silenceH = latestMs === null ? Infinity : (now - latestMs) / 3600000;

  const scanned = summaries.reduce((a, s) => a + (Number(s.targetsScanned) || 0), 0);
  const errors = summaries.reduce((a, s) => a + (Number(s.errors) || 0), 0);
  const errorRate = scanned > 0 ? errors / scanned : null;

  return {
    runs: summaries.length,
    latestIso: latestMs === null ? null : new Date(latestMs).toISOString(),
    silenceH,
    heartbeatOk: silenceH <= maxSilenceHours,
    scanned,
    errors,
    errorRate,
    dealsFound: summaries.reduce((a, s) => a + (Number(s.dealsFound) || 0), 0),
    notificationsSent: summaries.reduce((a, s) => a + (Number(s.notificationsSent) || 0), 0),
    // A null rate cannot fire: see above. A disabled axis (0) cannot either.
    errorsOk: !(maxErrorRate > 0) || errorRate === null || errorRate <= maxErrorRate,
  };
}

function readInput() {
  const src = process.env.TRACE_JSON;
  if (!src) return null;
  try {
    return src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");
  } catch { return null; }
}

/**
 * The verdict shape computed from a single doc read, kept parallel to
 * `verdicts()` (the trace-window verdict) so main() can print + gate on
 * either without branching downstream. `runs` is 0 or 1 — the doc carries
 * exactly one cycle, never a window.
 *
 * heartbeatOk is silenceH <= maxSilenceHours, same rule as the trace path.
 * errorsOk reads the doc's OWN errors/targetsScanned — one cycle's rate, not
 * a window's — because the doc has no window to sum over.
 */
function docVerdict(doc, { now, maxSilenceHours, maxErrorRate }) {
  const lastRunMs = doc && typeof doc.lastRunAt === "string" ? Date.parse(doc.lastRunAt) : NaN;
  const silenceH = Number.isFinite(lastRunMs) ? (now - lastRunMs) / 3600000 : Infinity;
  const scanned = Number(doc && doc.targetsScanned) || 0;
  const errors = Number(doc && doc.errors) || 0;
  const errorRate = scanned > 0 ? errors / scanned : null;
  return {
    runs: Number.isFinite(lastRunMs) ? 1 : 0,
    latestIso: Number.isFinite(lastRunMs) ? new Date(lastRunMs).toISOString() : null,
    silenceH,
    heartbeatOk: silenceH <= maxSilenceHours,
    scanned,
    errors,
    errorRate,
    dealsFound: null,
    notificationsSent: null,
    outcome: doc && typeof doc.outcome === "string" ? doc.outcome : null,
    roleInstance: doc && typeof doc.roleInstance === "string" ? doc.roleInstance : null,
    errorsOk: !(maxErrorRate > 0) || errorRate === null || errorRate <= maxErrorRate,
  };
}

/**
 * Point-read the heartbeat doc. Returns `{ ok: true, doc }` (doc is `null`
 * when genuinely absent — a real "no scan yet" answer, not a failure) or
 * `{ ok: false, reason }` when the read itself could not be attempted or
 * threw — the case that falls back to TRACE_JSON in main().
 *
 * `cosmosClientFactory` is injected so the pins can drive this without
 * `@azure/cosmos` on a real network — the same shape the service-layer test
 * mocks `CosmosClient` with.
 */
async function readHeartbeatDoc(cosmosClientFactory) {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return { ok: false, reason: "COSMOS_CONNECTION_STRING not set" };
  try {
    const CosmosClient = cosmosClientFactory || require("@azure/cosmos").CosmosClient;
    const client = new CosmosClient({
      connectionString: conn,
      connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 10, maxWaitTimeInSeconds: 30 } },
    });
    const container = client
      .database(process.env.COSMOS_DATABASE || "hobbyiq")
      .container(HEARTBEAT_CONTAINER);
    const { resource } = await container.item(HEARTBEAT_DOC_ID, HEARTBEAT_DOC_ID).read();
    return { ok: true, doc: resource || null };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

async function main() {
  const now = Date.now();

  // DOC FIRST. A point-read cannot be sampled away, so this is tried before
  // the trace path unconditionally — TRACE_JSON is read only if the doc
  // could not be reached at all (see readHeartbeatDoc: ok:false).
  const docResult = await readHeartbeatDoc();
  if (docResult.ok) {
    const v = docVerdict(docResult.doc, {
      now,
      maxSilenceHours: MAX_SILENCE_HOURS,
      maxErrorRate: MAX_ERROR_RATE,
    });

    console.log(`[deal-scanner-canary] source of truth: Cosmos doc ${HEARTBEAT_CONTAINER}/${HEARTBEAT_DOC_ID} (doc-first — immune to App Insights sampling)`);
    console.log(`[deal-scanner-canary] heartbeat threshold ${MAX_SILENCE_HOURS}h (2x the 60-min job interval)`);
    console.log("");
    console.log("axis        measured                          threshold        verdict");
    console.log("---------   -------------------------------   --------------   -------");
    const silenceStr = v.silenceH === Infinity ? "NEVER (no heartbeat doc)" : `${v.silenceH.toFixed(1)}h since last run`;
    console.log(`heartbeat   ${silenceStr.padEnd(31)}   <= ${String(MAX_SILENCE_HOURS).padEnd(11)}   ${v.heartbeatOk ? "ok" : "SILENT"}`);
    const rateStr = v.errorRate === null
      ? "no targets scanned (n/a)"
      : `${(v.errorRate * 100).toFixed(1)}% (${v.errors}/${v.scanned})`;
    console.log(`errors      ${rateStr.padEnd(31)}   <= ${String(MAX_ERROR_RATE > 0 ? `${(MAX_ERROR_RATE * 100).toFixed(0)}%` : "off").padEnd(11)}   ${v.errorsOk ? "ok" : "ERRORING"}`);
    console.log("");
    console.log(`[deal-scanner-canary] last cycle: outcome=${v.outcome ?? "(none)"}  targetsScanned=${v.scanned}  errors=${v.errors}  roleInstance=${v.roleInstance ?? "(none)"}  lastRunAt=${v.latestIso ?? "(none)"}`);

    let failed = false;
    if (!v.heartbeatOk) {
      failed = true;
      const st = v.silenceH === Infinity
        ? `NO heartbeat doc found at all (id ${HEARTBEAT_DOC_ID})`
        : `last run ${v.silenceH.toFixed(1)}h ago`;
      console.error(
        `::error::deal scanner SILENT: ${st} (threshold ${MAX_SILENCE_HOURS}h = 2x the 60-minute interval). ` +
        `The scanner is in-process on App Service — check that HobbyIQ3 is up and that BUYERIQ_DEAL_SCANNER_DISABLE is not "true"`,
      );
    }
    if (!v.errorsOk) {
      failed = true;
      console.error(
        `::error::deal scanner ERRORING: ${v.errors} errors on its last cycle across ${v.scanned} target-scans ` +
        `(${((v.errorRate ?? 0) * 100).toFixed(1)}%, ceiling ${(MAX_ERROR_RATE * 100).toFixed(0)}%) — ` +
        `the job is running but not working`,
      );
    }

    if (failed) {
      console.error("::error::Deal scanner health: https://portal.azure.com — Cosmos hobbyiq-comps, container rematch_control, doc heartbeat::buyeriq.deal.scanner");
      return 1;
    }

    console.log(`[deal-scanner-canary] OK — last cycle ${v.silenceH.toFixed(1)}h old; error rate within ceiling`);
    return 0;
  }

  console.log(`[deal-scanner-canary] heartbeat doc unreachable (${docResult.reason}) — falling back to the App Insights trace`);

  const raw = readInput();
  if (raw === null) {
    console.error("::error::[deal-scanner-canary] heartbeat doc unreachable AND TRACE_JSON not set (a path, or \"-\" for stdin) — the scanner could not be measured at all");
    return 2;
  }

  const rows = parseAiTable(raw);
  if (rows === null) {
    // Not "zero runs" — the question was never answered. Exiting 2 keeps a
    // broken query distinguishable from a dead scanner in the run history.
    console.error("::error::[deal-scanner-canary] App Insights payload did not parse as a result table — the query failed, the scanner was NOT measured");
    return 2;
  }

  const { parsed, unparsed } = parseSummaries(rows);
  const v = verdicts(parsed, {
    now,
    maxSilenceHours: MAX_SILENCE_HOURS,
    maxErrorRate: MAX_ERROR_RATE,
  });

  console.log(`[deal-scanner-canary] source of truth (FALLBACK): App Insights traces, event=buyeriq_deal_scan_summary`);
  console.log(`[deal-scanner-canary] window ${WINDOW_HOURS}h; heartbeat threshold ${MAX_SILENCE_HOURS}h (2x the 60-min job interval); max error rate ${MAX_ERROR_RATE > 0 ? MAX_ERROR_RATE : "off"}`);
  console.log("");

  console.log("axis        measured                          threshold        verdict");
  console.log("---------   -------------------------------   --------------   -------");
  const silenceStr = v.silenceH === Infinity ? "NEVER (no run in window)" : `${v.silenceH.toFixed(1)}h since last run`;
  console.log(`heartbeat   ${silenceStr.padEnd(31)}   <= ${String(MAX_SILENCE_HOURS).padEnd(11)}   ${v.heartbeatOk ? "ok" : "SILENT"}`);
  const rateStr = v.errorRate === null
    ? "no targets scanned (n/a)"
    : `${(v.errorRate * 100).toFixed(1)}% (${v.errors}/${v.scanned})`;
  console.log(`errors      ${rateStr.padEnd(31)}   <= ${String(MAX_ERROR_RATE > 0 ? `${(MAX_ERROR_RATE * 100).toFixed(0)}%` : "off").padEnd(11)}   ${v.errorsOk ? "ok" : "ERRORING"}`);
  console.log("");

  console.log(`[deal-scanner-canary] runs in window: ${v.runs}   latest: ${v.latestIso ?? "(none)"}`);
  console.log(`[deal-scanner-canary] corpus: ${v.scanned} target-scans, ${v.dealsFound} deals found, ${v.notificationsSent} pushes sent`);

  // RECONCILIATION. Name every trace row the query returned and where it
  // went, so a row that silently vanished from the report is itself visible.
  const accounted = parsed.length + unparsed;
  console.log(
    `[deal-scanner-canary] reconcile: ${rows.length} trace rows = ${parsed.length} summaries + ${unparsed} unparsed  ` +
    `${accounted === rows.length ? "RECONCILES" : "MISMATCH"}`,
  );
  if (unparsed > 0) {
    console.log(`[deal-scanner-canary] note: ${unparsed} row(s) in the result set were not deal-scan summaries — the query returned more than it was asked for`);
  }

  let failed = false;
  if (!v.heartbeatOk) {
    failed = true;
    const st = v.silenceH === Infinity
      ? `NO buyeriq_deal_scan_summary trace in the last ${WINDOW_HOURS}h at all`
      : `last run ${v.silenceH.toFixed(1)}h ago`;
    console.error(
      `::error::deal scanner SILENT: ${st} (threshold ${MAX_SILENCE_HOURS}h = 2x the 60-minute interval). ` +
      `The scanner is in-process on App Service — check that HobbyIQ3 is up and that BUYERIQ_DEAL_SCANNER_DISABLE is not "true"`,
    );
  }
  if (!v.errorsOk) {
    failed = true;
    console.error(
      `::error::deal scanner ERRORING: ${v.errors} errors across ${v.scanned} target-scans ` +
      `(${((v.errorRate ?? 0) * 100).toFixed(1)}%, ceiling ${(MAX_ERROR_RATE * 100).toFixed(0)}%) — ` +
      `the job is running but not working; a scan that throws per-target still prints a green summary`,
    );
  }

  if (failed) {
    console.error("::error::Deal scanner health: https://portal.azure.com — App Insights hobbyiq-insights, traces | where message has 'buyeriq_deal_scan_summary'");
    return 1;
  }

  console.log(`[deal-scanner-canary] OK — ${v.runs} run(s) in ${WINDOW_HOURS}h, newest ${v.silenceH.toFixed(1)}h old; error rate within ceiling`);
  return 0;
}

module.exports = { parseAiTable, parseSummaries, verdicts, numEnv, docVerdict, readHeartbeatDoc, HEARTBEAT_CONTAINER, HEARTBEAT_DOC_ID };

if (require.main === module) {
  main()
    .then((code) => finishLane(code))
    .catch(async (e) => {
      console.error("::error::[deal-scanner-canary] FAILED:", (e && e.message) || e);
      await finishLane(1);
    });
}
