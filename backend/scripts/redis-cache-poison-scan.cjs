/**
 * CF-ROUTE-CACHE-VALIDATION (2026-06-08): READ-ONLY Redis poison scan.
 *
 * Scans the two cache namespaces that wrap Cardsight pricing data and
 * reports any entry whose payload's card_id doesn't match the cache
 * key's id (the failure mode that produced the Trout-as-Frazier
 * pathology). NEVER writes; never deletes; never prints secrets.
 *
 * Usage (Windows, from repo root):
 *
 *   $env:REDIS_HOST = "$(az webapp config appsettings list -g rg-hobbyiq-dev `
 *     -n HobbyIQ3 --query \"[?name=='REDIS_HOST'].value | [0]\" -o tsv)"
 *   $env:REDIS_PORT = "$(az webapp config appsettings list -g rg-hobbyiq-dev `
 *     -n HobbyIQ3 --query \"[?name=='REDIS_PORT'].value | [0]\" -o tsv)"
 *   $env:REDIS_KEY  = "$(az webapp config appsettings list -g rg-hobbyiq-dev `
 *     -n HobbyIQ3 --query \"[?name=='REDIS_KEY'].value | [0]\" -o tsv)"
 *   $env:REDIS_TLS  = "$(az webapp config appsettings list -g rg-hobbyiq-dev `
 *     -n HobbyIQ3 --query \"[?name=='REDIS_TLS'].value | [0]\" -o tsv)"
 *   node backend/scripts/redis-cache-poison-scan.cjs
 *
 * Run post-deploy or whenever wrong-card data is reported by users.
 * Expected output in a healthy cache: 0 poisoned entries across both
 * namespaces.
 *
 * Namespaces scanned:
 *   - cs:pricing:<cardId>:<parallelId>
 *       Inner Cardsight pricing cache. Payload shape:
 *       { _v: { card: { card_id, name, set:{...} }, raw, graded, meta },
 *         _ts: epoch_ms }
 *
 *   - compiq:price-by-id:v4:<cardId>|<gradeCo><gradeVal>
 *       Route-level /api/compiq/price-by-id response cache. Payload:
 *       { _v: { cardsightCardId, cardIdentity:{card_id,...}, marketTier,
 *               recentComps, ... }, _ts: epoch_ms }
 *
 * Mismatch rule (BOTH namespaces): the key's <cardId> portion must equal
 * the payload's card_id field. Anything else is poison.
 */

const path = require("path");
const Redis = require(path.resolve(__dirname, "..", "node_modules", "ioredis"));

