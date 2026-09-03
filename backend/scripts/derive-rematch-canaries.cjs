#!/usr/bin/env node
/**
 * derive-rematch-canaries.cjs -- give EVERY shard a canary pool. READ ONLY.
 *
 * CF-A-CANARY-PER-SHARD (audit gate, 2026-09-03). The canary gate is per-shard
 * by construction -- MODE=before, apply that ONE shard, MODE=after -- but the
 * seven hand-verified canaries live in seven shards (5, 6, 9, 10, 16, 25, 30).
 * The other 25 shards, slot 29 among them (the 30/30-wrong 1990 Bowman Tiffany
 * shard), had NOTHING that could regress: their gate measured pools that their
 * apply could not touch and passed by construction.
 *
 * A canary is a hand-verified pool. We cannot mint Drew's hand verification,
 * so this script derives the next best evidence the pool actually carries:
 * pools anchored by a PROVENANCE-PROTECTED row.
 *
 *   drew-ruling*      a Drew ruling names the card
 *   verifiedByUser    a person confirmed this sale is this card
 *   ebay-user-*       a real person's own transaction, their own record
 *   manual-user-entry likewise
 *
 * Those rows are report-only forever, so a rematch may never re-key them -- but
 * the POOL they sit in is exactly what a rematch moves rows into and out of,
 * and a protected row is the strongest statement in the pool about which card
 * these sales belong to. A pool with a protected anchor that LOSES rows during
 * an apply has moved sales away from a card a human vouched for. That is the
 * regression the gate exists to catch, and it is now catchable in all 32.
 *
 * These canaries are labelled `derivedFrom: "provenance"` and carry the
 * protected row's id and reason, so nothing here is ever mistaken for one of
 * Drew's seven. The floor rule is the same for both: poolRows is a FLOOR
 * measured at capture, never an equality assertion -- ingest adds sales.
 *
 *   COSMOS_CONNECTION_STRING   required
 *   OUT                        default backend/data/rematch-canaries.json
 *   PER_SHARD                  canaries to derive per shard (default 1)
 *   DRY_RUN=true               print, do not write the file
 *
 * Writes NOTHING to Cosmos. The only write is the committed JSON file.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const K = require(path.join(__dirname, "lib", "rematch-classify.cjs"));
const RM = require(path.join(__dirname, "rematch-sold-comps.cjs"));

const OUT = String(process.env.OUT || path.join(__dirname, "..", "data", "rematch-canaries.json"));
const PER_SHARD = Math.max(1, Number(process.env.PER_SHARD || 1));
const DRY_RUN = process.env.DRY_RUN === "true";
const SHARD_TABLE = RM.SHARD_TABLE;
const SLOTS = SHARD_TABLE.slots.length;

const f = (n) => Number(n ?? 0).toLocaleString();
const hashPartOf = (id, parts) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % parts;
const retry = async (fn, tries = 8) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const msg = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

/** Which slot does this row belong to? The SAME predicate the fleet uses --
 *  imported, not re-implemented, so a canary can never be filed in a shard the
 *  runner would not apply it under. */
