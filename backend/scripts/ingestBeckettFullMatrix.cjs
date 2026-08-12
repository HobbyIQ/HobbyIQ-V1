// CF-BECKETT-FULL-MATRIX (Drew, 2026-08-12). Materialize the FULL card ×
// parallel matrix for a product, so a sale matches the moment it happens
// instead of after we notice the card is missing.
//
// DOCTRINE CHANGE — deliberate, confirmed by Drew 2026-08-12:
// ingestBeckettChecklistDataDriven.cjs (2026-08-09) writes rows ONLY for
// parallels with sales evidence — "dont make parallel assumptions unless the
// data is there." That was right when we had no verified 2026 parallel list,
// because exploding meant guessing. It is no longer the situation: the
// published 2026 checklists are in hand, so a Gold Refractor /50 row is a
// DOCUMENTED card that simply has not sold yet, not an assumption.
//
// The risk that rule protected against was dead-end search results — cards
// with 0 comps and a phantom FMV, the reason tree-builder-v1 is excluded from
// search. So evidence-free rows are written MATCHABLE BUT NOT SEARCHABLE:
//   verificationStatus = "pending-review"  → provisional tier (#1001)
// A sale lands on a real card instantly; the row becomes searchable once it
// has evidence. Rows that DO have sales evidence are written verified.
//
// Inputs:
//   data/beckett-sweep/<year>/<Brand>.json   card list (player, cardNumber, isAutograph)
//   data/checklists/hand-fetched/parallels-*.json  parallel list + print runs
//
// Env:
//   YEAR=2026 (required)
//   PRODUCTS="Topps-Chrome:topps-chrome,Bowman:bowman"   staged file : setKey
//   APPLY=true         write (default dry-run)
//   CONCURRENCY=12
//   MAX_ROWS=0         cap for smoke tests

const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const YEAR = Number(process.env.YEAR || 0);
const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const MAX_ROWS = Number(process.env.MAX_ROWS || 0);
const SPORT = process.env.SPORT || "baseball";
const PRODUCTS = (process.env.PRODUCTS || "").split(",").map((s) => s.trim()).filter(Boolean);

const BASE = path.resolve(__dirname, "..");
const SWEEP_DIR = path.join(BASE, "data", "beckett-sweep", String(YEAR));
const HAND_FETCHED_DIR = path.join(BASE, "data", "checklists", "hand-fetched");
const dist = (p) => require(path.join(BASE, "dist", p));
const { deriveCatalogEntry, upsertCatalogEntry } = dist("services/portfolioiq/cardCatalog.service.js");

if (!YEAR || PRODUCTS.length === 0) { console.error("YEAR and PRODUCTS required"); process.exit(2); }

/** Parallel list for a product. Prefers a DIRECT claim over a (proxy) claim —
 *  a proxy inherits last year's list and misses anything new. */
function parallelsFor(setKey) {
  const wanted = [`${YEAR}-${setKey}-${SPORT}`, `${YEAR}-${setKey}`];
  const matches = [];
  for (const f of fs.readdirSync(HAND_FETCHED_DIR).filter((f) => f.startsWith("parallels-") && f.endsWith(".json"))) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(HAND_FETCHED_DIR, f), "utf8"));
      for (const a of doc.appliesTo || []) {
        if (wanted.includes(String(a).replace(/\s*\(.*\)\s*$/, "").trim())) {
          matches.push({ file: f, doc, viaProxy: /\(proxy/i.test(a) });
          break;
        }
      }
    } catch { /* skip malformed */ }
  }
  return matches.find((m) => !m.viaProxy) ?? matches[0] ?? null;
}

