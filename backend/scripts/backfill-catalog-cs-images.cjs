#!/usr/bin/env node
// CF-BACKFILL-CATALOG-CS-IMAGES (Drew, 2026-08-01).
//
// Drew's rule: keep imageless catalog rows (some cards genuinely lack
// vendor images), but ORGANIZE the catalog so image availability is
// explicit — no ambiguity between "not probed" and "no image exists".
//
// CS's /v1/catalog/cards endpoint doesn't include images — they live
// at /v1/images/cards/{id}, which returns 200 for ~28% of cards and
// 404 for the rest.
//
// SCOPE (revised 2026-08-01): every CS-source row that hasn't been
// probed yet, NOT just __expandedFromCardsight enumeration rows. The
// 1.47M rows previously called "junk" turned out to be 99.2% real
// catalog observations from persistVendorCatalog side-effects — they
// deserve the same image + schema treatment.
//
// For each row:
//   - probe /v1/images/cards/{id}
//   - on 200: set imageUrl to our /api/compiq/card-image/{id} proxy,
//             mark __hasImage=true, __imageProbedAt
//   - on 404: mark __hasImage=false, __imageProbedAt (row stays in
//             the catalog; search can filter/sort by __hasImage)
//
// Idempotent — only touches rows without __imageProbedAt marker.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   CARDSIGHT_API_KEY          required (never echoed)
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel probes (default 8)
//   PROXY_ORIGIN               default https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const PROXY_ORIGIN = process.env.PROXY_ORIGIN || "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

if (!process.env.CARDSIGHT_API_KEY) { console.error("CARDSIGHT_API_KEY required"); process.exit(2); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const CS_API = "https://api.cardsight.ai/v1";
const CS_KEY = process.env.CARDSIGHT_API_KEY;
const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function probeImage(cardId) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    // HEAD would be cheaper but many APIs don't implement it; use GET
    // and abort read after headers via low timeout.
    const res = await fetch(`${CS_API}/images/cards/${cardId}`, {
      method: "GET",
      headers: { "X-API-Key": CS_KEY },
      signal: controller.signal,
    });
    if (res.status === 200) {
      const ct = res.headers.get("content-type") || "";
      // Consume body to free connection (small JPEGs, fast)
      await res.arrayBuffer().catch(() => {});
      return ct.startsWith("image/") ? "has_image" : "not_image";
    }
    if (res.status === 404) return "no_image";
    if (res.status === 429) return "rate_limited";
    return "other_" + res.status;
  } catch (e) {
    if (e.name === "AbortError") return "timeout";
    return "error";
  } finally {
    clearTimeout(t);
  }
}

async function withRetry429(fn, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const r = await fn();
    if (r !== "rate_limited") return r;
    await new Promise(res => setTimeout(res, 3000 + Math.random() * 2000));
  }
  return "rate_limited";
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[backfill-catalog-cs-images]  apply=${APPLY}  concurrency=${CONCURRENCY}  maxMinutes=${MAX_MINUTES}`);

  // Every CS-source row that hasn't been probed. Includes both the
  // __expandedFromCardsight enumeration rows AND the older
  // persistVendorCatalog observations (previously mis-labeled "junk").
  const query = "SELECT c.id, c.cardId FROM c " +
                "WHERE c.source = 'cardsight' " +
                "AND (NOT IS_DEFINED(c.__imageProbedAt))";

  const iter = cc.items.query({ query }, { maxItemCount: 500 });

  const stats = { scanned: 0, hasImage: 0, noImage: 0, errors: 0, other: 0 };
  const inFlight = [];

  async function processRow(row) {
    if (!UUID_RE.test(row.cardId)) { stats.other++; return; }
    const result = await withRetry429(() => probeImage(row.cardId));
    const nowIso = new Date().toISOString();
    if (result === "has_image") {
      stats.hasImage++;
      if (!APPLY) return;
      try {
        const { resource } = await cc.item(row.id, row.cardId).read();
        if (!resource) return;
        resource.imageUrl = `${PROXY_ORIGIN}/api/compiq/card-image/${row.cardId}`;
        resource.__hasImage = true;
        resource.__imageProbedAt = nowIso;
        await cc.items.upsert(resource);
      } catch { stats.errors++; }
    } else if (result === "no_image") {
      stats.noImage++;
      if (!APPLY) return;
      try {
        const { resource } = await cc.item(row.id, row.cardId).read();
        if (!resource) return;
        resource.__hasImage = false;
        resource.__imageProbedAt = nowIso;
        await cc.items.upsert(resource);
      } catch { stats.errors++; }
    } else {
      stats.other++;
    }
  }

  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ time cap reached"); break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      stats.scanned++;
      inFlight.push(processRow(row).catch(() => { stats.errors++; }));
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
      if (stats.scanned % 500 === 0) {
        console.log(`  scanned=${stats.scanned}  hasImage=${stats.hasImage}  deleted=${stats.deleted}  errors=${stats.errors}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:   ${stats.scanned}`);
  console.log(`  hasImage:  ${stats.hasImage}  (imageUrl set to proxy URL, __hasImage=true)`);
  console.log(`  noImage:   ${stats.noImage}  (kept in catalog, __hasImage=false)`);
  console.log(`  other:     ${stats.other}  (non-UUID cardId, timeouts, unexpected status)`);
  console.log(`  errors:    ${stats.errors}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  if (timeExpired()) console.log(`RELAUNCH_NEEDED=true`);
  else console.log(`RELAUNCH_NEEDED=false`);
}

main().catch(e => { console.error(e); process.exit(1); });
