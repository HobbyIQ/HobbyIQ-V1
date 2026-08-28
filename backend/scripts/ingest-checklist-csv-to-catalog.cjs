#!/usr/bin/env node
/**
 * CF-INGEST-THE-CLEAN-CHECKLIST (Drew, 2026-08-26).
 *
 * Turns staged canonical checklist CSVs into catalog rows. This is the step
 * that makes an acquired checklist matchable, and it is deliberately the LAST
 * step -- every scraper stages to disk, because a scraper that wrote straight
 * into the catalog would be another self-confirming source.
 *
 * WHY IT MATTERS, measured: 2026 Bowman Chrome Mega Box holds 944 catalog rows
 * from `ingest-auto-seed` -- built FROM the sales -- against 614 from a
 * checklist. A sale seeds a row and that row then confirms the sale, so the
 * match proves nothing about whether the card is real, spelled right or
 * numbered right. A checklist is the only artifact that can CONTRADICT a sale.
 *
 * THE SOURCE NAME IS LOAD-BEARING. upsertCatalogEntry now ranks by authority
 * before confidence, and catalogAuthority decides authority from `source`. A
 * name it does not recognise falls to `unknown` (rank 0) and loses to the very
 * derived rows this ingest exists to correct -- `keymancollectibles` is
 * currently in exactly that state. So the source is asserted to be a checklist
 * BEFORE anything is written, and the run refuses rather than quietly writing
 * rows that cannot win.
 *
 * READS THE MANIFEST, NOT THE FILENAME. Each product carries sport, year,
 * setKey and setName next to its CSV. Parsing those back out of a filename is
 * how "2025-26" seasons and multi-word set names get mangled.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   DIR                       directory of *.csv (+ *.manifest.json)
 *   SOURCE                    provenance stamped on every row; must be a
 *                             checklist-class name
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SLOT / SLOTS              shard across workers by file
 *   CONCURRENCY=48
 *   RUN_MINUTES=140
 *   LIMIT=0
 */