function slotOf(row) {
  for (let s = 0; s < SLOTS; s++) {
    if (RM.rowInSlot(row, RM.unitsForSlot(s, SHARD_TABLE))) return s;
  }
  return null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const client = new CosmosClient(conn);
  const pool = client.database("hobbyiq").container("sold_comps");

  console.log(`derive-rematch-canaries  READ ONLY  ${SLOTS} shards  ${PER_SHARD}/shard  out ${OUT}`);

  // Every provenance-protected row in the pool. This is a SMALL population --
  // ~160 user-sourced, ~53 relocations, ~800 verified measured 2026-09-01 --
  // so it is read whole rather than sampled, and the query is an indexed
  // equality/IN, never a scan on a computed predicate.
  const q = {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.source, c.cardYear, c.sport,
                   c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun,
                   c.gradeCompany, c.gradeValue, c.verifiedByUser, c.rekeyedReason,
                   c.relocatedReason, c.drewRuling, c.handRelocated, c.d31Relocated, c.provenance
            FROM c
            WHERE c.source IN (@s1, @s2, @s3, @s4) OR c.verifiedByUser = true
               OR IS_DEFINED(c.drewRuling) OR IS_DEFINED(c.handRelocated) OR IS_DEFINED(c.d31Relocated)`,
    parameters: [
      { name: "@s1", value: "ebay-user-purchase" }, { name: "@s2", value: "ebay-user-sale" },
      { name: "@s3", value: "ebay-account" }, { name: "@s4", value: "manual-user-entry" },
    ],
  };

  const it = pool.items.query(q, { maxItemCount: 500 });
  const bySlot = new Map();          // slot -> Map(slug -> {rows, anchor})
  let seen = 0, protectedRows = 0, noSlot = 0;
  while (it.hasMoreResults()) {
    const page = await retry(() => it.fetchNext());
    for (const row of page.resources ?? []) {
      seen++;
      const prov = K.provenanceTier(row);
      if (prov.tier !== K.PROTECTED) continue;    // the classifier decides, not the query
      protectedRows++;
      const slot = slotOf(row);
      if (slot === null) { noSlot++; continue; }
      const slug = String(row.hobbyiqCardId || row.cardId || "");
      if (!slug.startsWith("hiq:")) continue;     // a vendor bubble id is not a pool
      if (!bySlot.has(slot)) bySlot.set(slot, new Map());
      const m = bySlot.get(slot);
      if (!m.has(slug)) m.set(slug, { slug, anchors: [], slot });
      m.get(slug).anchors.push({ id: row.id, cardId: row.cardId, source: row.source ?? null, reasons: prov.reasons, title: String(row.title ?? "").slice(0, 120) });
    }
  }
  console.log(`  scanned ${f(seen)} candidate rows -> ${f(protectedRows)} provenance-protected, ${f(noSlot)} matched no slot`);
  console.log(`  shards with a protected pool: ${bySlot.size} of ${SLOTS}`);

  // Pick, per shard, the pools with the MOST protected anchors -- the strongest
  // statement the pool carries about which card its sales are.
  const picked = [];
  for (let s = 0; s < SLOTS; s++) {
    const m = bySlot.get(s);
    if (!m) continue;
    const ranked = [...m.values()].sort((a, b) => b.anchors.length - a.anchors.length);
    for (const p of ranked.slice(0, PER_SHARD)) picked.push(p);
  }

  // THE SHARDS WITH NO PROTECTED ROW STILL NEED A CANARY.
  //
  // Slots 0 and 7 are Pokemon-dominant (2025 and 2024 Pokemon, 484,940 and
  // 444,613 rows) plus a vintage year, and no user holds a card in them -- so
  // the provenance tier has nothing to anchor on. A shard with no canary is
  // the exact hole this script exists to close, and "there was no protected
  // row" is not a reason to leave it open.
  //
  // The fallback is the shard's LARGEST pool: it is not a human's verification,
  // and it is labelled `derivedFrom: "largest-pool"` so nobody mistakes it for
  // one. What it still buys is the assertion that matters most -- a large,
  // well-populated pool must not LOSE rows to an apply. A rematch that moves
  // hundreds of sales off the biggest pool in a shard has done damage whatever
  // its banner says, and without this the gate could not see it.
  const uncoveredSlots = [];
  for (let s = 0; s < SLOTS; s++) if (!bySlot.has(s)) uncoveredSlots.push(s);
  if (uncoveredSlots.length) {
    console.log(`\n  ${uncoveredSlots.length} shard(s) hold no provenance-protected row: ${uncoveredSlots.join(", ")}`);
    console.log(`  falling back to the largest pool in each -- labelled derivedFrom="largest-pool", never confused with a verified one.`);
    for (const s of uncoveredSlots) {
      const units = RM.unitsForSlot(s, SHARD_TABLE);
      const q2 = RM.slotQuery(units, []);
      if (!q2) { console.log(`    slot ${s}: no query -- skipped`); continue; }
      // Rank the shard's pools by row count. Cosmos rejects TOP + ORDER BY on a
      // GROUP BY aggregate, so the grouping is paged and ranked here -- the
      // WHERE is still the slot's own indexed year/sport predicate, so this
      // reads the shard's own slice and never the pool.
      const gq = pool.items.query({
        query: `SELECT c.cardId AS slug, COUNT(1) AS n FROM c WHERE ${q2.query.replace(/^SELECT \* FROM c WHERE /, "")} GROUP BY c.cardId`,
        parameters: q2.parameters,
      }, { maxItemCount: 1000 });
      let best = null;
      while (gq.hasMoreResults()) {
        const page = await retry(() => gq.fetchNext());
        for (const r of page.resources ?? []) {
          const slug = String(r.slug ?? "");
          if (!slug.startsWith("hiq:")) continue;    // a vendor bubble id is not a pool
          // A pool whose slug carries `unknown` is the one pool a rematch is
          // SUPPOSED to move -- an unknown setKey is a blank the census exists
          // to fill, so a canary built on it would fail the gate for doing the
          // right thing. Skip it: a canary must be a pool that should not move.
          if (/:unknown:/.test(slug) || slug.includes(":unknown")) continue;
          // The hash axis is applied on read for hash-sharded units, so a pool
          // is only this slot's if the rows really land here. The pool-level
          // pick is coarse; the union count below is what the gate measures.
          if (!best || Number(r.n) > best.n) best = { slug, n: Number(r.n) };
        }
      }
      if (!best) { console.log(`    slot ${s}: no hiq-slugged pool found -- STILL UNCOVERED`); continue; }
      picked.push({ slug: best.slug, slot: s, anchors: [], fallback: "largest-pool", groupCount: best.n });
      console.log(`    slot ${s}: largest pool ${best.slug} (${f(best.n)} rows in partition)`);
    }
  }

  // Measure each picked pool the way rematch-canary-check does: the UNION of
  // the slug's own partition and the rows that merely CARRY it. Reading one
  // field would see a healthy pool vanish and call it unchanged.
  console.log(`\n  measuring ${picked.length} derived pools (union of cardId partition + hobbyiqCardId field)...`);
  const derived = [];
  for (const p of picked) {
    const c1 = (await retry(() => pool.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.cardId = @s", parameters: [{ name: "@s", value: p.slug }] }).fetchAll())).resources[0] ?? 0;
    const c2 = (await retry(() => pool.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s AND c.cardId != @s", parameters: [{ name: "@s", value: p.slug }] }).fetchAll())).resources[0] ?? 0;
    const rows = Number(c1) + Number(c2);
    const fromProvenance = p.anchors.length > 0;
    const reasons = [...new Set(p.anchors.flatMap((x) => x.reasons))];
    derived.push({
      name: `[derived] slot ${p.slot} ${p.slug.split(":").slice(2, 6).join(" ")}`,
      slug: p.slug,
      shardSlot: p.slot,
      poolRows: rows,
      verifiedMarketDirection: "exact-pool",
      derivedFrom: fromProvenance ? "provenance" : "largest-pool",
      protectedAnchors: p.anchors.length,
      protectedAnchorReasons: reasons,
      anchorRowId: fromProvenance ? p.anchors[0].id : null,
      note: fromProvenance
        ? `Derived canary (2026-09-03), not one of Drew's hand-verified seven. This pool is anchored by ${p.anchors.length} provenance-protected row(s) -- ${reasons.join(", ")} -- which a rematch may never re-key. The pool losing rows during slot ${p.slot}'s apply means sales moved away from a card a person vouched for. poolRows ${rows} is a FLOOR measured at capture (${c1} in the slug partition + ${c2} carrying it), never an equality assertion.`
        : `Derived canary (2026-09-03), FALLBACK tier: slot ${p.slot} holds no provenance-protected row at all (Pokemon-dominant shard, no user holdings), so there is no human verification to anchor on. This is simply the LARGEST pool in the shard, and the assertion it carries is the one that still matters -- a pool this size must not LOSE rows to an apply. Not a verified market direction; never to be quoted as one. poolRows ${rows} is a FLOOR measured at capture (${c1} in the slug partition + ${c2} carrying it).`,
      protectedIdentity: fromProvenance,
    });
    console.log(`    slot ${String(p.slot).padStart(2)}  rows ${String(rows).padStart(6)}  anchors ${String(p.anchors.length).padStart(3)}  ${fromProvenance ? "prov " : "LARGE"}  ${p.slug}`);
  }

  // Merge with the existing file: Drew's seven are NEVER touched or reordered.
  const existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const hand = (existing.canaries ?? []).filter((c) => c.derivedFrom !== "provenance");
  const handSlugs = new Set(hand.map((c) => c.slug));
  const fresh = derived.filter((c) => !handSlugs.has(c.slug));

  // Which shard does each of Drew's seven live in? Stamped, not guessed -- the
  // gate has to be able to say "this shard has a canary" without re-deriving.
  for (const c of hand) {
    if (c.shardSlot !== undefined && c.shardSlot !== null) continue;
    const anchor = (await retry(() => pool.items.query({ query: "SELECT TOP 1 c.id, c.cardYear, c.sport FROM c WHERE c.cardId = @s OR c.hobbyiqCardId = @s", parameters: [{ name: "@s", value: c.slug }] }).fetchAll())).resources[0];
    c.shardSlot = anchor ? slotOf(anchor) : null;
  }

  const covered = new Set([...hand, ...fresh].map((c) => c.shardSlot).filter((s) => s !== null && s !== undefined));
  const out = {
    ...existing,
    _derivedCanaries: "CF-A-CANARY-PER-SHARD (2026-09-03). The gate is per-shard, so a shard with no canary passes by construction -- 25 of 32 did, slot 29 among them. Entries with derivedFrom='provenance' are DERIVED, not hand-verified: each is a pool anchored by rows a person's own transaction, a Drew ruling or a verification placed there, which the rematch may never re-key. They are a floor on damage, never a substitute for Drew's seven.",
    _shardCoverage: { of: SLOTS, covered: covered.size, uncovered: Array.from({ length: SLOTS }, (_, i) => i).filter((i) => !covered.has(i)) },
    _derivedAt: new Date().toISOString().slice(0, 10),
    canaries: [...hand, ...fresh],
  };

  console.log(`\n  hand-verified ${hand.length} + derived ${fresh.length} = ${out.canaries.length} canaries`);
  console.log(`  shard coverage ${covered.size}/${SLOTS}${out._shardCoverage.uncovered.length ? `  UNCOVERED: ${out._shardCoverage.uncovered.join(",")}` : "  (every shard has a canary)"}`);
  if (DRY_RUN) { console.log("\nDRY_RUN -- file not written."); return; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n  wrote ${OUT}`);
}

if (require.main === module) main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
