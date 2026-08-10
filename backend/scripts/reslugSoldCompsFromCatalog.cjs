// CF-SOLDCOMPS-RESLUG-FROM-CATALOG (Drew, 2026-08-10, rev 2 setKey-safe).
//
// The problem: 58.3% of sold_comps have a hobbyiqCardId that doesn't
// match any card_catalog row — not because catalog is missing the
// card, but because the sold_comp's slug was computed from a messy
// setName ("2025 Topps Chrome Prospects Baseball") while the catalog
// row was written from a clean setKey ("topps-chrome-prospects").
// Same card, different slug.
//
// Rev-1 (removed) tried matching on (sport, year, cardNumber,
// playerName, parallel, isAuto) — WITHOUT setKey. That produced
// dangerous cross-set false matches (2026 Topps #136 ≠ 2026 Topps
// Heritage #136 — same identity tuple minus setKey, totally
// different cards, different values). Never applied.
//
// Rev-2 (this): REQUIRES normalizedSetKey === catalog.setKey exact
// match in addition to the identity tuple. Skips any sold_comp that
// doesn't have normalizedSetKey (run normalizeSoldCompSetKey.cjs
// --apply first). This eliminates cross-set false matches by
// definition.
//
// Safety:
//   - Only patches sold_comps whose current slug is NOT in the
//     catalog slug set (i.e., don't touch correctly-slugged rows)
//   - REQUIRES normalizedSetKey field on sold_comp AND same setKey
//     on catalog row (identity tuple includes setKey)
//   - Requires exact match on cardNumber + playerName + parallel +
//     isAuto — never guesses across parallels or across autos
//   - If the identity tuple matches more than one distinct catalog
//     slug (rare after setKey included), skip; ambiguous is unsafe
//   - DRY_RUN default; only writes when explicitly enabled
//
// Idempotent: rows already matching a catalog slug are skipped in
// the scan filter. Re-running only processes the still-unmapped
// tail.
//
// Usage:
//   DRY_RUN=true  node backend/scripts/reslugSoldCompsFromCatalog.cjs
//   DRY_RUN=false node backend/scripts/reslugSoldCompsFromCatalog.cjs
//   Optional:
//     SPORT_FILTER=baseball          restrict to one sport
//     CONCURRENCY=16                 patch concurrency (default 16)
//     MAX_PATCHES=500000             cap total patches this run

const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const SPORT_FILTER = (process.env.SPORT_FILTER || "").trim().toLowerCase();
const CONCURRENCY = Math.min(64, Number(process.env.CONCURRENCY || 16));
const MAX_PATCHES = Number(process.env.MAX_PATCHES || 5_000_000);

if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

