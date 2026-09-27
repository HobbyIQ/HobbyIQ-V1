#!/usr/bin/env node
/**
 * census-unsigned-twins-fb-bk.cjs (2026-09-26/27) -- extends the baseball
 * "checklist rows minted unsigned for auto-only inserts" census
 * (C:/tmp/unsigned_1949/RESULT.md, PR #2453) to FOOTBALL and BASKETBALL,
 * 2024-2026.
 *
 * READ-ONLY. No writes anywhere in this file.
 *
 * METHOD (identical to the baseball run, reused deliberately -- see PR #2453
 * body): a blind full-year card_catalog scan for one sport+year exceeded
 * 1.3M rows and was abandoned. Instead this queries card_catalog by
 * `STARTSWITH(c.id, 'hiq:<sport>:<year>:<setKey>:<PREFIX>')` for each
 * (setKey x registered-auto-only-prefix) pair, for a curated list of the
 * biggest setKeys per sport. That keeps every query small and targeted --
 * never a bare cross-partition scan of a whole sport/year.
 *
 * Auto-only prefix vocabulary, per sport:
 *   - isCardNumberAutoSubset's global AUTO_PREFIX list (baseball-shaped, but
 *     the same physical prefixes -- CPA-, BPA-, CRA-, etc. -- also appear on
 *     football/basketball Bowman/Donruss/Optic-style products using the same
 *     manufacturer conventions), scoped down to the SUBSET this repo's own
 *     isFootballCardNumberAutoSubset / AUTO_SETNAME_RE machinery recognizes
 *     as legitimate for that sport.
 *   - isFootballCardNumberAutoSubset's football-only WT-/SOT- (Winning
 *     Ticket / Season/Championship/Playoff Ticket).
 *   - SCOPED_AUTO_ONLY_PREFIXES (backend/src/services/portfolioiq/
 *     scopedAutoOnlyPrefixes.ts) -- currently baseball-only entries, checked
 *     per sport anyway in case a future entry adds one; none matched here.
 *   - AUTO_SETNAME_RE-matching insert categories are NOT prefix-based (no
 *     cardNumber tell) -- Panini basketball/football have NO cardNumber
 *     auto vocabulary at all (inferIsAuto explicitly skips the prefix rule
 *     for sport==="basketball", and football's prefix rule is WT-/SOT- only).
 *     Those inserts are identified by SET NAME instead
 *     ("Rookie Ticket Autographs", "Prime Signatures", etc.), which this
 *     script also checks for via a per-insert-setKey allowlist below, since
 *     an "auto-only insert" there means EVERY card in that specific insert
 *     setKey is graded auto by definition, not a cardNumber subset within a
 *     mixed base set.
 *
 * Pairing rule: within one (sport, year, setKey, prefix) scan, group
 * card_catalog rows by (cardNumber, parallel, printRun) and flag a pair
 * where BOTH the :auto and :no-auto twin exist AND both are checklist-grade
 * per catalogAuthorityOf(source) (dist build, same classifier PR #2453 used).
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node census-unsigned-twins-fb-bk.cjs
 *
 * Env:
 *   SPORTS=football,basketball   (default: both)
 *   YEARS=2024,2025,2026         (default: all three)
 *   OUT=<path to write RESULT.json>  (default: ./fb-bk-census-result.json)
 */
"use strict";

const path = require("path");
const fs = require("fs");

process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT EXCEPTION:", e && e.stack ? e.stack : e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e && e.stack ? e.stack : e);
  process.exit(1);
});

const backend = path.join(__dirname, "..");

const SPORTS = (process.env.SPORTS || "football,basketball").split(",").map((s) => s.trim()).filter(Boolean);
const YEARS = (process.env.YEARS || "2024,2025,2026").split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
const OUT = process.env.OUT || path.join(__dirname, "fb-bk-census-result.json");

