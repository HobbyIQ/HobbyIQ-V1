// Let the CATALOG say which set a card is in — not the vendor's product text.
//
// WHY THIS REPLACES THE ONE-OFFS. comp-quality/ now holds a sweep per product
// line: Tiffany, Topps Traded, Sapphire, Draft Picks & Prospects. Each decided
// the destination by reading the sale's own setName through normalizeSetKey.
// CF-CATALOG-AUTHORITY (Drew, 2026-08-20) says that is the wrong side of the
// question:
//
//     "consume CardHedge SALES, not CardHedge PRODUCT fields. A setKey, a
//      parallel and a card number are all product fields."
//
// A sale's setName records how a seller or a vendor types. It is evidence about
// the listing, not about the card. The card's set is a fact about a printed
// product, and the thing that transcribes printed products is a checklist.
//
// So: for each sale, ask card_catalog which setKey holds this (sport, year,
// cardNumber) — counting ONLY rows that may adjudicate. canAdjudicate() is the
// shared declaration; do not re-implement it. Its own header records five
// places that each rewrote this question differently, and one of those
// differences flipped 51 card-number prefixes from "repair" to "blocked".
//
// DERIVED ROWS ARE EXCLUDED AND THAT IS THE POINT. ingest-auto-seed,
// sold-comps-stub and catalog-explode rows are built FROM our own comps. Let
// them vote and a mis-slugged comp seeds a catalog row which then confirms the
// comp. PR #1149's title is that exact failure: "a self-seeded row was
// outranking a printed checklist."
//
// GUARDS, in the order they proved necessary elsewhere in this directory:
//   1. EXACTLY ONE adjudicating setKey. Two checklists claiming one card number
//      is a real ambiguity — report it, never guess.
//   2. IT MUST DIFFER from where the sale already sits, or there is nothing to do.
//   3. THE DESTINATION ROW MUST EXIST at the full slug, not just the setKey.
//      Moving a sale to a set that lacks that exact parallel/grade identity
//      trades a wrong pool for an empty one.
//   4. SAME PLAYER, via the shared matcher. Products share card numbers, so a
//      set-key change can land a sale on somebody else's card.
//
// PERFORMANCE, learned the hard way today: card_catalog lookups by
// (sport, year, cardNumber) are CROSS-PARTITION. One query per card managed
// under 25 of 538 lookups in 71 minutes — the ~145k RU/s cost that
// resolveSetKey.service.ts warns about in its own header. Everything here is
// batched by (sport, year) with cardNumber IN (...), and resolutions are cached
// for the run.
//
// Report-only by default. Conditional patches, reversible markers.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/refile-by-catalog-authority.cjs
//     SETNAME=draft picks     restrict to sales whose setName contains this
//     FROMSET=bowman-draft    restrict to sales currently on this setKey
//     APPLY=true              perform the writes
//     LIMIT=50000             cap rows examined
//     CONCURRENCY=6
const { CosmosClient } = require("@azure/cosmos");
const { samePlayer } = require("./playerNameMatch.cjs");
const { canAdjudicate, catalogAuthorityOf } = require("../../dist/services/catalog/catalogAuthority.service.js");

const APPLY = process.env.APPLY === "true";
const SETNAME = String(process.env.SETNAME || "").trim().toLowerCase();
const FROMSET = String(process.env.FROMSET || "").trim();
const LIMIT = Number(process.env.LIMIT || 0);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

const GRADE = /:(raw|psa-\d+(-\d+)?|bgs-\d+(-\d+)?(-black)?|sgc-\d+(-\d+)?|cgc-\d+(-\d+)?)$/;
const SETKEY_SEG = 3;

