#!/usr/bin/env node
// CF-RESLUG-SUSPICIOUS-SETKEYS (Drew, 2026-07-30). Companion to
// reslug-cross-product-mis-slug (which only handled bowman-family).
// This one handles the BROADER class the setKey audit surfaced:
// rows where the setKey slot is a raw slugified title
// ("2003-flair-baseball", "1996-pinnacle-aficionado-baseball",
// "topps-stars-of-mlb") because normalizeSetKey didn't match a
// known pattern when the row was written.
//
// After the v3 vocab expansion (Flair, Goudey, SP, Pinnacle,
// Pinnacle Aficionado, Panini insert-set variants), matchKnownProductLine
// can now recognize these products. This backfill patches existing
// rows to their corrected canonical setKey.
//
// Only-improve guardrail:
//   - Skip if setKey is already a known canonical (via matchKnownProductLine)
//   - Only patch when derived setKey is a KNOWN canonical AND differs from existing
//   - Never demote a valid canonical to null/unknown
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=8       — parallel patches (kept low)
//   BACKFILL_LIMIT=250000        — max rows scanned per pass

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, matchKnownProductLine } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "8");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "250000");

// Canonical short-forms (kept in sync with audit-setkey-distribution.cjs
// and normalizeSetKey's known list in hobbyIqCardId.service.ts).
const KNOWN_CANONICALS = new Set([
  "bowman", "bowman-chrome", "bowman-chrome-sapphire", "bowman-chrome-draft",
  "bowman-paper", "bowman-draft", "bowman-draft-paper", "bowman-sterling",
  "topps", "topps-chrome", "topps-chrome-update", "topps-chrome-sapphire",
  "topps-heritage", "topps-finest", "topps-pristine", "topps-transcendent",
  "topps-dynasty", "topps-tribute", "topps-inception", "topps-definitive",
  "topps-five-star", "topps-museum-collection", "topps-gypsy-queen",
  "topps-archives", "topps-big-league", "topps-bunt", "topps-allen-ginter",
  "topps-stadium-club",
  "panini-prizm", "panini-select", "panini-mosaic", "panini-donruss",
  "panini-optic", "panini-contenders", "panini-immaculate", "panini-flawless",
  "panini-national-treasures", "panini-absolute", "panini-chronicles",
  "panini-phoenix", "panini-illusions", "panini-obsidian", "panini-spectra",
  "panini-revolution", "panini-crown-royale", "panini-one-one",
  "panini-playoff", "panini-score", "panini-classics", "panini-legacy",
  "panini-threads", "panini-rookies-and-stars", "panini-zenith",
  "panini-court-kings", "panini-origins", "panini-encased", "panini-eminence",
  "pinnacle", "pinnacle-aficionado", "goudey", "flair",
  "sp-prospects", "sp-authentic",
  "upper-deck", "fleer", "fleer-stickers",
]);

async function fetchWithRetry(iterator, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await iterator.fetchNext(); }
    catch (err) {
      const msg = String(err?.message || "");
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`\r  [429 backoff ${wait}ms attempt ${attempt+1}]  `);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[reslug-suspicious-setkeys]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}\n`);

  // Scan all rows in the LIMIT window and JS-side filter to non-canonical
  // setKeys. Simpler than trying to express the NOT-IN clause in Cosmos SQL.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE IS_STRING(c.hobbyiqCardId)
      AND IS_STRING(c.title)
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 2000 },
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const page = await fetchWithRetry(it);
    if (page && Array.isArray(page.resources)) rows.push(...page.resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
    if (rows.length >= LIMIT) break;
  }
  console.log(`\r  ${rows.length} rows scanned.        \n`);

  const patches = [];
  const setKeyDist = {};
  const originalSetKeyDist = {};
  let alreadyCanonical = 0, noDerivedMatch = 0, sameSetKey = 0, computeFailed = 0;

  for (const r of rows) {
    const parts = String(r.hobbyiqCardId || "").split(":");
    const existingSetKey = parts[3] || "";

    // Skip if already canonical (no reslug needed)
    if (KNOWN_CANONICALS.has(existingSetKey)) { alreadyCanonical++; continue; }

    const title = String(r.title || r.rawTitle || "");
    const derivedSetKey = matchKnownProductLine(title);
    if (!derivedSetKey) { noDerivedMatch++; continue; }
    if (!KNOWN_CANONICALS.has(derivedSetKey)) { noDerivedMatch++; continue; }
    if (derivedSetKey === existingSetKey) { sameSetKey++; continue; }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear) || 0,
        setKey: derivedSetKey,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { sameSetKey++; continue; }

    setKeyDist[derivedSetKey] = (setKeyDist[derivedSetKey] ?? 0) + 1;
    originalSetKeyDist[existingSetKey] = (originalSetKeyDist[existingSetKey] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      oldSetKey: existingSetKey,
      newSetKey: derivedSetKey,
      title: title.slice(0, 100),
    });
  }

  console.log(`  already canonical (skipped):   ${alreadyCanonical.toLocaleString()}`);
  console.log(`  no derived match (skipped):    ${noDerivedMatch.toLocaleString()}`);
  console.log(`  same setKey after derive:      ${sameSetKey.toLocaleString()}`);
  console.log(`  compute failed:                ${computeFailed.toLocaleString()}`);
  console.log(`  Ready to patch:                ${patches.length.toLocaleString()}\n`);

  console.log(`  New (corrected) setKey distribution (top 25):`);
  Object.entries(setKeyDist).sort((a,b) => b[1] - a[1]).slice(0, 25)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(6)}  ${k}`));

  console.log(`\n  Original mis-slugged setKey distribution (top 20):`);
  Object.entries(originalSetKeyDist).sort((a,b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(6)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5 patches:`);
    patches.slice(0, 5).forEach(p => {
      console.log(`    ${p.oldSetKey}  →  ${p.newSetKey}`);
      console.log(`      title: ${p.title}`);
    });
  }

  if (!APPLY || patches.length === 0) {
    console.log(`\n  Dry-run / no work. Re-dispatch with BACKFILL_APPLY=true to apply.`);
    return;
  }

  console.log(`\n  Applying ${patches.length} patches (concurrency ${CONCURRENCY})...`);
  const t0 = Date.now();
  let done = 0;
  const { ok, err } = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    if (++done % 500 === 0) process.stdout.write(`\r    ${done}/${patches.length} patched`);
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\r    ${done}/${patches.length} patched (${secs}s)  ok=${ok} err=${err}`);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  patched:  ${ok}`);
  console.log(`  errors:   ${err}`);
}

main().catch(e => { console.error(e); process.exit(1); });
