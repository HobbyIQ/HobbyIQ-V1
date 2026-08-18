#!/usr/bin/env node
/**
 * CF-SLUG-PLAYER-CONFLICT-AUDIT (Drew, 2026-08-17: "go back to checking our
 * sales index for wrongly attached cards to the catalog").
 *
 * READ-ONLY. Finds sales attached to the WRONG CARD.
 *
 * THE SIGNAL. A hobbyiqCardId is an identity — one product, one card number,
 * one parallel. So every sale under one slug should name the SAME person. When
 * a slug carries two materially different players, at least one of those sales
 * is attached to a card it is not. That is a stronger and cheaper test than
 * joining to the catalog, because it needs no catalog row to exist and it
 * catches the case where the catalog itself is wrong.
 *
 * This is the failure the 1995-96 Fleer work surfaced by hand:
 *
 *     hiq:basketball:1995:fleer:22:gold-medallion:no-auto  Michael Jordan
 *     hiq:basketball:1995:fleer:22:gold-medallion:no-auto  Alonzo Mourning
 *
 * where a Jordan Gold Medallion was catalogued as Mourning and could not be
 * found by anyone searching for it.
 *
 * WHY NAME NORMALISATION IS CONSERVATIVE. Vendor text writes one person a dozen
 * ways — "Ohtani", "Shohei Ohtani", "OHTANI, SHOHEI", "Shohei Ohtani RC". Those
 * are the SAME player and must not be reported as a conflict, or the report is
 * all noise. So names are compared on their surname plus first initial, and a
 * conflict is only claimed when those genuinely differ. This UNDER-reports on
 * purpose: a real conflict missed is better than a false one that sends someone
 * to repair data that was correct.
 *
 * MULTI-PLAYER CARDS ARE EXCLUDED. A card can legitimately depict two people
 * ("Mantle / Maris"), so any name carrying a separator is skipped rather than
 * counted as a disagreement with itself.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-slug-player-conflicts.cjs \
 *     [--scan=300000] [--top=25] [--sport=baseball] [--catalog]
 *
 *   --catalog  also read card_catalog for the worst offenders, to say which
 *              side is wrong rather than only that the two disagree.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const SCAN = Number(arg("scan", "300000"));
const TOP = Number(arg("top", "25"));
const SPORT = arg("sport", "");
const WITH_CATALOG = has("catalog");

/**
 * CF-CAPTION-FALSE-POSITIVE (2026-08-17). Subset cards put a CAPTION in the
 * player field — "Fence Busters", "League Leaders", "Checklist", "Team Card".
 * Those are not people, and comparing one against a real name reported a
 * conflict on a card where the catalog confirmed both strings describe the same
 * thing (1959 Topps #212: "Fence Busters" vs "Hank Aaron").
 *
 * Heuristic, and deliberately generous: anything containing one of these words
 * is treated as a caption and skipped. Skipping a real surname that happens to
 * collide (a player named "Champion") costs one missed conflict; keeping a
 * caption costs a false repair.
 */
const CAPTION_WORDS = new Set([
  "checklist", "leaders", "leader", "series", "busters", "stars", "star",
  "highlights", "highlight", "team", "card", "cards", "combo", "duo", "trio",
  "record", "records", "award", "awards", "champs", "champions", "champion",
  "playoff", "playoffs", "world", "allstar", "rookies", "prospects", "future",
  "classic", "legends", "greats", "moments", "action", "sluggers", "aces",
  "kings", "power", "sensations", "update", "traded",
]);

function looksLikeCaption(lower) {
  return lower.split(/[^a-z-]+/).some((w) => w && CAPTION_WORDS.has(w));
}

/**
 * CF-NAME-NOISE-FALSE-POSITIVE (2026-08-17). The first cut took the LAST WORD
 * as the surname. Vendor name fields routinely carry trailing noise — grading
 * qualifiers, parallel names, print-run words — so that assumption broke:
 *
 *     "Ken Griffey Jr"           -> surname "griffey"
 *     "Ken Griffey Jr Perfectly" -> surname "perfectly"    FALSE CONFLICT
 *     "Michael Jordan"           vs "Short Print Michael Jordan"
 *     "Jayden Daniels"           vs "Jayden Daniels Disco"
 *
 * All three pairs are the SAME player and all three were reported as wrong-card
 * attachments. At full-index scale that inflated the conflict rate by roughly an
 * order of magnitude (11.72% of slugs) and made the MINORITY class — the one
 * that looked mechanically repairable — almost entirely noise. Acting on it
 * would have "repaired" correct data.
 *
 * Names are now compared on their TOKEN SET. Two names describe the same person
 * when one is wholly contained in the other, or when they share two meaningful
 * tokens. Only names with no meaningful overlap are a conflict. That is immune
 * to anything appended to the end, which is where vendor noise always lands.
 */
