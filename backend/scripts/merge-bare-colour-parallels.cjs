#!/usr/bin/env node
/**
 * CF-KEEP-THE-LONG-FORM (Drew, 2026-08-25: "fix all parallels needing refractor").
 *
 * 413,178 sales sit on a slug whose parallel segment is a BARE COLOUR, while
 * the same card's "<Colour> Refractor" pool sits beside it holding the rest:
 *
 *     :gold:        67,216      :gold-refractor:        66,658
 *     :green:       92,708      :green-refractor:       59,294
 *     :blue:        50,137      :blue-refractor:        67,968
 *
 * One card, two pools, decided by whether the seller wrote the word
 * "Refractor". Drew's standing ruling is that the bare colour and the long
 * form are the same card and the LONG FORM WINS.
 *
 * SCOPED TO CHROME, DELIBERATELY. The same ruling carries an explicit warning:
 * it is per-CARD, and a product-level version destroys Panini Prizm, where a
 * colour is a Gold PRIZM and has nothing to do with a Refractor. Merging
 * globally would collapse two genuinely different parallels across every
 * Panini product in the catalog. Chrome-family products only:
 * Bowman, Topps Chrome, Finest, Sapphire.
 *
 * THE DESTINATION IS CHECKED. Same rule as the refractor repair -- a move to a
 * row that does not exist takes the sale out of one pool and lands it nowhere,
 * which is strictly worse than leaving it. Missing destinations are reported.
 *
 * Every move stamps parallelMergedBy.was, so it is reversible row by row.
 *
 *   BACKFILL_APPLY  "true" to write; anything else reports only
 *   YEARS           comma list, or empty for every year present
 *   SLOT / SLOTS    partition the year list across parallel dispatches
 */
