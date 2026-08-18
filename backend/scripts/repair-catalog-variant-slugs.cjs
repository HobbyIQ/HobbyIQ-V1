#!/usr/bin/env node
/**
 * CF-CATALOG-VARIANT-SLUG-ROOT (Drew, 2026-08-18).
 *
 * Stops the source of malformed slugs in sold_comps.
 *
 * WHY THIS IS THE ROOT AND THE COMP REPAIR IS NOT. persistVendorSalesToPool
 * calls adoptResolvedSlug(), which REBINDS a comp's slug to the catalog's
 * canonical form. So a bad slug in card_catalog is not one bad row — it is
 * stamped onto every comp that matches it, forever. repair-malformed-slugs
 * cleaned 8,962 comps and 143 came back within hours, one written the same
 * afternoon. Cleaning comps without this is mopping under a running tap.
 *
 * WHAT THESE 71 ROWS ARE. All source="ingest-auto-seed", and all three of
 * id / cardId / hobbyiqCardId carry a `variant::` prefix that should never
 * have reached a slug. Each one's slug segment also CONTRADICTS the row's own
 * setKey field:
 *
 *   slug topps          vs  setKey topps-archives
 *   slug bowman-chrome  vs  setKey bowman-chrome-mega-box
 *   slug bowman-chrome  vs  setKey bowman-chrome-sapphire
 *
 * so they do not merely look wrong, they name a different product than the row
 * describes. Many also have year=undefined and junk playerNames ("Disney
 * Embarrassment Inside Out", "Stefon Diggs Black").
 *
 * WHY NULL RATHER THAN RECOMPUTE OR DELETE.
 *   Recompute is not possible: year is undefined on most of them, and a slug
 *   without a year cannot be canonical.
 *   Delete is not mine to choose: card_catalog is the moat, and removing rows
 *   is a bigger, less reversible call than neutralising them. Nulling
 *   hobbyiqCardId means adoptResolvedSlug has nothing to adopt, which stops
 *   the propagation immediately and reversibly.
 * The rows are left in place, flagged, for a deletion decision.
 *
 * hobbyiqCardIdBefore records the original, so this is reversible.
 *
 * NOTE ON PARTITION KEY: card_catalog partitions on /cardId. These rows all
 * have a defined cardId (equal to their malformed id), so they patch normally
 * — unlike the pre-cardId catalog rows, which need the empty-object key.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-catalog-variant-slugs.cjs [--apply]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[repair-catalog-variant-slugs] mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  const { resources } = await cat.items.query(
    `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setKey, c.source, c.playerName
       FROM c WHERE STARTSWITH(c.hobbyiqCardId, "variant::")`,
  ).fetchAll();

  console.log(`found ${resources.length} catalog rows with a variant:: slug`);
  let contradict = 0;
  for (const r of resources) {
    const seg = String(r.hobbyiqCardId).replace(/^variant::/, "").split(":")[3] ?? "";
    if (r.setKey && seg && r.setKey !== seg) contradict++;
  }
  console.log(`  of those, ${contradict} have a slug setKey that contradicts their own setKey field\n`);

  let done = 0, failed = 0;
  for (const r of resources) {
    if (!APPLY) { done++; continue; }
    try {
      await cat.item(r.id, r.cardId).patch([
        { op: "add", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
        { op: "set", path: "/hobbyiqCardId", value: null },
        { op: "add", path: "/flaggedReason", value: "variant-prefix-auto-seed" },
      ]);
      done++;
    } catch (e) {
      failed++;
      if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 100)}`);
    }
  }

  console.log(`neutralised=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  else console.log("adoptResolvedSlug now has nothing to adopt from these rows.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
