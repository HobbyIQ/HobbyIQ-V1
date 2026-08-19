#!/usr/bin/env node
/**
 * CF-MULTIHOME-SLUGS (Drew, 2026-08-18: "now check for ALL cards in bowman and
 * bowman chrome and bowman paper that we may have slugged in multiple places").
 *
 * Finds ONE physical card whose sales are scattered across more than one
 * setKey, so no single search can see all its comps.
 *
 * WHY IT MATTERS. This is the defect that priced a gold CPA-MG auto at $6.90
 * against $187 paid. The comps existed — 226 rows on `bowman`, 27 on
 * `bowman-chrome` — but a card rooted at one key cannot see the other, so the
 * $51 gold-refractor sale was invisible to the card that needed it. Splitting a
 * pool does not lose data; it makes the data unreachable, which prices the same.
 *
 * THE IDENTITY. Two rows are the same card when sport, year, card number and
 * PLAYER agree. setKey is exactly what is in dispute, so it is deliberately not
 * part of the key.
 *
 * COMPARING PLAYERS IS THE WHOLE TRICK. Comp playerName is dirty — the same
 * player arrives as "eric hartman", "autos eric hartman", "eric hartman green
 * grass", "eric hartman bjst". A first cut compared each key's FULL SET of name
 * variants and concluded 86 of 88 CPA- numbers were genuinely two different
 * sets. That was backwards: comparing each key's DOMINANT core name instead
 * showed 80 of 88 are the same player, mis-keyed. So names are reduced to their
 * core (noise words stripped, first two alpha tokens) and only the DOMINANT
 * core per setKey is compared.
 *
 * SAME-PLAYER IS A CANDIDATE, NOT A VERDICT. Read this before merging anything.
 *
 * The obvious reading — "same player on both keys means one card, mis-keyed" —
 * is WRONG, and the first version of this script asserted it. Bowman ships
 * parallel product lines that deliberately reuse the player AND the number:
 *
 *   2025 #17 "shohei ohtani"   bowman 667 | bowman-chrome 890
 *                              bowman-chrome-mega-box 192 | ...-sapphire 112
 *
 * Those are four REAL cards. Sapphire has its own checklist and its own price.
 * Merging them would not repair a split — it would flatten a $500 Sapphire into
 * a $5 paper base and destroy the distinction permanently.
 *
 * The 2026 CPA- merge was safe for a reason that does NOT generalise: 2026
 * Bowman Chrome had not released, so those rows could not be a second product.
 *
 * So the output is three tiers, and only the first is ever actionable:
 *   COLLISION  different players share a number -> never merge
 *   CANDIDATE  same player on >1 key -> MIGHT be one card; must be confirmed
 *              against the TARGET checklist before any write
 *
 * The confirming question is always: does the target setKey's checklist
 * actually contain this number for this player? If both checklists list it,
 * they are two cards and the pool is correctly split.
 *
 * READ-ONLY, and deliberately so. The write is reslug-setkey-segment's job,
 * one reviewed mapping at a time. Direction comes from the CHECKLIST, never
 * from which side had more rows — the majority side is frequently wrong.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-multihome-slugs.cjs \
 *     [--family=bowman] [--sport=baseball] [--minRows=3] [--top=60]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const FAMILY = arg("family", "bowman");
const SPORT = arg("sport", "baseball");
const MIN_ROWS = Number(arg("minRows", "3"));
const TOP = Number(arg("top", "60"));

/** Words that ride along in a comp's playerName but are not part of the name:
 *  parallels, products, grading and marketplace noise. */
const NOISE = new Set([
  "au", "auto", "autos", "autograph", "autographs", "on", "card", "true", "mini", "rc", "rookie",
  "gold", "blue", "green", "orange", "yellow", "aqua", "purple", "pink", "red", "black", "white",
  "silver", "teal", "bronze", "lava", "ice", "sepia", "magenta", "fuchsia", "lime", "indigo", "rose",
  "refractor", "refractors", "xfractor", "fractor", "prizm", "shimmer", "speckle", "reptilian",
  "mojo", "wave", "atomic", "sapphire", "superfractor", "packfractor", "diamonds", "grass",
  "redemption", "redeemed", "sealed", "stud", "rare", "color", "colour", "match", "first", "1st",
  "choice", "hta", "sn", "qi", "qty", "os", "nb", "bjst", "bjby", "gpf", "psa", "bgs", "sgc",
  "graded", "raw", "lot", "the", "of", "and", "new", "mint", "gem",
]);

