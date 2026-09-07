#!/usr/bin/env node
/**
 * CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY (R5, 2026-09-07) -- the census
 * and the lists.
 *
 * READ ONLY. Writes nothing to Cosmos.
 *
 * #1948 measured 16,701 sold_comps rows that state Japanese while addressed on
 * one of the 38 English codes both markets share, and correctly LEFT THEM
 * ALONE: the JA vocabulary's own answer for such a row was the key it already
 * sat on, so there was nowhere to move it to. R5 mints the destination --
 * `ja-<code>` -- and this lane finds the rows that now have one.
 *
 * TWO CORPORA, because the defect has two homes:
 *
 *   sold_comps    JA-stated sales addressed on a shared EN code. Emitted as
 *                 REPOINT or RELOCATE for relocate-pool-rows-by-list.
 *   card_catalog  JA-stated checklist rows minted onto a shared EN code.
 *                 Emitted as RESLUG for relocate-catalog-rows-by-list.
 *
 * ── THE SHAPE FOLLOWS THE FIELD THAT IS WRONG (#1948's finding, reused) ──────
 *
 * sold_comps is partitioned on /cardId, and for this corpus cardId is usually a
 * CardHedge VENDOR id -- the slug lives only in `hobbyiqCardId`. Such a row is
 * in the RIGHT partition with the WRONG identity, which is REPOINT (a patch in
 * place), not RELOCATE (a new document plus a delete, D19). Emitting RELOCATE
 * for all of them would restructure the CardHedge pool's partitioning as a side
 * effect of a market fix. Only a row whose PARTITION carries the slug relocates.
 *
 * ── THE PREDICATES ARE REUSED, NEVER RESTATED ───────────────────────────────
 *
 * ROW SIDE is #1915 `marketOfRow` -- the same setName + title witnesses, in the
 * same order, that refuse new cross-market moves. Asked with the row's TEXT
 * only: the stored key IS the address here, so a key witness would agree with
 * the address by construction and no row could ever contradict.
 *
 * ADDRESS SIDE is the set-code segment of the row's own slug, tested against
 * the RULING's map -- never a private list of codes.
 *
 * DESTINATION is `ja-<code>`, and the NUMBER SEGMENT IS KEPT (#1938 N/M ruling,
 * reaffirmed by #1948): the Japanese print carries the same number, so only the
 * set-code segment changes. Nothing about a card's identity is re-derived here.
 *
 * ── WHY THE CATALOG SIDE IS A RESLUG AND NOT A RETIRE ───────────────────────
 *
 * A JA checklist row on a shared EN code is a REAL CARD AT THE WRONG ADDRESS --
 * the tcgdex-ja lane staged it correctly and only the key was shared. It moves.
 * `relocate-catalog-rows-by-list` refuses a destination another card occupies
 * (an occupied address is a collision to REPORT, never to route around) and
 * carries the row's graded children with it (#1920).
 *
 * Env: COSMOS_CONNECTION_STRING. OUT_DIR, LIST_DATE optional.
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require("@azure/cosmos");
const { marketOfRow } = require(path.join(backend, "scripts/lib/market-guard.cjs"));
const {
  japaneseVintageKeyRewrites,
} = require(path.join(backend, "dist/services/catalog/japaneseVintageSetKeyRuling.js"));

const OUT_DIR = process.env.OUT_DIR || path.join(backend, "data/pool-relocations");
const LIST_DATE = process.env.LIST_DATE || "2026-09-07";
const MAX_PER_FILE = 2000;
const f = (n) => Number(n).toLocaleString();

/** English code -> ruled `ja-<code>` key. THE scope of this lane. */
const RULED = japaneseVintageKeyRewrites();

/**
 * The address a row holds and its set-code segment.
 *
 * A sold_comps row carries cardId (the partition key) and hobbyiqCardId (what
 * the pricing engine reads). The code is read from hobbyiqCardId when present
 * -- that is the field the pool is addressed by -- and from cardId otherwise.
 */
function addressOf(row) {
  const hid = String(row.hobbyiqCardId ?? "").trim();
  const cid = String(row.cardId ?? "").trim();
  const primary = hid || cid;
  const parts = primary.split(":");
  return { primary, hid, cid, parts, code: parts.length >= 5 ? parts[3] : null };
}