async function main() {
  const host = process.env.REDIS_HOST;
  const port = Number(process.env.REDIS_PORT ?? 6380);
  const key  = process.env.REDIS_KEY;
  const tls  = process.env.REDIS_TLS !== "false";
  if (!host || !key) {
    console.error("REDIS_HOST and REDIS_KEY env vars are required.");
    process.exit(1);
  }

  const client = new Redis({
    host, port, password: key,
    tls: tls ? {} : undefined,
    enableReadyCheck: true, maxRetriesPerRequest: 2,
    connectTimeout: 5000, lazyConnect: true,
  });
  await client.connect();
  console.log("Connected to Redis at", host + ":" + port, "TLS=" + tls);

  // ─── cs:pricing namespace ──────────────────────────────────────────────
  const csKeys = [];
  for await (const batch of client.scanStream({ match: "cs:pricing:*", count: 500 })) {
    csKeys.push(...batch);
  }
  let csPoisoned = 0;
  let csClean = 0;
  let csUnknown = 0;
  const csPoisonedSamples = [];
  for (const k of csKeys) {
    // Key shape: cs:pricing:<cardId>:<parallelId>
    const parts = k.split(":");
    if (parts.length < 3) { csUnknown++; continue; }
    const keyCardId = parts[2];
    const raw = await client.get(k);
    let payload = null;
    try { payload = JSON.parse(raw); } catch { csUnknown++; continue; }
    const v = payload && payload._v;
    if (!v || !v.card) { csUnknown++; continue; }
    // Cardsight's pricing payload uses snake-case `card_id`; legacy entries
    // (pre-2026-06-07) wrote `id` under the old CardsightCatalogResult type.
    const cardId = v.card.card_id || v.card.id || null;
    if (!cardId) { csUnknown++; continue; }
    if (cardId !== keyCardId) {
      csPoisoned++;
      if (csPoisonedSamples.length < 25) {
        csPoisonedSamples.push({
          key: k,
          keyCardId,
          payloadCardId: cardId,
          payloadName: v.card.name || null,
          payloadNumber: v.card.number || null,
          ageMs: payload._ts ? Date.now() - payload._ts : null,
        });
      }
    } else {
      csClean++;
    }
  }

  // ─── compiq:price-by-id:v4 namespace ───────────────────────────────────
  const routeKeys = [];
  for await (const batch of client.scanStream({ match: "compiq:price-by-id:v4:*", count: 500 })) {
    routeKeys.push(...batch);
  }
  let routePoisoned = 0;
  let routeClean = 0;
  let routeUnknown = 0;
  const routePoisonedSamples = [];
  for (const k of routeKeys) {
    // Key shape: compiq:price-by-id:v4:<cardId>|<gradeCo><gradeVal>
    const afterPrefix = k.replace(/^compiq:price-by-id:v4:/, "");
    const keyCardId = afterPrefix.split("|")[0];
    const raw = await client.get(k);
    let payload = null;
    try { payload = JSON.parse(raw); } catch { routeUnknown++; continue; }
    const v = payload && payload._v;
    if (!v) { routeUnknown++; continue; }
    const id = v.cardIdentity || null;
    const cardId = id && id.card_id ? id.card_id : null;
    if (!cardId) {
      // No identity surfaced — common on the unresolved-source branches.
      // Don't flag; can't validate.
      routeUnknown++;
      continue;
    }
    if (cardId !== keyCardId) {
      routePoisoned++;
      if (routePoisonedSamples.length < 25) {
        routePoisonedSamples.push({
          key: k,
          keyCardId,
          cardIdentityCardId: cardId,
          cardIdentityPlayer: id.player || null,
          cardIdentityNumber: id.number || null,
          ageMs: payload._ts ? Date.now() - payload._ts : null,
        });
      }
    } else {
      routeClean++;
    }
  }

  console.log("\n========================================");
  console.log("cs:pricing namespace");
  console.log("========================================");
  console.log("  total keys:        ", csKeys.length);
  console.log("  clean (id-match):  ", csClean);
  console.log("  POISONED:          ", csPoisoned);
  console.log("  unknown shape:     ", csUnknown);
  if (csPoisonedSamples.length > 0) {
    console.log("\npoisoned cs:pricing samples (up to 25):");
    for (const s of csPoisonedSamples) console.log(" ", JSON.stringify(s));
  }

  console.log("\n========================================");
  console.log("compiq:price-by-id:v4 namespace");
  console.log("========================================");
  console.log("  total keys:        ", routeKeys.length);
  console.log("  clean (id-match):  ", routeClean);
  console.log("  POISONED:          ", routePoisoned);
  console.log("  unknown shape:     ", routeUnknown);
  if (routePoisonedSamples.length > 0) {
    console.log("\npoisoned route-cache samples (up to 25):");
    for (const s of routePoisonedSamples) console.log(" ", JSON.stringify(s));
  }

  await client.quit();
  console.log("\nSCAN COMPLETE — read-only, no DELs issued.");
  // Exit non-zero if anything is poisoned so CI / cron can alert.
  if (csPoisoned + routePoisoned > 0) process.exit(2);
}

main().catch((e) => {
  console.error("FAILED:", e && e.message ? e.message : String(e));
  if (e && e.stack) console.error(e.stack);
  process.exit(99);
});
