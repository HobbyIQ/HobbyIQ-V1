#!/usr/bin/env node
/**
 * CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD (Drew, 2026-09-01: "I am missing a lot
 * of sales").
 *
 * Topps Tiffany is a separate factory set — the same card list on glossy stock,
 * ~30,000 sets against tens of millions of base. Its sales were keyed to the
 * PLAIN base slug, so the two cards share one pool:
 *
 *     1987 topps #320 (Barry Bonds RC), base pool of 6,193
 *       Tiffany  n=1040  $2    .. $6,600  median $140
 *       plain    n=5153  $0.05 .. $1,900  median $6
 *
 * A 23x median gap. $4,700-$6,600 Tiffany cards price the ordinary base card,
 * and $0.05 base sales drag Tiffany's FMV down. FMV projects the next sale from
 * a pool's trend, so one pool cannot serve both.
 *
 * Measured 2026-09-01: 2,474 Tiffany-titled sales across 144 plain 1987 topps
 * base slugs.
 *
 * WHY IT IS SAFE NOW AND WAS NOT BEFORE. Until the checklist landed, 1987
 * topps-tiffany covered 77 of 792 card numbers, so most of these sales had no
 * Tiffany card to move TO — re-keying would have produced orphans. The
 * checklist ingest closed that (792/792), and this script REFUSES to move a
 * sale whose destination has no catalog row.
 *
 * MATCHING IS ON THE TITLE, and only the title. A sale is Tiffany when its own
 * title says so; the stored parallel is not consulted, because these rows carry
 * parallel="Base" — that is the defect, not the evidence.
 *
 * NOT TOUCHED: a title naming Tiffany AND a finish/parallel we do not model
 * here, and multi-card lots. Both are left for a human.
 *
 * REVERSIBLE via /hobbyiqCardIdBefore and /setKeyBefore.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-tiffany-sales-to-tiffany-setkey.cjs \
 *     --year=1987 --from=topps --to=topps-tiffany [--expect=2474] [--apply]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const YEAR = Number(arg("year", "0"));
const FROM = arg("from", "");
const TO = arg("to", "");
const EXPECT = arg("expect", "");

// "1987 Topps Tiffany ..." — the word has to be there. Guard against the
// handful of titles where Tiffany is a person's name rather than the product.
const SAYS_TIFFANY = /\btiffany\b/i;
const IS_LOT = /\b(lot|lots|set|complete set|\d+\s*cards?)\b/i;

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!YEAR || !FROM || !TO) {
    console.error("FATAL: --year, --from and --to are required; this script refuses whole-container scope.");
    process.exit(2);
  }

  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`[repair-tiffany-sales] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  ${YEAR}  ${FROM} -> ${TO}\n`);

  const { resources: rows } = await sold.items.query({
    query: `SELECT c.id, c.cardId, c.title, c.price, c.parallel, c.cardNumber,
                   c.hobbyiqCardId, c.gradeCompany, c.gradeValue, c.isAuto
            FROM c WHERE c.cardYear = @y AND CONTAINS(c.hobbyiqCardId ?? '', @seg)`,
    parameters: [{ name: "@y", value: YEAR }, { name: "@seg", value: `:${FROM}:` }],
  }, { enableCrossPartitionQuery: true }).fetchAll();

  // Destination catalog rows, so a move can never invent a card.
  const { resources: catRows } = await cat.items.query({
    query: `SELECT c.cardNumber FROM c WHERE c.setKey = @sk AND c.cardYear = @y`,
    parameters: [{ name: "@sk", value: TO }, { name: "@y", value: YEAR }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const known = new Set(catRows.map((r) => String(r.cardNumber).toUpperCase()));
  console.log(`  destination catalog covers ${known.size} card numbers`);

  const plan = [];
  const skipped = { notTiffany: 0, lot: 0, noCard: 0, alreadyThere: 0 };
  for (const r of rows) {
    const t = String(r.title || "");
    if (!SAYS_TIFFANY.test(t)) { skipped.notTiffany++; continue; }
    if (IS_LOT.test(t)) { skipped.lot++; continue; }
    if (String(r.hobbyiqCardId || "").includes(`:${TO}:`)) { skipped.alreadyThere++; continue; }
    const num = String(r.cardNumber || "").toUpperCase();
    if (!num || !known.has(num)) { skipped.noCard++; continue; }
    let slug = String(r.hobbyiqCardId).replace(`:${FROM}:`, `:${TO}:`);
    if (slug === r.hobbyiqCardId) { skipped.noCard++; continue; }

    // ONCE THE SETKEY IS topps-tiffany, "Tiffany" IS NO LONGER A PARALLEL —
    // it is the product, already stated one segment earlier. These sales are
    // split between parallel="Base" (2,473) and parallel="Tiffany" (1,079) for
    // the same card, so carrying the segment across would land #366 on BOTH
    // topps-tiffany:366:base AND topps-tiffany:366:tiffany: one card, two
    // pools, which is the very defect this repair exists to close.
    //
    // Only the bare Tiffany spellings collapse. A parallel that says anything
    // MORE than Tiffany is left alone — it is a finish we are not qualified to
    // discard here.
    const par = String(r.parallel ?? "").trim();
    const bareTiffany = /^(tiffany|limited edition\s*\(?tiffany\)?)$/i.test(par);
    let newParallel = null;
    if (bareTiffany) {
      slug = slug.replace(/:tiffany:/, ":base:");
      newParallel = "Base";
    }
    plan.push({ r, slug, newParallel });
  }

  console.log(`  candidates scanned: ${rows.length}`);
  console.log(`  TO MOVE: ${plan.length}`);
  console.log(`  skipped — not tiffany: ${skipped.notTiffany}, lot: ${skipped.lot}, no destination card: ${skipped.noCard}, already there: ${skipped.alreadyThere}`);

  if (EXPECT !== "" && plan.length !== Number(EXPECT)) {
    console.error(`\nFATAL: expected ${EXPECT}, planned ${plan.length}. Refusing.`);
    process.exit(3);
  }
  if (!plan.length) { console.log("nothing to do."); return; }

  const byDest = new Map();
  for (const p of plan) byDest.set(p.slug, (byDest.get(p.slug) || 0) + 1);
  console.log(`\n  ${byDest.size} destination slugs; biggest:`);
  for (const [s, n] of [...byDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(n).padStart(4)}  ${s}`);
  }
  console.log("\n  most valuable moves:");
  for (const p of [...plan].sort((a, b) => (Number(b.r.price) || 0) - (Number(a.r.price) || 0)).slice(0, 6)) {
    console.log(`    $${String(p.r.price).padEnd(9)} ${p.r.gradeCompany || "raw"}${p.r.gradeValue || ""}  "${String(p.r.title).slice(0, 68)}"`);
  }

  if (!APPLY) { console.log(`\n(dry-run; would move ${plan.length})`); return; }

  let ok = 0, failed = 0;
  for (const p of plan) {
    const ops = [
      { op: "set", path: "/hobbyiqCardId", value: p.slug },
      { op: p.r.hobbyiqCardIdBefore === undefined ? "add" : "set", path: "/hobbyiqCardIdBefore", value: p.r.hobbyiqCardId },
      { op: p.r.setKeyBefore === undefined ? "add" : "set", path: "/setKeyBefore", value: FROM },
      { op: "set", path: "/setKey", value: TO },
    ];
    if (p.newParallel) {
      ops.push({ op: p.r.parallelBefore === undefined ? "add" : "set", path: "/parallelBefore", value: p.r.parallel ?? null });
      ops.push({ op: "set", path: "/parallel", value: p.newParallel });
    }
    try { await sold.item(p.r.id, p.r.cardId).patch(ops); ok++; }
    catch (e) { failed++; if (failed <= 5) console.error(`  FAILED ${p.r.id}: ${String(e.message).slice(0, 130)}`); }
  }
  console.log(`\n[done] moved=${ok} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
