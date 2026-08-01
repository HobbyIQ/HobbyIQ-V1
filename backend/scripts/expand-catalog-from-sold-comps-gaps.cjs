#!/usr/bin/env node
// CF-EXPAND-CATALOG-FROM-GAPS (Drew, 2026-08-01).
//
// The catalog covers ~30K keys but sold_comps has ~200K unique
// (player, year) tuples. Stage 2 backfill "not in catalog" is 2.1M
// rows — every one of them a card we can't safely canonicalize
// because we don't know CH's authoritative set for its (year, cardNumber).
//
// This script closes that gap. It:
//   1. Reads distinct (playerName, cardYear) tuples from sold_comps
//   2. Filters to tuples NOT already in card_catalog
//   3. For each, calls CH's searchCards(query=`${player} ${year}`)
//   4. Persists every returned card to card_catalog with source="cardhedge"
//   5. Checkpoints progress in a Cosmos doc so re-invocations resume
//
// Self-relaunching via the backfill-runner workflow — designed to
// run again and again until the gap is closed.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   CARD_HEDGE_API_KEY         required (never echoed)
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_BATCH_SIZE        tuples per invocation (default 3000)
//   BACKFILL_CONCURRENCY       parallel CH searches (default 4)

const { CosmosClient } = require("@azure/cosmos");

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const BATCH_SIZE = Math.max(100, Number(process.env.BACKFILL_BATCH_SIZE || 3000));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 4));
const CHECKPOINT_ID = "expand-catalog-from-sold-comps-gaps::checkpoint";

if (!process.env.CARD_HEDGE_API_KEY) {
  console.error("CARD_HEDGE_API_KEY required — cannot search CH");
  process.exit(2);
}

const CH_API = "https://api.cardhedger.com/v1";

