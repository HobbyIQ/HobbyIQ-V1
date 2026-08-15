#!/usr/bin/env node
/**
 * CF-CATALOG-SIBLING-IMAGES (Drew, 2026-08-15). Recover images the
 * catalog ALREADY has but cannot reach, by copying them across
 * fragmented duplicate rows of the same card.
 *
 * THE CASE THAT FOUND THIS. "2018 Topps Chrome Update Shohei Ohtani
 * #HMT1" renders a blank placeholder on the card page. The catalog holds
 * 35 rows for that one card. Exactly ONE carries an image (source
 * tcdb-scrape, setKey "topps-chrome"); the row search actually resolves
 * to (setKey "topps-chrome-update") has none, as do 24 cardhedge-graded
 * duplicates. The picture was never missing — it was stranded on a
 * sibling with a differently-normalized setKey.
 *
 * MATCH KEY — deliberately tight:
 *   year + cardNumber + playerName + parallel + isAuto
 *
 * parallel and isAuto are NOT optional. A looser key (year + number +
 * player alone) matched an average of 287 rows per card instead of 121,
 * and the extra matches were other parallels. Parallels genuinely look
 * different, so grafting a Base image onto a Refractor row would put a
 * confidently WRONG picture on the card — worse than a blank, because
 * the catalog's job is letting someone confirm "yes, that is my card".
 * A wrong image quietly defeats that.
 *
 * Why so many legitimate siblings remain at the tight key: graded rows
 * are stored one-per-grade (PSA 9, PSA 10, BGS 9.5 ...) for the same
 * physical card design. Those share artwork, so sharing the image is
 * correct, not a compromise.
 *
 * DRIVEN FROM THE IMAGED SIDE. Iterating the ~283K rows that HAVE an
 * image and fanning out to their siblings costs a fraction of scanning
 * 35.4M imageless rows to ask each one whether a picture exists.
 *
 * ONLY-FILL, NEVER-OVERWRITE — same asymmetry as the slug sweep's
 * only-improve rule. A row that already has art keeps it.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/graft-catalog-sibling-images.cjs
 *     [--apply] [--concurrency=12] [--limit=N]
 *
 * Defaults to DRY-RUN. Nothing is written without --apply.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

/**
 * Hosts whose images were confirmed to load by actually requesting them.
 * A donor outside this list is skipped rather than spread.
 *
 * Verified 2026-08-15:
 *   cdn.bubble.io (CardHedge)   200 image/jpeg  — 244,399 catalog rows
 *   i.ebayimg.com               200 image/jpeg
 *   cloudfront.net (Cardsight)  200 image/jpeg 898KB
 *
 * DELIBERATELY EXCLUDED — these are already in the catalog and are dead:
 *   www.tcdb.com          403 on every variant, with and without a
 *                         Referer header. Hotlink-protected, so it can
 *                         never render in a browser. 3,059 rows.
 *   <our own host>/api/compiq/card-image/<uuid>
 *                         404 on every id tested. This is the Cardsight
 *                         proxy that compiq.routes.ts already documents
 *                         as "always 404s". 31,958 rows.
 *
 * Both would have rendered as broken images, and the graft fans each
 * donor out to ~120 siblings — so spreading them would have multiplied
 * roughly 35K dead URLs into millions. Allowlist, don't denylist: a new
 * unverified host should fail closed.
 */
const ALLOWED_IMAGE_HOSTS = [
  /(^|\.)cdn\.bubble\.io$/i,
  /(^|\.)i\.ebayimg\.com$/i,
  /(^|\.)cloudfront\.net$/i,
];

/** Force TLS, since a browser blocks mixed-content images on our https
 *  site and the picture silently never renders. */