const fs = require("node:fs");
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { upsertCatalogEntry } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
const { computeHobbyIqCardId, slugify, normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { CosmosClient } = require("@azure/cosmos");

/**
 * CF-EVERY-CHECKLIST-ROW-IS-A-MISS.
 *
 * upsertCatalogEntry with no `known` hint calls getCatalogEntry, which point-
 * reads and then, ON A MISS, falls back to a CROSS-PARTITION
 * `SELECT TOP 1 * WHERE c.id = @id` across 31.2M documents.
 *
 * That fallback exists to find rows still sitting under a foreign partition
 * key. A checklist ingest is the pathological caller for it: every row it
 * writes is a NEW slug, so every row misses, so every row pays the scan.
 * Measured: 9,297 rows in 43 minutes. 216/min puts one Beckett pass at 38
 * hours, which is why two full runs landed 8 files out of 409.
 *
 * So do the point read here (1 RU) and hand the answer over. A miss stays a
 * miss instead of escalating. The authority merge is unaffected -- a row at
 * its own address is still found, and 98.9% of the catalog is at its own
 * address now.
 */
const lookup = (() => {
  let container = null;
  return async (slug) => {
    if (!container) {
      container = new CosmosClient({
        connectionString: process.env.COSMOS_CONNECTION_STRING,
        connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
      }).database("hobbyiq").container("card_catalog");
    }
    try { return (await container.item(slug, slug).read()).resource ?? null; }
    catch (e) { if (e.code === 404) return null; throw e; }
  };
})();

const DIR = process.env.DIR || "";
const SOURCE = process.env.SOURCE || "";
const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
const LIMIT = Number(process.env.LIMIT || 0);
const SLOT = Number(process.env.SLOT ?? 0);
const SLOTS = Number(process.env.SLOTS ?? 1);
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();

const f = (n) => Number(n).toLocaleString();

/** Split a canonical CSV line, honouring quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** sport/year/setKey/setName for a product, from its manifest. */
function productOf(csvPath) {
  const manifest = csvPath.replace(/\.csv$/, ".manifest.json");
  if (fs.existsSync(manifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (m.year && m.sport && (m.setKey || m.setName)) {
        return {
          sport: m.sport, year: Number(m.year),
          setKey: m.setKey || normalizeSetKey(m.setName),
          setName: m.setName || m.setKey,
          sourceUrl: m.sourceUrl ?? null,
        };
      }
    } catch { /* fall through */ }
  }
  // Fallback: <year>-<set>-<sport>. Season products ("2025-26-...") take the
  // FIRST year, matching how the catalog keys them.
  const base = path.basename(csvPath, ".csv");
  const m = base.match(/^((?:19|20)\d{2})(?:-\d{2})?-(.+)-(baseball|basketball|football|hockey|soccer|pokemon|wrestling)$/);
  if (!m) return null;
  return {
    sport: m[3], year: Number(m[1]), setKey: slugify(m[2]),
    setName: `${m[1]} ${m[2].replace(/-/g, " ")}`, sourceUrl: null,
  };
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!DIR || !fs.existsSync(DIR)) { console.error(`FATAL: DIR not found: ${DIR}`); process.exit(1); }
  if (!SOURCE) { console.error("FATAL: SOURCE required — it decides authority"); process.exit(1); }

  // The whole point of ingesting a checklist is that it can outrank a
  // sales-derived row. A source name catalogAuthority does not recognise ranks
  // BELOW derived, so the rows would be written and then lose to exactly what
  // they were meant to correct. Refuse instead.
  const authority = catalogAuthorityOf(SOURCE);
  if (authority !== "checklist") {
    console.error(`FATAL: SOURCE "${SOURCE}" classifies as ${authority}, not checklist.`);
    console.error(`       It would rank below the derived rows this ingest exists to correct.`);
    console.error(`       Declare it in catalogAuthority.service.ts first.`);
    process.exit(2);
  }

  const allFiles = fs.readdirSync(DIR).filter((n) => n.endsWith(".csv")).sort();
  let files = allFiles;
  if (SLOTS > 1) files = files.filter((_, i) => i % SLOTS === SLOT);

  // A SHARD IS NOT A RUN. The workflow's `slots` input defaults to 16 and the
  // wrapper hands the child its whole environment, so an un-sharded dispatch
  // silently took 1/16 of the files -- 26 of 409 -- and then printed a clean
  // reconciliation, a full phases-done line and a green check. The totals were
  // all internally consistent; they were just consistent about a sixteenth of
  // the job. Say the denominator out loud so that can never read as complete.
  if (SLOTS > 1) {
    console.log(`SHARD ${SLOT}/${SLOTS} — this run owns ${f(files.length)} of ${f(allFiles.length)} files.`);
    console.log(`  The other ${f(allFiles.length - files.length)} belong to sibling slots and are NOT ingested here.`);
    console.log(`  Dispatch every slot 0..${SLOTS - 1}, or pass slots=1 for the whole set.\n`);
  }

  // A file that finished completely leaves a marker beside its CSV, and the
  // marker rides the same cache the CSVs do. Without this, a budget stop sends
  // the next run back to file 1 to re-do the same head of the list forever,
  // never reaching the tail.
  const REINGEST = String(process.env.REINGEST || "") === "true";
  let alreadyDone = 0;
  if (!REINGEST) {
    const before = files.length;
    files = files.filter((n) => !fs.existsSync(path.join(DIR, n + ".ingested")));
    alreadyDone = before - files.length;
  }
  console.log(`${f(files.length)} files  source=${SOURCE} (${authority})  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);

  let rows = 0, written = 0, skippedRow = 0, noProduct = 0, failed = 0, files_ok = 0;
  // Counted directly, never by subtraction: a remainder derived as
  // intended-minus-everything-else makes the reconciliation balance by
  // construction and so can never disagree with itself.
  let notReached = 0;
  // Numbered rows whose parallel the source left blank. NOT base cards.
  let unnamedParallel = 0;
  let stopReason = null;

  for (const name of files) {
    if (stopReason) break;
    const csvPath = path.join(DIR, name);
    const product = productOf(csvPath);
    if (!product) { noProduct++; continue; }
    files_ok++;

    const lines = fs.readFileSync(csvPath, "utf8").split("\n");
    const batch = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const [category, cardNumber, parallel, isAuto, printRun, player] = splitCsv(line);
      rows++;
      if (!cardNumber || !player) { skippedRow++; continue; }
      batch.push({ category, cardNumber, parallel, isAuto, printRun, player });
    }

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(batch.slice(i, i + CONCURRENCY).map(async (r) => {
        try {
          // A blank parallel is "the plain card", which the slug generator
          // reads as Base. It is NOT the string "Base" in the CSV, and that
          // distinction is what lets a later pass tell "plain" from "nobody
          // told us".
          const slug = computeHobbyIqCardId({
            sport: product.sport, year: product.year, setKey: product.setKey,
            cardNumber: String(r.cardNumber),
            parallel: r.parallel || "Base",
            isAuto: r.isAuto === "true",
            printRun: r.printRun ? Number(r.printRun) : null,
          });
          if (!slug || !slug.startsWith("hiq:")) { skippedRow++; return; }
          if (!APPLY) { written++; return; }

          // A BLANK PARALLEL IS NOT A BASE CARD WHEN THE CARD IS NUMBERED.
          //
          // `r.parallel || "Base"` treats an empty cell as the plain card, and
          // for an unnumbered base-set row that is right. For a SERIAL-NUMBERED
          // row it is provably wrong: base cards are not numbered, so /1 is a
          // Superfractor and /5 is a numbered parallel whose NAME the source
          // did not give us. Calling those Base files a parallel into the base
          // card's own comp pool -- the pool the most sales land in.
          //
          // Measured before this guard existed: 828,893 catalog rows claimed
          // Base while numbered /1 to /999, and this ingest had contributed
          // 140,991 of them in one night.
          //
          // Blank means UNKNOWN, never Base. We cannot name the parallel, so we
          // decline to mint an identity that would collide with the base card,
          // and count it where it can be seen.
          const parallelBlank = !r.parallel || !String(r.parallel).trim();
          const numbered = r.printRun && Number(r.printRun) > 0;
          if (parallelBlank && numbered) { unnamedParallel++; return; }

          const known = await lookup(slug);
          await upsertCatalogEntry({
            id: slug, cardId: slug, hobbyiqCardId: slug,
            sport: product.sport, year: product.year,
            setKey: product.setKey, setName: product.setName,
            cardNumber: String(r.cardNumber).toUpperCase(),
            parallel: r.parallel || "Base",
            parallelSlug: slugify(r.parallel || "Base"),
            isAuto: r.isAuto === "true",
            printRun: r.printRun ? Number(r.printRun) : null,
            playerName: r.player, playerSlug: slugify(r.player),
            vendorIds: {},
            source: SOURCE,
            confidence: 0.95,
            verificationStatus: "verified",
            catalogVersion: 2,
            searchTokens: Array.from(new Set([
              String(product.year), String(r.cardNumber).toLowerCase(),
              ...r.player.toLowerCase().split(/\s+/),
              ...(r.parallel ? r.parallel.toLowerCase().split(/\s+/) : []),
              ...product.setKey.split("-"),
            ].filter(Boolean))),
          }, { known });
          written++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(r.cardNumber)}: ${String(e.message || e).slice(0, 70)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, batch.length);
      if (LIMIT && written >= LIMIT) { stopReason = "limit"; notReached += batch.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; notReached += batch.length - processed; break; }
    }
    // Marked only when the whole file was processed: a budget stop mid-file
    // must NOT claim the file is done, or its tail is silently lost.
    if (!stopReason && APPLY) {
      try { fs.writeFileSync(csvPath + ".ingested", String(written)); } catch { /* a lost marker only costs a redo */ }
    }
    // Rate, live. Printing throughput only in the final summary means the
    // answer to "does this fit in the budget?" arrives when the budget is
    // already spent -- which is how a 216 rows/min run went two full cycles
    // before anyone could see it was 175x too slow.
    const mins = Math.max(1 / 60, (Date.now() - STARTED) / 60000);
    process.stderr.write(`\r  ${files_ok}/${files.length}  rows=${f(rows)} written=${f(written)}  ${f(Math.round(written / mins))}/min   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  files ingested         ${f(files_ok)}${SLOTS > 1 ? `   of ${f(allFiles.length)} in the directory — SHARD ${SLOT}/${SLOTS}, NOT the whole set` : ""}`);
  console.log(`  files already done     ${f(alreadyDone)}   <- resumed past these`);
  console.log(`  files with no manifest ${f(noProduct)}   <- could not name the product`);
  console.log(`  csv rows read          ${f(rows)}`);
  console.log(`  catalog rows written   ${f(written)}`);
  {
    // The number that decides whether another cycle is needed, stated rather
    // than left to be inferred from a wall-clock subtraction.
    const mins = Math.max(1 / 60, (Date.now() - STARTED) / 60000);
    const rate = Math.round(written / mins);
    const left = files.length - files_ok;
    console.log(`  throughput             ${f(rate)} rows/min`);
    if (left > 0 && rate > 0 && files_ok > 0) {
      const perFile = rows / Math.max(1, files_ok);
      console.log(`  files left             ${f(left)}   ~${f(Math.ceil((left * perFile) / rate))} more minutes at this rate`);
    }
  }
  console.log(`  rows skipped           ${f(skippedRow)}   <- no card number, no player, or unslugable`);
  console.log(`  numbered, parallel blank ${f(unnamedParallel)}   <- NOT written as Base; the name is unknown`);
  console.log(`  rows not reached       ${f(notReached)}   <- the budget stopped before these`);
  console.log(`  failed                 ${f(failed)}`);
  if (APPLY) {
    reportWrites({ job: "ingest-checklist-csv-to-catalog", intended: rows, written, skipped: skippedRow + notReached + unnamedParallel, failed });
  }
}

module.exports = { splitCsv, productOf };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
