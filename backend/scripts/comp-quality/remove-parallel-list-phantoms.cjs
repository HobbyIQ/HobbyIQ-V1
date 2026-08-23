// Delete catalog rows that are a PARALLEL NAME, not a card.
//
// WHAT THEY ARE. The baseballcardpedia sweep read a set's parallel list —
// "Red Refractor", "Orange Refractor", "Lava Refractor" — and wrote each entry
// as if it were a card, splitting the two words across two fields:
//
//   {"cardNumber":"Red",    "playerName":"Refractor", "parallel":"Base", ...}
//   {"cardNumber":"Orange", "playerName":"Refractor", "parallel":"Base", ...}
//   {"cardNumber":"Lava",   "playerName":"Refractor", "parallel":"Base", ...}
//
// There is no player, no card number, and no title anywhere in the document.
// These cannot be repaired into real cards because there is no card in them —
// they are the parallel list itself, transposed one row per colour.
//
// WHY THEY MATTER. They are not inert. The draft/chrome consolidation matches
// twins on "same player", and these rows made "Refractor" == "Refractor" look
// like a match, nearly merging two piles of debris and repointing real sales
// onto a slug no lookup will ever ask for.
//
// THE PREDICATE IS DELIBERATELY NARROW: BOTH cardNumber AND playerName must be
// hobby vocabulary. Requiring both is what protects real cards. A single-token
// playerName alone is NOT evidence — measured in bowman-chrome + bowman-draft:
//
//   11,184  "Refractor"      phantom
//    1,782  "(one-of-one)"   phantom
//      329  "Ichiro"         A REAL PLAYER, mononymous
//       18  "Jeter"          a real player, surname only
//
// Ichiro and Jeter carry a real cardNumber, so the both-fields rule spares them
// while catching every phantom.
//
// SALES. A row with sales attached is never deleted, only reported. Nine sales
// were found across seven of these rows; deleting underneath them would orphan
// real transactions, and where those nine belong is a separate question that
// deserves an answer rather than a cascade.
//
// DELETION, NOT SUPERSEDE. Every other repair in this family marks supersededBy
// and leaves the row. That is useless here: nothing in backend/src reads
// supersededBy, so a retired phantom still matches. Removal is the only thing
// that actually prevents recurrence — together with fixing the ingest that
// writes them.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/remove-parallel-list-phantoms.cjs
//     SETKEYS=bowman-chrome,bowman-draft   REQUIRED — no catalog-wide scan; an
//                                          unindexed full scan times out and a
//                                          timeout must not read as "none found"
//     APPLY=true                           perform the deletes
//     CONCURRENCY=8
const { CosmosClient } = require("@azure/cosmos");

