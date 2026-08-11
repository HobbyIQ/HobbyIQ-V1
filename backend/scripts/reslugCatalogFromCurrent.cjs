// CF-CATALOG-RESLUG-CURRENT (Drew, 2026-08-10). Re-run every catalog
// row's hobbyiqCardId through the current computeHobbyIqCardId. Where
// the produced slug differs from the stored one, move the row (delete +
// re-insert at the canonical id, since id === hobbyiqCardId and both
// change together).
//
// Motivation: after the sold_comps mass reslug consolidated 107k rows
// onto canonical bowman-chrome / topps-chrome slugs, some catalog rows
// still sit at legacy sub-keys (bowman-chrome-mega-box, etc.) that the
// current generator collapses. Search-click on those catalog candidates
// hits recent-sales with the stale slug → empty panel. Aligning catalog
// to the current generator closes the gap.
//
// Idempotent (skips rows already canonical). Env: APPLY=true.

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");

const APPLY = process.env.APPLY === "true";
const LIMIT = Number(process.env.LIMIT || 0);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

// tsx-free: require the compiled TS output directly. Fall back to
// dynamic import of tsx if compiled dist isn't present.
async function loadSlugFn() {
  try {
    const mod = require(path.resolve(__dirname, "../dist/services/portfolioiq/hobbyIqCardId.service.js"));
    return mod.computeHobbyIqCardId;
  } catch (err) {
    // Compile-on-the-fly via tsx would require esm loader; simpler:
    // register ts-node/register.
    require("ts-node/register/transpile-only");
    const mod = require(path.resolve(__dirname, "../src/services/portfolioiq/hobbyIqCardId.service.ts"));
    return mod.computeHobbyIqCardId;
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const catalog = new CosmosClient(conn).database("hobbyiq").container("card_catalog");
  const computeHobbyIqCardId = await loadSlugFn();

  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  limit=${LIMIT || "∞"}`);

  // Pull all rows with the fields the generator needs. Only touch rows
  // whose stored hobbyiqCardId doesn't equal what the generator produces.
  const q = `SELECT c.id, c.cardId, c.sport, c.cardYear, c.setKey, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.hobbyiqCardId
             FROM c
             WHERE IS_STRING(c.hobbyiqCardId)`;
  // Small page size to keep initial RU cost per fetchNext low + let
  // Cosmos SDK retry internally on 429s.
  const it = catalog.items.query({ query: q }, { maxItemCount: 100 });

  // Wrap fetchNext with our own retry so 429s on paging don't crash
  // the whole script (SDK retries the operation N times but big scans
  // can burn all retries when concurrency is high).
  async function fetchNextWithRetry(tries = 5) {
    for (let i = 0; i < tries; i++) {
      try { return await it.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) {
          const wait = (err.retryAfterInMs || 1000 * (i + 1)) + 200;
          console.log(`  fetchNext 429; backing off ${wait}ms (try ${i+1}/${tries})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    throw new Error("fetchNext retries exhausted");
  }

  let scanned = 0, changed = 0, touched = 0, failed = 0, skipped = 0;
  const startedAt = Date.now();
  const inflight = [];

  while (it.hasMoreResults()) {
    const { resources } = await fetchNextWithRetry();
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

      // Read the full doc, upsert at new id + new cardId partition, delete old.
      // card_catalog partition is /cardId; on this container cardId always
      // equals the row id (== hobbyiqCardId). The reslug flips both together.
      const oldPk = r.cardId ?? r.id;
      const p = (async () => {
        try {
          const { resource: doc } = await catalog.item(r.id, oldPk).read();
          if (!doc) { skipped++; return; }
          const newDoc = { ...doc, id: newSlug, cardId: newSlug, hobbyiqCardId: newSlug, reslugedAt: new Date().toISOString(), reslugedFrom: r.hobbyiqCardId };
          delete newDoc._rid; delete newDoc._self; delete newDoc._etag; delete newDoc._attachments; delete newDoc._ts;
          await catalog.items.upsert(newDoc);
          await catalog.item(r.id, oldPk).delete().catch(() => {});
          touched++;
        } catch (err) {
          const code = err && err.code;
          if (code === 429) {
            const wait = (err.retryAfterInMs || 500) + 100;
            await new Promise((res) => setTimeout(res, wait));
            try {
              const { resource: doc } = await catalog.item(r.id, oldPk).read();
              if (!doc) { skipped++; return; }
              const newDoc = { ...doc, id: newSlug, cardId: newSlug, hobbyiqCardId: newSlug, reslugedAt: new Date().toISOString(), reslugedFrom: r.hobbyiqCardId };
              delete newDoc._rid; delete newDoc._self; delete newDoc._etag; delete newDoc._attachments; delete newDoc._ts;
              await catalog.items.upsert(newDoc);
              await catalog.item(r.id, oldPk).delete().catch(() => {});
              touched++;
              return;
            } catch (err2) { console.warn(`fail(retry) ${r.id}: ${err2.message || err2}`); failed++; return; }
          }
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
  console.log(`\n[done ${dur}s] scanned=${scanned} changed=${changed} touched=${touched} failed=${failed} skipped=${skipped}`);
}
main().catch(e => { console.error(e); process.exit(1); });
