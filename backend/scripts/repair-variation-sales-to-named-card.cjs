#!/usr/bin/env node
/**
 * CF-A-VARIATION-SALE-BELONGS-TO-THE-NAMED-CARD (Drew, 2026-09-01: "move them").
 *
 * A 2018 Bowman Chrome Rookie Image Variation is its own card, named for the
 * photo ("Carrying Bag"). The sales were never keyed that way, so they pooled
 * with the ordinary base card and priced it:
 *
 *     $47,000  "Autographs #1 Shohei Ohtani, Carrying Bag Signed (#02/25)"
 *     $38,000  "Carrying Bag Variation Shohei Ohtani #1 PSA 10"      parallel=Base
 *     $20,051  "Rookie Variation Bag Over Shoulder #1 PSA 10"        parallel=Base
 *
 * against a base pool of 2,437 rows whose median is $1,676.
 *
 * DREW'S RULINGS, 2026-09-01:
 *   1. The auto is the SAME named card with isAuto=true, not a separate name.
 *      The /25 auto ($6,000-$57,500) and the raw variation ($8-$45,140) are
 *      separated by the auto flag, exactly as the checklist's 13 auto rows are.
 *   2. The variation WINS but the finish is KEPT: a refractor variation is
 *      "Carrying Bag Image Variation Refractor SP". Nothing is discarded.
 *
 * MATCHING IS EVIDENCE-BASED, NOT KEYWORD-GREEDY. A sale must either name the
 * photo (the descriptor or a known market alias) or say "variation" outright.
 * The descriptor alone is enough because 8 of the 15 cards never appear with
 * Beckett's wording in a title, and "variation" alone is enough because most
 * sellers write only that. A title that says neither is left alone.
 *
 * ONE CARD AT A TIME. --card-number is required; there is no all-cards mode.
 * Re-keying five-figure comps is not something to do in a sweep.
 *
 * REVERSIBLE via /hobbyiqCardIdBefore and /parallelBefore.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-variation-sales-to-named-card.cjs \
 *     --card-number=1 [--apply]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { normalizeParallel } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const CARD = arg("card-number", "");

// number -> [player, canonical photo name, market alias phrases]
const CARDS = {
  "1":  ["Shohei Ohtani",   "Carrying Bag",   ["carrying bag", "bag over shoulder", "with bag", "shoulder bag"]],
  "8":  ["Rafael Devers",   "With Bat",       ["with bat", "swinging bat"]],
  "11": ["Amed Rosario",    "Hand On Waist",  ["hand on waist"]],
  "21": ["Clint Frazier",   "Wearing Shorts", ["wearing shorts"]],
  "25": ["Rhys Hoskins",    "Wearing Cap",    ["wearing cap"]],
  "33": ["Francisco Mejia", "Catchers Gear",  ["catchers gear", "catcher's gear", "catching gear"]],
  "35": ["Nick Williams",   "Gray Jersey",    ["gray jersey", "grey jersey"]],
  "44": ["Dominic Smith",   "With Ball",      ["with ball"]],
  "47": ["Alex Verdugo",    "Facing Forward", ["facing forward"]],
  "52": ["Victor Robles",   "White Shirt",    ["white shirt"]],
  "65": ["J.P. Crawford",   "Running",        ["white pinstripe", "running"]],
  "68": ["Harrison Bader",  "Arms Raised",    ["arms raised"]],
  "72": ["Jack Flaherty",   "Batting",        ["batting"]],
  "87": ["Austin Hays",     "No Helmet",      ["no helmet", "no cap"]],
  "92": ["Ozzie Albies",    "Warm Up Shirt",  ["warm up shirt", "warmup shirt"]],
};

const SAYS_VARIATION = /\b(image\s+variation|photo\s+variation|rookie\s+variation|variation)\b/i;
// Finishes worth preserving beside the variation name (ruling 2).
const FINISHES = [
  [/\bsuperfractor\b/i, "Superfractor"],
  [/\bx-?fractor\b/i, "X-Fractor"],
  [/\b(orange)\s+refractor\b/i, "Orange Refractor"],
  [/\b(purple)\s+refractor\b/i, "Purple Refractor"],
  [/\b(green)\s+refractor\b/i, "Green Refractor"],
  [/\b(blue)\s+refractor\b/i, "Blue Refractor"],
  [/\b(gold)\s+refractor\b/i, "Gold Refractor"],
  [/\b(red)\s+refractor\b/i, "Red Refractor"],
  [/\brefractor\b/i, "Refractor"],
];

function finishOf(title, storedParallel) {
  const hay = `${title || ""} ${storedParallel || ""}`;
  for (const [re, label] of FINISHES) if (re.test(hay)) return label;
  return null;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!CARDS[CARD]) {
    console.error(`FATAL: --card-number must be one of: ${Object.keys(CARDS).join(", ")}`);
    process.exit(2);
  }
  const [player, name, aliases] = CARDS[CARD];

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");

  console.log(`[repair-variation-sales] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  card: 2018 Bowman Chrome #${CARD} ${player} — "${name}"\n`);

  const { resources: rows } = await sold.items.query({
    query: `SELECT c.id, c.cardId, c.title, c.parallel, c.price, c.isAuto, c.printRun,
                   c.hobbyiqCardId, c.gradeCompany, c.gradeValue
            FROM c WHERE c.cardYear=2018 AND c.cardNumber=@n
              AND CONTAINS(c.hobbyiqCardId ?? '', ':bowman-chrome:')`,
    parameters: [{ name: "@n", value: CARD }],
  }, { enableCrossPartitionQuery: true }).fetchAll();

  const plan = [];
  for (const r of rows) {
    const t = String(r.title || "").toLowerCase();
    const namesPhoto = aliases.some((a) => t.includes(a));
    if (!namesPhoto && !SAYS_VARIATION.test(t)) continue;
    // Already on a named variation slug? nothing to do.
    if (/image-variation|photo-variation/.test(String(r.hobbyiqCardId || ""))) continue;

    // Ruling 1: auto is the flag, not a different name. Trust the title over a
    // stored isAuto that disagrees — one row says isAuto=false on a card whose
    // title reads "Signed Rookie Card (#14/25)".
    const isAuto = /\bauto(graph)?s?\b|\bsigned\b/i.test(t) || r.isAuto === true;
    // Ruling 2: variation wins, finish is kept.
    const finish = finishOf(r.title, r.parallel);
    const parallel = `${name} Image Variation${finish ? ` ${finish}` : ""} SP`;
    const parSlug = normalizeParallel(parallel);
    // The print run comes from the TITLE when the stored field is empty. Three
    // of the six Ohtani autos carry printRun=null while their titles read
    // "Auto /25" — keying on the stored field alone would split one /25 card
    // into two pools ($57,500/$10,000/$6,000 apart from $47,000/$30,000/
    // $19,250), which is the split-pool defect this repair exists to close.
    // Only a serial of the "/N" or "#nn/N" form counts; a bare number in a
    // title is not a print run (CF: a print run is not a count of cards).
    let run = Number(r.printRun);
    if (!Number.isFinite(run) || run <= 0) {
      const m = String(r.title || "").match(/(?:^|[\s(#])#?\d{0,4}\s*\/\s*(\d{1,4})\b/);
      if (m) run = Number(m[1]);
    }
    const runPart = Number.isFinite(run) && run > 0 ? `:num-${run}` : "";
    const slug = `hiq:baseball:2018:bowman-chrome:${CARD}:${parSlug}:${isAuto ? "auto" : "no-auto"}${runPart}`;
    if (slug === r.hobbyiqCardId) continue;
    const recoveredRun = (!Number.isFinite(Number(r.printRun)) || Number(r.printRun) <= 0)
      && Number.isFinite(run) && run > 0 ? run : null;
    plan.push({ r, slug, parallel, isAuto, recoveredRun });
  }

  console.log(`${plan.length} sales to move\n`);
  const groups = new Map();
  for (const p of plan) groups.set(p.slug, (groups.get(p.slug) || 0) + 1);
  console.log("destination slugs:");
  for (const [s, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${s}`);

  console.log("\nevery move:");
  for (const p of plan.sort((a, b) => (Number(b.r.price) || 0) - (Number(a.r.price) || 0))) {
    console.log(`  $${String(p.r.price).padEnd(10)} ${p.r.gradeCompany || "raw"}${p.r.gradeValue || ""}`);
    console.log(`     "${String(p.r.title).slice(0, 92)}"`);
    console.log(`     from ${p.r.hobbyiqCardId}`);
    console.log(`     to   ${p.slug}`);
  }

  if (!APPLY) { console.log(`\n(dry-run; would move ${plan.length})`); return; }

  let ok = 0, failed = 0;
  for (const p of plan) {
    const ops = [
      { op: "set", path: "/hobbyiqCardId", value: p.slug },
      { op: "set", path: "/parallel", value: p.parallel },
      { op: "set", path: "/isAuto", value: p.isAuto },
      { op: p.r.hobbyiqCardIdBefore === undefined ? "add" : "set", path: "/hobbyiqCardIdBefore", value: p.r.hobbyiqCardId },
      { op: p.r.parallelBefore === undefined ? "add" : "set", path: "/parallelBefore", value: p.r.parallel ?? null },
    ];
    // Persist a print run recovered from the title, so the row itself is right
    // and not merely its slug.
    if (p.recoveredRun) ops.push({ op: p.r.printRun === undefined ? "add" : "set", path: "/printRun", value: p.recoveredRun });
    try { await sold.item(p.r.id, p.r.cardId).patch(ops); ok++; }
    catch (e) { failed++; if (failed <= 5) console.error(`  FAILED ${p.r.id}: ${String(e.message).slice(0, 140)}`); }
  }
  console.log(`\n[done] moved=${ok} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
