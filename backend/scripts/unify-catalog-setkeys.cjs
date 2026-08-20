#!/usr/bin/env node
/**
 * CF-UNIFY-CATALOG-SETKEYS (Drew, 2026-08-20: "lets fix it and dedupe and
 * unify").
 *
 * Collapses catalog rows for ONE card that are filed under several setKeys —
 * the 22,111 identities the duplicate audit classified as a split rather than a
 * duplicate.
 *
 * ORDER MATTERS, AND THIS MUST RUN BEFORE ANY DEDUPE. Dedupe first and it picks
 * a survivor PER setKey — one row kept on `bowman`, one on `bowman-chrome` —
 * cementing the split permanently while reporting a successful cleanup. Unify
 * first and those identities collapse into one, so a later dedupe sees the
 * duplicates for what they are.
 *
 * THE CATALOG CANNOT BE ADJUDICATED BY THE CATALOG. Every other repair today
 * asked the checklist which setKey was right. That move is unavailable here,
 * because the catalog IS the checklist. So the question becomes which setKey the
 * CHECKLIST-BACKED rows use, versus which exist only because a vendor or one of
 * our own seed jobs wrote them:
 *
 *   exactly ONE setKey has checklist-backed rows  -> that key is canonical
 *   SEVERAL have checklist backing                -> genuinely two products
 *   NONE has any                                  -> unproven
 *
 * Only the first case is ever actionable. This is the "count by source, not row
 * count" rule, and it is load-bearing: the sources leading duplicated identities
 * are catalog-explode-actuals (25,044) and ingest-auto-seed (24,207) — rows WE
 * generated. Counting rows would let our own inferences outvote a checklist.
 *
 * SEVERAL-CHECKLISTS MEANS LEAVE IT ALONE, and that is not a cop-out. Ohtani
 * #17 exists in bowman, bowman-chrome, mega-box AND sapphire as four real cards.
 * Collapsing those would flatten a $500 Sapphire into a $5 paper base — the
 * mistake this whole effort has been avoiding.
 *
 * MARKS, NEVER DELETES. A losing row gets setKey rewritten plus a breadcrumb;
 * nothing is removed. Deletion is irreversible and the catalog is the moat.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/unify-catalog-setkeys.cjs \
 *     [--apply] [--family=bowman] [--years=2023-2026] [--pair=bowman,bowman-chrome]
 *     [--pool=8] [--top=20]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const FAMILY = arg("family", "bowman");
const [Y0, Y1] = arg("years", "2023-2026").split("-").map(Number);
const PAIR = arg("pair", "").split(",").map((s) => s.trim()).filter(Boolean);
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "20"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));

const GRADE_TAIL = /:(psa|bgs|sgc|cgc|ace|tag|hga)-[0-9]{1,2}(-[0-9])?(-black)?$|:raw$/i;
const norm = (s) => String(s ?? "").toLowerCase().trim();
const numKey = (n) => norm(n).replace(/[^a-z0-9]/g, "");

/** Transcriptions of a printed checklist. Vendor catalogs record how the vendor
 *  types; `ingest-auto-seed`, `catalog-explode` and `sold-comps-stub` are our
 *  OWN inferences written back, so a mis-slugged row could confirm itself. */
/**
 * Sources whose setKey may be re-keyed to the one checklist-backed key.
 *
 * TWO GROUPS, BOTH NON-AUTHORITATIVE ON WHICH SET A CARD IS IN.
 *
 * 1. Rows WE generated — ingest-auto-seed, catalog-explode, sold-comps-stub,
 *    tree-builder. Our own inferences written back; they carry no independent
 *    information, so re-keying them destroys nothing.
 *
 * 2. VENDOR PRODUCT classifications. Drew, 2026-08-20, on a cardhedge row
 *    filed under bowman-sapphire: "that is correct, cardhedge classified it
 *    wrongly". This is not a one-off judgement — it restates a standing rule:
 *    consume CardHedge SALES, not CardHedge PRODUCT fields. A setKey IS a
 *    product field. Cardsight is likewise retired from matching.
 *
 * A first cut held vendor rows back on the reasoning that Sapphire is a real
 * product, so moving a vendor row for want of a Sapphire checklist would treat
 * absence of our evidence as evidence of absence. That caution was misplaced:
 * it granted authority to a field the doctrine already says is untrustworthy.
 * What actually protects a real Sapphire card is the several-checklists rule —
 * if Sapphire has its own checklist row, the identity is left alone entirely.
 */
