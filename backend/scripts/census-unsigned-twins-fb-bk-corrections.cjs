#!/usr/bin/env node
/**
 * census-unsigned-twins-fb-bk-corrections.cjs -- supplemental targeted pass
 * fixing two setKey-spelling errors discovered mid-run in
 * census-unsigned-twins-fb-bk.cjs's SETKEYS table, plus a `sub-` segment
 * scan for Contenders-style ticket-autograph inserts that live INSIDE
 * panini-contenders (as a subset segment) rather than as their own setKey.
 *
 * CORRECTIONS (verified against hobbyIqCardId.service.ts's normalizeSetKey
 * fold table, 2026-09-27):
 *   - "panini-optic" FOLDS TO "donruss-optic" (line ~1120: [/panini-optic/,
 *     "donruss-optic"]) -- the main run's SETKEYS list scanned the WRONG
 *     setKey and would have silently returned zero rows even if real data
 *     existed under the correct key.
 *   - "panini-hoops" FOLDS TO "nba-hoops" (Drew 2026-09-05 ruling: "NBA Hoops
 *     is spelled by its CHECKLIST, not the maker prefix" -- nba-hoops holds
 *     26,355 checklistinsider rows, panini-hoops holds ZERO strict rows).
 *   - AUTO_ONLY_INSERT_SETKEYS in the main run guessed standalone setKeys
 *     ("panini-contenders-rookie-ticket-autographs" etc.) that do not exist
 *     anywhere in the setKey vocabulary -- these products key as
 *     `hiq:<sport>:<year>:panini-contenders:sub-<ticket-insert-slug>:...`
 *     (the `sub-` segment, confirmed against the id grammar comment at the
 *     top of hobbyIqCardId.service.ts). This pass scans
 *     `hiq:<sport>:<year>:panini-contenders:sub-` broadly (STARTSWITH on the
 *     sub- stem, catching every ticket-autograph insert regardless of exact
 *     subset slug spelling) instead of guessing individual insert setKeys.
 *
 * READ-ONLY. No writes. Same doctrine as the main census script (paginated
 * {500,-1}, no cross-partition COUNT/GROUP BY, gentle pacing).
 */
"use strict";
const path = require("path");
const fs = require("fs");
const backend = path.join(__dirname, "..");

process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e && e.stack ? e.stack : e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e && e.stack ? e.stack : e); process.exit(1); });

const SPORTS = (process.env.SPORTS || "football,basketball").split(",").map((s) => s.trim()).filter(Boolean);
const YEARS = (process.env.YEARS || "2024,2025,2026").split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
const OUT = process.env.OUT || path.join(__dirname, "..", "..", "fb-bk-census-corrections-result.json");

const GLOBAL_AUTO_PREFIX = [
  "CPATWH-", "CPALD-", "APDCA-", "54FAV-", "FFDA-", "CUSA-", "SCCA-", "CCAR-",
  "RODA-", "ROTA-", "TTAR-", "DPPA-", "BSPA-", "BCPA-", "BCRA-", "TCRA-",
  "B96A-", "BGA-", "MRA-", "UAC-", "BSA-", "FSA-", "CPA-", "CDA-", "CRA-",
  "BPA-", "CBA-", "CCA-", "USA-", "DAS-", "NTS-", "SSM-", "DCA-", "CAA-",
  "GQA-", "AGA-", "ROA-", "FAR-", "FFA-", "BOA-", "T1A-", "SCA-", "PPA-",
  "ODA-", "IAP-", "UAR-", "BA-", "PA-", "RA-", "FA-", "TA-", "AA-", "AP-",
];
const FOOTBALL_ONLY_PREFIX = ["WT-", "SOT-"];

function prefixesForSport(sport) {
  const set = new Set(GLOBAL_AUTO_PREFIX);
  if (sport === "football") for (const p of FOOTBALL_ONLY_PREFIX) set.add(p);
  return [...set];
}

