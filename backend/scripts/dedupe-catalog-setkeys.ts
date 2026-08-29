#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-DEDUPE (Drew, 2026-08-04).
 *
 * Merges catalog rows that ended up under an unqualified setKey (from
 * pre-fix bulk-build) into their canonical topps-* / bowman-* slug. The
 * bare-alias normalizer fix (b2545984) means new builds land at the
 * right slug, but rows built under the old code still occupy the old
 * slug.
 *
 * Mappings (old → new): every bare-Topps sub-brand alias registered in
 * hobbyIqCardId.service.ts bareAliasPatterns. Plus the Bowman ones and
 * O-Pee-Chee where applicable.
 *
 * For every catalog row at an OLD slug:
 *   - Compute NEW slug (same identity, canonical setKey).
 *   - Probe for an existing row at NEW slug; the answer is handed to the
 *     move as `known` (CF-DO-NOT-LOOK-TWICE).
 *   - catalogRowOps.moveCatalogRow (D5 PR 4) does the move: copy to NEW
 *     with the searchable fields rebuilt (the OLD setKey's tokens do not
 *     travel), re-point the sold_comps rows still at OLD (normalizedSetKey
 *     follows), retire OLD's graded children, delete OLD last. A row
 *     already at NEW is decided by authority: folded (its vendorIds
 *     unioned with ours) or replaced.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx backend/scripts/dedupe-catalog-setkeys.ts \
 *     [--year YYYY|--all] [--sport baseball] [--dry-run|--auto-approve]
 */

import { CosmosClient } from "@azure/cosmos";
import { moveCatalogRow, type CatalogRowDoc } from "../src/services/catalog/catalogRowOps.service.js";

interface Args { year?: number; all?: boolean; sport?: string; dryRun?: boolean; autoApprove?: boolean; }
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { sport: "baseball" };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--year") { args.year = Number(v); i++; }
    else if (f === "--all") args.all = true;
    else if (f === "--sport") { args.sport = v; i++; }
    else if (f === "--dry-run") args.dryRun = true;
    else if (f === "--auto-approve" || f === "-y") args.autoApprove = true;
  }
  return args;
}

// Mapping tables — every bare alias registered in bareAliasPatterns()
// that would have fragmented setKeys pre-fix. Order matters only in
// that we never remap a canonical → less-canonical form.
const OLD_TO_NEW_SETKEY: Record<string, string> = {
  // Bare-Topps sub-brands that collapsed to slug without "topps-" prefix.
  "finest": "topps-finest",
  "finest-flashbacks": "topps-finest-flashbacks",
  "heritage": "topps-heritage",
  "gypsy-queen": "topps-gypsy-queen",
  "big-league": "topps-big-league",
  "archives": "topps-archives",
  "museum-collection": "topps-museum-collection",
  "tribute": "topps-tribute",
  "dynasty": "topps-dynasty",
  "definitive": "topps-definitive",
  "inception": "topps-inception",
  "transcendent": "topps-transcendent",
  "five-star": "topps-five-star",
  "bunt": "topps-bunt",
  "pristine": "topps-pristine",
  // Traded/Tiffany chain (baseball-almanac list). Older bulk-build
  // collapsed "Topps Traded" into flagship "topps"; the fix keeps
  // Traded as its own slug. We don't dedupe topps→topps-traded because
  // that would need CARD-LEVEL disambiguation (was the row actually a
  // traded card or a flagship card?). Handled by re-run on affected
  // years, not by mass rename here.
};

/** Compute the NEW slug for a row that's currently at OLD setKey. We
 *  rebuild the id string mechanically because computeHobbyIqCardId
 *  derives the same suffix regardless of setKey. Safer than importing
 *  the util because we want the substitution to be verbatim — no other
 *  changes to the slug tail. */
