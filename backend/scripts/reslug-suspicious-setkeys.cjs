#!/usr/bin/env node
// CF-RESLUG-SUSPICIOUS-SETKEYS (Drew, 2026-07-30). Companion to
// reslug-cross-product-mis-slug (which only handled bowman-family).
// This one handles the BROADER class the setKey audit surfaced:
// rows where the setKey slot is a raw slugified title
// ("2003-flair-baseball", "1996-pinnacle-aficionado-baseball",
// "topps-stars-of-mlb") because normalizeSetKey didn't match a
// known pattern when the row was written.
//
// After the v3 vocab expansion (Flair, Goudey, SP, Pinnacle,
// Pinnacle Aficionado, Panini insert-set variants), matchKnownProductLine
// can now recognize these products. This backfill patches existing
// rows to their corrected canonical setKey.
//
// Only-improve guardrail:
//   - Skip if setKey is already a known canonical (via matchKnownProductLine)
//   - Only patch when derived setKey is a KNOWN canonical AND differs from existing
//   - Never demote a valid canonical to null/unknown
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=8       — parallel patches (kept low)
//   BACKFILL_LIMIT=250000        — max rows scanned per pass

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, matchKnownProductLine } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "8");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "250000");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane REWRITES hobbyiqCardId on
// sold_comps rows -- it moves sales between comp pools, which is the input to
// every FMV -- and declared no budget at all.
//
// ITS SCAN IS THE WIDEST OF THE PAIR, and the file says so in its own comment:
// where reslug-cross-product-mis-slug filters to bowman-family slugs carrying a
// cross-product title token, this one selects EVERY row with a string slug and
// a string title and does the whole filter in JS ("simpler than trying to
// express the NOT-IN clause in Cosmos SQL"). BACKFILL_LIMIT (default 250,000)
// is the only thing bounding it, and 250,000 rows at maxItemCount 2,000 is 125
// round trips of full 11-field projections before a single patch is planned.
// Before this it could only ever end by being KILLED at the 150-minute
// ceiling: no marker, no reconcile, no finishLane line.
//
// >>> A PARTIAL SCAN HERE IS SHORTER, NOT WRONG, so this lane does not refuse
// >>> its write phase.
//
// Nothing is derived across rows. Each patch is decided from that row own
// title via matchKnownProductLine(), and both only-improve guards -- existing
// setKey must NOT already be canonical, derived setKey MUST be canonical and
// different -- read the same way over one row as over 250,000. A scan that
// stops early plans fewer patches; the next run finds the rows it did not
// reach, still non-canonical, still matching the same query.
//
// TWO LOOPS, TWO UNITS, ONE RESERVE SIZED TO THE LARGER.
//   The SCAN unit is one 2,000-row page -- and this lane fetchWithRetry() can
//   sleep up to 2+4+6+8+10+12 = 42 seconds of 429 backoff on a single page
//   before it gives up, which is the real worst case and the reason the
//   reserve is not the 60 seconds its narrower twin uses.
//   The APPLY unit is one CONCURRENCY-wide (default 8) batch of single-row
//   patches, checked per batch rather than per row.
// 90 seconds covers the backoff-worst page with room to spare.
//
// VERIFY_MS is nominal: this lane reads nothing after its loops.
// Worst case 110 + 1.5 + 1 + 1 + 1 = 114.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// Canonical short-forms (kept in sync with audit-setkey-distribution.cjs
// and normalizeSetKey's known list in hobbyIqCardId.service.ts).
const KNOWN_CANONICALS = new Set([
  "bowman", "bowman-chrome", "bowman-chrome-sapphire", "bowman-chrome-draft",
  "bowman-paper", "bowman-draft", "bowman-draft-paper", "bowman-sterling",
  "topps", "topps-chrome", "topps-chrome-update", "topps-chrome-sapphire",
  "topps-heritage", "topps-finest", "topps-pristine", "topps-transcendent",
  "topps-dynasty", "topps-tribute", "topps-inception", "topps-definitive",
  "topps-five-star", "topps-museum-collection", "topps-gypsy-queen",
  "topps-archives", "topps-big-league", "topps-bunt", "topps-allen-ginter",
  "topps-stadium-club",
  "panini-prizm", "panini-select", "panini-mosaic", "panini-donruss",
  "panini-optic", "panini-contenders", "panini-immaculate", "panini-flawless",
  "panini-national-treasures", "panini-absolute", "panini-chronicles",
  "panini-phoenix", "panini-illusions", "panini-obsidian", "panini-spectra",
  "panini-revolution", "panini-crown-royale", "panini-one-one",
  "panini-playoff", "panini-score", "panini-classics", "panini-legacy",
  "panini-threads", "panini-rookies-and-stars", "panini-zenith",
  "panini-court-kings", "panini-origins", "panini-encased", "panini-eminence",
  "pinnacle", "pinnacle-aficionado", "goudey", "flair",
  "sp-prospects", "sp-authentic",
  "upper-deck", "fleer", "fleer-stickers",
]);