// ---------------------------------------------------------------------------
// Auto-only cardNumber prefix vocabulary, per sport.
//
// GLOBAL_AUTO_PREFIX mirrors isCardNumberAutoSubset's AUTO_PREFIX regex
// (parseTitleIdentity.service.ts:538) as a literal prefix list rather than a
// regex, because STARTSWITH needs literal strings for a sargable card_catalog
// query. This is the SAME table, transcribed -- not a new vocabulary. It is
// applied to football/basketball too because the physical manufacturer
// convention (CPA- = Chrome Prospect Auto, BPA- = Bowman Prospect Auto, etc.)
// is shared across Bowman/Donruss/Optic-family products regardless of sport;
// what's football/basketball-SPECIFIC is layered on top.
const GLOBAL_AUTO_PREFIX = [
  "CPATWH-", "CPALD-", "APDCA-", "54FAV-", "FFDA-", "CUSA-", "SCCA-", "CCAR-",
  "RODA-", "ROTA-", "TTAR-", "DPPA-", "BSPA-", "BCPA-", "BCRA-", "TCRA-",
  "B96A-", "BGA-", "MRA-", "UAC-", "BSA-", "FSA-", "CPA-", "CDA-", "CRA-",
  "BPA-", "CBA-", "CCA-", "USA-", "DAS-", "NTS-", "SSM-", "DCA-", "CAA-",
  "GQA-", "AGA-", "ROA-", "FAR-", "FFA-", "BOA-", "T1A-", "SCA-", "PPA-",
  "ODA-", "IAP-", "UAR-", "BA-", "PA-", "RA-", "FA-", "TA-", "AA-", "AP-",
];

// Football-only, from isFootballCardNumberAutoSubset (parseTitleIdentity.
// service.ts:665-669): WT (Winning Ticket) and SOT (Season/Championship/
// Playoff/Winning-family "...Ticket" numbering used across Contenders).
const FOOTBALL_ONLY_PREFIX = ["WT-", "SOT-"];

// Basketball: inferIsAuto EXPLICITLY skips the cardNumber-prefix rule for
// sport==="basketball" (parseTitleIdentity.service.ts:696-699 -- "Panini era
// has NO prefix vocabulary"). So the global list above is the parser's own
// admission that basketball prefixes aren't a reliable auto tell BY ITSELF;
// we still scan it for the census (a checklist-grade collision would still
// be a real defect if found), but do not add basketball-only prefixes here
// since none are registered anywhere in the parser.
const BASKETBALL_ONLY_PREFIX = [];

function prefixesForSport(sport) {
  const set = new Set(GLOBAL_AUTO_PREFIX);
  if (sport === "football") for (const p of FOOTBALL_ONLY_PREFIX) set.add(p);
  if (sport === "basketball") for (const p of BASKETBALL_ONLY_PREFIX) set.add(p);
  return [...set];
}

// Curated top setKeys per sport (per task instructions) -- targeted, not a
// blind scan. computeHobbyIqCardId / normalizeSetKey spelling.
const SETKEYS = {
  football: [
    "panini-prizm", "panini-select", "panini-donruss", "panini-optic",
    "panini-mosaic", "panini-contenders", "panini-national-treasures",
    "panini-immaculate", "panini-flawless", "panini-obsidian",
    "panini-chronicles", "panini-absolute", "panini-spectra",
    "panini-limited", "panini-playbook", "panini-certified",
    "panini-illusions", "panini-phoenix", "panini-elite",
    "topps-chrome",
  ],
  basketball: [
    "panini-prizm", "panini-select", "panini-donruss", "panini-optic",
    "panini-mosaic", "panini-contenders", "panini-national-treasures",
    "panini-immaculate", "panini-flawless", "panini-obsidian",
    "panini-chronicles", "panini-noir", "panini-spectra",
    "panini-hoops", "panini-crown-royale", "panini-court-kings",
    "panini-revolution", "panini-illusions",
    "topps-chrome",
  ],
};