/** Beckett's xlsx parse leaves trailing punctuation on names ("Alvarez,"). */
function cleanPlayer(raw) {
  return String(raw ?? "").replace(/[,;]+\s*$/, "").replace(/\s+/g, " ").trim();
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");

  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  year=${YEAR}  products=${PRODUCTS.length}  concurrency=${CONCURRENCY}\n`);

  let grandPlanned = 0, grandWrote = 0, grandFailed = 0, grandSkipped = 0;

  for (const spec of PRODUCTS) {
    const [file, setKey] = spec.split(":");
    const cardsPath = path.join(SWEEP_DIR, `${file}.json`);
    if (!fs.existsSync(cardsPath)) { console.log(`  !! ${cardsPath} missing — skipping`); continue; }

    const staged = JSON.parse(fs.readFileSync(cardsPath, "utf8"));
    const cards = staged.cards || [];
    const par = parallelsFor(setKey);
    if (!par) { console.log(`  !! no parallel list for ${YEAR} ${setKey} — skipping`); continue; }

    const baseP = par.doc.baseParallels || [];
    const autoP = par.doc.autoParallels || [];
    console.log(`=== ${YEAR} ${setKey} ===`);
    console.log(`  cards:     ${cards.length.toLocaleString()}  (${staged.sourceUrl ? "beckett" : "?"})`);
    console.log(`  parallels: ${baseP.length} base / ${autoP.length} auto  <- ${par.file}${par.viaProxy ? "  *** PROXY — parallels inherited from another year; new-for-" + YEAR + " parallels will be absent ***" : ""}`);

    // Sales evidence: which (cardNumber, parallelSlug) already trade? Those
    // rows are written VERIFIED; everything else is provisional.
    const prefix = `hiq:${SPORT}:${YEAR}:${setKey}:`;
    const { resources: obs } = await sold.items.query(
      { query: "SELECT c.hobbyiqCardId FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)", parameters: [{ name: "@p", value: prefix }] },
      { maxItemCount: -1 },
    ).fetchAll();
    const withEvidence = new Set(obs.map((r) => String(r.hobbyiqCardId)));
    console.log(`  sales evidence: ${withEvidence.size.toLocaleString()} distinct slugs already trade`);

    const planned = [];
    for (const card of cards) {
      const playerName = cleanPlayer(card.player);
      const cardNumber = String(card.cardNumber ?? "").trim();
      if (!playerName || !cardNumber) { grandSkipped++; continue; }
      const isAuto = Boolean(card.isAutograph);
      for (const p of (isAuto ? autoP : baseP)) {
        planned.push({
          playerName, cardNumber, isAuto,
          parallel: p.name,
          printRun: p.printRun ?? card.inlinePrintRun ?? null,
        });
        if (MAX_ROWS && planned.length >= MAX_ROWS) break;
      }
      if (MAX_ROWS && planned.length >= MAX_ROWS) break;
    }

    let verified = 0, provisional = 0;
    const entries = [];
    for (const row of planned) {
      const entry = deriveCatalogEntry({
        sport: SPORT, year: YEAR, setKey, cardNumber: row.cardNumber,
        parallel: row.parallel, isAuto: row.isAuto, printRun: row.printRun,
        playerName: row.playerName,
        source: "checklist",
        confidence: 0.95,
        vendorIds: {},
      });
      if (!entry) { grandSkipped++; continue; }
      const hasEvidence = withEvidence.has(entry.id);
      if (hasEvidence) { verified++; }
      else {
        provisional++;
        // Matchable now, searchable once it has evidence.
        entry.verificationStatus = "pending-review";
      }
      if (par.viaProxy) entry.parallelSourceProxy = par.file; // audit trail
      entries.push(entry);
    }

    console.log(`  PLANNED ROWS: ${entries.length.toLocaleString()}   verified=${verified.toLocaleString()}  provisional=${provisional.toLocaleString()}`);
    grandPlanned += entries.length;

    if (!APPLY) { console.log(`  (dry-run — nothing written)\n`); continue; }

    let wrote = 0, failed = 0, i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < entries.length) {
        const e = entries[i++];
        try { await upsertCatalogEntry(e); wrote++; }
        catch (err) { failed++; if (failed < 4) console.warn(`   fail ${e.id}: ${err.message || err}`); }
        if (wrote % 5000 === 0 && wrote) console.log(`    ...${wrote.toLocaleString()}/${entries.length.toLocaleString()}`);
      }
    }));
    grandWrote += wrote; grandFailed += failed;
    console.log(`  WROTE ${wrote.toLocaleString()}  failed=${failed}\n`);
  }

  console.log(`================ TOTAL ================`);
  console.log(`  planned  ${grandPlanned.toLocaleString()}`);
  if (APPLY) console.log(`  wrote    ${grandWrote.toLocaleString()}   failed=${grandFailed}`);
  console.log(`  skipped  ${grandSkipped.toLocaleString()} (missing player/cardNumber or underivable)`);
  if (!APPLY) console.log(`\n[dry-run] APPLY=true to write.`);
})().catch((e) => { console.error("ERR", e && e.message ? e.message : e); process.exit(1); });
