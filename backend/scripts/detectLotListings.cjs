#!/usr/bin/env node
// CF-LOT-LISTINGS-ARE-NOT-SALES (Drew, 2026-08-14: "these should be removed and
// deleted").
//
// Some listings are not a sale of one card. They surface in the blocked pile
// wearing a single-card slug:
//
//   "1990 Star Co. NBA Basketball Isiah Thomas 9 Card Silver Set NM-MT /2000"
//   "#005 - 4 Box- Break #KH414 - 2025 TOPPS CACTUS JACK + Signature Class"
//   "#022 - Random Player IGOR808 - 8x 2025/26 TOPPS CHROME UPDATE JUMBO"
//
// The first is a NINE-CARD set priced as one. The others are BREAK SLOTS — you
// are buying a random outcome, not a card — and the "#005" is the slot number,
// which the parser reads as a card number.
//
// This is a PRICING defect, not merely a matching one. A box-break slot or a
// 9-card lot landing in a single card's comp pool moves that card's FMV to a
// number no one ever paid for it. Unlike the blocked rows, these can reach
// sold_comps, because a lot title can match a real card by accident.
//
// PRECISION OVER RECALL. Deleting a real single-card sale is worse than keeping
// a lot, so every pattern below names the lot structure explicitly. Deliberately
// NOT used as signals:
//   "set"    — "Topps Set", "Update Set" are product names
//   "lot"    — appears in "Lot 5" auction-house numbering on single cards
//   "break"  — "Breakout", "Record Breakers" are insert names
// Each requires an accompanying quantity or slot structure.
//
//   node scripts/detectLotListings.cjs
//   node scripts/detectLotListings.cjs --container sold_comps

const path = require("node:path");
const { CosmosClient } = require(path.join(__dirname, "..", "node_modules/@azure/cosmos"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CONTAINER = val("--container", "comps_staging");
const LIMIT = Number(val("--limit", "20000"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const c = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq").container(CONTAINER);

/** Each pattern names a lot STRUCTURE, never a single suggestive word. */
const LOT_PATTERNS = [
  [/\b\d{1,3}\s*[- ]?card\s+(?:set|lot|pack)\b/i, "N-card set/lot"],
  [/\blot\s+of\s+\d+/i, "lot of N"],
  [/\b\d{1,3}\s*(?:ct|count)\s+lot\b/i, "N-count lot"],
  [/\b\d{1,2}\s*box\b[^.]{0,24}\bbreak\b/i, "N-box break"],
  [/\bbox\s*-?\s*break\b/i, "box break"],
  [/\bcase\s*-?\s*break\b/i, "case break"],
  [/\bmega\s+break\b/i, "mega break"],
  [/\brandom\s+(?:player|team|hit|spot)\b/i, "random slot"],
  [/\bpick\s+(?:your|a|the)\s+(?:card|player|slot)\b/i, "pick-your-card"],
  [/\brepack\b/i, "repack"],
  [/\bmystery\s+(?:box|pack|card)\b/i, "mystery"],
  [/\b\d{1,2}x\s+\d{4}/i, "Nx <year> multi-quantity"],
];

function classify(title) {
  for (const [re, label] of LOT_PATTERNS) if (re.test(title)) return label;
  return null;
}

(async () => {
  console.log(`lot-listing detection over ${CONTAINER} (read-only)\n`);
  const titleField = CONTAINER === "sold_comps" ? "c.title" : "c.raw.vendorPayload.title";
  const { resources } = await c.items.query({
    query: `SELECT TOP ${LIMIT} c.id, ${titleField} AS t,
                   ${CONTAINER === "sold_comps" ? "c.cardId" : "c.hobbyiqCardId"} AS slug,
                   ${CONTAINER === "sold_comps" ? "c.price" : "c.price"} AS price
            FROM c ORDER BY c.id`,
  }).fetchAll();

  let n = 0, lots = 0;
  const byLabel = {}, examples = [];
  let lotPriceSum = 0, normalPriceSum = 0, normalN = 0;
  for (const r of resources) {
    const t = String(r.t ?? "");
    if (!t) continue;
    n++;
    const label = classify(t);
    if (label) {
      lots++;
      byLabel[label] = (byLabel[label] ?? 0) + 1;
      lotPriceSum += Number(r.price ?? 0);
      if (examples.length < 12) examples.push(`$${String(r.price ?? "?").padStart(8)}  [${label}]  ${t.slice(0, 68)}`);
    } else {
      normalPriceSum += Number(r.price ?? 0); normalN++;
    }
  }

  console.log(`rows with a title : ${n.toLocaleString()}`);
  console.log(`detected as LOTS  : ${lots.toLocaleString()} (${(100 * lots / Math.max(n, 1)).toFixed(2)}%)`);
  console.log(`by pattern        : ${JSON.stringify(byLabel)}`);
  if (lots && normalN) {
    console.log(`\nmean price  lots: $${(lotPriceSum / lots).toFixed(2)}   single cards: $${(normalPriceSum / normalN).toFixed(2)}`);
    console.log("(a large gap is the pricing harm — lot prices dragging real card pools)");
  }
  console.log("\nexamples:");
  for (const e of examples) console.log(`  ${e}`);
  console.log(`\nREAD-ONLY. Nothing was modified. Sample is ORDER BY id — a slice, not a random draw.`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