function norm(s) { return String(s ?? "").trim().toLowerCase(); }
function normCardNum(s) { return String(s ?? "").trim().toUpperCase().replace(/^#/, ""); }
function normParallel(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t || t === "none") return "base";
  return t;
}
function normAuto(v) { return v === true; }

async function main() {
  const client = new CosmosClient(CONN);
  const cat = client.database("hobbyiq").container("card_catalog");
  const sc = client.database("hobbyiq").container("sold_comps");
  const t0 = Date.now();

  console.log("[phase1] loading catalog index (setKey-scoped)...");
  const catBySlug = new Set();
  const catByIdentity = new Map();
  const identityConflicts = new Set();
  const sportFilterClause = SPORT_FILTER ? `AND c.sport = "${SPORT_FILTER}"` : "";
  const catIter = cat.items.query({
    query: `SELECT c.hobbyiqCardId, c.sport, c.cardYear, c.year, c.cardNumber, c.playerName,
                   c.parallel, c.isAuto, c.setKey
            FROM c
            WHERE c.catalogVersion = 2
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
              AND IS_DEFINED(c.setKey)
              ${sportFilterClause}`,
  }, { maxItemCount: 5000 });

  async function fetchNextWithRetry(iter, maxAttempts = 8) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try { return await iter.fetchNext(); }
      catch (err) {
        const code = err && (err.code ?? err.statusCode);
        const msg = String((err && err.message) || "");
        if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxAttempts - 1) {
          const wait = Number((err && err.retryAfterInMs) ?? 1000 * Math.pow(2, attempt));
          console.log(`  [429 backoff ${wait}ms attempt ${attempt + 1}]`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    throw new Error("exhausted retries");
  }

  let loaded = 0, indexed = 0;
  while (catIter.hasMoreResults()) {
    const { resources } = await fetchNextWithRetry(catIter);
    for (const r of resources) {
      catBySlug.add(r.hobbyiqCardId);
      const year = r.cardYear ?? r.year;
      if (!year || !r.cardNumber || !r.playerName || !r.setKey) continue;
      const key = `${norm(r.sport)}|${year}|${norm(r.setKey)}|${normCardNum(r.cardNumber)}|${norm(r.playerName)}|${normParallel(r.parallel)}|${normAuto(r.isAuto) ? 1 : 0}`;
      if (catByIdentity.has(key)) {
        if (catByIdentity.get(key) !== r.hobbyiqCardId) identityConflicts.add(key);
      } else {
        catByIdentity.set(key, r.hobbyiqCardId);
        indexed++;
      }
    }
    loaded += resources.length;
    if (loaded % 500000 === 0) console.log(`  loaded=${loaded.toLocaleString()}  indexed=${indexed.toLocaleString()}  conflicts=${identityConflicts.size.toLocaleString()}  (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  }
  console.log(`[phase1] catalog: ${catBySlug.size.toLocaleString()} slugs, ${indexed.toLocaleString()} identity tuples, ${identityConflicts.size.toLocaleString()} ambiguous`);

  console.log("");
  console.log("[phase2] scanning sold_comps for unmapped rows (setKey-safe)...");
  const scIter = sc.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
                   c.playerName, c.parallel, c.isAuto, c.normalizedSetKey
            FROM c
            WHERE c.price > 0
              AND IS_DEFINED(c.cardYear) AND IS_DEFINED(c.cardNumber) AND IS_DEFINED(c.playerName)
              AND IS_DEFINED(c.normalizedSetKey)
              ${SPORT_FILTER ? `AND c.sport = "${SPORT_FILTER}"` : ""}`,
  }, { maxItemCount: 5000 });

  let scanned = 0, alreadyMatched = 0, notMatchable = 0, planned = 0, skippedAmbiguous = 0, skippedNoNormalizedSet = 0;
  const patchQueue = [];
  const sportUnlocked = new Map();

  while (scIter.hasMoreResults()) {
    const { resources } = await fetchNextWithRetry(scIter);
    for (const r of resources) {
      scanned++;
      if (r.hobbyiqCardId && catBySlug.has(r.hobbyiqCardId)) { alreadyMatched++; continue; }
      if (!r.normalizedSetKey) { skippedNoNormalizedSet++; continue; }
      const key = `${norm(r.sport)}|${r.cardYear}|${norm(r.normalizedSetKey)}|${normCardNum(r.cardNumber)}|${norm(r.playerName)}|${normParallel(r.parallel)}|${normAuto(r.isAuto) ? 1 : 0}`;
      if (identityConflicts.has(key)) { skippedAmbiguous++; continue; }
      const newSlug = catByIdentity.get(key);
      if (!newSlug) { notMatchable++; continue; }
      if (newSlug === r.hobbyiqCardId) { alreadyMatched++; continue; }
      patchQueue.push({ id: r.id, pk: r.cardId ?? r.id, oldSlug: r.hobbyiqCardId, newSlug });
      planned++;
      const s = r.sport || "?";
      sportUnlocked.set(s, (sportUnlocked.get(s) || 0) + 1);
      if (planned >= MAX_PATCHES) break;
    }
    if (planned >= MAX_PATCHES) { console.log(`  (cap MAX_PATCHES=${MAX_PATCHES} reached)`); break; }
    if (scanned % 200000 === 0) console.log(`  scanned=${scanned.toLocaleString()}  planned=${planned.toLocaleString()}  ambig=${skippedAmbiguous}  notMatchable=${notMatchable.toLocaleString()}`);
  }

  console.log("");
  console.log("[plan]");
  console.log(`  sold_comps scanned            : ${scanned.toLocaleString()}`);
  console.log(`  already correctly matched     : ${alreadyMatched.toLocaleString()}`);
  console.log(`  patches planned (unlock)      : ${planned.toLocaleString()}`);
  console.log(`  skipped (no normalizedSetKey) : ${skippedNoNormalizedSet.toLocaleString()}`);
  console.log(`  skipped (identity ambiguous)  : ${skippedAmbiguous.toLocaleString()}`);
  console.log(`  no catalog identity match     : ${notMatchable.toLocaleString()}`);
  console.log("");
  console.log("[unlock by sport]");
  for (const [s, n] of [...sportUnlocked.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(s).padEnd(15)} ${n.toLocaleString().padStart(10)}`);
  }

  if (DRY_RUN) {
    console.log("");
    console.log("[DRY_RUN] no writes issued. Set DRY_RUN=false to apply.");
    if (patchQueue.length > 0) {
      console.log("");
      console.log("[sample patches]");
      for (const p of patchQueue.slice(0, 5)) console.log(`  ${p.id.slice(0, 60)}...\n    old: ${p.oldSlug}\n    new: ${p.newSlug}`);
    }
    return;
  }

  console.log("");
  console.log("[apply] patching sold_comps hobbyiqCardId (429 backoff enabled)…");
  let patched = 0, patchFailed = 0;
  const inflight = new Set();
  for (const p of patchQueue) {
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const task = (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await sc.item(p.id, p.pk).patch([
            { op: "add", path: "/hobbyiqCardId", value: p.newSlug },
          ]);
          return true;
        } catch (err) {
          const code = err && (err.code ?? err.statusCode);
          if (code === 429 && attempt < 4) {
            const wait = Number(err.retryAfterInMs ?? 500 * Math.pow(2, attempt));
            await new Promise(r => setTimeout(r, wait));
            continue;
          }
          return { failed: true, err };
        }
      }
    })()
      .then((r) => {
        if (r === true) {
          patched++;
          if (patched % 5000 === 0) {
            const eps = (patched / ((Date.now() - t0) / 1000)).toFixed(0);
            console.log(`  patched ${patched.toLocaleString()}/${planned.toLocaleString()}  (${eps}/sec)`);
          }
        } else if (r && r.failed) {
          patchFailed++;
          if (patchFailed <= 10) console.warn(`  patch-fail id=${p.id}: ${r.err && r.err.message}`);
        }
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  }
  await Promise.all([...inflight]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done]");
  console.log(`  patched        : ${patched.toLocaleString()}`);
  console.log(`  patch-failed   : ${patchFailed.toLocaleString()}`);
  console.log(`  elapsed        : ${elapsed}s`);
}

main().catch(e => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
