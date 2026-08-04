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
 *   - Look for an existing row at NEW slug in card_catalog.
 *   - Case A — NEW exists: MERGE. Take max compCount / most-recent
 *     lastSeenAt / union of searchTokens onto NEW. Delete OLD.
 *   - Case B — NEW absent: RENAME. Rewrite doc.id + doc.cardId +
 *     doc.setKey to NEW slug, insert as NEW, delete OLD. (Cosmos can't
 *     move a partition-key value in place — the doc travels.)
 *
 * sold_comps rows that were built with the old normalizer still carry
 * hobbyiqCardId pointing at the OLD slug. We do NOT change comps here
 * — a separate re-run of backfill-soldcomps-canonical.ts (which uses
 * the same fixed normalizer) will re-derive the canonical slug and
 * patch every comp. That script is idempotent and cheap.
 *
 * Idempotent — safe to re-run. Uses bulk() upsert + point deletes.
 *
 * Usage:
 *   npx tsx backend/scripts/dedupe-catalog-setkeys.ts \
 *     [--year YYYY|--all] [--sport baseball] [--dry-run|--auto-approve]
 */

import { CosmosClient, type JSONObject } from "@azure/cosmos";

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

interface CatalogRow {
  id: string; cardId: string; year: number; sport: string; setKey: string;
  cardNumber?: string; parallel?: string; isAuto?: boolean; printRun?: number | null;
  observedCompCount?: number; lastSeenAt?: string; source?: string;
  searchTokens?: string[]; setName?: string; playerName?: string; playerSlug?: string;
  parallelSlug?: string; hobbyiqCardId?: string;
}

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

function mergeRow(target: CatalogRow, source: CatalogRow): CatalogRow {
  // Prefer the higher observedCompCount and the most recent lastSeen.
  const merged: CatalogRow = { ...target };
  if ((source.observedCompCount ?? 0) > (target.observedCompCount ?? 0)) merged.observedCompCount = source.observedCompCount;
  else merged.observedCompCount = (target.observedCompCount ?? 0) + (source.observedCompCount ?? 0);
  if (source.lastSeenAt && (!target.lastSeenAt || source.lastSeenAt > target.lastSeenAt)) merged.lastSeenAt = source.lastSeenAt;
  if (source.searchTokens || target.searchTokens) {
    const tokens = new Set<string>([...(target.searchTokens ?? []), ...(source.searchTokens ?? [])]);
    merged.searchTokens = [...tokens];
  }
  if (source.playerName && !target.playerName) merged.playerName = source.playerName;
  if (source.playerSlug && !target.playerSlug) merged.playerSlug = source.playerSlug;
  return merged;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.year && !args.all) { console.error("Usage: dedupe-catalog-setkeys.ts (--year YYYY|--all) [--sport baseball] [--dry-run|--auto-approve]"); process.exit(2); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");

  const oldSetKeys = Object.keys(OLD_TO_NEW_SETKEY);
  console.log(`\n▸ Dedupe scan across ${oldSetKeys.length} old-setKey fragmentations`);
  if (args.year) console.log(`  year=${args.year}`); else console.log(`  year=ALL`);
  console.log(`  sport=${args.sport}\n`);

  const yearFilter = args.year ? " AND c.year = @year" : "";
  const yearParam = args.year ? [{ name: "@year", value: args.year }] : [];
  const setKeyList = oldSetKeys.map((_, i) => `@sk${i}`).join(", ");
  const setKeyParams = oldSetKeys.map((k, i) => ({ name: `@sk${i}`, value: k }));

  console.log(`▸ Scanning for old-setKey rows...`);
  const iterator = cat.items.query<CatalogRow>({
    query: `SELECT * FROM c WHERE c.sport = @sport${yearFilter} AND c.source = 'bulk-build-from-pool' AND c.setKey IN (${setKeyList})`,
    parameters: [{ name: "@sport", value: args.sport ?? "baseball" }, ...yearParam, ...setKeyParams],
  }, { maxItemCount: 500 });
  const oldRows: CatalogRow[] = [];
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

  // Plan actions: {mode: "merge" | "rename", oldRow, newSlug, newRowIfMerge?}
  interface Action { mode: "merge" | "rename"; oldRow: CatalogRow; newSlug: string; newRow?: CatalogRow; }
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
      try {
        const { resource } = await cat.item(newSlug, newSlug).read<CatalogRow>();
        if (resource) { actions.push({ mode: "merge", oldRow: row, newSlug, newRow: resource }); missCounter.hasNew++; }
        else { actions.push({ mode: "rename", oldRow: row, newSlug }); missCounter.needsRename++; }
      } catch {
        actions.push({ mode: "rename", oldRow: row, newSlug });
        missCounter.needsRename++;
      }
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
  let merged = 0, renamed = 0, deleted = 0, errors = 0;

  // Group deletes/upserts by partition (each id is its own partition).
  // Simple loop with modest concurrency; the volume is bounded by
  // pre-fix dupe count (~20K rows across all years).
  const CONC = 8;
  for (let i = 0; i < actions.length; i += CONC) {
    const batch = actions.slice(i, i + CONC);
    await Promise.all(batch.map(async (act) => {
      try {
        if (act.mode === "merge" && act.newRow) {
          const target = mergeRow(act.newRow, act.oldRow);
          await cat.items.upsert(target as unknown as JSONObject);
          await cat.item(act.oldRow.id, act.oldRow.id).delete();
          merged++;
          deleted++;
        } else {
          // Rename: build new doc with rewritten setKey + id.
          const newDoc = { ...act.oldRow, id: act.newSlug, cardId: act.newSlug, setKey: OLD_TO_NEW_SETKEY[act.oldRow.setKey] } as unknown as JSONObject;
          // Drop Cosmos internal fields that upsert won't like.
          delete (newDoc as { _rid?: unknown })._rid;
          delete (newDoc as { _self?: unknown })._self;
          delete (newDoc as { _etag?: unknown })._etag;
          delete (newDoc as { _attachments?: unknown })._attachments;
          delete (newDoc as { _ts?: unknown })._ts;
          await cat.items.upsert(newDoc);
          await cat.item(act.oldRow.id, act.oldRow.id).delete();
          renamed++;
          deleted++;
        }
      } catch (err) {
        errors++;
        if (errors < 5) console.warn(`  ! ${act.oldRow.id}: ${(err as Error).message}`);
      }
    }));
    const rate = (merged + renamed) / Math.max(1, (Date.now() - startedAt) / 1000);
    process.stdout.write(`  merged ${merged}, renamed ${renamed}, deleted ${deleted}, err ${errors} — ${rate.toFixed(1)}/s\r`);
  }

  console.log(`\n▸ Done in ${Math.round((Date.now() - startedAt) / 1000)}s: merged=${merged}, renamed=${renamed}, deleted=${deleted}, errors=${errors}`);
  console.log(`\n▸ Next: re-run backfill-soldcomps-canonical.ts so sold_comps.hobbyiqCardId points at the new slugs.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