function secure(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return null;
  const https = u.replace(/^http:\/\//i, "https://");
  let host;
  try { host = new URL(https).host; } catch { return null; }
  if (!ALLOWED_IMAGE_HOSTS.some((re) => re.test(host))) return null;
  return https;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");

  const APPLY = has("apply");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "12")));
  const LIMIT = Number(arg("limit", "0")) || Infinity;
  console.log(`[sibling-images] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}${LIMIT !== Infinity ? ` limit=${LIMIT}` : ""}`);

  const iter = cat.items.query({
    query: `SELECT c.year, c.cardNumber, c.playerName, c.parallel, c.isAuto, c.imageUrl
            FROM c
            WHERE IS_DEFINED(c.imageUrl) AND NOT IS_NULL(c.imageUrl) AND c.imageUrl != ""
              AND IS_DEFINED(c.playerName) AND NOT IS_NULL(c.playerName)
              AND IS_DEFINED(c.cardNumber) AND NOT IS_NULL(c.cardNumber)
              AND IS_DEFINED(c.year) AND NOT IS_NULL(c.year)`,
  }, { maxItemCount: 500 });

  const tot = { donors: 0, rejectedHost: 0, keys: 0, siblings: 0, patched: 0, failed: 0 };
  const seenKey = new Set();
  const inflight = new Set();
  const samples = [];

  while (iter.hasMoreResults() && tot.donors < LIMIT) {
    const { resources } = await iter.fetchNext();
    for (const d of resources || []) {
      if (tot.donors >= LIMIT) break;
      tot.donors++;
      const img = secure(d.imageUrl);
      if (!img) { tot.rejectedHost++; continue; }

      const parallel = d.parallel ?? "Base";
      const isAuto = d.isAuto ?? false;
      const key = `${d.year}|${d.cardNumber}|${d.playerName}|${parallel}|${isAuto}`;
      if (seenKey.has(key)) continue; // one fan-out per distinct card
      seenKey.add(key);
      tot.keys++;

      const q = {
        query: `SELECT c.id, c.cardId FROM c
                WHERE c.year=@y AND c.cardNumber=@n AND c.playerName=@p
                  AND c.parallel=@par AND c.isAuto=@a
                  AND (NOT IS_DEFINED(c.imageUrl) OR IS_NULL(c.imageUrl) OR c.imageUrl="")`,
        parameters: [
          { name: "@y", value: d.year }, { name: "@n", value: d.cardNumber },
          { name: "@p", value: d.playerName }, { name: "@par", value: parallel },
          { name: "@a", value: isAuto },
        ],
      };
      const rows = [];
      const it2 = cat.items.query(q, { maxItemCount: 1000 });
      while (it2.hasMoreResults()) {
        const { resources: r2 } = await it2.fetchNext();
        rows.push(...(r2 || []));
      }
      if (!rows.length) continue;
      tot.siblings += rows.length;
      if (samples.length < 6) samples.push(`${d.year} ${d.playerName} #${d.cardNumber} ${parallel}${isAuto ? " AUTO" : ""} -> ${rows.length} row(s)`);
      if (!APPLY) continue;

      for (const row of rows) {
        while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
        const p = cat.item(row.id, row.cardId).patch([
          { op: "add", path: "/imageUrl", value: img },
          { op: "add", path: "/imageSource", value: "catalog-sibling-graft" },
          { op: "add", path: "/imageBackfilledAt", value: new Date().toISOString() },
        ])
          .then(() => { tot.patched++; })
          .catch((e) => {
            tot.failed++;
            if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
    process.stderr.write(`\rdonors=${tot.donors} cards=${tot.keys} siblings=${tot.siblings} patched=${tot.patched}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  console.log(`\n  donor rows scanned      ${tot.donors}`);
  console.log(`  distinct cards          ${tot.keys}`);
  console.log(`  imageless siblings      ${tot.siblings}`);
  console.log(`  patched                 ${APPLY ? `${tot.patched} (failed ${tot.failed})` : "(dry-run)"}`);
  console.log("\n  sample grafts:");
  for (const s of samples) console.log(`    ${s}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