async function fetchWithRetry(iterator, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await iterator.fetchNext(); }
    catch (err) {
      const msg = String(err?.message || "");
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`\r  [429 backoff ${wait}ms attempt ${attempt+1}]  `);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// CF-RECONCILE-ON-A-REAL-SUCCESS-COUNTER. `ok` here counted a worker callback
// that did not THROW, which is not the same thing as a write that landed --
// and it is the number the summary used to print as "patched". The callback is
// now the one that increments, on the line after its own patch resolves, so
// `written` cannot outrun the container. `stop` lets the clock end the drain
// between batches without unwinding the workers.
async function runInParallel(items, worker, concurrency = CONCURRENCY, stop = () => false) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      if (stop()) return;
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err, reached: i };
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809).
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[reslug-suspicious-setkeys]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  ${CLOCK.describe()}\n`);

  // Scan all rows in the LIMIT window and JS-side filter to non-canonical
  // setKeys. Simpler than trying to express the NOT-IN clause in Cosmos SQL.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE IS_STRING(c.hobbyiqCardId)
      AND IS_STRING(c.title)
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 2000 },
  );
  const rows = [];
  let scanStoppedAtBudget = false;
  while (it.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after its 42
    // possible seconds of 429 backoff have been spent. A stop here is SAFE,
    // not fatal: every patch is decided from one row own title, so a shorter
    // scan plans fewer patches and the next run finds the rest still matching
    // the same query. See THE CLOCK above.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const page = await fetchWithRetry(it);
    if (page && Array.isArray(page.resources)) rows.push(...page.resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
    if (rows.length >= LIMIT) break;
  }
  console.log(`\r  ${rows.length} rows scanned.        \n`);
  if (scanStoppedAtBudget) {
    console.log(`  !! the scan STOPPED at the budget -- this is a PARTIAL survey, not the whole ${LIMIT.toLocaleString()}-row window.`);
  }

  const patches = [];
  const setKeyDist = {};
  const originalSetKeyDist = {};
  let alreadyCanonical = 0, noDerivedMatch = 0, sameSetKey = 0, computeFailed = 0;

  for (const r of rows) {
    const parts = String(r.hobbyiqCardId || "").split(":");
    const existingSetKey = parts[3] || "";

    // Skip if already canonical (no reslug needed)
    if (KNOWN_CANONICALS.has(existingSetKey)) { alreadyCanonical++; continue; }

    const title = String(r.title || r.rawTitle || "");
    const derivedSetKey = matchKnownProductLine(title);
    if (!derivedSetKey) { noDerivedMatch++; continue; }
    if (!KNOWN_CANONICALS.has(derivedSetKey)) { noDerivedMatch++; continue; }
    if (derivedSetKey === existingSetKey) { sameSetKey++; continue; }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear) || 0,
        setKey: derivedSetKey,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { sameSetKey++; continue; }

    setKeyDist[derivedSetKey] = (setKeyDist[derivedSetKey] ?? 0) + 1;
    originalSetKeyDist[existingSetKey] = (originalSetKeyDist[existingSetKey] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      oldSetKey: existingSetKey,
      newSetKey: derivedSetKey,
      title: title.slice(0, 100),
    });
  }

  console.log(`  already canonical (skipped):   ${alreadyCanonical.toLocaleString()}`);
  console.log(`  no derived match (skipped):    ${noDerivedMatch.toLocaleString()}`);
  console.log(`  same setKey after derive:      ${sameSetKey.toLocaleString()}`);
  console.log(`  compute failed:                ${computeFailed.toLocaleString()}`);
  console.log(`  Ready to patch:                ${patches.length.toLocaleString()}\n`);

  console.log(`  New (corrected) setKey distribution (top 25):`);
  Object.entries(setKeyDist).sort((a,b) => b[1] - a[1]).slice(0, 25)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(6)}  ${k}`));

  console.log(`\n  Original mis-slugged setKey distribution (top 20):`);
  Object.entries(originalSetKeyDist).sort((a,b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(6)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5 patches:`);
    patches.slice(0, 5).forEach(p => {
      console.log(`    ${p.oldSetKey}  →  ${p.newSetKey}`);
      console.log(`      title: ${p.title}`);
    });
  }

  if (!APPLY || patches.length === 0) {
    console.log(`\n  Dry-run / no work. Re-dispatch with BACKFILL_APPLY=true to apply.`);
    if (scanStoppedAtBudget) emitMarker(0);
    return { client, budget: CLOCK };
  }

  console.log(`\n  Applying ${patches.length} patches (concurrency ${CONCURRENCY})...`);
  const t0 = Date.now();
  // A REAL success counter: incremented after the patch resolves, not by a
  // callback that merely returned.
  let written = 0;
  let applyStoppedAtBudget = false;
  const { err } = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    written++;
    if (written % 500 === 0) process.stdout.write(`\r    ${written}/${patches.length} patched`);
  }, CONCURRENCY, () => {
    // THE PRE-CHECK for the apply loop, taken by each worker BEFORE it claims
    // its next patch. Safe for the same reason the scan stop is: a patched row
    // now carries a canonical setKey, so the first only-improve guard skips it
    // and the next run picks up exactly what this pass did not reach.
    if (!applyStoppedAtBudget && CLOCK.outOfClock()) applyStoppedAtBudget = true;
    return applyStoppedAtBudget;
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const notReached = Math.max(0, patches.length - written - err);
  console.log(`\r    ${written}/${patches.length} patched (${secs}s)  err=${err}  not reached=${notReached}`);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  patched:  ${written}`);
  console.log(`  errors:   ${err}`);
  console.log(`  not reached (budget): ${notReached}`);

  // RECONCILE OVER THE PLAN. This lane builds its plan first, so it KNOWS its
  // denominator and reconciles the four-term way: every planned patch either
  // landed, failed, or was never reached because the clock stopped the drain.
  console.log(`  reconciled: intended ${patches.length} = written ${written} + failed ${err} + not reached ${notReached}`);
  if (written + err + notReached !== patches.length) {
    console.error("  !! RECONCILE MISMATCH -- a planned patch was neither written, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "reslug-suspicious-setkeys",
    intended: patches.length, written, skipped: notReached, failed: err,
  });

  if (scanStoppedAtBudget || applyStoppedAtBudget) emitMarker(notReached);
  return { client, budget: CLOCK };
}

// -- THE MARKER THE RELAUNCH GREPS -----------------------------------------
//
// CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
// variables. Printed from BOTH stop paths -- a scan stop with nothing applied
// still means work remains, and a dry-run scan stop means the survey itself
// was partial.
function emitMarker(notReached) {
  console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
    + `this sweep is UNFINISHED; the relaunch continues from here`);
  console.log(`  the continuation never re-reads what this pass wrote: a patched row carries a`
    + ` KNOWN_CANONICALS setKey, so the first only-improve guard skips it outright.`
    + ` ${notReached} planned patch(es) were left for the next run.`);
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
