#!/usr/bin/env node
// CF-PROBE-BLOCKED-TITLES (Drew, 2026-08-14).
//
// probeBlockedSet showed blocked slugs under hiq:baseball:2025:topps that are
// plainly not baseball — "pf-universe-wwe-jake-the", "pf-uefa-competitions-...",
// "pf-jofra-archer-the-hundred" (cricket), and a cardNumber "097100" in the
// Pokemon zero-pad+printedTotal convention. If that reading is right, these are
// not missing checklists at all: they are the vertical default writing
// non-baseball sales into the baseball namespace, where no catalog lookup can
// ever match them.
//
// This prints the RAW vendor title beside the computed slug so the claim is
// checked against source data rather than inferred from the slug text.
//
//   node scripts/probeBlockedTitles.cjs --set hiq:baseball:2025:topps --n 30

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SET = val("--set", "hiq:baseball:2025:topps");
const N = Number(val("--n", "30"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const staging = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq").container("comps_staging");

// Words that prove the sale is NOT the vertical its slug claims. Deliberately
// conservative — these are unambiguous product/competition names, not guesses.
const FOREIGN = [
  ["soccer", /\b(uefa|champions league|premier league|la liga|barcelona|real madrid|arsenal|liverpool|man utd|manchester|chelsea|mls|fifa|world cup|bundesliga|serie a|ligue 1)\b/i],
  ["wwe", /\b(wwe|wrestlemania|aew|nxt|smackdown|raw)\b/i],
  ["cricket", /\b(the hundred|ipl|cricket|big bash)\b/i],
  ["f1", /\b(formula 1|formula one|\bf1\b|grand prix)\b/i],
  ["ufc", /\b(ufc|mma|bellator)\b/i],
  ["pokemon", /\b(pokemon|pok[eé]mon|charizard|pikachu)\b/i],
  ["basketball", /\b(nba|basketball)\b/i],
  ["football", /\b(nfl|football)\b/i],
  ["hockey", /\b(nhl|hockey)\b/i],
];

(async () => {
  const claimed = SET.split(":")[1];
  console.log(`raw titles behind blocked ${SET}  (slug claims vertical="${claimed}")\n`);

  const { resources } = await staging.items.query({
    query: `SELECT TOP @n c.hobbyiqCardId AS slug, c.raw.vendorPayload.title AS title, c.raw.identityHint AS hint
            FROM c
            WHERE c.status = 'awaiting-catalog' AND STARTSWITH(c.hobbyiqCardId, @p)
            ORDER BY c.hobbyiqCardId`,
    parameters: [{ name: "@p", value: `${SET}:` }, { name: "@n", value: N }],
  }).fetchAll();

  let foreign = 0;
  for (const r of resources) {
    const t = String(r.title ?? "");
    const hit = FOREIGN.find(([v, re]) => v !== claimed && re.test(t));
    if (hit) foreign++;
    console.log(`${hit ? `MIS-VERTICAL -> ${hit[0]}` : "ok            "}  ${t.slice(0, 96)}`);
    console.log(`                  ${r.slug}`);
  }
  console.log(`\n${foreign}/${resources.length} sampled titles name a vertical other than "${claimed}".`);
  console.log("NOTE: sample is ORDER BY slug, so it is a slice of the set, not a random draw.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