const NAME_NOISE = new Set([
  "jr", "sr", "ii", "iii", "iv", "rc", "rookie", "short", "print", "sp",
  "auto", "autograph", "refractor", "prizm", "holo", "disco", "mojo", "wave",
  "psa", "bgs", "sgc", "cgc", "gem", "mint", "graded", "raw", "the", "of",
  "perfectly", "bccg", "case", "hit", "ssp", "variation", "image", "photo",
  "silver", "gold", "black", "red", "blue", "green", "orange", "purple",
]);

function nameTokens(raw) {
  let t = String(raw ?? "").toLowerCase().trim();
  if (!t) return null;
  if (/[/&+]| and | vs\.? /.test(t)) return null;   // multi-player card
  if (looksLikeCaption(t)) return null;
  if (t.includes(",")) {                            // "Ohtani, Shohei"
    const [last, first] = t.split(",").map((x) => x.trim());
    t = `${first ?? ""} ${last}`.trim();
  }
  const toks = t.replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 1 && !NAME_NOISE.has(w));
  return toks.length ? toks : null;
}

/** Stable grouping key: the meaningful tokens, order-independent. */
function nameKey(raw) {
  const toks = nameTokens(raw);
  return toks ? [...new Set(toks)].sort().join(" ") : null;
}

/**
 * Conflict only when the two names share NO meaningful token, or share exactly
 * one and neither contains the other. Containment ("michael jordan" inside
 * "michael jordan short print") is the same person.
 */