function isReKeyable(source) {
  const s = norm(source);
  if (/^(ingest-auto-seed|catalog-explode|sold-comps-stub|tree-builder)/.test(s)) return true;
  return /^(cardhedge|cardsight|ebay)/.test(s);
}

function isChecklistSource(source) {
  const s = norm(source).replace(/-graded$/, "");
  if (/^(cardhedge|cardsight|ebay|ingest-auto-seed|sold-comps-stub|tree-builder|catalog-explode|user-verified)/.test(s)) return false;
  if (/-product-structure$/.test(s)) return false;
  return /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor/.test(s);
}

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}) ${Math.round(w / 1000)}s   `);
        await new Promise((r) => setTimeout(r, w));
        break;
      }
      token = page.continuationToken;
      progressed = true;
      for (const r of page.resources || []) { rows++; onRow(r); }
      legPages++;
      if (rows % 250000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      if (legPages >= REFRESH_PAGES) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[unify-catalog-setkeys] mode=${APPLY ? "APPLY" : "DRY-RUN"} family=${FAMILY} years=${Y0}-${Y1}`
    + `${PAIR.length ? ` pair=${PAIR.join(" <-> ")}` : ""}\n`);

  const idents = new Map();   // identity -> setKey -> { ck, other, rows:[] }
  await scanAll("card_catalog", {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setKey, c.cardNumber, c.playerName,
                   c.parallel, c.printRun, c.isAuto, c.year, c.source, c.sport
             FROM c WHERE STARTSWITH(c.setKey, @f) AND c.year >= @y0 AND c.year <= @y1`,
    parameters: [{ name: "@f", value: FAMILY }, { name: "@y0", value: Y0 }, { name: "@y1", value: Y1 }],
  }, (r) => {
    if (GRADE_TAIL.test(String(r.hobbyiqCardId || ""))) return;
    const player = norm(r.playerName);
    const num = numKey(r.cardNumber);
    if (!player || !num || !r.setKey) return;
    const k = [r.sport ?? "", r.year, num, player, norm(r.parallel), r.isAuto ? 1 : 0, r.printRun ?? "-"].join("|");
    let byKey = idents.get(k);
    if (!byKey) idents.set(k, (byKey = new Map()));
    let e = byKey.get(r.setKey);
    if (!e) byKey.set(r.setKey, (e = { ck: 0, other: 0, rows: [] }));
    if (isChecklistSource(r.source)) e.ck++; else e.other++;
    e.rows.push(r);
  });

  const work = [];
  const stats = { split: 0, unifiable: 0, twoProducts: 0, unproven: 0, vendorHeld: 0 };
  const moves = new Map();
  const twoProdEx = [], unifiedEx = [];

  for (const [, byKey] of idents) {
    if (byKey.size < 2) continue;
    if (PAIR.length && !PAIR.every((p) => byKey.has(p))) continue;
    stats.split++;
    const backed = [...byKey.entries()].filter(([, v]) => v.ck > 0);
    if (backed.length === 0) { stats.unproven++; continue; }
    if (backed.length > 1) {
      stats.twoProducts++;
      if (twoProdEx.length < 6) {
        const s = backed[0][1].rows[0];
        twoProdEx.push(`${s.year} #${s.cardNumber} ${s.playerName} — ${backed.map(([k, v]) => `${k}(ck=${v.ck})`).join(" | ")}`);
      }
      continue;
    }
    // Exactly one checklist-backed key: it is canonical.
    const canonical = backed[0][0];
    stats.unifiable++;
    for (const [sk, v] of byKey) {
      if (sk === canonical) continue;
      for (const row of v.rows) {
        // ONLY OUR OWN SEEDED ROWS MOVE.
        //
        // A vendor row claiming `bowman-sapphire` is not authority, but it is
        // not nothing either — Sapphire is a REAL product. Moving it to
        // `bowman` merely because we lack a Sapphire checklist for that card
        // treats absence of OUR evidence as evidence of absence, and files a
        // real card in the wrong pool. Same discipline as BDPP, where a silent
        // checklist was not permission.
        //
        // Rows we generated ourselves (ingest-auto-seed, catalog-explode,
        // sold-comps-stub) carry no independent information, so re-keying them
        // to the one checklist-backed key destroys nothing.
        if (!isReKeyable(row.source)) { stats.vendorHeld++; continue; }
        const mk = `${sk}  ->  ${canonical}`;
        moves.set(mk, (moves.get(mk) ?? 0) + 1);
        work.push({ row, canonical, from: sk });
        if (unifiedEx.length < TOP && v.rows.length) {
          unifiedEx.push(`${row.year} #${row.cardNumber} ${row.playerName}  ${sk} -> ${canonical}  (src=${row.source})`);
        }
      }
    }
  }

  console.log(`identities split across setKeys : ${stats.split.toLocaleString()}`);
  console.log(`  UNIFIABLE (one checklist key) : ${stats.unifiable.toLocaleString()}`);
  console.log(`  two products (several backed) : ${stats.twoProducts.toLocaleString()}   <- left alone`);
  console.log(`  unproven (no checklist at all): ${stats.unproven.toLocaleString()}   <- left alone`);
  console.log(`  rows held (checklist-sourced) : ${stats.vendorHeld.toLocaleString()}   <- a checklist put them there; never moved`);
  console.log(`\nrows to re-key : ${work.length.toLocaleString()}\n`);

  console.log("moves:");
  for (const [k, n] of [...moves].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`   ${String(n).padStart(7)}  ${k}`);
  }
  console.log("\nexamples:");
  for (const e of unifiedEx.slice(0, 8)) console.log(`   ${e}`);
  console.log("\nLEFT ALONE — several setKeys are checklist-backed, so these are");
  console.log("genuinely different cards:");
  for (const e of twoProdEx) console.log(`   ${e}`);

  if (!APPLY) {
    console.log("\nDRY-RUN. Re-run with --apply to write. Nothing is deleted — a losing row");
    console.log("has its setKey rewritten and keeps setKeyBefore for reversal.");
    return 0;
  }

  let done = 0, failed = 0, cursor = 0;
  console.log(`\napplying ${work.length.toLocaleString()} re-keys...`);
  const cat = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const w = work[cursor++];
      const patch = [
        { op: "add", path: "/setKeyBefore", value: w.from },
        { op: "set", path: "/setKey", value: w.canonical },
        { op: "add", path: "/unifiedBy", value: "CF-UNIFY-CATALOG-SETKEYS" },
      ];
      // Keep the row's own slug consistent with its new key.
      if (typeof w.row.hobbyiqCardId === "string") {
        const parts = w.row.hobbyiqCardId.split(":");
        if (parts.length >= 4 && parts[3] === w.from) {
          parts[3] = w.canonical;
          patch.push({ op: "set", path: "/hobbyiqCardId", value: parts.join(":") });
        }
      }
      try {
        await cat.item(w.row.id, w.row.cardId).patch(patch);
        done++;
        if (done % 2000 === 0) process.stderr.write(`\r  patched ${done}/${work.length}   `);
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${w.row.id}: ${String(e.message).slice(0, 80)}`);
      }
    }
  }));
  console.log(`\nrepaired=${done} failed=${failed}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
