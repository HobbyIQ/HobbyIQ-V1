#!/usr/bin/env node
/**
 * CF-RETIRE-THE-ROWS-I-FLATTENED (Drew, 2026-08-24).
 *
 * attest-unnumbered-by-player ran before the attestation guard existed. It
 * hardcoded parallel "Base", isAuto false and printRun null on every row it
 * minted, on the assumption that a set with no card numbers is a 1950s set with
 * no parallels either. True for Red Man and Berk Ross; false for everything
 * modern, where a missing card number usually means the PARSER missed it.
 *
 * Measured after the fact: 878 of 7,666 rows (11.5%), carrying 18,134 sales,
 * were minted from titles that plainly named a variant --
 *
 *   "2024 Panini Photogenic Progressions Derrick Henry Blue Foil /99"
 *   "2023 Panini Black Tank Bigsby Rookie Auto /50 No 125"
 *
 * A Blue Foil /99 sale filed into the base pool does not just fail to price
 * itself, it MOVES THE BASE PRICE. This undoes that.
 *
 * PER-SALE, not per-row. A group is (set, player), so it can legitimately hold
 * base sales AND parallel sales. Retracting the whole group would throw away
 * the base ones, which are correctly filed. Each sale is re-judged on its OWN
 * title; a row is deleted only once nothing points at it any more.
 *
 * Retracted sales return to hobbyiqCardId = null -- exactly where they were
 * this morning. Unresolved is not a loss here: it is the honest state, and the
 * re-run with the guard in place will resolve the ones it can.
 *
 *   BACKFILL_APPLY   "true" to write; anything else reports only
 *   BATCH            catalogBatch to audit (default the unnumbered pass)
 */
const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { unparsedVariantReason } = require(path.join(ROOT, "dist/services/catalog/attestationGuard.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const BATCH = process.env.BATCH || "unnumbered-by-player-2026-08-24";
const STAMP = process.env.STAMP || "unnumbered-by-player-2026-08-24";

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  // Every sale this batch resolved, re-judged on its own title.
  const retract = [];
  const survivors = new Set();
  const reasons = new Map();
  let scanned = 0, token;
  do {
    const page = await sold.items.query(
      // c.identityResolvedBy["by"] -- BY is a Cosmos SQL reserved word, so the
      // dotted form returns "One of the input values is invalid" rather than an
      // empty result. Same collision as c["set"] in f7b00d5d.
      { query: "SELECT c.id, c.cardId, c.title, c.setName, c.hobbyiqCardId FROM c " +
               "WHERE c.identityResolvedBy[\"by\"] = @s",
        parameters: [{ name: "@s", value: STAMP }] },
      { maxItemCount: 500, continuationToken: token },
    ).fetchNext();
    token = page.continuationToken;
    for (const r of page.resources) {
      scanned++;
      // The rows this batch wrote carry no parallel/auto/printRun at all, so
      // judge the title against an empty parse -- which is what was stored.
      const why = unparsedVariantReason({ title: r.title, setName: r.setName });
      if (why) { retract.push(r); reasons.set(why, (reasons.get(why) || 0) + 1); }
      else if (r.hobbyiqCardId) survivors.add(r.hobbyiqCardId);
    }
  } while (token);

  const orphaned = new Set(retract.map((r) => r.hobbyiqCardId).filter(Boolean));
  for (const s of survivors) orphaned.delete(s);

  console.log("sales stamped by " + STAMP + " : " + scanned);
  console.log("  retract (title names an unparsed variant): " + retract.length +
              "   [" + [...reasons].map(([k, v]) => k + " " + v).join(", ") + "]");
  console.log("  keep    (correctly filed base cards)     : " + (scanned - retract.length));
  console.log("  rows left with nothing pointing at them  : " + orphaned.size);
  for (const r of retract.slice(0, 6)) {
    console.log("     " + r.hobbyiqCardId + "\n          " + String(r.title || "").slice(0, 96));
  }

  if (!APPLY) { console.log("\nREPORT ONLY - nothing written."); return; }

  let unset = 0, deleted = 0, failed = 0;
  for (const r of retract) {
    try {
      const d = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
      if (!d) continue;
      d.hobbyiqCardId = null;
      d.identityRetracted = {
        by: "retire-flattened-attestations", was: r.hobbyiqCardId,
        reason: unparsedVariantReason({ title: r.title, setName: r.setName }),
        at: new Date().toISOString(),
      };
      delete d.identityResolvedBy;
      await sold.item(r.id, r.cardId ?? r.id).replace(d);
      unset++;
    } catch { failed++; }
  }
  // Only rows the batch itself created, and only once nothing points at them.
  for (const id of orphaned) {
    try {
      const row = (await cat.item(id, id).read()).resource;
      if (!row || row.catalogBatch !== BATCH) continue;   // never touch another batch's row
      await cat.item(id, id).delete();
      deleted++;
    } catch { failed++; }
  }
  console.log("\nsales retracted " + unset + "   catalog rows deleted " + deleted + "   failed " + failed);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
