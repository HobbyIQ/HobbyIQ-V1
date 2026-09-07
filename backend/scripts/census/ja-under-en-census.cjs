#!/usr/bin/env node
/**
 * CF-JA-AND-EN-NEVER-SHARE-A-POOL -- the census.
 *
 * READ ONLY. Finds sold_comps rows whose OWN TEXT states one market while the
 * set code in their address states the other:
 *
 *   jaUnderEn   the title/setName says Japanese, the address says an EN code
 *   enUnderJa   the row states English, the address says a JA-only code
 *
 * The #1915 market guard now REFUSES to create new ones, but it never went
 * back for the rows already stored. This counts them, resolves where each
 * belongs, and emits the relocate-pool-rows-by-list lists.
 *
 * THE ROW-SIDE DETECTOR IS NOT RESTATED HERE. `marketOfRow` from
 * lib/market-guard.cjs is THE market predicate (#1915) -- the same setName +
 * title witnesses, in the same order, that the guard refuses on. A census that
 * used its own regex could name rows the guard would not refuse, and the two
 * would drift.
 *
 * THE DESTINATION IS RESOLVED THROUGH THE RESOLVER, not a private table.
 * `resolveSetKeyForSlug("pokemon", setName, year)` routes a "japanese" setName
 * through resolveJapanesePokemonSet -> JAPANESE_POKEMON_SET_ALIASES, which is
 * where the JA vocabulary lives. A row whose JA key cannot be resolved is
 * PARKED, never guessed at (CF-UNKNOWN-IS-ALSO-A-GUESS).
 *
 * ── WHAT THE MEASUREMENT ACTUALLY FOUND (2026-09-07) ────────────────────────
 *
 * 22,413 rows state Japanese under a key `marketOfKey` reads as English. They
 * are NOT one population, and treating them as one would have parked 16,905
 * correctly-addressed sales:
 *
 *   16,905  SHARED CODE, ALREADY CORRECT. 38 of the 230 destinations in
 *           JAPANESE_POKEMON_SET_ALIASES are codes present ONLY in the English
 *           table -- `jungle` -> base2, `dark-rush` -> bw4. For those products
 *           the markets SHARE the code string, so the JA vocabulary's own
 *           answer for the row IS the key it already sits on. Nothing to move.
 *           A vocabulary gap (the key space cannot express the split), not a
 *           pool defect.
 *
 *    4,553  GENUINELY MISFILED, and a distinct JA code resolves -- swsh8 -> s8,
 *           swsh12 -> s12. These move.
 *
 *      955  MISFILED with a resolvable but NON-CODE answer, or a code that is
 *           neither market's -- PARKED as cross-market:unresolved.
 *
 * ── AND THE SHAPE FOLLOWS THE FIELD THAT IS WRONG ───────────────────────────
 *
 * sold_comps is partitioned on /cardId, and for this corpus cardId is usually
 * a CARDHEDGE VENDOR ID -- the slug lives only in hobbyiqCardId. Such a row is
 * in the right partition with the wrong identity, which is REPOINT (a patch in
 * place), not RELOCATE (a new document plus a delete). Only 3 of the movable
 * rows carry the EN code in the partition itself.
 *
 * Env: COSMOS_CONNECTION_STRING. Writes nothing to Cosmos.
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require("@azure/cosmos");
const { marketOfRow, marketOfKey } = require(path.join(backend, "scripts/lib/market-guard.cjs"));
const { resolveSetKeyForSlug } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { POKEMON_JA_SET_CODES, POKEMON_EN_SET_CODES: EN_CODES } = require(path.join(backend, "dist/services/catalog/pokemonSetCodes.js"));

const OUT_DIR = process.env.OUT_DIR || path.join(backend, "data/pool-relocations");
const LIST_DATE = process.env.LIST_DATE || "2026-09-07";
const MAX_PER_FILE = 2000;
const f = (n) => Number(n).toLocaleString();

/**
 * The address a row currently holds, and its set-code segment.
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

/**
 * The JA slug for a row that is addressed under an EN code, or null.
 *
 * CF-THE-NUMBER-SEGMENT-IS-KEPT (the #1938 N-M ruling): the Japanese print of
 * the same card carries the same "N/M" number, so segment 4 is carried across
 * unchanged. Only the SET CODE moves. A different number stated in the title
 * is not inferred here -- this lane moves markets, not numbers.
 */
