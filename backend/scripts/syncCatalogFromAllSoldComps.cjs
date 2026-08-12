// CF-SYNC-CATALOG-FROM-SOLD-COMPS-ALL (Drew, 2026-08-11). Global stub
// creator: for EVERY distinct hobbyiqCardId in sold_comps that meets a
// minimum-comp-count threshold and has NO catalog row, insert a stub.
// This ensures every physical card variant we've seen sales for has an
// identity anchor — parallels, autos, grade tiers all included.
//
// The prior sold-comps-stubs script required a PRODUCTS whitelist for
// safety; this variant runs full-catalog and is intended for the
// authorized "make every observed sale findable" sweep. Uses source
// tag 'sold-comps-stub-YYYY-MM-DD' so we can identify + upgrade to
// authoritative rows later when a checklist arrives.
//
// Env: APPLY=true; MIN_COMPS=3 (default); CONCURRENCY=8

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "cardCatalog.service.js"));

const APPLY = process.env.APPLY === "true";
const MIN_COMPS = Number(process.env.MIN_COMPS || 3);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const MAX_STUBS = Number(process.env.MAX_STUBS || 500000);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");
  const sold = db.container("sold_comps");
  const catalog = db.container("card_catalog");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  minComps=${MIN_COMPS}  concurrency=${CONCURRENCY}  maxStubs=${MAX_STUBS.toLocaleString()}`);

  // Step 1: page through sold_comps, aggregate (slug, count, playerNames)
  console.log("\n[step 1] scanning sold_comps to enumerate slugs + player names");
  const slugData = new Map();
  const iter = sold.items.query({
    query: `SELECT c.hobbyiqCardId, c.playerName FROM c WHERE IS_STRING(c.hobbyiqCardId)`,
  }, { maxItemCount: 500 });
  let scanned = 0;
  const t0 = Date.now();
  async function fetchWithRetry(tries = 5) {
    for (let i = 0; i < tries; i++) {
      try { return await iter.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) {
          const wait = (err.retryAfterInMs || 1000 * (i + 1)) + 200;
          await new Promise(r => setTimeout(r, wait)); continue;
        }
        throw err;
      }
    }
    throw new Error("retries exhausted");
  }
  while (iter.hasMoreResults()) {
    const { resources } = await fetchWithRetry();
    for (const r of resources) {
      scanned++;
      const s = slugData.get(r.hobbyiqCardId) ?? { count: 0, players: new Map() };
      s.count++;
      const pn = String(r.playerName || "").trim();
      if (pn && pn.length > 1) s.players.set(pn, (s.players.get(pn) || 0) + 1);
      slugData.set(r.hobbyiqCardId, s);
    }
    if (scanned % 200000 === 0) {
      const dur = ((Date.now() - t0)/1000).toFixed(0);
      console.log(`   scanned ${scanned.toLocaleString()}  distinct=${slugData.size.toLocaleString()}  ${dur}s`);
    }
  }
  console.log(`   TOTAL scanned=${scanned.toLocaleString()}  distinct slugs=${slugData.size.toLocaleString()}`);

  // Step 2: filter to eligible slugs
  const eligible = [...slugData.entries()].filter(([_, v]) => v.count >= MIN_COMPS);
  console.log(`\n[step 2] eligible slugs (>= ${MIN_COMPS} comps): ${eligible.length.toLocaleString()}`);
  eligible.sort((a, b) => b[1].count - a[1].count);
  if (eligible.length > MAX_STUBS) {
    console.log(`   capped to top ${MAX_STUBS.toLocaleString()} by comp count`);
    eligible.length = MAX_STUBS;
  }

  // Step 3: check catalog + write stubs
  console.log(`\n[step 3] ${APPLY ? "writing" : "would write"} catalog stubs`);
  let wrote = 0, existed = 0, missingPlayer = 0, failed = 0;
  const inflight = [];
  for (const [slug, agg] of eligible) {
    const topPlayer = [...agg.players.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!topPlayer) { missingPlayer++; continue; }
    const parts = slug.split(":");
    if (parts.length < 7) { missingPlayer++; continue; }
    const sport = parts[1], year = Number(parts[2]), setKey = parts[3];
    const cardNumber = parts[4], parallel = parts[5], autoFlag = parts[6];
    const printRun = parts[7] && parts[7].startsWith("num-") ? Number(parts[7].slice(4)) : null;

    const task = (async () => {
      // Catalog check
      // CF-STUB-EXISTS-POINT-READ (Drew, 2026-08-12). Was a CROSS-PARTITION
      // COUNT per slug. Over ~10^5 slugs that is 10^5 fan-out queries against
      // a 25M-row container — the same shape that had the TCA webhook
      // sustaining 145k RU/s. card_catalog keys canonical rows as
      // id === cardId === slug, so existence is a ~1 RU point read.
      // Measured: ~1ms vs seconds for the query form.
      let exists = false;
      try {
        const { resource } = await catalog.item(slug, slug).read();
        exists = Boolean(resource);
      } catch { exists = false; } // 404 => absent
      if (exists) { existed++; return; }

      const entry = deriveCatalogEntry({
        sport, year, setKey,
        cardNumber, parallel, isAuto: autoFlag === "auto", printRun,
        playerName: topPlayer,
        source: `sold-comps-stub-${new Date().toISOString().slice(0,10)}`,
        // CF-STUB-CONFIDENCE-NUMERIC (Drew, 2026-08-12). Was the STRING
        // "low" in a field typed as a number. upsertCatalogEntry decides
        // winners with `entry.confidence > existing.confidence`, and any
        // comparison against a string is false — so stubs could never lose
        // OR win predictably, and every downstream consumer of confidence
        // (source-priority dedup, catalog-verify boost hierarchy) saw a
        // non-numeric value. 0.35 sits below every real source:
        // cardhedge/cardsight 0.85, ch-catalog 0.80, user-verified 0.98.
        confidence: 0.35,
        vendorIds: {},
      });
      if (!entry) { missingPlayer++; return; }

      // CF-CATALOG-SEARCH-TIERS (Drew, 2026-08-12). These rows exist so sold
      // comps have something to roll up to — they power a card's pricing and
      // trend. They are NOT checklist-backed, so they must never surface as
      // ordinary search results. Two independent markers carry that:
      //   source: sold-comps-stub-<date>   (provenance — the primary test)
      //   verificationStatus: pending-review
      // catalogVisibility.ts tiers on both, and search only returns the
      // verified tier, falling back to these when nothing verified matched.
      // Without this stamp the sweep would repeat the `sales-derived`
      // mistake (purged 2026-08-08) at ~10^5 rows.
      entry.verificationStatus = "pending-review";

      if (!APPLY) { wrote++; return; }
      try { await upsertCatalogEntry(entry); wrote++; }
      catch (e) { failed++; if (failed < 5) console.warn(`   fail ${slug}: ${e.message||e}`); }
    })().finally(() => {
      const idx = inflight.indexOf(task);
      if (idx >= 0) inflight.splice(idx, 1);
    });
    inflight.push(task);
    if (inflight.length >= CONCURRENCY) await Promise.race(inflight);

    if ((wrote + existed) % 5000 === 0 && (wrote + existed) > 0) {
      const dur = ((Date.now() - t0)/1000).toFixed(0);
      console.log(`   progress: wrote=${wrote.toLocaleString()} existed=${existed.toLocaleString()} failed=${failed}  ${dur}s`);
    }
  }
  await Promise.all(inflight);
  const dur = ((Date.now() - t0)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] wrote=${wrote.toLocaleString()} existed=${existed.toLocaleString()} missing-player=${missingPlayer} failed=${failed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
