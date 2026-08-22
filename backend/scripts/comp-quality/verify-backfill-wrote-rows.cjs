// Did a running backfill actually WRITE anything? Answer from the data, not
// from the process.
//
// WHY THIS EXISTS. On 2026-08-22 the 2024 re-tokenisation pass went 88 minutes
// without flushing a log line. Process-level metrics said it was spinning:
//
//   readDelta  = 0 bytes over 15s
//   writeDelta = 0 bytes over 15s
//   otherTransferDelta = 0 bytes over 40s     <- while CPU burned 1.28s
//   5 established TLS connections, log frozen
//
// It was diagnosed as wedged. It was not. A Cosmos _ts count showed it had
// written 403,353 rows, and it went on to finish 443,142. OtherTransferCount
// simply does not capture that process's socket traffic on this machine.
//
// The silence had a mundane cause: the driver piped node through
// `grep -vE "^\s*scanned="` into a file, grep block-buffers to a file, and the
// filtered-out progress lines were the only frequent output — so nothing
// reached the log until each year's process exited.
//
// The lesson is the rule: VERIFY THE OUTPUT, NOT THE PROCESS. This script is
// how. Cosmos stamps _ts on every write, so counting rows touched since a run
// began is a direct measurement of progress that no process counter can fake.
//
// Read-only.
//
// Usage:
//   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
//     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
//     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
//     node scripts/comp-quality/verify-backfill-wrote-rows.cjs --year 2024 --since 2026-08-22T01:47:15Z
//
//   --container  defaults to card_catalog
const { CosmosClient } = require("@azure/cosmos");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const YEAR = Number(arg("year", ""));
const SINCE_RAW = arg("since", "");
const CONTAINER = arg("container", "card_catalog");

const cs = process.env.COSMOS_CONNECTION_STRING;
if (!cs) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
  process.exit(1);
}
if (!YEAR || !SINCE_RAW) {
  console.error("FATAL: --year and --since are both required.");
  console.error("  e.g. --year 2024 --since 2026-08-22T01:47:15Z");
  process.exit(2);
}
const sinceMs = Date.parse(SINCE_RAW);
if (!Number.isFinite(sinceMs)) {
  console.error(`FATAL: --since "${SINCE_RAW}" is not a parseable ISO timestamp.`);
  process.exit(2);
}
const sinceTs = Math.floor(sinceMs / 1000);

const c = new CosmosClient(cs).database("hobbyiq").container(CONTAINER);

async function count(label, sql, params) {
  const t0 = Date.now();
  try {
    const { resources } = await c.items.query({ query: sql, parameters: params }).fetchAll();
    const n = Number(resources[0]);
    console.log(`${label.padEnd(46)} ${String(n).padStart(10)}   (${Date.now() - t0}ms)`);
    return n;
  } catch (e) {
    console.log(`${label.padEnd(46)} QUERY FAILED: ${e.message}`);
    return null;
  }
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const elapsedMin = Math.round((now - sinceTs) / 60);
  console.log(`container=${CONTAINER}  year=${YEAR}  since=${SINCE_RAW} (${elapsedMin} min ago)\n`);

  const written = await count(
    "rows touched since the run began",
    "SELECT VALUE COUNT(1) FROM c WHERE c.year = @y AND c._ts >= @s",
    [{ name: "@y", value: YEAR }, { name: "@s", value: sinceTs }],
  );
  const total = await count(
    "total rows for that year",
    "SELECT VALUE COUNT(1) FROM c WHERE c.year = @y",
    [{ name: "@y", value: YEAR }],
  );

  console.log("");
  if (written === null || total === null) {
    console.log("VERDICT: inconclusive — a query failed, so this proves nothing.");
    process.exit(4);
  }
  if (written === 0) {
    console.log("VERDICT: *** ZERO rows written. The run is NOT making progress. ***");
    console.log("         Before concluding it is wedged, confirm --since is right and that");
    console.log("         the run really targets this year and container.");
    process.exit(5);
  }
  const pct = total > 0 ? ((written / total) * 100).toFixed(1) : "?";
  const rate = elapsedMin > 0 ? Math.round(written / elapsedMin) : 0;
  console.log(`VERDICT: PROGRESSING — ${written} of ${total} rows (${pct}%), ~${rate} rows/min.`);
  console.log(`         A frozen log does NOT mean a stalled job. Check buffering before`);
  console.log(`         you check the process.`);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