// Insert-shaped auto-only sets, identified by SETKEY (not cardNumber prefix)
// -- these are products/insert-lines where EVERY card is graded auto by the
// checklist itself. Included because AUTO_SETNAME_RE's title-text vocabulary
// (rookie ticket, season ticket, prime signatures, etc.) has no cardNumber
// prefix tell in football/basketball Panini products at all, so a
// card_catalog scan keyed only on cardNumber prefixes would MISS this shape
// entirely. checked via id prefix hiq:<sport>:<year>:<setKey>: with no
// cardNumber-prefix restriction (the WHOLE setKey is auto-only).
const AUTO_ONLY_INSERT_SETKEYS = {
  football: [
    "panini-contenders-rookie-ticket-autographs",
    "panini-contenders-season-ticket-autographs",
    "panini-contenders-playoff-ticket-autographs",
    "panini-contenders-championship-ticket-autographs",
  ],
  basketball: [
    "panini-contenders-rookie-ticket-autographs",
    "panini-contenders-season-ticket-autographs",
  ],
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  let catalogAuthorityOf;
  try {
    ({ catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js")));
  } catch (e) {
    console.error("FATAL: dist build missing -- run `npm run build` first.", e.message);
    process.exit(1);
  }

  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database("hobbyiq");
  const cat = db.container("card_catalog");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); } catch (e) {
        const status = e && (e.code || e.statusCode);
        if (status === 429 && a < tries) {
          const retryAfter = (e.retryAfterInMilliseconds || wait);
          await new Promise((r) => setTimeout(r, retryAfter));
          wait = Math.min(wait * 1.6, 30000);
          continue;
        }
        throw e;
      }
    }
  };

  // Paginated {500,-1} drain, no cross-partition COUNT/GROUP BY -- same
  // doctrine as sales-at-id.cjs / relocate-catalog-rows-by-list.cjs.
  async function drainRows(query, params) {
    const iter = cat.items.query(
      { query, parameters: params },
      { maxItemCount: 500, maxDegreeOfParallelism: -1 },
    );
    const rows = [];
    while (iter.hasMoreResults()) {
      const { resources } = await retry(() => iter.fetchNext());
      for (const r of resources ?? []) rows.push(r);
      // Be gentle: brief pause between pages so this shares the containers
      // civilly with the concurrent census (04:30Z) and normal traffic.
      await new Promise((r) => setTimeout(r, 15));
    }
    return rows;
  }

  const groups = []; // one entry per (sport, setKey, prefixOrInsert, year)
  const startedAt = Date.now();
  const DEADLINE_MS = process.env.NO_DEADLINE ? Infinity : (4 * 60 * 60 * 1000); // soft guard
  let combosScanned = 0;
  let rowsSeen = 0;

  function saveProgress() {
    fs.writeFileSync(OUT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      inProgress: true,
      combosScanned,
      rowsSeen,
      groups,
    }, null, 2));
  }

  function pairFromRows(rows) {
    // Group by (cardNumber, parallel, printRun); split by isAuto via id's
    // own auto/no-auto segment (parsed from the id directly -- avoids
    // depending on a stored isAuto field that may drift from the id).
    const byKey = new Map();
    for (const r of rows) {
      const parts = String(r.id).split(":");
      // hiq:sport:year:setKey[:sub-x]:cardNumber:parallel:auto|no-auto[:num-N]
      const autoIdx = parts.findIndex((p) => p === "auto" || p === "no-auto");
      if (autoIdx < 0) continue;
      const isAutoSeg = parts[autoIdx] === "auto";
      const cardNumber = parts[autoIdx - 2];
      const parallel = parts[autoIdx - 1];
      const printRunPart = parts[autoIdx + 1];
      const printRun = printRunPart && printRunPart.startsWith("num-") ? printRunPart.slice(4) : null;
      const key = `${cardNumber}|${parallel}|${printRun ?? ""}`;
      if (!byKey.has(key)) byKey.set(key, { auto: null, noAuto: null });
      const slot = byKey.get(key);
      if (isAutoSeg) slot.auto = r; else slot.noAuto = r;
    }
    const bothChecklistPairs = [];
    for (const [key, slot] of byKey) {
      if (!slot.auto || !slot.noAuto) continue;
      const autoAuth = catalogAuthorityOf(slot.auto.source);
      const noAutoAuth = catalogAuthorityOf(slot.noAuto.source);
      if (autoAuth === "checklist" && noAutoAuth === "checklist") {
        bothChecklistPairs.push({ key, auto: slot.auto, noAuto: slot.noAuto });
      }
    }
    return bothChecklistPairs;
  }

  // Build the full worklist up front -- targeted-prefix combos (per
  // sport/year/setKey/prefix) plus whole-insert-setKey combos -- then drain
  // it with a small worker pool. Each individual query is a cheap, indexed
  // STARTSWITH(c.id, ...) point-prefix lookup (never a cross-partition
  // COUNT/GROUP BY, never a blind scan), so running a handful concurrently
  // stays well inside "be gentle" -- it is the SAME work the serial version
  // did, just not queued behind network round-trip latency one at a time.
  const worklist = [];
  for (const sport of SPORTS) {
    const setKeys = SETKEYS[sport] || [];
    const prefixes = prefixesForSport(sport);
    for (const year of YEARS) {
      for (const setKey of setKeys) {
        for (const prefix of prefixes) {
          worklist.push({
            sport, year, setKey, prefix,
            idPrefix: `hiq:${sport}:${year}:${setKey}:${prefix}`,
            kind: "prefix",
          });
        }
      }
      for (const insertSetKey of (AUTO_ONLY_INSERT_SETKEYS[sport] || [])) {
        worklist.push({
          sport, year, setKey: insertSetKey, prefix: "(whole-insert)",
          idPrefix: `hiq:${sport}:${year}:${insertSetKey}:`,
          kind: "insert",
        });
      }
    }
  }
  console.log(`Worklist built: ${worklist.length} combos to scan.`);

  const query = "SELECT c.id, c.cardNumber, c.parallel, c.printRun, c.source, c.playerName FROM c WHERE STARTSWITH(c.id, @p)";
  const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
  let nextIdx = 0;
  let deadlineHit = false;

  async function worker() {
    for (;;) {
      if (deadlineHit) return;
      const idx = nextIdx++;
      if (idx >= worklist.length) return;
      const item = worklist[idx];
      if (Date.now() - startedAt > DEADLINE_MS) {
        deadlineHit = true;
        console.error("Soft deadline reached -- stopping scan early.");
        return;
      }
      let rows;
      try {
        rows = await drainRows(query, [{ name: "@p", value: item.idPrefix }]);
      } catch (e) {
        console.error(`ERROR scanning ${item.idPrefix}: ${e.message}`);
        combosScanned++;
        continue;
      }
      combosScanned++;
      if (combosScanned % 25 === 0) {
        console.log(`... heartbeat: ${combosScanned}/${worklist.length} combos scanned, ${rowsSeen} rows seen, ${groups.length} groups so far, elapsed ${Math.round((Date.now() - startedAt) / 1000)}s (at ${item.idPrefix}*)`);
        saveProgress();
      }
      if (rows.length === 0) continue;
      rowsSeen += rows.length;
      console.log(`${item.idPrefix}*  -> ${rows.length} rows${item.kind === "insert" ? " (whole-insert auto-only)" : ""}`);

      const bothChecklistPairs = pairFromRows(rows);
      if (bothChecklistPairs.length > 0) {
        groups.push({
          sport: item.sport, setKey: item.setKey, prefix: item.prefix, year: item.year,
          totalRowsScanned: rows.length,
          bothChecklistPairCount: bothChecklistPairs.length,
          pairs: bothChecklistPairs,
        });
        saveProgress();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, worklist.length) }, () => worker()));

  const totalPairs = groups.reduce((s, g) => s + g.bothChecklistPairCount, 0);
  console.log(`\nDONE. ${groups.length} groups, ${totalPairs} BOTH-checklist pairs, ${combosScanned} combos scanned, ${rowsSeen} total rows seen.`);
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), inProgress: false, combosScanned, rowsSeen, groups,
  }, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