const SETKEYS = String(process.env.SETKEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

const PRODUCT_TOKEN = new RegExp("^(" + [
  "base", "refractor", "refractors", "superfractor", "xfractor", "retrofractor", "atomic", "mojo",
  "prism", "prizm", "shimmer", "wave", "speckle", "sparkle", "lava", "magma", "scope", "choice",
  "ice", "disco", "negative", "ray", "aqua", "sepia", "gold", "orange", "red", "blue", "green",
  "teal", "cyan", "purple", "black", "yellow", "pink", "bronze", "silver", "platinum", "chrome",
  "white", "gray", "grey", "draft", "sapphire", "auto", "autograph", "autographs", "parallel",
  "insert", "mini", "canary", "fuchsia", "plate", "plates", "printingplate", "printingplates",
  "printing", "oneofone", "numbered", "diecut", "image", "variation", "short", "print", "asia",
  "mega", "box", "hta",
].join("|") + ")$");

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

/** True when every alphabetic token in the value is hobby vocabulary AND the
 *  value carries no digits. A real cardNumber almost always has a digit, and a
 *  real player never reads as a colour. */
function isProductWord(v) {
  const s = String(v === null || v === undefined ? "" : v).trim();
  if (!s) return false;
  if (/[0-9]/.test(s)) return false;
  const words = s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => PRODUCT_TOKEN.test(w));
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  if (!SETKEYS.length) {
    console.error("FATAL: SETKEYS is required. A catalog-wide scan times out, and a timeout must not be mistaken for a clean result.");
    process.exit(2);
  }

  // A delete on card_catalog is expensive — the container is broadly indexed,
  // so every removed row rewrites many index entries. It autoscales to 40,000
  // RU/s but the floor is a tenth of that, and ten concurrent deletes outran
  // the ramp and returned 429 before the SDK's default retry budget ran out.
  // Widen the budget and let the client wait rather than failing the run.
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: {
      retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 },
    },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");
  console.log(`mode: ${APPLY ? "APPLY — WILL DELETE CATALOG ROWS" : "report only"}   setKeys: ${SETKEYS.join(", ")}\n`);

  const ps = SETKEYS.map((s, i) => ({ name: `@k${i}`, value: s }));

  // TWO STEPS, BECAUSE THE ONE-STEP VERSION TAKES THE CONTAINER DOWN.
  // Pulling every row for these setKeys is 915,377 documents; it completed once
  // and then returned 429 on the retry, and it was the SCAN throttling, not the
  // deletes. A GROUP BY is answered server-side and comes back with distinct
  // values only, so step 1 costs a few hundred RU instead of tens of thousands.
  //
  // 1. distinct playerName values -> classify locally -> the junk ones
  // 2. fetch only rows carrying a junk playerName
  const { resources: names } = await cat.items.query({
    query: `SELECT c.playerName, COUNT(1) AS n FROM c
            WHERE c.setKey IN (${ps.map((p) => p.name).join(", ")})
              AND IS_DEFINED(c.playerName) AND c.playerName != null
            GROUP BY c.playerName`,
    parameters: ps,
  }).fetchAll();
  const junkNames = names.filter((x) => isProductWord(x.playerName)).map((x) => x.playerName);
  const junkRowCount = names.filter((x) => isProductWord(x.playerName)).reduce((a, b) => a + b.n, 0);
  console.log(`distinct playerName values            : ${names.length}`);
  console.log(`  of those, a product word            : ${junkNames.length}   covering ${junkRowCount} rows`);
  if (!junkNames.length) { console.log("no phantoms here."); return; }

  const rows = [];
  for (let i = 0; i < junkNames.length; i += 40) {
    const chunk = junkNames.slice(i, i + 40);
    const np = chunk.map((s, k) => ({ name: `@n${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id, c.cardId, c.cardNumber, c.playerName, c.parallel, c.setKey, c.year, c.source FROM c
              WHERE c.setKey IN (${ps.map((p) => p.name).join(", ")})
                AND c.playerName IN (${np.map((p) => p.name).join(", ")})`,
      parameters: [...ps, ...np],
    }).fetchAll();
    rows.push(...resources);
  }

  const phantoms = rows.filter((r) => isProductWord(r.cardNumber));
  const playerOnly = rows.filter((r) => !isProductWord(r.cardNumber));
  console.log(`rows fetched                          : ${rows.length}`);
  console.log(`phantoms (BOTH fields product words)  : ${phantoms.length}`);
  console.log(`playerName junk but cardNumber real   : ${playerOnly.length}   (left alone — repairable, not phantom)`);

  // Sales check. Never delete out from under a real transaction.
  // Batched AND concurrent. Serially this is ~570 cross-partition round trips
  // and blows a ten-minute budget; the container sits at a fraction of its RU
  // ceiling either way, so the cost is latency, not throughput.
  const ids = phantoms.map((r) => r.id);
  const withSales = new Set();
  const batches = [];
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
  let bi = 0;
  async function salesWorker() {
    for (;;) {
      const k = bi++;
      if (k >= batches.length) return;
      const qp = batches[k].map((s, n) => ({ name: `@s${n}`, value: s }));
      const { resources } = await sold.items.query({
        query: `SELECT c.hobbyiqCardId FROM c WHERE c.hobbyiqCardId IN (${qp.map((p) => p.name).join(", ")})`,
        parameters: qp,
      }).fetchAll();
      for (const x of resources) withSales.add(x.hobbyiqCardId);
    }
  }
  await Promise.all(Array.from({ length: 12 }, () => salesWorker()));
  const deletable = phantoms.filter((r) => !withSales.has(r.id));
  console.log(`  of those, HAVE sales attached       : ${withSales.size}   (kept — deleting would orphan real sales)`);
  console.log(`  deletable                           : ${deletable.length}`);

  console.log("\nsample of what would be deleted:");
  for (const r of deletable.slice(0, 8)) {
    console.log(`   #${String(r.cardNumber).padEnd(14)} player=${JSON.stringify(r.playerName).padEnd(16)} ${String(r.id).slice(4, 62)}`);
  }
  console.log("\nsample of what the both-fields rule SPARES:");
  for (const r of playerOnly.slice(0, 6)) {
    console.log(`   #${String(r.cardNumber).padEnd(14)} player=${JSON.stringify(r.playerName)}`);
  }

  if (!APPLY) {
    console.log("\nReport only — nothing deleted. Re-run with APPLY=true.");
    return;
  }

  let gone = 0, failed = 0, unaddressable = 0, cursor = 0, throttled = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= deletable.length) return;
      const r = deletable[i];
      if (typeof r.cardId !== "string" || !r.cardId) { unaddressable++; continue; }
      // Retry throttling here as well as in the SDK, and never let it escape:
      // a worker that throws rejects the Promise.all and abandons the run
      // mid-way, which is how the first attempt died having deleted nothing.
      let attempt = 0;
      for (;;) {
        try {
          await cat.item(r.id, r.cardId).delete();
          gone++;
          if (gone % 1000 === 0) process.stdout.write(`  ...${gone}/${deletable.length}\n`);
          break;
        } catch (e) {
          if (e && e.code === 404) { gone++; break; }
          if (e && (e.code === 429 || e.code === 503) && attempt < 8) {
            attempt++;
            throttled++;
            await new Promise((res) => setTimeout(res, Math.min(8000, 250 * 2 ** attempt)));
            continue;
          }
          failed++;
          if (failed <= 3) console.log(`  delete failed ${r.id}: ${e.code} ${e.message}`);
          break;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nDELETED: ${gone}   failed: ${failed}   unaddressable: ${unaddressable}   throttle-retries: ${throttled}`);
  if (failed) process.exit(4);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
