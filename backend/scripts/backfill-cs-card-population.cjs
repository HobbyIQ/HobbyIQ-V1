#!/usr/bin/env node
// CF-BACKFILL-CS-CARD-POPULATION (Drew, 2026-08-01).
//
// Fills the card_population container (256 rows → hopefully millions)
// by iterating CS-source card_catalog rows and hitting
// /population/card/{cardId} on Cardsight's API for each. Population
// data is the scarcity anchor for rare-card FMV projection and grade-
// multiplier tightening.
//
// Simpler than backend/scripts/cardsight-bulk/phase-c-crawl-population.cjs
// — no state-file dependency, directly walks card_catalog. Idempotent
// via __populationProbedAt marker on card_catalog rows.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   CARDSIGHT_API_KEY          required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 6)
//   POP_MIN_CARD_YEAR          skip rows with year older than this (default 1990)

const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 6));
const MIN_YEAR = Math.max(1900, Number(process.env.POP_MIN_CARD_YEAR || 1990));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
if (!process.env.CARDSIGHT_API_KEY) { console.error("CARDSIGHT_API_KEY required"); process.exit(2); }

const CS_BASE = "https://api.cardsight.ai/v1";
const CS_KEY = process.env.CARDSIGHT_API_KEY;
const START = Date.now();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function csPopulation(cardId) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${CS_BASE}/population/card/${cardId}`, {
      headers: { "X-API-Key": CS_KEY, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) { return { error: e.message }; }
  finally { clearTimeout(t); }
}

function contentHashOf(...parts) {
  return crypto.createHash("md5").update(parts.map(String).join("|")).digest("hex").slice(0, 12);
}

async function withRetry(fn, attempts = 4, baseMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cc = db.container("card_catalog");
  const popContainer = db.container("card_population");
  console.log(`[backfill-cs-card-population] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES} minYear=${MIN_YEAR}`);

  // Iterate CS-source rows without __populationProbedAt, year >= MIN_YEAR
  const query = "SELECT c.id, c.cardId, c.year, c.player, c.playerName, c.setName " +
                "FROM c WHERE c.source = 'cardsight' " +
                "AND (NOT IS_DEFINED(c.__populationProbedAt)) " +
                "AND IS_DEFINED(c.cardId) AND c.cardId != null " +
                "AND (c.year >= @minYear OR c.year = null)";
  const iter = cc.items.query({ query, parameters: [{ name: "@minYear", value: MIN_YEAR }] }, { maxItemCount: 500 });

  const stats = { scanned: 0, probed: 0, hasPopulation: 0, notFound: 0, docsUpserted: 0, errors: 0, skippedNonUuid: 0 };
  const errorReasons = new Map();   // {reason -> count}
  const inFlight = [];

  async function processRow(row) {
    if (!UUID_RE.test(row.cardId)) {
      stats.skippedNonUuid++;
      // Mark so we don't re-scan on next slice
      if (APPLY) {
        try {
          const { resource } = await cc.item(row.id, row.cardId).read();
          if (resource) {
            resource.__populationProbedAt = new Date().toISOString();
            resource.__populationSkipReason = "non-uuid-cardid";
            await cc.items.upsert(resource);
          }
        } catch {}
      }
      return;
    }
    stats.probed++;
    const resp = await csPopulation(row.cardId);
    const nowIso = new Date().toISOString();
    if (resp?.error) {
      stats.errors++;
      errorReasons.set(resp.error, (errorReasons.get(resp.error) || 0) + 1);
      return;
    }
    if (resp?.notFound) {
      if (APPLY) {
        try {
          const { resource } = await cc.item(row.id, row.cardId).read();
          if (resource) {
            resource.__populationProbedAt = nowIso;
            resource.__populationFound = false;
            await cc.items.upsert(resource);
          }
        } catch { stats.errors++; }
      }
      stats.notFound++;
      return;
    }
    stats.hasPopulation++;
    // CF-POP-RESPONSE-SHAPE-FIX (Drew, 2026-08-01). Grading companies
    // live under resp.base.grading_companies, NOT resp.grading_companies.
    // Confirmed via direct probe: response is
    //   { card_id, card_name, total_population, base: { total_population, grading_companies: [...] }, parallels: [...] }
    const companies = resp?.base?.grading_companies || resp?.grading_companies || [];
    if (!companies.length) {
      if (APPLY) {
        try {
          const { resource } = await cc.item(row.id, row.cardId).read();
          if (resource) {
            resource.__populationProbedAt = nowIso;
            resource.__populationFound = false;
            await cc.items.upsert(resource);
          }
        } catch { stats.errors++; }
      }
      return;
    }
    // Persist a doc per (cardId, company)
    if (APPLY) {
      for (const co of companies) {
        const doc = {
          id: `card::${row.cardId}::${co.id}`,
          cardId: row.cardId,
          releaseId: row.releaseId ?? null,
          level: "card",
          sport: row.sport ?? null,
          year: row.year ?? null,
          playerName: row.playerName ?? row.player ?? null,
          setName: row.setName ?? null,
          gradingCompanyId: co.id,
          gradingCompanyName: co.name,
          totalPopulation: co.total_population || 0,
          basePopulation: resp?.base?.total_population ?? null,
          totalPopulationAllCompanies: resp?.total_population ?? null,
          gradingTypes: co.grading_types || [],
          parallels: (resp?.parallels || []).map(p => ({
            id: p.id,
            name: p.name,
            totalPopulation: p.total_population,
          })),
          lastSyncedAt: co.last_synced_at ?? null,
          contentHash: contentHashOf(row.cardId, co.id, co.total_population, co.last_synced_at),
          probedAt: nowIso,
        };
        try {
          await withRetry(() => popContainer.items.upsert(doc));
          stats.docsUpserted++;
        } catch { stats.errors++; }
      }
      // Mark card_catalog row as probed
      try {
        const { resource } = await cc.item(row.id, row.cardId).read();
        if (resource) {
          resource.__populationProbedAt = nowIso;
          resource.__populationFound = true;
          resource.__populationCompanies = companies.length;
          await cc.items.upsert(resource);
        }
      } catch { stats.errors++; }
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
        console.log(`  scanned=${stats.scanned} probed=${stats.probed} hasPop=${stats.hasPopulation} notFound=${stats.notFound} docs=${stats.docsUpserted} err=${stats.errors}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:         ${stats.scanned}`);
  console.log(`  skippedNonUuid:  ${stats.skippedNonUuid}`);
  console.log(`  probed:          ${stats.probed}`);
  console.log(`  hasPopulation:   ${stats.hasPopulation}`);
  console.log(`  notFound:        ${stats.notFound}`);
  console.log(`  docsUpserted:    ${stats.docsUpserted}`);
  console.log(`  errors:          ${stats.errors}`);
  if (errorReasons.size > 0) {
    console.log(`  Top error reasons:`);
    for (const [reason, count] of [...errorReasons.entries()].sort((a,b) => b[1] - a[1]).slice(0, 5)) {
      console.log(`    ${count.toString().padStart(6)}  ${reason}`);
    }
  }
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  if (timeExpired()) console.log(`RELAUNCH_NEEDED=true`);
  else console.log(`RELAUNCH_NEEDED=false`);
}

main().catch(e => { console.error(e); process.exit(1); });
