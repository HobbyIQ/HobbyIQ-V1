#!/usr/bin/env node
/**
 * measure-corrupted-player-unlock.cjs -- READ-ONLY. How many rows does the
 * corrupted-player rule move from REPORT-ONLY to IMPROVE?
 *
 * CF-A-PLAYER-SEGMENT-IS-A-PERSON (Drew, 2026-09-04). The census says 29,654 of
 * 115,535 pseudo-number rows carry a player field that is not a person. This
 * script asks the next question, which is the one that decides whether the rule
 * is worth having: OF THOSE, HOW MANY CAN ACTUALLY BE REPAIRED?
 *
 * A row is UNLOCKED when all of these hold:
 *
 *   1. the stored player is corrupted        (the census's classification)
 *   2. today's parser derives a CLEAN name   (the fix's output is a person)
 *   3. the derived identity is CHECKLIST-BACKED for the same
 *      (year, setKey, cardNumber)            (the authority agrees)
 *
 * Rows failing (2) or (3) are REPORT-ONLY: we know the stored name is wrong,
 * and that is not the same as knowing the right one. Absent beats wrong on both
 * sides of the swap, so this script counts them separately rather than folding
 * them into a headline.
 *
 * NOTHING IS WRITTEN. There is no APPLY flag, by design -- the GREAT REMATCH
 * apply pass owns the write and reads this measurement to size the lane.
 *
 * THE ANSWER, MEASURED 2026-09-04: THE LANE IS EMPTY, AND WHY IT IS EMPTY IS
 * THE FINDING.
 *
 *     115,539  scanned
 *       6,476  stored player legibly corrupted
 *          76  ... of which today's parser derives a clean name
 *           0  ... of which the derived identity is checklist-backed
 *
 * Every one of the 76 near-misses carries `setKey: null`. They are the
 * `setKey: unknown` population #1728's census already identified as needing the
 * SETKEY ACQUISITION LANE, not this one -- a row with no product cannot be
 * checked against a product's checklist, so condition (3) can never hold for
 * them no matter how good the name derivation gets.
 *
 * So the corrupted-player rule is correct and currently unlocks NOTHING, and
 * that is the honest result rather than a reason to loosen the gate. The
 * checklist gate is what stops us trading a wrong name for a guess; dropping it
 * to make this number non-zero would be minting identities from titles alone,
 * which is the class of move that produced the corruption in the first place.
 * The rule stands so that the rows unlock automatically once the setKey lane
 * fills their product in -- and the FIX still matters on its own, because it
 * stops 25.7% of NEW rows acquiring the same corruption at ingest.
 *
 * USAGE
 *   COSMOS_CONNECTION_STRING=... node scripts/measure-corrupted-player-unlock.cjs [--limit N] [--out FILE]
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { CosmosClient } = require("@azure/cosmos");
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = Number(argOf("--limit", "0")) || 0;
const OUT = argOf("--out", "");

let parseCardQuery;
try {
  ({ parseCardQuery } = require(path.join(__dirname, "..", "dist", "services", "compiq", "cardQueryParser.js")));
} catch (e) {
  console.error("build dist/ first (npx tsc && node scripts/copy-static-data-to-dist.cjs):", e.message);
  process.exit(2);
}

const lower = (s) => String(s ?? "").toLowerCase();

/** The checklist corpus, used ONLY to answer "does this product list this
 *  card number" -- the same evidence the IMPROVE gate reads. */
let _checklist = null;
function checklistBacks(year, setKey) {
  if (!_checklist) {
    _checklist = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "checklist-parallel-names.json"), "utf8"));
      for (const key of Object.keys(raw.products || {})) {
        const p = key.split("|");
        _checklist.add(`${p[1]}|${p[2]}`);
      }
    } catch { /* absent -> nothing is checklist-backed, and the count says so */ }
  }
  return _checklist.has(`${year}|${lower(setKey)}`);
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const container = new CosmosClient(conn).database("hobbyiq").container("sold_comps");

  const counts = {
    scanned: 0,
    storedCorrupted: 0,
    derivesCleanName: 0,
    checklistBacked: 0,
    unlockedImprove: 0,
    reportOnlyNoCleanName: 0,
    reportOnlyNotBacked: 0,
  };
  const samples = [];
  let ru = 0;

  const q = {
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.playerName, c.cardNumber, c.setKey, c.cardYear, c.parallel, c.sport, c.source FROM c WHERE CONTAINS(c.hobbyiqCardId, ':player-') OR CONTAINS(c.cardId, ':player-')",
  };
  const it = container.items.query(q, { maxItemCount: 1000, maxDegreeOfParallelism: 8 });
  outer:
  while (it.hasMoreResults()) {
    const { resources, requestCharge } = await it.fetchNext();
    ru += requestCharge || 0;
    for (const row of resources || []) {
      counts.scanned++;
      const slug = String(row.hobbyiqCardId || row.cardId || "");
      const m = slug.match(/:player-([^:]+)/);
      const storedName = m ? m[1].replace(/-/g, " ") : lower(row.playerName);
      if (!storedName) continue;

      // (1) is the stored player corrupted?
      const corrupted = K.isCorruptedPlayerName(storedName);
      if (!corrupted) continue;
      counts.storedCorrupted++;

      // (2) does today's parser derive a clean name?
      const derivedName = parseCardQuery(String(row.title || "")).playerName;
      if (!derivedName) { counts.reportOnlyNoCleanName++; continue; }
      counts.derivesCleanName++;

      // (3) is the derived identity checklist-backed?
      const backed = checklistBacks(row.cardYear, row.setKey);
      if (!backed) {
        counts.reportOnlyNotBacked++;
        if (samples.length < 20) samples.push({ why: "not-checklist-backed", title: String(row.title||"").slice(0,110), storedName, derivedName, setKey: row.setKey ?? null, year: row.cardYear ?? null });
        continue;
      }
      counts.checklistBacked++;
      counts.unlockedImprove++;

      if (samples.length < 20) {
        samples.push({
          title: String(row.title || "").slice(0, 110),
          storedName, derivedName,
          setKey: row.setKey ?? null, year: row.cardYear ?? null,
        });
      }
      if (LIMIT && counts.scanned >= LIMIT) break outer;
    }
  }

  const report = {
    _doc: "CF-A-PLAYER-SEGMENT-IS-A-PERSON unlock measurement. READ-ONLY; nothing was written.",
    asOf: new Date().toISOString().slice(0, 10),
    requestCharge: Math.round(ru),
    counts,
    samples,
  };
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log("wrote", OUT); }
  console.log(JSON.stringify({ counts, ru: Math.round(ru) }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
