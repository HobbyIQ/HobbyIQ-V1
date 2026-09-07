#!/usr/bin/env node
/**
 * report-staging-twin-resolution.cjs -- REPORT ONLY. Names the rows.
 *
 * CF-A-PARKED-TWIN-IS-NOT-A-TWIN (#1953) fixed the two twin shapes the
 * promoter can decide FOR ITSELF at the write door:
 *
 *   FOLD    the sale is already resident at the address being written, so the
 *           upsert is a replace and cannot mint a second document.
 *   REFUSE  a LIVE copy sits at a different address, so writing here would be
 *           the split-pool defect itself.
 *
 * A refusal is correct and it is also a DEAD END: nothing about the row can
 * change on a re-run, which is why the same 461 ids were refused at 13:31Z and
 * again at 14:31Z. Clearing them needs a ruling about WHICH address is right,
 * and that ruling is not the ingest writer's to make
 * (CF-COLLISION-IS-NOT-A-DUPLICATE, and #1942's canonical rule).
 *
 * So this script does the only thing a report-first lane may do: it reads the
 * refused ids, resolves each against the live pool AND the catalog, applies
 * #1942's `decideCanonical`, and EMITS A LIST for
 * `relocate-pool-rows-by-list.cjs` -- which is itself report-first and needs
 * BACKFILL_APPLY=true to write. Nothing here writes to Cosmos. Ever.
 *
 * THE RULE, and it is #1942's, not a second one:
 *
 *   CANONICAL   the copy whose partition matches its own hobbyiqCardId AND
 *               whose slug resolves to a card_catalog row. Its siblings are
 *               PARKED (`parkIdentityUnverified`), never deleted.
 *   PARK-BOTH / PARK-NEITHER
 *               no tell picks between them, so nothing is promoted and the
 *               extras are parked with the reason recorded. A sale never mints
 *               an identity from itself (CF-CATALOG-MATCH-IS-SELF-CONFIRMING).
 *
 * WHY PARK AND NOT RELOCATE. A relocate MOVES a row to a new address, and a
 * move is only honest when the destination is known right. Here the two
 * addresses are rival readings of one title and the catalog is the only
 * arbiter; where it does not name a winner, parking the extra keeps the sale
 * (a sale is never lost) while taking it out of every pool, which is exactly
 * what stops the double count. #1942 measured this shape and reached the same
 * remedy: 87 CANONICAL, 168 PARK-NEITHER-QUALIFIES.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   IDS_FILE                  JSON array of { id, staged }, a plain newline
 *                             list of ids, or the raw jsonl the job logs.
 *   OUT                       where to write the list file.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { decideCanonical, parkEntry, byTsDesc } = require(path.join(__dirname, "lib", "duplicate-sale-ids.cjs"));

const OUT = process.env.OUT || "data/pool-relocations/2026-09-07-staging-twins.json";
const IDS_FILE = process.env.IDS_FILE;
const CONC = Math.max(1, Number(process.env.CONCURRENCY || 12));

function readIds(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.startsWith("[")) {
    return JSON.parse(raw).map((e) => (typeof e === "string" ? { id: e } : { id: e.id, staged: e.staged ?? null }));
  }
  // Also accept the raw jsonl the job logs, so an operator can pipe a run log
  // straight in without reshaping it by hand.
  const out = new Map();
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith("{")) {
      try {
        const o = JSON.parse(s);
        if (o.event === "twin_address_refused" && o.id) out.set(o.id, { id: o.id, staged: o.wouldWriteAt ?? null });
      } catch { /* not a json line */ }
    } else out.set(s, { id: s, staged: null });
  }
  return [...out.values()];
}

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  if (!IDS_FILE) { console.error("IDS_FILE required (the refused ids to resolve)"); process.exit(1); }
  const client = new CosmosClient(cs);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  const wanted = readIds(IDS_FILE);
  console.log(`[twin-report] resolving ${wanted.length} refused sale ids (READ ONLY)`);

  // 1. every copy of every id, cross-partition. A point read on the id index.
  const found = [];
  const queue = [...wanted];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const w = queue.shift();
      const { resources } = await pool.items.query({
        query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c._ts, c.flaggedWrong, c.identityUnverified, c.dedupSupersededBy, c.title FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: w.id }],
      }).fetchAll();
      found.push({ ...w, copies: resources });
    }
  }));

  // 2. the catalog decides, and it is asked in batches.
  const addresses = new Set();
  for (const f of found) {
    for (const c of f.copies) if (String(c.cardId ?? "").startsWith("hiq:")) addresses.add(c.cardId);
    if (f.staged && String(f.staged).startsWith("hiq:")) addresses.add(f.staged);
  }
  const inCatalog = new Set();
  const addrList = [...addresses];
  for (let i = 0; i < addrList.length; i += 100) {
    const slice = addrList.slice(i, i + 100);
    const params = slice.map((a, j) => ({ name: `@a${j}`, value: a }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id FROM c WHERE c.id IN (${params.map((p) => p.name).join(", ")})`,
      parameters: params,
    }).fetchAll();
    for (const r of resources) inCatalog.add(r.id);
  }
  console.log(`[twin-report] catalog: ${inCatalog.size} of ${addrList.length} distinct addresses are checklist-backed`);

  // 3. the ruling, per id.
  const entries = [];
  const tally = {};
  const bump = (k) => { tally[k] = (tally[k] ?? 0) + 1; };
  const lines = [];

  for (const f of found) {
    const copies = f.copies.map((c) => ({ ...c, ts: c._ts }));
    if (copies.length === 0) { bump("NO COPY IN POOL (nothing to rule on)"); continue; }
    // A copy already parked is out of every pool and is not a competing
    // address -- the same rule the write-door guard now applies.
    const live = copies.filter((c) => !c.flaggedWrong && !c.identityUnverified);
    if (live.length <= 1) { bump("ALREADY RESOLVED (<=1 live copy) — no action"); continue; }

    const decision = decideCanonical(live, inCatalog);
    bump(decision.verdict);
    lines.push(`${f.id}  x${live.length} live  ${decision.verdict}`);
    for (const c of byTsDesc(live)) {
      const mark = decision.canonical && c.cardId === decision.canonical.cardId ? "KEEP" : "park";
      lines.push(`      ${mark}  ${new Date(c.ts * 1000).toISOString().slice(0, 10)}  ${String(c.cardId).slice(0, 62)}`);
    }
    for (const extra of decision.extras) {
      entries.push(parkEntry(f.id, extra, decision.reason));
    }
  }

  console.log(`\n[twin-report] verdicts`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

  const outPath = path.resolve(__dirname, "..", OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 1));
  console.log(`\n[twin-report] ${entries.length} PARK entries -> ${OUT}`);
  console.log(`[twin-report] REPORT ONLY — nothing written to Cosmos. Apply with:`);
  console.log(`    SCOPE=${OUT} BACKFILL_APPLY=true node scripts/relocate-pool-rows-by-list.cjs`);
  if (lines.length) {
    console.log(`\n[twin-report] sample rulings`);
    for (const l of lines.slice(0, 60)) console.log("  " + l);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