function jaSlugFor(row, addr) {
  const setName = String(row.setName ?? "").trim();
  const title = String(row.title ?? "").trim();
  const year = Number(row.year ?? row.cardYear ?? 0) || 0;
  // The resolver's JA branch is gated on /japanese/i in the SET NAME. When the
  // Japanese witness is the TITLE and not the setName, the title is what the
  // resolver must be shown -- otherwise it takes the English branch and answers
  // the very code we are trying to move away from.
  const jaStated = /japanese/i.test(setName) ? setName
    : /japanese/i.test(title) ? title
    : setName || title;
  let code = null;
  try { code = resolveSetKeyForSlug("pokemon", jaStated, year); } catch { code = null; }
  if (!code) return { slug: null, code: null, why: "no-code" };
  // A code the JA vocabulary answers may be a REAL code or a slugify() miss.
  // `marketOfKey` answers "ja" for ANY string beginning `japanese-` (the
  // minter-artefact branch), so a miss like "japanese-sv2a-151-charizard"
  // would pass a market test while being unaddressable. A name is not an
  // address, so it is refused here.
  const isRealCode = Boolean(POKEMON_JA_SET_CODES[code]) || Boolean(EN_CODES[code]);
  if (!isRealCode) return { slug: null, code, why: "not-a-code" };

  // THE SHARED-CODE SETS ARE NOT MISFILED, AND THIS IS THE BIG ONE.
  //
  // 38 of the 230 destinations in JAPANESE_POKEMON_SET_ALIASES are codes that
  // exist ONLY in the ENGLISH table -- `jungle` -> base2, `dark-rush` -> bw4,
  // `mystery-of-the-fossils` -> base3. For those products the two markets
  // genuinely SHARE the code string, and `base2` IS what the Japanese
  // vocabulary calls Japanese Jungle.
  //
  // So a row whose setName says Japanese and whose address is `base2` is
  // ALREADY at the address the JA vocabulary names for it. It is not in the
  // wrong pool -- the KEY SPACE cannot express the distinction. Parking 16,905
  // such rows would remove correctly-addressed sales from pricing to fix a
  // defect they do not have, and relocating them would be a no-op onto their
  // own key. They are reported as a VOCABULARY GAP and left alone.
  if (code === addr.code) return { slug: null, code, why: "shared-code-already-correct" };

  const next = addr.parts.slice();
  next[3] = code;
  return { slug: next.join(":"), code, why: null };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const pool = db.container("sold_comps");

  // Paged over the `hiq:pokemon:` prefix -- never a cross-partition COUNT.
  const it = pool.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setKey, c.setName, c.title,
                   c.year, c.cardYear, c.source, c.price, c.soldAt,
                   c.identityUnverified, c.flaggedWrong
            FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:pokemon:')`,
  }, { maxItemCount: 2000 });

  // A long prefix scan crosses many partitions and will meet both throttling
  // and connection-level timeouts. The SDK's retryOptions cover 429s but NOT a
  // dropped socket, and a read-only census that dies at row 700,000 has
  // measured nothing -- so the page fetch itself is retried, the same shape the
  // write lanes use.
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

  let scanned = 0, alreadyParked = 0, sharedCode = 0;
  const jaUnderEn = [], enUnderJa = [];
  const byEnCode = new Map(), byJaCode = new Map(), bySource = new Map(), byYear = new Map();
  const enUnderJaByJaCode = new Map(), enUnderJaBySource = new Map();
  const sharedByCode = new Map(), sharedBySource = new Map();

  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const row of resources) {
      scanned++;
      const addr = addressOf(row);
      if (!addr.code) continue;
      const addrMarket = marketOfKey(addr.code);
      if (!addrMarket) continue;              // silent address: no contradiction

      // marketOfRow reads setName + title FIRST, then the row's own stored key
      // and id stem. The stored key IS the address here, so those later
      // witnesses would agree with the address by construction and no row could
      // ever contradict. The TEXT witnesses are the independent ones, so the
      // row is asked with its text only -- the guard's own first branch,
      // isolated, not reimplemented.
      const textMarket = marketOfRow({ setName: row.setName, title: row.title });
      if (!textMarket || textMarket === addrMarket) continue;

      // A row already parked is out of scope: it is in no pool and asserts no
      // identity, so there is nothing left to move.
      if (row.identityUnverified === true) { alreadyParked++; continue; }

      const yr = String(row.year ?? row.cardYear ?? "unknown");
      const src = String(row.source ?? "unknown");

      if (textMarket === "ja" && addrMarket === "en") {
        const res = jaSlugFor(row, addr);
        // A shared-code row is at the address its own vocabulary names. It is
        // counted as a vocabulary gap and never enters the movable population.
        if (res.why === "shared-code-already-correct") {
          sharedCode++;
          sharedByCode.set(addr.code, (sharedByCode.get(addr.code) || 0) + 1);
          sharedBySource.set(src, (sharedBySource.get(src) || 0) + 1);
          continue;
        }
        const to = res.slug, jaCode = res.code && res.slug ? res.code : null;
        jaUnderEn.push({ row, addr, to, jaCode });
        byEnCode.set(addr.code, (byEnCode.get(addr.code) || 0) + 1);
        const jk = jaCode || "(unresolved)";
        byJaCode.set(jk, (byJaCode.get(jk) || 0) + 1);
        bySource.set(src, (bySource.get(src) || 0) + 1);
        byYear.set(yr, (byYear.get(yr) || 0) + 1);
      } else if (textMarket === "en" && addrMarket === "ja") {
        enUnderJa.push({ row, addr });
        enUnderJaByJaCode.set(addr.code, (enUnderJaByJaCode.get(addr.code) || 0) + 1);
        enUnderJaBySource.set(src, (enUnderJaBySource.get(src) || 0) + 1);
      }
    }
    if (scanned % 250000 === 0) {
      console.error(`  ...${f(scanned)} scanned  jaUnderEn=${f(jaUnderEn.length)} enUnderJa=${f(enUnderJa.length)}`);
    }
  }

  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const obj = (m) => Object.fromEntries(sorted(m));

  console.log(`\n=== JA/EN CROSS-MARKET CENSUS (read only) ===`);
  console.log(`pokemon rows scanned      ${f(scanned)}`);
  console.log(`JA-stated under EN code   ${f(jaUnderEn.length)}`);
  console.log(`EN-stated under JA code   ${f(enUnderJa.length)}`);
  console.log(`already parked (skipped)  ${f(alreadyParked)}`);
  console.log(`shared-code, NOT misfiled ${f(sharedCode)}   <- vocabulary gap, left alone`);

  console.log(`\n-- jaUnderEn by EN code (top 30) --`);
  for (const [k, n] of sorted(byEnCode).slice(0, 30)) console.log(`  ${String(k).padEnd(14)} ${f(n)}`);
  console.log(`\n-- jaUnderEn by resolved JA code (top 30) --`);
  for (const [k, n] of sorted(byJaCode).slice(0, 30)) console.log(`  ${String(k).padEnd(14)} ${f(n)}`);
  console.log(`\n-- jaUnderEn by source --`);
  for (const [k, n] of sorted(bySource)) console.log(`  ${String(k).padEnd(24)} ${f(n)}`);
  console.log(`\n-- jaUnderEn by year (top 20) --`);
  for (const [k, n] of sorted(byYear).slice(0, 20)) console.log(`  ${String(k).padEnd(10)} ${f(n)}`);
  console.log(`\n-- enUnderJa by JA code (top 20) --`);
  for (const [k, n] of sorted(enUnderJaByJaCode).slice(0, 20)) console.log(`  ${String(k).padEnd(14)} ${f(n)}`);
  console.log(`\n-- enUnderJa by source --`);
  for (const [k, n] of sorted(enUnderJaBySource)) console.log(`  ${String(k).padEnd(24)} ${f(n)}`);

  // -- the lists ------------------------------------------------------------
  // Uniqueness on (id, fromCardId): sold_comps is partitioned on /cardId, so
  // that pair is what addresses a document. The same id under two partitions
  // is two documents, and both are named.
  const seen = new Set();
  const entries = [];
  let relocate = 0, repoint = 0, park = 0;
  for (const { row, addr, to, jaCode } of jaUnderEn) {
    const from = addr.cid || addr.primary;
    const key = `${row.id} ${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stated = (String(row.setName ?? "").trim() || String(row.title ?? "").trim()).slice(0, 70);
    if (to && jaCode) {
      // WHICH FIELD IS ACTUALLY WRONG DECIDES THE SHAPE.
      //
      // sold_comps is partitioned on /cardId, and for most of this population
      // cardId is a CARDHEDGE VENDOR ID, not a slug -- the EN code lives ONLY
      // in hobbyiqCardId. Those rows are in the RIGHT partition with the WRONG
      // identity, which is the lane's REPOINT shape: a patch in place, no
      // document created, none deleted.
      //
      // Emitting RELOCATE for them would set cardId to a slug the row never
      // lived under -- a new document plus a delete (D19) -- restructuring the
      // CardHedge pool's partitioning as a side effect of a market fix. Only a
      // row whose PARTITION itself carries the EN code truly relocates.
      const partitionIsTheSlug = from.startsWith("hiq:");
      if (partitionIsTheSlug) {
        relocate++;
        entries.push({
          id: row.id, fromCardId: from, toCardId: to, price: row.price,
          evidence: `row states JAPANESE ("${stated}") but its PARTITION is the EN-coded slug ${addr.code}; JA code ${jaCode} resolved from the set name, number segment kept`,
        });
      } else {
        repoint++;
        entries.push({
          id: row.id, fromCardId: from, repointHobbyiqCardId: to, price: row.price,
          evidence: `row states JAPANESE ("${stated}") but its hobbyiqCardId is addressed under EN code ${addr.code}; JA code ${jaCode} resolved from the set name, number segment kept; partition (${from.slice(0, 24)}) is a vendor id and does not move`,
        });
      }
    } else {
      park++;
      entries.push({
        id: row.id, fromCardId: from, parkIdentityUnverified: true, price: row.price,
        evidence: `cross-market:unresolved -- row states JAPANESE ("${stated}") under EN code ${addr.code}, and no JA set code resolves from its set name`,
      });
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rulings = [
    "CF-JA-AND-EN-NEVER-SHARE-A-POOL -- a Japanese print and an English print are different cards, different markets, different prices. One sale, one pool.",
    "CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01) -- the JA destination is the BARE Japanese code (sv2a), resolved through JAPANESE_POKEMON_SET_ALIASES.",
    "CF-THE-ENGLISH-SET-CODE-IS-THE-KEY (Drew, 2026-09-06) -- the EN code these rows sit under is a correct English key; it is the ROW that is in the wrong pool, not the key.",
    "The market predicate is #1915 lib/market-guard.cjs marketOfRow -- the same witnesses, in the same order, that refuse new cross-market moves.",
    "The number segment is KEPT: the Japanese print carries the same N/M number, so only the set-code segment moves.",
    "THE SHAPE FOLLOWS THE WRONG FIELD: where cardId is a vendor id and only hobbyiqCardId carries the EN code, the row is REPOINTED in place; only a row whose PARTITION is the EN-coded slug is RELOCATED.",
    "THE SHARED-CODE SETS ARE NOT MISFILED: 38 of the 230 JA-alias destinations are codes that exist only in the ENGLISH table (jungle -> base2, dark-rush -> bw4), so the two markets share the code string and such a row is ALREADY at the address the JA vocabulary names. Reported as a vocabulary gap; never moved, never parked.",
    "PARK where no JA code resolves -- an unaddressable row is parked (cross-market:unresolved), never guessed onto a plausible code.",
  ];
  const paths = [];
  const chunks = [];
  for (let i = 0; i < entries.length; i += MAX_PER_FILE) chunks.push(entries.slice(i, i + MAX_PER_FILE));
  chunks.forEach((chunk, i) => {
    const name = chunks.length === 1
      ? `${LIST_DATE}-ja-sales-under-en-codes.json`
      : `${LIST_DATE}-ja-sales-under-en-codes-${String(i + 1).padStart(2, "0")}.json`;
    const p = path.join(OUT_DIR, name);
    const body = { generatedAt: new Date().toISOString(), generatedBy: "scripts/census/ja-under-en-census.cjs" };
    if (chunks.length > 1) body.part = `${i + 1} of ${chunks.length}`;
    body.rulings = rulings;
    body.excluded = [];
    body.entries = chunk;
    fs.writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
    paths.push(path.relative(backend, p).replace(/\\/g, "/"));
  });

  console.log(`\n-- lists --`);
  console.log(`  RELOCATE entries        ${f(relocate)}   <- partition itself carries the EN code`);
  console.log(`  REPOINT entries         ${f(repoint)}   <- vendor-id partition, hobbyiqCardId repointed`);
  console.log(`  PARK entries            ${f(park)}`);
  console.log(`  files                   ${paths.length}`);
  for (const p of paths) console.log(`    ${p}`);

  fs.writeFileSync(path.join(backend, "..", "census-summary.json"), JSON.stringify({
    scanned, jaUnderEn: jaUnderEn.length, enUnderJa: enUnderJa.length, alreadyParked,
    sharedCodeNotMisfiled: sharedCode, sharedByCode: obj(sharedByCode), sharedBySource: obj(sharedBySource),
    byEnCode: obj(byEnCode), byJaCode: obj(byJaCode), bySource: obj(bySource),
    byYear: obj(byYear), enUnderJaByJaCode: obj(enUnderJaByJaCode),
    enUnderJaBySource: obj(enUnderJaBySource), relocate, repoint, park, listPaths: paths,
  }, null, 2) + "\n");
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