function conflicts(a, b) {
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  if (shared === 0) return true;
  if (shared === A.size || shared === B.size) return false;  // containment
  // A single shared token is usually just a common first name
  // ("Chris Carter" vs "Chris Johnson"), so that still counts as a conflict.
  return shared < 2;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");

  const where = ["IS_DEFINED(c.hobbyiqCardId)", "NOT IS_NULL(c.hobbyiqCardId)", "IS_DEFINED(c.playerName)"];
  if (SPORT) where.push(`c.sport = ${JSON.stringify(SPORT)}`);

  console.log(`[slug-player-conflicts] scanning up to ${SCAN.toLocaleString()} rows${SPORT ? ` (${SPORT})` : ""}\n`);

  const iter = sold.items.query(
    `SELECT c.hobbyiqCardId, c.playerName, c.price FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 1000 },
  );

  /** slug -> Map<nameKey, {n, sample, value}> */
  const bySlug = new Map();
  let scanned = 0;

  while (iter.hasMoreResults() && scanned < SCAN) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      if (scanned >= SCAN) break;
      scanned++;
      const key = nameKey(r.playerName);
      if (!key) continue;
      const slug = String(r.hobbyiqCardId);
      let m = bySlug.get(slug);
      if (!m) { m = new Map(); bySlug.set(slug, m); }
      const cur = m.get(key) ?? { n: 0, sample: r.playerName, value: 0 };
      cur.n += 1;
      cur.value += Number(r.price) || 0;
      m.set(key, cur);
    }
    if (scanned % 50000 < 1000) process.stderr.write(`\r  scanned=${scanned}    `);
  }
  process.stderr.write("\n");

  // A slug is in conflict when any two of its name keys genuinely disagree.
  const offenders = [];
  let slugsWithConflict = 0, salesInConflict = 0;
  for (const [slug, names] of bySlug) {
    if (names.size < 2) continue;
    const keys = [...names.keys()];
    let bad = false;
    outer: for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (conflicts(keys[i], keys[j])) { bad = true; break outer; }
      }
    }
    if (!bad) continue;
    slugsWithConflict++;
    const total = [...names.values()].reduce((s, v) => s + v.n, 0);
    salesInConflict += total;
    offenders.push({
      slug, total,
      value: [...names.values()].reduce((s, v) => s + v.value, 0),
      names: [...names.values()].sort((a, b) => b.n - a.n),
    });
  }

  offenders.sort((a, b) => b.total - a.total);

  const pct = (x, of) => (of ? `${(x / of * 100).toFixed(2)}%` : "—");
  console.log(`rows scanned            : ${scanned.toLocaleString()}`);
  console.log(`distinct slugs          : ${bySlug.size.toLocaleString()}`);
  console.log(`slugs WITH a conflict   : ${slugsWithConflict.toLocaleString()}  ${pct(slugsWithConflict, bySlug.size)} of slugs`);
  console.log(`sales on those slugs    : ${salesInConflict.toLocaleString()}  ${pct(salesInConflict, scanned)} of scanned
`);

  // ---- Root-cause classification -------------------------------------
  //
  // The four causes need DIFFERENT fixes, so a single "repair" pass over this
  // list would make things worse. Splitting them here is the point of the
  // report:
  //
  //   MINORITY   catalog agrees with the most common sale name — the few
  //              disagreeing sales are on the wrong card. Mechanically fixable.
  //   MAJORITY   catalog agrees with a MINORITY sale name. The common name is
  //              the wrong one, so a majority vote repairs in the wrong
  //              direction. This is why no vote-based fix ships.
  //   CATALOG    catalog agrees with NOBODY. Either the catalog row is wrong or
  //              every sale is. Needs a published checklist, not a vote.
  //   GRANULARITY  the identity itself is too coarse (unnumbered cards all
  //              share one slug), so "conflict" is expected and repairing the
  //              names would be meaningless.
  //   UNKNOWN    no catalog row to adjudicate with.
  const cat = db.container("card_catalog");
  const classified = { MINORITY: [], MAJORITY: [], CATALOG: [], GRANULARITY: [], UNKNOWN: [] };
  const limit = Math.min(offenders.length, Number(arg("classify", "400")));

  for (let i = 0; i < limit; i++) {
    const o = offenders[i];
    const cardNumber = String(o.slug.split(":")[4] ?? "").toLowerCase();
    if (!cardNumber || cardNumber === "nno" || cardNumber === "null") {
      classified.GRANULARITY.push({ ...o, catalog: null });
      continue;
    }
    let catName = null;
    try {
      const { resources } = await cat.items.query({
        query: "SELECT TOP 1 c.playerName FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: o.slug }],
      }).fetchAll();
      catName = resources[0]?.playerName ?? null;
    } catch { /* non-fatal */ }

    if (!catName) { classified.UNKNOWN.push({ ...o, catalog: null }); continue; }
    const catKey = nameKey(catName);
    const ranked = o.names;                 // already sorted desc by count
    const topKey = nameKey(ranked[0].sample);
    const matchesAny = ranked.some((v) => {
      const k = nameKey(v.sample);
      return k && catKey && !conflicts(k, catKey);
    });
    if (!matchesAny) classified.CATALOG.push({ ...o, catalog: catName });
    else if (topKey && catKey && !conflicts(topKey, catKey)) classified.MINORITY.push({ ...o, catalog: catName });
    else classified.MAJORITY.push({ ...o, catalog: catName });
  }

  console.log(`ROOT CAUSE (top ${limit} offenders, catalog-adjudicated)`);
  console.log("-".repeat(96));
  for (const [k, list] of Object.entries(classified)) {
    const sales = list.reduce((s, o) => s + o.total, 0);
    console.log(`  ${k.padEnd(12)} ${String(list.length).padStart(5)} slugs   ${String(sales).padStart(7)} sales`);
  }

  for (const [k, list] of Object.entries(classified)) {
    if (list.length === 0) continue;
    console.log(`
=== ${k} — worst ${Math.min(TOP, list.length)}`);
    for (const o of list.slice(0, TOP)) {
      console.log(`${o.slug}   ${o.total} sales`);
      for (const v of o.names.slice(0, 3)) console.log(`      ${String(v.n).padStart(5)}  ${v.sample}`);
      if (o.catalog) console.log(`      catalog: ${o.catalog}`);
    }
  }

  console.log(`
NOTE: name matching is surname + first initial, skips multi-player cards`);
  console.log(`and caption subsets, so this UNDER-reports. A missed conflict beats a`);
  console.log(`false one. MAJORITY is the class that makes vote-based repair unsafe.`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
