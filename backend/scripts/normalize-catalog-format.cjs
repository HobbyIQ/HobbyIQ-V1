// FIELD NORMALISER — one worker over a year slice. Report-only unless APPLY=true.
//
// Drew: "without uniform consistency, searches and matches won't be clean" and
// "we need 16 workers".
//
// He is right, and it is a different point from the one I was arguing. A
// DISPLAY name can be computed per request and never drifts. But the MATCHER
// reads stored fields — setName, parallel, parallelSlug, searchTokens — and if
// those disagree across rows then search and matching are inconsistent no
// matter what the UI renders. Those have to be uniform at rest.
//
// So this normalises the inputs and stores displayName alongside them, using
// the same canonicalCardName the read path uses, so the two can never disagree.
//
// Partitioned by YEAR so N workers never touch the same document, which means
// no coordination and no lost updates.
const { CosmosClient } = require("@azure/cosmos");
const { canonicalCardName, canonicalSetName, titleCaseWords } = require(require("node:path").resolve(__dirname, "..", "dist/services/catalog/canonicalCardName.js"));
const { reportWrites } = require(require("node:path").resolve(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// Work units come from partitions.json: {y, lo, hi} where lo/hi optionally
// bound setKey so a mega-year (2025 alone is 7.1M rows) can be split across
// workers. Balanced to 1.01x spread.
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD: this lane's NORMAL mode is a
// fan-out -- it declares its own multi-slot default (16) and is always
// dispatched per slot -- so it shards on the env alone. The helper is shared so
// the banner and the arithmetic are the same everywhere.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ alwaysShard: true, defaultSlots: 16, label: "normalize-catalog-format" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const MEGA_CUT = 1500000;
const RANGES = [["", "g"], ["g", "n"], ["n", "t"], ["t", "~"]];

// Partitions are computed from LIVE row counts at startup, not read from a
// file, so a slot cannot drift out of step with the data. Balanced by ROW
// COUNT: 2025 alone is 7.1M rows, roughly 400x a vintage year, so one-year-
// per-worker is hopeless. Years over the cut are split further by setKey
// letter range. Slots never overlap, so workers need no coordination.
async function buildUnits(cat) {
  const rows = (await cat.items.query({
    query: `SELECT c.year AS y, COUNT(1) AS n FROM c
            WHERE IS_NUMBER(c.year) AND STARTSWITH(c.id,'hiq:')
              AND (NOT IS_DEFINED(c.verificationStatus) OR c.verificationStatus != 'rejected')
            GROUP BY c.year`,
  }).fetchAll()).resources.filter((x) => x.y >= 1900 && x.y <= 2030).sort((a, b) => b.n - a.n);
  const units = [];
  for (const r of rows) {
    if (r.n > MEGA_CUT) for (const [lo, hi] of RANGES) units.push({ y: r.y, lo, hi, n: Math.round(r.n / RANGES.length) });
    else units.push({ y: r.y, lo: null, hi: null, n: r.n });
  }
  units.sort((a, b) => b.n - a.n);
  const bins = Array.from({ length: SLOTS }, () => ({ u: [], n: 0 }));
  for (const u of units) { bins.sort((a, b) => a.n - b.n); bins[0].u.push(u); bins[0].n += u.n; }
  return bins;
}
const CONC = Number(process.env.CONC || 48);
const BULK_CONC = Number(process.env.BACKFILL_CONCURRENCY || process.env.BULK_CONC || 6);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 8);
const TAG = process.env.TAG || `slot${process.env.SLOT ?? 0}`;
const STOP = new Set(["the","a","of","and","psa","bgs","sgc","cgc","raw","rc","hof","set","break","lot","card","cards","vintage","graded"]);

(async () => {
  const db = new CosmosClient({
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  let throttled = 0, exhausted = 0, retryAfter = 0;

  // CF-THE-SCAN-CAN-BE-THROTTLED-TOO, applied here as well. The bulk WRITES
  // retry (that was this morning's fix) but the QUERY did not, so a slot could
  // still die with FATAL mid-scan and abandon every unit it had not reached --
  // which is exactly what one of the 16 just did. Same claim from the server,
  // same answer: not now, ask again.
  const queryWithRetry = async (spec, opts) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await cat.items.query(spec, opts).fetchNext(); }
      catch (e) {
        const t = /request rate is too large|429/i.test(String(e?.message));
        if (!t || attempt >= 12) throw e;
        throttled++;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };
  const bins = await buildUnits(cat);
  const mine = bins[SLOT];
  if (!mine) { console.error(`FATAL: SLOT ${SLOT} out of range for SLOTS ${SLOTS}`); process.exit(1); }
  const UNITS = mine.u;
  console.log(`[${TAG}] slot ${SLOT}/${SLOTS}  APPLY=${APPLY}  units=${UNITS.length}  ~rows=${mine.n}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let seen = 0, changed = 0, wrote = 0, failed = 0;

  for (const unit of UNITS) {
    const y = unit.y;
    const bounded = unit.lo !== null && unit.lo !== undefined;
    let token;
    do {
      const page = await queryWithRetry(
        { query: `SELECT * FROM c WHERE c.year=@y AND STARTSWITH(c.id,'hiq:')
                  AND (NOT IS_DEFINED(c.verificationStatus) OR c.verificationStatus != 'rejected')
                  ${bounded ? "AND c.setKey >= @lo AND c.setKey < @hi" : ""}`,
          parameters: bounded
            ? [{ name: "@y", value: y }, { name: "@lo", value: unit.lo }, { name: "@hi", value: unit.hi }]
            : [{ name: "@y", value: y }] },
        { maxItemCount: 1000, continuationToken: token },
      );
      token = page.continuationToken;
      const batch = [];
      for (const r of page.resources) {
        seen++;
        const setName = canonicalSetName(r);
        const parallel = titleCaseWords(r.parallel) || r.parallel || null;
        const dn = canonicalCardName({ ...r, setName, parallel });
        const toks = new Set();
        for (const src of [setName, r.setKey, parallel, r.parallelSlug, r.subsetName, r.playerName, String(r.cardNumber ?? ""), String(r.year ?? ""), r.sport]) {
          for (const w of String(src ?? "").toLowerCase().replace(/[^a-z0-9\- ]/g, " ").split(/[\s-]+/)) {
            if (w && w.length > 1 && !STOP.has(w)) toks.add(w);
          }
        }
        const cn = String(r.cardNumber ?? "").toLowerCase();
        if (cn) toks.add(cn);
        const tokens = [...toks];
        const same = r.setName === setName && r.parallel === parallel && r.displayName === dn
          && Array.isArray(r.searchTokens) && r.searchTokens.length === tokens.length
          && r.searchTokens.every((t, i) => t === tokens[i]);
        if (same) continue;
        changed++;
        if (!APPLY) continue;
        r.setName = setName;
        if (parallel) r.parallel = parallel;
        r.displayName = dn;
        r.searchTokens = tokens;
        r.searchText = tokens.join(" ");
        batch.push(r);
      }
      // BULK, not one round trip per row. Individual upserts ran at ~27k
      // rows/min across 16 workers, so every write was paying a full round
      // trip; items.bulk batches up to 100 operations per request, and
      // BULK_CONC of those go at once so a worker never sits idle.
      //
      // CF-A-429-IS-NOT-A-FAILURE (Drew, 2026-08-25). The first run reported
      // DONE on all 16 slots, green, having written 3,931,610 of the
      // 13,012,857 rows it set out to fix. The other 9,081,247 were counted
      // "failed" and dropped. Every one of them was a 429.
      //
      // items.bulk does NOT get the connection policy's throttle retry: that
      // covers the HTTP request, whereas a bulk response carries a PER-
      // OPERATION statusCode, and a 429 there means "this row was not written,
      // send it again" -- not "this row cannot be written". Conflating the two
      // is what made a 70% loss look like success.
      //
      // So: retry throttled operations, honour the server's retryAfter, and
      // shrink the in-flight window while it is saying slow down. Only a
      // non-429 status is a real failure now.
      const chunks = [];
      for (let i = 0; i < batch.length; i += 100) chunks.push(batch.slice(i, i + 100));

      /** Send one chunk; return the docs the server threw back with a 429. */
      const sendChunk = async (chunk) => {
        try {
          const res = await cat.items.bulk(chunk.map((d) => ({ operationType: "Upsert", resourceBody: d })));
          const again = [];
          for (let i = 0; i < res.length; i++) {
            const r = res[i];
            if (r.statusCode >= 200 && r.statusCode < 300) { wrote++; continue; }
            if (r.statusCode === 429) {
              again.push(chunk[i]);
              retryAfter = Math.max(retryAfter, Number(r.retryAfterInMs ?? r.retryAfterMilliseconds ?? 0) || 0);
              throttled++;
            } else {
              failed++;
              if (failed <= 5) console.error(`[${TAG}] status ${r.statusCode}`);
            }
          }
          return again;
        } catch (e) {
          // A whole-request throttle. The batch is intact and unwritten, so it
          // is retryable in full; the old code charged all 100 to `failed`.
          if (/request rate is too large|429/i.test(String(e.message))) {
            throttled += chunk.length;
            retryAfter = Math.max(retryAfter, 1000);
            return chunk;
          }
          failed += chunk.length;
          if (failed <= 300) console.error(`[${TAG}] BULK ERR ${String(e.message).slice(0, 70)}`);
          return [];
        }
      };

      let pending = chunks;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length; attempt++) {
        retryAfter = 0;
        const next = [];
        // Shrink the in-flight window each pass: if the server is throttling,
        // re-sending the same volume just earns another 429.
        const conc = Math.max(1, Math.floor(BULK_CONC / (attempt + 1)));
        for (let c = 0; c < pending.length; c += conc) {
          const out = await Promise.all(pending.slice(c, c + conc).map(sendChunk));
          for (const docs of out) if (docs.length) next.push(docs);
        }
        pending = next;
        if (pending.length) {
          const wait = Math.min(retryAfter || 250 * Math.pow(2, attempt), 15000);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      // Anything still unwritten after MAX_ATTEMPTS is a genuine loss, and is
      // reported as one rather than folded into a success count.
      for (const chunk of pending) exhausted += chunk.length;

      process.stderr.write(`\r[${TAG}] ${y}  seen ${seen}  changed ${changed}  wrote ${wrote}   `);
    } while (token);
  }
  process.stderr.write("\n");
  console.log(`[${TAG}] DONE units=${UNITS.length} seen=${seen} changed=${changed} wrote=${wrote}` +
              ` failed=${failed} throttled-and-retried=${throttled} still-unwritten=${exhausted}`);
  // Loud, because the previous run's silence on exactly this is why 9,081,247
  // rows were reported done when they had not been written.
  if (exhausted) console.error(`[${TAG}] WARNING ${exhausted} rows exhausted ${MAX_ATTEMPTS} attempts and are STILL UNWRITTEN`);

  // ...and loud is still not enough. On 2026-08-25 all 28 reporting slots
  // printed that WARNING, together dropping 3,805,355 of 8,944,939 intended
  // writes to throttling, and every one of them exited 0 and went green. A
  // warning nobody is paged on is the same as silence.
  //
  // Reconciling makes the shortfall the exit code. That is safe to do here
  // BECAUSE this job is convergent: it re-reads every row and skips the ones
  // already normalised (`same`), so a row dropped this run is simply still
  // pending next run. Red means "run me again", not "the work is lost".
  if (APPLY) {
    reportWrites({ job: `normalize-catalog-format ${TAG}`, intended: changed, written: wrote, failed });
  }
})().catch((e) => { console.error(`[${TAG}] FATAL:`, e?.message || String(e)); process.exit(3); });
