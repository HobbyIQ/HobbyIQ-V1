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

  let files = fs.readdirSync(DIR).filter((n) => n.endsWith(".csv")).sort();
  if (SLOTS > 1) files = files.filter((_, i) => i % SLOTS === SLOT);
  console.log(`${f(files.length)} files  source=${SOURCE} (${authority})  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);

  let rows = 0, written = 0, skippedRow = 0, noProduct = 0, failed = 0, files_ok = 0;
  // Counted directly, never by subtraction: a remainder derived as
  // intended-minus-everything-else makes the reconciliation balance by
  // construction and so can never disagree with itself.
  let notReached = 0;
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
          });
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
    process.stderr.write(`\r  ${files_ok}/${files.length}  rows=${f(rows)} written=${f(written)}   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  files ingested         ${f(files_ok)}`);
  console.log(`  files with no manifest ${f(noProduct)}   <- could not name the product`);
  console.log(`  csv rows read          ${f(rows)}`);
  console.log(`  catalog rows written   ${f(written)}`);
  console.log(`  rows skipped           ${f(skippedRow)}   <- no card number, no player, or unslugable`);
  console.log(`  rows not reached       ${f(notReached)}   <- the budget stopped before these`);
  console.log(`  failed                 ${f(failed)}`);
  if (APPLY) {
    reportWrites({ job: "ingest-checklist-csv-to-catalog", intended: rows, written, skipped: skippedRow + notReached, failed });
  }
}

module.exports = { splitCsv, productOf };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