// RETIRED (Drew, 2026-08-30: "color does not always mean refractor … remove
// rules, and follow it to the checklist or catalog"). This mover's premise —
// the bare colour and the long form are one card, the long form wins — is a
// vocabulary rule the catalog contradicts (Topps Tribute names 19,099
// bare-colour parallels with no refractor form; Finest lists "Uncommon" and
// "Uncommon Refractor" as two cards). Consolidation now follows the checklist
// row per card (the D30 fleet). The script refuses to run.
console.error("RETIRED 2026-08-30: merge-bare-colour-parallels moved sales on a vocabulary rule (colour = refractor). Colour follows the checklist per card now — use the D30 consolidation fleet.");
process.exit(2);
// eslint-disable-next-line no-unreachable
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(require("node:path").resolve(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const YEARS = String(process.env.YEARS || "").split(",").map(Number).filter(Boolean);
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "merge-bare-colour-parallels" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;


// Bare colours that mean "<Colour> Refractor" inside a chrome product.
const BARE_COLOURS = new Set([
  "gold", "red", "orange", "purple", "green", "yellow", "aqua", "blue", "pink",
  "black", "white", "fuchsia", "bronze", "sky-blue", "neon-green",
]);

// Chrome-family products only. A colour in Panini is a Prizm, not a Refractor,
// and merging there would destroy a real distinction.
const CHROME_SETKEY = /(^|-)(bowman|chrome|finest|sapphire)(-|$)/i;
const NOT_CHROME = /(panini|prizm|optic|select|donruss|mosaic|contenders|absolute|obsidian|spectra|immaculate|certified|score)/i;

const isChromeProduct = (setKey) => {
  const k = String(setKey || "");
  if (!k || NOT_CHROME.test(k)) return false;
  return CHROME_SETKEY.test(k);
};

async function yearsPresent(sold) {
  if (YEARS.length) return YEARS;
  const rows = (await sold.items.query({
    query: "SELECT c.cardYear AS y, COUNT(1) AS n FROM c " +
           "WHERE IS_NUMBER(c.cardYear) AND IS_STRING(c.hobbyiqCardId) GROUP BY c.cardYear",
  }).fetchAll()).resources;
  return rows.filter((r) => r.y >= 1990 && r.y <= 2030)
    .sort((a, b) => b.n - a.n).map((r) => r.y);
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  const query = async (spec, opts) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await sold.items.query(spec, opts).fetchNext(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || a >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };

  const destCache = new Map();
  const destExists = async (slug) => {
    if (destCache.has(slug)) return destCache.get(slug);
    let ok = false;
    try { ok = !!(await cat.item(slug, slug).read()).resource; } catch { ok = false; }
    destCache.set(slug, ok);
    return ok;
  };

  const all = await yearsPresent(sold);
  const years = all.filter((_, i) => i % SLOTS === SLOT);
  console.log("years: " + all.length + "   this worker (slot " + SLOT + "/" + SLOTS + "): " + years.length);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const total = { seen: 0, bare: 0, chrome: 0, notChrome: 0, noDest: 0, wrote: 0, failed: 0 };

  for (const year of years) {
    let token, seen = 0, bare = 0, chrome = 0, notChrome = 0, noDest = 0, wrote = 0, failed = 0;
    const samples = [], missing = new Map(), skipped = new Map();

    do {
      const page = await query(
        { query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title FROM c " +
                 "WHERE c.cardYear = @y AND IS_STRING(c.hobbyiqCardId)",
          parameters: [{ name: "@y", value: year }] },
        { maxItemCount: 500, continuationToken: token },
      );
      token = page.continuationToken;

      for (const r of page.resources) {
        seen++;
        const parts = String(r.hobbyiqCardId).split(":");
        if (parts[0] !== "hiq" || parts.length < 7) continue;
        const setKey = parts[3], parallel = parts[5];
        if (!BARE_COLOURS.has(parallel)) continue;
        bare++;

        if (!isChromeProduct(setKey)) {
          notChrome++;
          skipped.set(setKey, (skipped.get(setKey) || 0) + 1);
          continue;
        }
        chrome++;

        parts[5] = parallel + "-refractor";
        const dest = parts.join(":");
        if (!(await destExists(dest))) {
          noDest++;
          missing.set(dest, (missing.get(dest) || 0) + 1);
          continue;
        }
        if (samples.length < 3) samples.push({ from: r.hobbyiqCardId, to: dest, t: r.title });

        if (!APPLY) continue;
        try {
          const d = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
          if (!d) continue;
          d.hobbyiqCardId = dest;
          d.parallelMergedBy = {
            by: "merge-bare-colour-parallels", was: r.hobbyiqCardId,
            reason: "colour equals refractor, long form wins (chrome only)",
            at: new Date().toISOString(),
          };
          await sold.item(r.id, r.cardId ?? r.id).replace(d);
          wrote++;
        } catch { failed++; }
      }
    } while (token);

    total.seen += seen; total.bare += bare; total.chrome += chrome;
    total.notChrome += notChrome; total.noDest += noDest;
    total.wrote += wrote; total.failed += failed;

    console.log("  " + year + "  seen " + String(seen).padStart(8) +
                "  bare-colour " + String(bare).padStart(7) +
                "  chrome " + String(chrome).padStart(7) +
                "  panini-etc(skipped) " + String(notChrome).padStart(6) +
                "  noDest " + String(noDest).padStart(6) +
                "  wrote " + String(wrote).padStart(7));
    if (!APPLY) {
      for (const s of samples) console.log("        " + s.from + "\n     -> " + s.to);
      for (const [k, n] of [...skipped].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        console.log("        LEFT ALONE x" + n + "  setKey=" + k + "  (colour is not a refractor here)");
      }
      for (const [d, n] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        console.log("        MISSING DEST x" + n + "  " + d);
      }
    }
  }

  console.log("");
  console.log("TOTAL " + JSON.stringify(total));
  if (!APPLY) console.log("REPORT ONLY - nothing written.");

  // Every bare colour this run made a decision about is "intended": the ones it
  // merged, plus the ones it deliberately left alone because the product is not
  // chrome stock, plus the ones with no destination row to merge into. Declared
  // is accounted for; only a merge that was chosen and then never landed is a
  // shortfall. See CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW.
  if (APPLY) {
    reportWrites({
      job: "merge-bare-colour-parallels",
      intended: total.bare,
      written: total.wrote,
      skipped: total.notChrome + total.noDest,
      failed: total.failed,
    });
  }
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