/** The same slug with segment 3 (the set code) replaced. Nothing else moves. */
function withSetKey(slug, code) {
  const parts = String(slug ?? "").split(":");
  if (parts.length < 5) return null;
  const next = parts.slice();
  next[3] = code;
  return next.join(":");
}

function writeLists(base, entries, rulings, meta) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const paths = [];
  for (let i = 0; i < entries.length; i += MAX_PER_FILE) {
    const chunk = entries.slice(i, i + MAX_PER_FILE);
    const n = String(Math.floor(i / MAX_PER_FILE) + 1).padStart(2, "0");
    const p = path.join(OUT_DIR, `${LIST_DATE}-${base}-${n}.json`);
    fs.writeFileSync(p, JSON.stringify({ ...meta, rulings, entries: chunk }, null, 2));
    paths.push(p);
  }
  return paths;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database("hobbyiq");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        const msg = String(e?.message ?? e);
        if (!/request rate|429|ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN|ENOTFOUND/i.test(msg) || a >= tries) throw e;
        console.error(`  retry ${a + 1}/${tries} after ${msg.slice(0, 60)}`);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  console.log(`ruled keys in scope     ${f(Object.keys(RULED).length)}`);
  console.log("");

  // ── THE POOL ──────────────────────────────────────────────────────────────
  //
  // Paged over the `hiq:pokemon:` prefix -- never a cross-partition COUNT.
  const pool = db.container("sold_comps");
  const it = pool.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setKey, c.setName, c.title,
                   c.year, c.cardYear, c.source, c.price, c.soldAt,
                   c.identityUnverified, c.flaggedWrong
            FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:pokemon:')`,
  }, { maxItemCount: 2000 });

  let scanned = 0, jaOnRuledCode = 0, alreadyParked = 0;
  const poolEntries = [];
  const byCode = new Map(), bySource = new Map(), byYear = new Map();
  let repoint = 0, relocate = 0;

  while (it.hasMoreResults()) {
    const page = await retry(() => it.fetchNext());
    for (const row of page.resources || []) {
      scanned++;
      const addr = addressOf(row);
      if (!addr.code) continue;
      const to = RULED[addr.code];
      if (!to) continue;                      // not one of the 38
      if (marketOfRow(row) !== "ja") continue; // the row does not state Japanese
      jaOnRuledCode++;
      if (row.identityUnverified === true || row.flaggedWrong === true) { alreadyParked++; continue; }

      byCode.set(addr.code, (byCode.get(addr.code) || 0) + 1);
      const src = String(row.source || "unknown");
      bySource.set(src, (bySource.get(src) || 0) + 1);
      const yr = String(row.year ?? row.cardYear ?? "?");
      byYear.set(yr, (byYear.get(yr) || 0) + 1);

      const evidence = `R5: setName/title states Japanese; address code ${addr.code} is shared with the ENGLISH product; ruled key ${to}`;
      // RELOCATE only when the PARTITION itself carries the English code.
      // Otherwise the partition is a vendor id and only the identity is wrong.
      const cidCode = addr.cid.split(":").length >= 5 ? addr.cid.split(":")[3] : null;
      if (cidCode && RULED[cidCode]) {
        const toCardId = withSetKey(addr.cid, RULED[cidCode]);
        if (!toCardId) continue;
        poolEntries.push({ id: row.id, fromCardId: addr.cid, toCardId, price: row.price ?? null, evidence });
        relocate++;
      } else {
        const target = withSetKey(addr.hid || addr.primary, to);
        if (!target) continue;
        poolEntries.push({ id: row.id, fromCardId: addr.cid, repointHobbyiqCardId: target, price: row.price ?? null, evidence });
        repoint++;
      }
    }
    if (scanned % 500000 < 2000) console.error(`  ... scanned ${f(scanned)}`);
  }

  // ── THE CATALOG ───────────────────────────────────────────────────────────
  const cat = db.container("card_catalog");
  const codeList = Object.keys(RULED).map((c) => `'${c}'`).join(",");
  const cit = cat.items.query({
    query: `SELECT c.id, c.setKey, c.setName, c.title, c.cardNumber, c.parallel,
                   c.player, c.playerName, c.year, c.cardYear, c.source, c.sport,
                   c.grade, c.gradingCompany
            FROM c WHERE c.sport = 'pokemon' AND c.setKey IN (${codeList})`,
  }, { maxItemCount: 1000 });

  let catScanned = 0, catJa = 0;
  const catEntries = [];
  const catByCode = new Map(), catBySource = new Map();
  while (cit.hasMoreResults()) {
    const page = await retry(() => cit.fetchNext());
    for (const row of page.resources || []) {
      catScanned++;
      const to = RULED[String(row.setKey ?? "").toLowerCase()];
      if (!to) continue;
      if (marketOfRow(row) !== "ja") continue;
      catJa++;
      const target = withSetKey(row.id, to);
      if (!target) continue;
      catByCode.set(row.setKey, (catByCode.get(row.setKey) || 0) + 1);
      const src = String(row.source || "unknown");
      catBySource.set(src, (catBySource.get(src) || 0) + 1);
      catEntries.push({
        id: row.id,
        action: "reslug",
        to: target,
        reason: `R5: setName "${String(row.setName ?? "").slice(0, 60)}" states Japanese; setKey ${row.setKey} is the shared ENGLISH code; ruled key ${to}`,
      });
    }
  }

  const obj = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));

  const rulings = [
    "CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY (Drew, 2026-09-07, R5): the 38 Japanese sets whose alias resolves to a code the ENGLISH table owns get the distinct key ja-<code>.",
    "THE NUMBER SEGMENT IS KEPT (#1938 N/M, reaffirmed #1948): the Japanese print carries the same number, so ONLY the set-code segment changes.",
    "SHAPE FOLLOWS THE FIELD THAT IS WRONG: sold_comps is partitioned on /cardId and this corpus is CardHedge vendor ids, so a wrong identity is a REPOINT (patch in place); only a row whose PARTITION carries the slug RELOCATES.",
    "THE ROW SIDE IS #1915 marketOfRow, asked with the row's TEXT only -- the stored key IS the address here, so a key witness would agree with the address by construction.",
  ];

  const poolPaths = writeLists("ja-vintage-pool-repoint", poolEntries, rulings, {
    note: "R5 pool moves: JA-stated sales addressed on one of the 38 shared English codes.",
  });
  const catPaths = writeLists("ja-vintage-catalog-reslug", catEntries, rulings, {
    note: "R5 catalog moves: JA-stated checklist rows minted onto a shared English code.",
    keepSales: false,
  });

  console.log("── POOL ──────────────────────────────────────────────────────");
  console.log(`scanned (hiq:pokemon:)  ${f(scanned)}`);
  console.log(`JA-stated on a ruled code ${f(jaOnRuledCode)}`);
  console.log(`  already parked/flagged  ${f(alreadyParked)}   <- left alone`);
  console.log(`  REPOINT (hiqCardId)     ${f(repoint)}`);
  console.log(`  RELOCATE (partition)    ${f(relocate)}`);
  console.log(`  entries emitted         ${f(poolEntries.length)}`);
  console.log("");
  console.log("── CATALOG ───────────────────────────────────────────────────");
  console.log(`rows at the 38 codes    ${f(catScanned)}`);
  console.log(`  JA-stated (RESLUG)      ${f(catJa)}`);
  console.log(`  entries emitted         ${f(catEntries.length)}`);
  console.log("");
  for (const p of [...poolPaths, ...catPaths]) console.log(`  wrote ${path.relative(backend, p)}`);

  const report = {
    ruling: "CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY (R5, 2026-09-07)",
    measuredAt: new Date().toISOString(),
    keys: Object.keys(RULED).length,
    pool: {
      scanned, jaOnRuledCode, alreadyParked, repoint, relocate,
      entries: poolEntries.length,
      byCode: obj(byCode), bySource: obj(bySource), byYear: obj(byYear),
    },
    catalog: {
      scannedAtCodes: catScanned, jaStated: catJa, entries: catEntries.length,
      byCode: obj(catByCode), bySource: obj(catBySource),
    },
    listPaths: [...poolPaths, ...catPaths].map((p) => path.relative(backend, p)),
  };
  const rp = path.join(OUT_DIR, `${LIST_DATE}-ja-vintage-key-census.json`);
  fs.writeFileSync(rp, JSON.stringify(report, null, 2));
  console.log(`  wrote ${path.relative(backend, rp)}`);
  client.dispose?.();
}

main().catch((e) => { console.error(e); process.exit(1); });