async function chSearchCards(query, limit = 25) {
  const url = `${CH_API}/search/cards?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.CARD_HEDGE_API_KEY,
    },
  });
  if (!res.ok) {
    if (res.status === 429) return { _rateLimited: true };
    return null;
  }
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.cards) ? body.cards : Array.isArray(body) ? body : null;
}

async function withRetry(fn, attempts = 4, baseMs = 400) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r && r._rateLimited) {
        await new Promise(res => setTimeout(res, 5000 + Math.random() * 3000));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 200));
    }
  }
  throw lastErr;
}

function slugContentHash(source, cardId) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(`${source}::${cardId}`).digest("hex").slice(0, 8);
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sc = db.container("sold_comps");
  const cc = db.container("card_catalog");

  console.log(`[expand-catalog-from-gaps]  mode=${MODE}  batchSize=${BATCH_SIZE}  concurrency=${CONCURRENCY}`);

  // Load checkpoint (resume from last-processed tuple)
  let checkpoint = { lastProcessedIndex: 0, totalPersisted: 0, totalTuples: 0 };
  try {
    const { resource } = await cc.item(CHECKPOINT_ID, CHECKPOINT_ID).read().catch(() => ({ resource: null }));
    if (resource) checkpoint = { ...checkpoint, ...resource };
    console.log(`Resume from checkpoint: lastProcessedIndex=${checkpoint.lastProcessedIndex}, totalPersisted=${checkpoint.totalPersisted}`);
  } catch { /* first run */ }

  // Load existing (year, player) coverage from card_catalog
  console.log("\nLoading current catalog coverage...");
  const covered = new Set();
  const iter1 = cc.items.query({ query: "SELECT c.player, c.set FROM c WHERE IS_DEFINED(c.player) AND IS_DEFINED(c.set)" }, { maxItemCount: 5000 });
  let ccScanned = 0;
  while (iter1.hasMoreResults()) {
    const { resources } = await iter1.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      ccScanned++;
      const player = String(r.player || "").trim().toLowerCase();
      const m = String(r.set || "").match(/(19|20)\d{2}/);
      if (!player || !m) continue;
      covered.add(`${m[0]}::${player}`);
    }
  }
  console.log(`  catalog rows scanned: ${ccScanned}`);
  console.log(`  (year, player) tuples covered: ${covered.size}`);

  // Discover gap tuples from sold_comps
  console.log("\nEnumerating (playerName, cardYear) gaps from sold_comps...");
  const gapTuples = [];
  const iter2 = sc.items.query({
    query: "SELECT DISTINCT c.playerName, c.cardYear FROM c WHERE IS_DEFINED(c.playerName) AND IS_DEFINED(c.cardYear) AND c.playerName != null AND c.cardYear != null"
  }, { maxItemCount: 5000 });
  let scScanned = 0;
  while (iter2.hasMoreResults()) {
    const { resources } = await iter2.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scScanned++;
      const player = String(r.playerName || "").trim();
      const year = Number(r.cardYear);
      if (!player || !Number.isFinite(year) || year < 1980 || year > 2030) continue;
      const key = `${year}::${player.toLowerCase()}`;
      if (covered.has(key)) continue;
      gapTuples.push({ player, year, key });
    }
  }
  console.log(`  sold_comps DISTINCT rows scanned: ${scScanned}`);
  console.log(`  gap (year, player) tuples: ${gapTuples.length}`);
  checkpoint.totalTuples = gapTuples.length;

  // Slice to this batch
  const startIdx = checkpoint.lastProcessedIndex;
  const endIdx = Math.min(startIdx + BATCH_SIZE, gapTuples.length);
  const batch = gapTuples.slice(startIdx, endIdx);
  console.log(`\nProcessing batch: index ${startIdx} → ${endIdx} of ${gapTuples.length}`);

  let persisted = 0, searched = 0, empty = 0, errors = 0;
  const perTupleFn = async (tuple) => {
    searched++;
    const q = `${tuple.player} ${tuple.year}`;
    let cards;
    try {
      cards = await withRetry(() => chSearchCards(q, 25));
    } catch (e) {
      errors++;
      return;
    }
    if (!Array.isArray(cards) || cards.length === 0) { empty++; return; }

    if (MODE !== "apply") {
      persisted += cards.length;
      return;
    }

    // Persist each card as card_catalog row (source=cardhedge)
    for (const card of cards) {
      try {
        const cardId = String(card.card_id ?? card.cardId ?? "").trim();
        if (!cardId) continue;
        const doc = {
          id: `cardhedge::${cardId}::${slugContentHash("cardhedge", cardId)}`,
          cardId,
          source: "cardhedge",
          contentHash: slugContentHash("cardhedge", cardId),
          title: card.title ?? card.name ?? null,
          player: card.player ?? tuple.player,
          set: card.set ?? null,
          year: card.year ?? tuple.year,
          number: card.number ?? null,
          variant: card.variant ?? null,
          imageUrl: card.image ?? card.image_url ?? null,
          observedAt: new Date().toISOString(),
          __expandedFromGap: true,
          __expandedFromGapAt: new Date().toISOString(),
        };
        await cc.items.upsert(doc);
        persisted++;
      } catch (e) {
        errors++;
      }
    }
  };

  // Simple worker pool
  const inFlight = new Set();
  for (const tuple of batch) {
    const p = perTupleFn(tuple).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);
    if (searched % 100 === 0) console.log(`  searched=${searched}/${batch.length}  persisted=${persisted}  empty=${empty}  errors=${errors}`);
  }
  await Promise.allSettled(inFlight);

  console.log(`\nBatch done:  searched=${searched}  persisted=${persisted}  empty=${empty}  errors=${errors}`);

  // Update checkpoint
  const newCheckpoint = {
    id: CHECKPOINT_ID,
    cardId: CHECKPOINT_ID,
    lastProcessedIndex: endIdx,
    totalPersisted: (checkpoint.totalPersisted || 0) + persisted,
    totalTuples: gapTuples.length,
    lastRunAt: new Date().toISOString(),
  };
  if (MODE === "apply") {
    await cc.items.upsert(newCheckpoint);
  }

  const remaining = gapTuples.length - endIdx;
  console.log(`\n=== Checkpoint ===`);
  console.log(`  lastProcessedIndex: ${newCheckpoint.lastProcessedIndex}`);
  console.log(`  totalTuples:        ${newCheckpoint.totalTuples}`);
  console.log(`  totalPersisted:     ${newCheckpoint.totalPersisted}`);
  console.log(`  remaining tuples:   ${remaining}`);
  console.log(`\nnext start index: ${endIdx}`);
  if (remaining > 0) {
    console.log(`RELAUNCH_NEEDED=true`);
  } else {
    console.log(`RELAUNCH_NEEDED=false — catalog gap fully closed`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
