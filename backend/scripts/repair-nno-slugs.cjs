#!/usr/bin/env node
/**
 * CF-NNO-IS-NOT-A-CARD-NUMBER (Drew, 2026-08-18).
 *
 * Nulls the slug on every row whose cardNumber segment is `nno`, so those sales
 * stop sharing one identity.
 *
 * `nno` means "no number" — an ABSENCE. slugGuard refused "", "null" and
 * "undefined" but not `nno`, so it passed as though it were a real card number
 * and every unnumbered card in a set collapsed onto ONE slug:
 *
 *   304 players, 3,650 sales, $3.95 .. $10,675    1909 t206 nno
 *   274 players, 3,493 sales, $0.94 .. $655,960   1993 tcg-other leb nno
 *   395 players, 1,865 sales, $3.49 .. $103,700   1909 unknown nno
 *
 * 50,989 rows sat on a `:nno:` slug; 637 of those slugs pooled two or more
 * players, covering 47,061 sales. A pool spanning $0.94 to $655,960 cannot
 * price anything. Same defect as the Topps Traded Tiffany case — one pool,
 * several cards — but with hundreds of cards rather than two.
 *
 * WHY ALL OF THEM, NOT JUST THE MULTI-PLAYER ONES. ~870 nno slugs currently
 * hold a single player and look harmless. They are not: the guard now REFUSES
 * to mint an nno slug, so a freshly ingested copy of one of those sales gets no
 * slug while the stored row keeps one. That divergence between repaired and
 * fresh rows is the "one rule, two implementations" failure this codebase keeps
 * hitting. A single-player nno pool is also one bad ingest away from becoming a
 * multi-player one, silently.
 *
 * The rows keep every field, so a future slug format that can express an
 * unnumbered card re-keys them through the normal backfill. Until then an
 * ABSENT identity is strictly better than a shared wrong one.
 *
 * hobbyiqCardIdBefore records the original, so this is reversible.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-nno-slugs.cjs \
 *     [--apply] [--pool=8] [--top=15]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "15"));

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[repair-nno-slugs] mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}\n`);

  const { resources } = await sold.items.query(
    `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.price
       FROM c WHERE CONTAINS(c.hobbyiqCardId, ":nno:")`,
  ).fetchAll();

  // Confirm the segment really is the cardNumber, not a setKey that contains
  // "nno" — CONTAINS is a coarse filter and must not decide the repair.
  const work = resources.filter((r) => String(r.hobbyiqCardId).split(":")[4] === "nno");
  const skipped = resources.length - work.length;

  const bySlug = new Map();
  for (const r of work) {
    let g = bySlug.get(r.hobbyiqCardId);
    if (!g) bySlug.set(r.hobbyiqCardId, (g = { n: 0, players: new Set(), lo: Infinity, hi: -Infinity }));
    g.n++;
    const nm = String(r.playerName ?? "").trim().toLowerCase();
    if (nm) g.players.add(nm);
    const p = Number(r.price);
    if (Number.isFinite(p)) { g.lo = Math.min(g.lo, p); g.hi = Math.max(g.hi, p); }
  }
  const multi = [...bySlug.values()].filter((g) => g.players.size > 1);

  console.log(`rows on a :nno: slug        : ${work.length.toLocaleString()}${skipped ? `  (${skipped} skipped — "nno" was not the cardNumber segment)` : ""}`);
  console.log(`distinct :nno: slugs        : ${bySlug.size.toLocaleString()}`);
  console.log(`  pooling 2+ players        : ${multi.length.toLocaleString()}  covering ${multi.reduce((s, g) => s + g.n, 0).toLocaleString()} sales`);
  console.log(`  single-player (also nulled, see header): ${(bySlug.size - multi.length).toLocaleString()}\n`);
  console.log("worst pools being dissolved:");
  for (const [slug, g] of [...bySlug.entries()].sort((a, b) => b[1].players.size - a[1].players.size).slice(0, TOP)) {
    console.log(`  ${String(g.players.size).padStart(4)} players, ${String(g.n).padStart(5)} sales, $${g.lo}..$${g.hi}   ${slug}`);
  }

  let done = 0, failed = 0, cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const r = work[cursor++];
      if (!APPLY) { done++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch([
          { op: "add", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
          { op: "set", path: "/hobbyiqCardId", value: null },
        ]);
        done++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 90)}`);
      }
    }
  }));

  console.log(`\nrows=${work.length} nulled=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  else console.log("These sales now have NO identity rather than a shared wrong one.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