// ── CF-A-CARD-NUMBER-IS-ONLY-MEANINGFUL-INSIDE-A-PRODUCT (2026-08-23) ────────
//
// The first version of this tool asked the catalog "who holds (sport, year,
// cardNumber)?" and moved the sale wherever exactly one checklist answered.
// Card number 19 in 2013 exists in dozens of products, so "exactly one" was
// often satisfied by a completely different manufacturer. Report-only run:
//
//     4125  panini-prizm-draft-picks -> panini-prizm
//      202  panini-contenders        -> bowman
//      183  donruss-elite            -> bowman
//
// Donruss Elite into Bowman. The same-player guard waved it through because a
// player appears in both products. Nothing was written, but MOVABLE said 4,910
// and it was wrong.
//
// Two structural guards, both about the RELATIONSHIP between the current key
// and the proposed one — neither trusts vendor text:
//
//   SHARED ROOT   the two keys must share at least one token. bowman-chrome and
//                 bowman-draft share "bowman"; donruss and panini-donruss share
//                 "donruss" (a real correction, 138,782 rows). panini-contenders
//                 and bowman share nothing, so that move cannot be proposed.
//
//   NEVER LESS SPECIFIC   a destination may not have fewer tokens than where the
//                 sale already sits. Every defect this session was specificity
//                 being discarded — Tiffany into base, Gold into Refractor, DPP
//                 into bowman-draft. A repoint that DROPS tokens is that same
//                 failure wearing the costume of a fix. It blocks
//                 panini-prizm-draft-picks -> panini-prizm exactly.
const tokens = (k) => String(k || "").split("-").filter(Boolean);

