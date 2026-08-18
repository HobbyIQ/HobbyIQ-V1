#!/usr/bin/env node
/**
 * CF-POKEMON-CROSS-VERTICAL (Drew, 2026-08-18: "should we do the pokemon?").
 *
 * Pokemon cards that were classified as a SPORT at ingest, and so carry a
 * sports slug: hiq:BASEBALL:2018:sm-ultra-prism:90156:base:no-auto.
 *
 * WHY A SWEEP CANNOT FIX THESE. The drift audit listed
 * `sm-ultra-prism -> ultra` as 289 movable rows. Running it would be actively
 * harmful: resolveSetKeyForSlug is GATED ON SPORT, so with a `baseball` slug
 * those rows resolve through the SPORTS vocabulary, where "Ultra Prism" hits
 * the Fleer `ultra` rule. The sweep would file a Pokemon card as a Fleer
 * basketball card -- worse than leaving it. The sport is the defect; the
 * setKey is only a symptom, and it cannot be re-derived correctly until the
 * sport is right.
 *
 * THE FIX: set sport=pokemon and NULL the slug, so the nightly backfill
 * re-derives it through the POKEMON branch -- POKEMON_SET_ALIASES and
 * JAPANESE_POKEMON_SET_ALIASES -- exactly as a fresh ingest would. We do not
 * hand-write the new slug here: that would be a second implementation of the
 * derivation, and this codebase has been bitten repeatedly by the same rule
 * living in two places.
 *
 * STRICT NOTATION, NOT KEYWORD CONTAINS. A first cut selected on
 * CONTAINS(setName,"prism") and swept up "Pacific Prism" (162 rows) -- a real
 * 1990s baseball/football product. Converting THAT to Pokemon would be the
 * mirror image of the bug being fixed. So membership is decided by the era
 * notations Pokemon actually uses, each anchored at the START of the setName:
 *
 *   pokemon anywhere            "2024 Pokemon Surging Sparks", "pokemon-swsh"
 *   SM -/: or SM Base Set       "SM - Cosmic Eclipse", "sm-ultra-prism"
 *   SWSH<n>:                    "SWSH08: Fusion Strike"
 *   XY -/:                      "XY - BREAKthrough"
 *   SV<n>: or sv-               "SV: Scarlet & Violet 151", "sv-prismatic-evolutions"
 *
 * "Pacific Prism" matches none of them, because none of those anchors appear
 * at its start. Bare tokens like "Base Set" are deliberately NOT included:
 * they collide across verticals and the doctrine is that an unchanged row
 * beats a confidently wrong one.
 *
 * TITLE IS NOT USED as evidence, though 1,107 rows have "pokemon" in the
 * title. Title is untrusted parser input; the same reasoning keeps the Ultra
 * sweep off rows whose setName says only "fleer".
 *
 * sportBefore and hobbyiqCardIdBefore record the originals.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-pokemon-cross-vertical.cjs \
 *     [--apply] [--pool=12] [--top=30]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const POOL = Math.max(1, Number(arg("pool", "12")));
const TOP = Number(arg("top", "30"));

/** Era notations Pokemon actually uses. Anchored so "Pacific Prism" cannot match. */
const POKEMON_NOTATION = [
  /pokemon/i,
  // The era prefix followed by a WORD BOUNDARY or a digit. The first cut
  // required a dash or colon ("SM - Cosmic Eclipse") and so rejected 443 rows
  // that are plainly Pokemon and merely use a space: "SM Promos", "XY Base
  // Set", "XY BREAKthrough", "SM Cosmic Eclipse", "SM12a", the Trainer Kits.
  //
  // Loosening is safe because these prefixes are Pokemon-specific era codes.
  // The sports products that begin with S or X do not start with these exact
  // tokens -- SP Authentic, SPx, Score, Select, Stadium Club, Studio, SkyBox,
  // Summit, Sweet Spot, Synergy, Sterling, Sapphire all fail \b after "sm"/"sv".
  // "Pacific Prism", the false positive that motivated strictness, does not
  // begin with any of them at all.
  /^sm\b/i, /^sm\d/i, /^sm-/i,
  /^swsh/i,
  /^xy\b/i, /^xy\d/i,
  /^sv\b/i, /^sv\d/i, /^sv-/i,
];
const isPokemonSetName = (s) => {
  const v = String(s ?? "").trim();
  if (!v) return false;
  return POKEMON_NOTATION.some((re) => re.test(v));
};

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[repair-pokemon-cross-vertical] mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // Loose server-side filter; isPokemonSetName makes the real decision, so a
  // generous fetch costs RU but cannot cause a wrong conversion.
  const iter = sold.items.query(
    `SELECT c.id, c.cardId, c.setName, c.sport, c.hobbyiqCardId FROM c
      WHERE NOT STARTSWITH(c.hobbyiqCardId, "hiq:pokemon:")
        AND (CONTAINS(LOWER(c.setName), "pokemon")
             OR STARTSWITH(c.setName, "SM") OR STARTSWITH(c.setName, "sm-")
             OR STARTSWITH(c.setName, "SWSH") OR STARTSWITH(c.setName, "swsh")
             OR STARTSWITH(c.setName, "XY") OR STARTSWITH(c.setName, "xy")
             OR STARTSWITH(c.setName, "SV") OR STARTSWITH(c.setName, "sv-"))`,
    { maxItemCount: 1000 },
  );

  const accepted = new Map(), rejected = new Map();
  const work = [];
  let scanned = 0;

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      scanned++;
      const name = r.setName ?? "";
      if (!isPokemonSetName(name)) { rejected.set(name, (rejected.get(name) || 0) + 1); continue; }
      accepted.set(name, (accepted.get(name) || 0) + 1);
      work.push(r);
    }
  }

  console.log(`fetched=${scanned}  accepted=${work.length}  rejected=${scanned - work.length}\n`);
  console.log("ACCEPTED — will become sport=pokemon, slug nulled for re-derive (top):");
  for (const [k, v] of [...accepted.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`   ${String(v).padStart(5)}  ${JSON.stringify(k)}`);
  }
  console.log("\nREJECTED — fetched by the loose filter, NOT Pokemon notation (top):");
  for (const [k, v] of [...rejected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${String(v).padStart(5)}  ${JSON.stringify(k)}`);
  }

  let done = 0, failed = 0, cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const r = work[cursor++];
      if (!APPLY) { done++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch([
          { op: "add", path: "/sportBefore", value: r.sport ?? null },
          { op: "add", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
          { op: "set", path: "/sport", value: "pokemon" },
          { op: "set", path: "/hobbyiqCardId", value: null },
        ]);
        done++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 90)}`);
      }
    }
  }));

  console.log(`\nfetched=${scanned} repaired=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  else console.log("Slugs nulled; the nightly backfill re-derives them through the Pokemon branch.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
