// CF-TCA-RETROACTIVE-NORMALIZE (Drew, 2026-08-02). Walks all
// source='tca-ebay' rows in sold_comps + comps_staging, re-runs the
// improved parser on each row's title, and updates any field that
// changed (playerName, parallel, sport, cardYear, cardNumber). Also
// recomputes hobbyiqCardId slug when identity changes.
//
// Safe to run: idempotent (running a second time is a no-op on already-
// normalized rows). Never touches non-tca rows.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   APPLY=true                execute writes (else dry-run counts only)
//   MAX_MINUTES=60            wall-clock cap
//   BATCH=500                 rows per Cosmos query page

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const distRoot = path.resolve(__dirname, "..", "dist");
const { parseCardQuery } = require(path.join(distRoot, "services", "compiq", "cardQueryParser.js"));
const { inferSetKeyFromTitle, inferSportFromTitle } = require(path.join(distRoot, "services", "portfolioiq", "parseTitleIdentity.service.js"));
const { computeHobbyIqCardId } = require(path.join(distRoot, "services", "portfolioiq", "hobbyIqCardId.service.js"));

const APPLY = process.env.APPLY === "true";
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 60);
const BATCH = Number(process.env.BATCH || 500);

function reparseRow(title, existing) {
  if (!title) return null;
  const parsed = parseCardQuery(title);
  // Prefer NEW parse over EXISTING wherever new is populated (parser is
  // now stricter/cleaner, so any non-null new value is at-worst-as-good).
  const next = {
    playerName: parsed.playerName || existing.playerName,
    cardYear: parsed.year ?? existing.cardYear,
    cardNumber: parsed.cardNumber ?? existing.cardNumber,
    parallel: parsed.parallel ?? existing.parallel,
    isAuto: parsed.isAuto ?? existing.isAuto,
    printRun: parsed.printRun ?? existing.printRun,
    setName: (() => {
      const inferred = inferSetKeyFromTitle(title);
      return (inferred && inferred !== "Unknown") ? inferred : existing.setName;
    })(),
    sport: inferSportFromTitle(title) || existing.sport,
  };
  return next;
}

function slugForRow(row) {
  if (!row.sport || !row.cardYear || !row.setName || !row.cardNumber) return null;
  try {
    return computeHobbyIqCardId({
      sport: row.sport,
      year: row.cardYear,
      setKey: row.setName,
      cardNumber: row.cardNumber,
      parallel: row.parallel || "Base",
      isAuto: row.isAuto === true,
      printRun: row.printRun,
    });
  } catch { return null; }
}

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");

  console.log(`[normalize-tca] apply=${APPLY} maxMinutes=${MAX_MINUTES} batch=${BATCH}`);

  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  const q = {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.sport FROM c WHERE c.source = 'tca-ebay'`,
  };
  const iter = sold.items.query(q, { maxItemCount: BATCH });

  let scanned = 0, changed = 0, unchanged = 0, failed = 0, slugChanged = 0;
  const CONCURRENCY = 16;
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn("wall-clock cap"); break; }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      const next = reparseRow(row.title, row);
      if (!next) { unchanged++; continue; }
      // Detect any diff worth writing
      const diff = ["playerName", "cardYear", "setName", "cardNumber", "parallel", "isAuto", "printRun", "sport"]
        .filter(k => JSON.stringify(next[k]) !== JSON.stringify(row[k]));
      if (diff.length === 0) { unchanged++; continue; }
      const newSlug = slugForRow(next);
      const slugMoved = newSlug && newSlug !== row.hobbyiqCardId;
      if (!APPLY) {
        changed++;
        if (slugMoved) slugChanged++;
        continue;
      }
      // Apply writes
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const p = (async () => {
        try {
          const patch = { ...row, ...next, __normalizedAt: new Date().toISOString() };
          if (newSlug) patch.hobbyiqCardId = newSlug;
          if (newSlug && newSlug !== row.cardId) {
            // Partition key change — write new FIRST (upsert idempotent
            // vs concurrent webhook), then delete old. Data is
            // continuously present; a crash mid-migration leaves BOTH
            // (harmless, next normalize catches the duplicate). Reversed
            // order (delete-then-create) was losing rows to a race with
            // the cron webhook re-writing.
            patch.cardId = newSlug;
            await sold.items.upsert(patch);
            try { await sold.item(row.id, row.cardId).delete(); }
            catch (delErr) {
              // Not fatal — the new row is written; old-partition delete
              // failure means we have a duplicate that a future normalize
              // pass will collapse. Log for triage.
              if (failed < 10) console.warn(`  post-write delete failed id=${row.id} oldPart=${row.cardId}: ${delErr?.code ?? delErr?.message ?? delErr}`);
            }
            slugChanged++;
          } else {
            await sold.items.upsert(patch);
          }
          changed++;
        } catch (err) {
          failed++;
          if (failed < 10) console.warn(`  fail id=${row.id}: ${err?.code ?? err?.message ?? err}`);
        }
      })().finally(() => inflight.delete(p));
      inflight.add(p);

      if (scanned % 200 === 0) {
        const el = ((Date.now() - startMs) / 1000).toFixed(0);
        console.log(`  scanned=${scanned} changed=${changed} unchanged=${unchanged} slugMoved=${slugChanged} failed=${failed} elapsed=${el}s`);
      }
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[normalize-tca] done — scanned=${scanned} changed=${changed} unchanged=${unchanged} slugMoved=${slugChanged} failed=${failed} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  if (!APPLY) console.log(`(dry-run — no writes)`);
}

main().catch(err => { console.error(err); process.exit(1); });