function rewriteSlug(oldSlug: string, oldSetKey: string, newSetKey: string): string {
  // Slug shape: hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallelSlug}:{autoFlag}[:num-N]
  // Only the setKey segment changes.
  const parts = oldSlug.split(":");
  if (parts.length < 6 || parts[0] !== "hiq") return oldSlug;
  if (parts[3] !== oldSetKey) return oldSlug; // guard against wrong replacement
  parts[3] = newSetKey;
  return parts.join(":");
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year && !args.all) { console.error("Usage: dedupe-catalog-setkeys.ts (--year YYYY|--all) [--sport baseball] [--dry-run|--auto-approve]"); process.exit(2); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const oldSetKeys = Object.keys(OLD_TO_NEW_SETKEY);
  console.log(`\n▸ Dedupe scan across ${oldSetKeys.length} old-setKey fragmentations`);
  if (args.year) console.log(`  year=${args.year}`); else console.log(`  year=ALL`);
  console.log(`  sport=${args.sport}\n`);

  const yearFilter = args.year ? " AND c.year = @year" : "";
  const yearParam = args.year ? [{ name: "@year", value: args.year }] : [];
  const setKeyList = oldSetKeys.map((_, i) => `@sk${i}`).join(", ");
  const setKeyParams = oldSetKeys.map((k, i) => ({ name: `@sk${i}`, value: k }));

  console.log(`▸ Scanning for old-setKey rows...`);
  const iterator = cat.items.query<CatalogRowDoc>({
    query: `SELECT * FROM c WHERE c.sport = @sport${yearFilter} AND c.source = 'bulk-build-from-pool' AND c.setKey IN (${setKeyList})`,
    parameters: [{ name: "@sport", value: args.sport ?? "baseball" }, ...yearParam, ...setKeyParams],
  }, { maxItemCount: 500 });
  const oldRows: CatalogRowDoc[] = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    for (const r of resources) oldRows.push(r);
    process.stdout.write(`  scanned ${oldRows.length}\r`);
  }
  console.log(`\n  ✓ ${oldRows.length} rows to consider\n`);
  if (oldRows.length === 0) { console.log("▸ Nothing to dedupe."); process.exit(0); }

  // Group by old setKey for reporting.
  const perOldSetKey = new Map<string, number>();
  for (const r of oldRows) perOldSetKey.set(r.setKey, (perOldSetKey.get(r.setKey) ?? 0) + 1);
  console.log(`▸ Breakdown by old setKey:`);
  for (const [k, v] of [...perOldSetKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(28)} ${v}`);

  // Plan actions: the old row, its new slug, and whatever the probe found there.
  interface Action { oldRow: CatalogRowDoc; newSetKey: string; newSlug: string; known: CatalogRowDoc | null; }
  const actions: Action[] = [];
  const missCounter = { hasNew: 0, needsRename: 0, badSlug: 0 };

  console.log(`\n▸ Probing for existing NEW-slug rows...`);
  const CONCURRENCY = 16;
  let probed = 0;
  for (let i = 0; i < oldRows.length; i += CONCURRENCY) {
    const batch = oldRows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      const newSetKey = OLD_TO_NEW_SETKEY[row.setKey];
      if (!newSetKey) { missCounter.badSlug++; return; }
      const newSlug = rewriteSlug(row.id, row.setKey, newSetKey);
      if (newSlug === row.id) { missCounter.badSlug++; return; }
      let known: CatalogRowDoc | null = null;
      try {
        const { resource } = await cat.item(newSlug, newSlug).read<CatalogRowDoc>();
        known = resource ?? null;
      } catch {
        known = null;
      }
      actions.push({ oldRow: row, newSetKey, newSlug, known });
      if (known) missCounter.hasNew++; else missCounter.needsRename++;
      probed++;
    }));
    if (probed % 500 === 0) process.stdout.write(`  probed ${probed}/${oldRows.length}\r`);
  }
  console.log(`\n  merge (NEW exists): ${missCounter.hasNew}`);
  console.log(`  rename (NEW absent): ${missCounter.needsRename}`);
  console.log(`  skipped (bad slug):  ${missCounter.badSlug}`);

  if (args.dryRun) { console.log("\n▸ DRY RUN — no writes."); process.exit(0); }
  if (!args.autoApprove) {
    console.log(`\n  Not --auto-approve, refusing to run writes without explicit confirmation.`);
    console.log(`  Re-run with --auto-approve when ready.`);
    process.exit(0);
  }

  console.log(`\n▸ Applying ${actions.length} actions...`);
  const startedAt = Date.now();
  let merged = 0, replaced = 0, renamed = 0, deleted = 0, salesRepointed = 0, errors = 0;

  // Simple loop with modest concurrency; the volume is bounded by
  // pre-fix dupe count (~20K rows across all years).
  const CONC = 8;
  for (let i = 0; i < actions.length; i += CONC) {
    const batch = actions.slice(i, i + CONC);
    await Promise.all(batch.map(async (act) => {
      try {
        const r = await moveCatalogRow(cat, act.oldRow, act.newSlug, { setKey: act.newSetKey }, {
          reason: `bare setKey ${act.oldRow.setKey} -> ${act.newSetKey}`,
          repointNormalizedSetKey: true,
          salesContainer: pool,
          known: act.known,
        });
        if (r.action === "fold") merged++;
        else if (r.action === "replace") replaced++;
        else renamed++;
        salesRepointed += r.salesRepointed;
        deleted++;
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`  ! ${act.oldRow.id}: ${(err as Error).message}`);
      }
    }));
    const rate = (merged + replaced + renamed) / Math.max(1, (Date.now() - startedAt) / 1000);
    process.stdout.write(`  merged ${merged}, replaced ${replaced}, renamed ${renamed}, deleted ${deleted}, err ${errors} — ${rate.toFixed(1)}/s\r`);
  }

  console.log(`\n▸ Done in ${Math.round((Date.now() - startedAt) / 1000)}s: merged=${merged}, replaced=${replaced}, renamed=${renamed}, deleted=${deleted}, sales re-pointed=${salesRepointed}, errors=${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