// The corrected setKeys, scanned with the SAME prefix vocabulary as the main
// run (only the setKey spelling changes).
const CORRECTED_SETKEYS = {
  football: ["donruss-optic"], // panini-optic mis-scan correction (also applies to football)
  basketball: ["donruss-optic", "nba-hoops"], // both mis-scans
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

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
          await new Promise((r) => setTimeout(r, e.retryAfterInMilliseconds || wait));
          wait = Math.min(wait * 1.6, 30000);
          continue;
        }
        throw e;
      }
    }
  };
  async function drainRows(query, params) {
    const iter = cat.items.query({ query, parameters: params }, { maxItemCount: 500, maxDegreeOfParallelism: -1 });
    const rows = [];
    while (iter.hasMoreResults()) {
      const { resources } = await retry(() => iter.fetchNext());
      for (const r of resources ?? []) rows.push(r);
      await new Promise((r) => setTimeout(r, 15));
    }
    return rows;
  }

  function pairFromRows(rows) {
    const byKey = new Map();
    for (const r of rows) {
      const parts = String(r.id).split(":");
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
    const pairs = [];
    for (const [key, slot] of byKey) {
      if (!slot.auto || !slot.noAuto) continue;
      if (catalogAuthorityOf(slot.auto.source) === "checklist" && catalogAuthorityOf(slot.noAuto.source) === "checklist") {
        pairs.push({ key, auto: slot.auto, noAuto: slot.noAuto });
      }
    }
    return pairs;
  }

  const worklist = [];
  for (const sport of SPORTS) {
    for (const year of YEARS) {
      for (const setKey of (CORRECTED_SETKEYS[sport] || [])) {
        for (const prefix of prefixesForSport(sport)) {
          worklist.push({ sport, year, setKey, prefix, idPrefix: `hiq:${sport}:${year}:${setKey}:${prefix}`, kind: "corrected-prefix" });
        }
      }
      // Contenders ticket-autograph inserts: scan the sub- stem broadly.
      worklist.push({
        sport, year, setKey: "panini-contenders", prefix: "(sub-*)",
        idPrefix: `hiq:${sport}:${year}:panini-contenders:sub-`,
        kind: "contenders-sub",
      });
    }
  }
  console.log(`Corrections worklist: ${worklist.length} combos.`);

  const query = "SELECT c.id, c.cardNumber, c.parallel, c.printRun, c.source, c.playerName FROM c WHERE STARTSWITH(c.id, @p)";
  const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
  let nextIdx = 0;
  const groups = [];
  let combosScanned = 0;
  let rowsSeen = 0;
  const startedAt = Date.now();

  function saveProgress() {
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), inProgress: true, combosScanned, rowsSeen, groups }, null, 2));
  }

  async function worker() {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= worklist.length) return;
      const item = worklist[idx];
      let rows;
      try {
        rows = await drainRows(query, [{ name: "@p", value: item.idPrefix }]);
      } catch (e) {
        console.error(`ERROR scanning ${item.idPrefix}: ${e.message}`);
        combosScanned++;
        continue;
      }
      combosScanned++;
      if (combosScanned % 10 === 0) {
        console.log(`... heartbeat: ${combosScanned}/${worklist.length} combos, ${rowsSeen} rows, ${groups.length} groups, elapsed ${Math.round((Date.now() - startedAt) / 1000)}s (at ${item.idPrefix}*)`);
        saveProgress();
      }
      if (rows.length === 0) continue;
      rowsSeen += rows.length;
      console.log(`${item.idPrefix}*  -> ${rows.length} rows [${item.kind}]`);

      // For contenders-sub, group by the FULL id shape (subset matters --
      // two different ticket inserts must not be paired against each
      // other). Extract subset slug to tag the group.
      if (item.kind === "contenders-sub") {
        const bySubset = new Map();
        for (const r of rows) {
          const m = String(r.id).match(/:sub-([^:]+):/);
          const subset = m ? m[1] : "(unknown)";
          if (!bySubset.has(subset)) bySubset.set(subset, []);
          bySubset.get(subset).push(r);
        }
        for (const [subset, subRows] of bySubset) {
          const pairs = pairFromRows(subRows);
          if (pairs.length > 0) {
            groups.push({
              sport: item.sport, setKey: `panini-contenders:sub-${subset}`, prefix: "(whole-subset)", year: item.year,
              totalRowsScanned: subRows.length, bothChecklistPairCount: pairs.length, pairs,
            });
            saveProgress();
          }
        }
        continue;
      }

      const pairs = pairFromRows(rows);
      if (pairs.length > 0) {
        groups.push({
          sport: item.sport, setKey: item.setKey, prefix: item.prefix, year: item.year,
          totalRowsScanned: rows.length, bothChecklistPairCount: pairs.length, pairs,
        });
        saveProgress();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, worklist.length) }, () => worker()));
  const totalPairs = groups.reduce((s, g) => s + g.bothChecklistPairCount, 0);
  console.log(`\nDONE. ${groups.length} groups, ${totalPairs} pairs, ${combosScanned} combos, ${rowsSeen} rows.`);
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), inProgress: false, combosScanned, rowsSeen, groups }, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