/** May a sale on `from` be proposed a move to `to`? Structure only. */
function compatibleKeys(from, to) {
  const a = tokens(from), b = tokens(to);
  if (!a.length || !b.length) return { ok: false, why: "unparseable" };
  if (!a.some((t) => b.includes(t))) return { ok: false, why: "no-shared-root" };
  if (b.length < a.length) return { ok: false, why: "less-specific" };
  return { ok: true, why: "" };
}
const seg = (id, i) => { const p = String(id || "").replace(GRADE, "").split(":"); return p[0] === "hiq" && p.length > i ? p[i] : null; };
const retarget = (slug, setKey) => {
  const p = String(slug).split(":");
  if (p[0] !== "hiq" || p.length <= SETKEY_SEG) return null;
  p[SETKEY_SEG] = setKey;
  return p.join(":");
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  if (!SETNAME && !FROMSET) {
    console.error("FATAL: give SETNAME= or FROMSET= — refusing to sweep the whole pool unscoped.");
    process.exit(2);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL REWRITE SLUGS" : "report only"}`);
  console.log(`scope: ${SETNAME ? `setName contains "${SETNAME}"` : ""}${SETNAME && FROMSET ? " AND " : ""}${FROMSET ? `currently on ${FROMSET}` : ""}\n`);

  const where = ["IS_STRING(c.hobbyiqCardId)"];
  const params = [];
  if (SETNAME) { where.push("CONTAINS(LOWER(c.setName), @sn)"); params.push({ name: "@sn", value: SETNAME }); }
  if (FROMSET) { where.push("CONTAINS(c.hobbyiqCardId, @fs)"); params.push({ name: "@fs", value: `:${FROMSET}:` }); }
  const top = LIMIT > 0 ? `TOP ${LIMIT} ` : "";

  const rows = (await sold.items.query({
    query: `SELECT ${top}c.id, c.cardId, c.hobbyiqCardId, c.setName, c.playerName, c.cardNumber, c.sport, c.cardYear
            FROM c WHERE ${where.join(" AND ")}`,
    parameters: params,
  }).fetchAll()).resources;
  console.log(`sales in scope: ${rows.length}`);
  if (!rows.length) return;

  // ── Batched authority lookup, keyed by (sport, year) then cardNumber IN (…)
  const byYear = new Map();
  for (const r of rows) {
    const sport = String(r.sport ?? seg(r.hobbyiqCardId, 1) ?? "").toLowerCase();
    const year = Number(r.cardYear ?? seg(r.hobbyiqCardId, 2));
    const num = String(r.cardNumber ?? seg(r.hobbyiqCardId, 4) ?? "").toUpperCase();
    if (!sport || !year || !num) continue;
    const yk = `${sport}|${year}`;
    if (!byYear.has(yk)) byYear.set(yk, new Set());
    byYear.get(yk).add(num);
  }
  console.log(`distinct (sport, year) groups: ${byYear.size}`);

  /** (sport|year|CARDNUMBER) -> { adjudicating:Set<setKey>, all:Set<setKey>, authorities:Set } */
  const authority = new Map();
  let looked = 0;
  for (const [yk, nums] of byYear) {
    const [sport, yearStr] = yk.split("|");
    const year = Number(yearStr);
    const list = [...nums];
    for (let i = 0; i < list.length; i += 60) {
      const ch = list.slice(i, i + 60);
      const qp = ch.map((s, k) => ({ name: `@n${k}`, value: s }));
      const res = (await cat.items.query({
        query: `SELECT c.setKey, c.source, c.cardNumber, c.playerName FROM c
                WHERE c.sport = @s AND c.year = @y
                  AND UPPER(c.cardNumber ?? '') IN (${qp.map((p) => `UPPER(${p.name})`).join(", ")})`,
        parameters: [{ name: "@s", value: sport }, { name: "@y", value: year }, ...qp],
      }).fetchAll()).resources;
      for (const x of res) {
        const k = `${yk}|${String(x.cardNumber ?? "").toUpperCase()}`;
        if (!authority.has(k)) authority.set(k, { adj: new Set(), all: new Set(), auths: new Set() });
        const e = authority.get(k);
        e.all.add(String(x.setKey ?? "?"));
        e.auths.add(catalogAuthorityOf(x.source));
        if (canAdjudicate(x.source)) e.adj.add(String(x.setKey ?? "?"));
      }
      looked += ch.length;
      process.stderr.write(`\r  authority lookups ${looked}   `);
    }
  }
  process.stderr.write("\n");

  // ── Decide
  const moves = [];
  let already = 0, noAuthority = 0, ambiguous = 0, weakOnly = 0, noKey = 0, incompatible = 0;
  const incompatibleBy = new Map();
  const ambSample = [], weakSample = [];
  const wantByPair = new Map();

  for (const r of rows) {
    const sport = String(r.sport ?? seg(r.hobbyiqCardId, 1) ?? "").toLowerCase();
    const year = Number(r.cardYear ?? seg(r.hobbyiqCardId, 2));
    const num = String(r.cardNumber ?? seg(r.hobbyiqCardId, 4) ?? "").toUpperCase();
    const cur = seg(r.hobbyiqCardId, SETKEY_SEG);
    if (!sport || !year || !num || !cur) { noKey++; continue; }
    const e = authority.get(`${sport}|${year}|${num}`);
    if (!e || (!e.adj.size && !e.all.size)) { noAuthority++; continue; }
    if (!e.adj.size) {
      weakOnly++;
      if (weakSample.length < 5) weakSample.push(`${year} #${num} only [${[...e.auths].join(",")}] under ${[...e.all].join("|")}`);
      continue;
    }
    if (e.adj.size > 1) {
      ambiguous++;
      if (ambSample.length < 5) ambSample.push(`${year} #${num} claimed by ${[...e.adj].join(" | ")}`);
      continue;
    }
    const want = [...e.adj][0];
    if (want === cur) { already++; continue; }

    // Structural compatibility — see CF-A-CARD-NUMBER-IS-ONLY-MEANINGFUL-INSIDE-
    // A-PRODUCT at the top. This is what stops "Donruss Elite -> Bowman".
    const compat = compatibleKeys(cur, want);
    if (!compat.ok) {
      incompatible++;
      const k = `${cur} -> ${want}   [${compat.why}]`;
      incompatibleBy.set(k, (incompatibleBy.get(k) || 0) + 1);
      continue;
    }

    const to = retarget(r.hobbyiqCardId, want);
    if (!to) { noKey++; continue; }
    moves.push({ r, to, want, cur });
    const pk = `${cur} -> ${want}`;
    wantByPair.set(pk, (wantByPair.get(pk) || 0) + 1);
  }

  console.log(`\n  already on the adjudicated set : ${already}`);
  console.log(`  no catalog row at all          : ${noAuthority}   (acquisition)`);
  console.log(`  only vendor/derived rows       : ${weakOnly}   (promotion — acquire the checklist)`);
  for (const s of weakSample) console.log(`      ${s}`);
  console.log(`  two checklists disagree        : ${ambiguous}   (reported, never guessed)`);
  for (const s of ambSample) console.log(`      ${s}`);
  console.log(`  unparseable                    : ${noKey}`);
  console.log(`  structurally incompatible      : ${incompatible}   (cross-brand, or would LOSE specificity)`);
  for (const [k, n] of [...incompatibleBy].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`     ${String(n).padStart(7)}  ${k}`);
  }
  console.log(`  CANDIDATES to move             : ${moves.length}`);
  for (const [k, n] of [...wantByPair].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`     ${String(n).padStart(7)}  ${k}`);
  }
  if (!moves.length) { console.log("\nnothing to do."); return; }

  // GUARD 3 + 4 — the exact destination slug must exist, and name the same player.
  const wanted = [...new Set(moves.map((m) => m.to))];
  const destPlayer = new Map();
  for (let i = 0; i < wanted.length; i += 60) {
    const ch = wanted.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const res = (await cat.items.query({
      query: `SELECT c.id, c.playerName FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll()).resources;
    for (const x of res) destPlayer.set(x.id, x.playerName);
  }
  const final = [];
  let destMissing = 0, wrongPlayer = 0;
  const wrongSample = [];
  for (const m of moves) {
    if (!destPlayer.has(m.to)) { destMissing++; continue; }
    if (!m.r.playerName || !samePlayer(m.r.playerName, destPlayer.get(m.to))) {
      wrongPlayer++;
      if (wrongSample.length < 5) wrongSample.push(`${m.r.playerName} -> ${String(m.to).slice(4, 70)} is ${destPlayer.get(m.to)}`);
      continue;
    }
    final.push(m);
  }
  console.log(`\n  exact destination slug missing : ${destMissing}   (set is right, that identity is not built)`);
  console.log(`  destination is another player  : ${wrongPlayer}`);
  for (const s of wrongSample) console.log(`      ${s}`);
  console.log(`  MOVABLE                        : ${final.length}`);

  if (!APPLY) { console.log("\nReport only — nothing written. Re-run with APPLY=true."); return; }

  let moved = 0, skipped = 0, failed = 0, unaddressable = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= final.length) return;
      const { r, to, want } = final[i];
      if (typeof r.cardId !== "string" || !r.cardId) { unaddressable++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/hobbyiqCardId", value: to },
            { op: "set", path: "/repointedFrom", value: r.hobbyiqCardId },
            { op: "set", path: "/repointedReason", value: `catalog authority: a checklist-backed row places this card number in ${want}` },
            { op: "set", path: "/repointedAt", value: new Date().toISOString() },
          ],
          condition: `FROM c WHERE c.hobbyiqCardId = "${String(r.hobbyiqCardId).replace(/"/g, "")}"`,
        });
        moved++;
        if (moved % 1000 === 0) process.stdout.write(`  ...${moved}/${final.length}\n`);
      } catch (e) {
        if (e && (e.code === 412 || e.code === 404)) { skipped++; continue; }
        failed++;
        if (failed <= 3) console.log(`  write failed ${r.id}: ${e.code} ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nREFILED: ${moved}   skipped: ${skipped}   unaddressable: ${unaddressable}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
