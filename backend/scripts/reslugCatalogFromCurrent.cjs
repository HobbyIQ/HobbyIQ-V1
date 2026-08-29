// CF-CATALOG-RESLUG-CURRENT (Drew, 2026-08-10). Re-run every catalog
// row's hobbyiqCardId through the current computeHobbyIqCardId. Where
// the produced slug differs from the stored one, move the row to the
// canonical id (id === hobbyiqCardId and both change together).
//
// Motivation: after the sold_comps mass reslug consolidated 107k rows
// onto canonical bowman-chrome / topps-chrome slugs, some catalog rows
// still sit at legacy sub-keys (bowman-chrome-mega-box, etc.) that the
// current generator collapses. Search-click on those catalog candidates
// hits recent-sales with the stale slug → empty panel. Aligning catalog
// to the current generator closes the gap.
//
// The move is catalogRowOps.moveCatalogRow (D5 PR 4): copy to the
// canonical slug with the setKey the slug says and the searchable fields
// rebuilt, re-point the sales still at the old slug, retire the old
// slug's graded children, delete the old row last. A row already at the
// canonical slug is decided by authority -- moved / folded / replaced.
//
// Identity rows only. A graded row's slug is its parent's plus a tier,
// which the generator never produces, so "drift" on a graded row would
// have folded it onto its parent.
//
// Idempotent (skips rows already canonical). Env: APPLY=true.

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { computeHobbyIqCardId } = require(path.resolve(__dirname, "../dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { moveCatalogRow } = require(path.resolve(__dirname, "../dist/services/catalog/catalogRowOps.service.js"));

const APPLY = process.env.APPLY === "true";
const LIMIT = Number(process.env.LIMIT || 0);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

// 429s on paging and on the per-row moves back off here rather than
// crashing the script (the SDK's own retries burn out under concurrency).
const retry = async (fn, tries = 5) => {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) {
      if (!(err && err.code === 429) || i >= tries) throw err;
      const wait = (err.retryAfterInMs || 1000 * (i + 1)) + 200;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(conn).database("hobbyiq");
  const catalog = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  limit=${LIMIT || "∞"}`);

  // Pull the identity rows with the fields the generator needs. Only touch
  // rows whose stored hobbyiqCardId doesn't equal what the generator produces.
  const q = `SELECT c.id, c.cardId, c.sport, c.cardYear, c.setKey, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.hobbyiqCardId
             FROM c
             WHERE IS_STRING(c.hobbyiqCardId) AND NOT IS_DEFINED(c.gradeTier)`;
  // Small page size to keep initial RU cost per fetchNext low.
  const it = catalog.items.query({ query: q }, { maxItemCount: 100 });

  let scanned = 0, changed = 0, touched = 0, moved = 0, folded = 0, replaced = 0, failed = 0, skipped = 0;
  const startedAt = Date.now();
  const inflight = [];

  while (it.hasMoreResults()) {
    const { resources } = await retry(() => it.fetchNext());
    for (const r of resources) {
      scanned++;
      if (!r.sport || !r.cardYear || !r.cardNumber) { skipped++; continue; }
      let newSlug;
      try {
        newSlug = computeHobbyIqCardId({
          sport: r.sport,
          year: Number(r.cardYear),
          setKey: r.setKey ?? "",
          cardNumber: String(r.cardNumber),
          parallel: r.parallel ?? "Base",
          isAuto: Boolean(r.isAuto),
          printRun: r.printRun ?? null,
        });
      } catch (err) { skipped++; continue; }
      if (newSlug === r.hobbyiqCardId) { skipped++; continue; }
      changed++;

      if (LIMIT && touched + inflight.length >= LIMIT) break;
      if (!APPLY) { touched++; continue; }

      const p = (async () => {
        try {
          const { resource: doc } = await retry(() => catalog.item(r.id, r.cardId ?? r.id).read());
          if (!doc) { skipped++; return; }
          // The slug carries the setKey the generator resolved; the row's
          // stored setKey may be the legacy sub-key -- a key needs both halves.
          const setKey = newSlug.split(":")[3];
          const res = await moveCatalogRow(catalog, doc, newSlug, { setKey }, {
            reason: "catalog slug re-derived by the current generator",
            repointNormalizedSetKey: setKey !== doc.setKey,
            salesContainer: pool,
            retry,
          });
          if (res.action === "move") moved++;
          else if (res.action === "fold") folded++;
          else if (res.action === "replace") replaced++;
          else { skipped++; return; }   // noop: the id was already canonical
          touched++;
        } catch (err) {
          console.warn(`fail ${r.id}: ${err.message || err}`);
          failed++;
        }
      })().finally(() => {
        const idx = inflight.indexOf(p);
        if (idx >= 0) inflight.splice(idx, 1);
      });
      inflight.push(p);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);

      if ((touched + failed) % 500 === 0 && (touched + failed) > 0) {
        const dur = ((Date.now() - startedAt)/1000).toFixed(0);
        console.log(`  progress: scanned=${scanned} changed=${changed} touched=${touched} failed=${failed} skipped=${skipped}  ${dur}s`);
      }
    }
    if (LIMIT && touched + inflight.length >= LIMIT) break;
  }
  await Promise.all(inflight);

  const dur = ((Date.now() - startedAt)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] scanned=${scanned} changed=${changed} touched=${touched} (moved=${moved} folded=${folded} replaced=${replaced}) failed=${failed} skipped=${skipped}`);
}
main().catch(e => { console.error(e); process.exit(1); });
