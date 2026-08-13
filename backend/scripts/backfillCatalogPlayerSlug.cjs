#!/usr/bin/env node
// CF-PLAYER-SLUG-BACKFILL (Drew, 2026-08-12, scope: "baseball flagship first").
//
// THE DEFECT. card_catalog stores display names with diacritics and punctuation
// ("Ronald Acuña, Jr.", "José Ramírez"). Lookups pass what a user types
// ("acuna"). Cosmos CONTAINS is byte-exact, so those rows are unreachable —
// 5.5% of a 1,595-row sample, concentrated in the most-traded players. And
// 99.8% of sampled rows carry NO playerSlug, so services that query
// `WHERE c.playerSlug = @p` (catalogVerify, resolveSetKey) find nothing at all;
// a miss there is indistinguishable from "no such card", which is why it went
// unnoticed. This writes the folded slug so those paths can work.
//
// WHY POINT READS AND NOT A QUERY. card_catalog partitions on /cardId with
// id === cardId === slug for canonical rows. Cross-partition scans time out
// (a bare COUNT ran past 9 minutes); point reads are ~1 RU / ~40ms. So this
// enumerates the deterministic base-card slugs rather than scanning.
//
// SAFETY. Dry-run by default — pass --apply to write. Each write is a patch of
// exactly one field on one row, skipped when the correct value is already
// present, so re-running is a no-op. playerName is never modified: the display
// name keeps its accents, which is how it should render.
//
// Usage:
//   node scripts/backfillCatalogPlayerSlug.cjs                 # dry run
//   node scripts/backfillCatalogPlayerSlug.cjs --apply
//   node scripts/backfillCatalogPlayerSlug.cjs --apply --sets topps-chrome --years 2024

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APPLY = has("--apply");
const SPORT = val("--sport", "baseball");
const YEARS = val("--years", "2018,2019,2020,2021,2022,2023,2024,2025,2026")
  .split(",").map((s) => Number(s.trim())).filter(Boolean);
const SETS = val("--sets", "topps-chrome,bowman-chrome,topps,bowman,finest,bowman-chrome-sapphire,topps-chrome-sapphire")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_N = Number(val("--max", "400"));
const CONCURRENCY = Number(val("--concurrency", "20"));

// Mirrors slugify() in src/services/portfolioiq/hobbyIqCardId.service.ts.
// NFKD first so the combining mark separates from the base letter and the
// punctuation strip removes it — that is what folds ñ to n rather than
// mangling it to a hyphen.
function slugify(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) {
  console.error("COSMOS_CONNECTION_STRING is unset. Pipe it in from App Service settings.");
  process.exit(1);
}
const container = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq")
  .container("card_catalog");

async function withRetry(fn, attempt = 0) {
  try { return await fn(); }
  catch (e) {
    if (e.code === 404) return null;
    if (attempt < 4 && (e.code === 429 || e.code === 503 || e.code === "ECONNRESET")) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      return withRetry(fn, attempt + 1);
    }
    throw e;
  }
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const stats = { read: 0, absent: 0, noName: 0, alreadyOk: 0, wouldWrite: 0, wrote: 0, errors: 0, ru: 0 };
const samples = [];

async function handle(id) {
  let row;
  try {
    const r = await withRetry(() => container.item(id, id).read());
    if (!r) { stats.absent++; return; }
    stats.ru += r.requestCharge || 0;
    row = r.resource;
    if (!row) { stats.absent++; return; }
  } catch (e) { stats.errors++; return; }

  stats.read++;
  const name = String(row.playerName ?? "").trim();
  if (!name) { stats.noName++; return; }

  const want = slugify(name);
  if (!want) { stats.noName++; return; }
  if (row.playerSlug === want) { stats.alreadyOk++; return; }

  stats.wouldWrite++;
  if (samples.length < 10 && /[^\x00-\x7F]/.test(name)) {
    samples.push(`${id}  ${JSON.stringify(name)} -> ${want}` +
      (row.playerSlug ? `  (was ${JSON.stringify(row.playerSlug)})` : "  (was absent)"));
  }
  if (!APPLY) return;

  try {
    // Patch a single field. Replaces the whole row only if patch is
    // unsupported for this row shape, and never touches playerName.
    await withRetry(() => container.item(id, id).patch([
      { op: row.playerSlug === undefined ? "add" : "replace", path: "/playerSlug", value: want },
    ]));
    stats.wrote++;
  } catch (e) { stats.errors++; }
}

(async () => {
  console.log(`playerSlug backfill — ${APPLY ? "APPLY" : "DRY RUN"}  sport=${SPORT} sets=${SETS.length} years=${YEARS.length} n=1..${MAX_N}\n`);
  for (const setKey of SETS) {
    for (const year of YEARS) {
      const before = stats.wouldWrite;
      const ids = Array.from({ length: MAX_N }, (_, i) =>
        `hiq:${SPORT}:${year}:${setKey}:${i + 1}:base:no-auto`);
      await mapLimit(ids, CONCURRENCY, handle);
      const delta = stats.wouldWrite - before;
      if (delta) console.log(`  ${setKey} ${year}  ${delta} rows need playerSlug`);
    }
  }
  console.log(`\nrows found          : ${stats.read}`);
  console.log(`  already correct   : ${stats.alreadyOk}`);
  console.log(`  no playerName     : ${stats.noName}`);
  console.log(`  ${APPLY ? "WRITTEN         " : "would write     "}  : ${APPLY ? stats.wrote : stats.wouldWrite}`);
  console.log(`slugs not in catalog: ${stats.absent}`);
  console.log(`errors              : ${stats.errors}`);
  console.log(`RU (reads)          : ${Math.round(stats.ru)}`);
  if (samples.length) {
    console.log("\naccented-name examples:");
    for (const s of samples) console.log("   " + s);
  }
  if (!APPLY) console.log("\nDRY RUN — no writes. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