const core = (s) => {
  const t = String(s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 1 && !NOISE.has(w));
  return t.slice(0, 2).join(" ");
};

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[audit-multihome] family=${FAMILY} sport=${SPORT} minRows=${MIN_ROWS}\n`);

  // Every setKey in the family: `bowman`, `bowman-chrome`, `bowman-paper`,
  // `bowman-draft`, `bowman-chrome-sapphire`, ... Matching on the slug segment
  // keeps unrelated keys that merely contain the word out.
  const iter = sold.items.query({
    query: `SELECT c.hobbyiqCardId, c.playerName, c.price FROM c
             WHERE STARTSWITH(c.hobbyiqCardId, @p) AND CONTAINS(c.hobbyiqCardId, @f)`,
    parameters: [{ name: "@p", value: `hiq:${SPORT}:` }, { name: "@f", value: `:${FAMILY}` }],
  }, { maxItemCount: 2000 });

  // (year, number) -> setKey -> core name -> count
  const idx = new Map();
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      const p = String(r.hobbyiqCardId).split(":");
      if (p.length < 7) continue;
      const [, , year, setKey, num] = p;
      if (!setKey.startsWith(FAMILY)) continue;   // `:bowman` must not match `topps-bowman`
      if (!num) continue;
      scanned++;
      const key = `${year}|${num}`;
      let byKey = idx.get(key);
      if (!byKey) idx.set(key, (byKey = new Map()));
      let names = byKey.get(setKey);
      if (!names) byKey.set(setKey, (names = new Map()));
      const c = core(r.playerName);
      if (c) names.set(c, (names.get(c) ?? 0) + 1);
    }
    if (scanned % 250000 < 2000) process.stderr.write(`\r  scanned=${scanned} keys=${idx.size}   `);
  }
  process.stderr.write("\n");

  const candidates = [], collisions = [];
  for (const [key, byKey] of idx) {
    if (byKey.size < 2) continue;
    // Dominant core name per setKey, plus how many rows that key holds.
    const dom = [];
    for (const [setKey, names] of byKey) {
      const rows = [...names.values()].reduce((s, n) => s + n, 0);
      if (rows < MIN_ROWS) continue;
      const top = [...names.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) dom.push({ setKey, name: top[0], rows });
    }
    if (dom.length < 2) continue;
    const [year, num] = key.split("|");
    const entry = { year, num, dom, total: dom.reduce((s, d) => s + d.rows, 0) };
    if (new Set(dom.map((d) => d.name)).size === 1) candidates.push(entry);
    else collisions.push(entry);
  }
  candidates.sort((a, b) => b.total - a.total);
  collisions.sort((a, b) => b.total - a.total);

  // Which PAIRS of keys keep splitting? That is the actionable unit — a merge
  // is authored per key pair, not per card.
  const pairs = new Map();
  for (const s of candidates) {
    const keys = s.dom.map((d) => d.setKey).sort();
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const k = `${keys[i]}  <->  ${keys[j]}`;
        let agg = pairs.get(k);
        if (!agg) pairs.set(k, (agg = { cards: 0, rows: 0, years: new Set() }));
        agg.cards++; agg.rows += s.total; agg.years.add(s.year);
      }
    }
  }

  console.log(`scanned=${scanned.toLocaleString()} distinct (year, number) = ${idx.size.toLocaleString()}\n`);
  console.log(`CANDIDATE same player on >1 setKey (UNCONFIRMED): ${candidates.length.toLocaleString()} cards`);
  console.log(`COLLISION different players share a number   : ${collisions.length.toLocaleString()} cards\n`);

  console.log("── key pairs to merge, by cards affected ──");
  for (const [k, v] of [...pairs.entries()].sort((a, b) => b.cards - a.cards).slice(0, TOP)) {
    const ys = [...v.years].sort();
    console.log(`  ${String(v.cards).padStart(5)} cards  ${String(v.rows).padStart(7)} comps   ${k}`);
    console.log(`         years ${ys[0]}${ys.length > 1 ? `..${ys[ys.length - 1]}` : ""} (${ys.length})`);
  }

  console.log("\n── worst individual splits ──");
  for (const s of candidates.slice(0, 15)) {
    console.log(`  ${s.year} #${s.num}  "${s.dom[0].name}"  ${s.total} comps`);
    for (const d of s.dom) console.log(`       ${String(d.rows).padStart(6)}  ${d.setKey}`);
  }

  console.log("\n── COLLISIONS: do NOT merge these ──");
  for (const c of collisions.slice(0, 15)) {
    console.log(`  ${c.year} #${c.num}  ${c.dom.map((d) => `${d.setKey}="${d.name}"(${d.rows})`).join("  |  ")}`);
  }

  console.log("\nREAD-ONLY. Merge direction comes from the CHECKLIST, not row counts.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
