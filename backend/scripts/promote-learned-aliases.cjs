#!/usr/bin/env node
/**
 * CF-LEARNED-ALIAS-PROMOTION (2026-07-08, Drew):
 *
 * Nightly aggregation job. Scans search_selections for
 * (queryNormalized, resolvedPlayer) pairs with strong support
 * (distinct users >= MIN_DISTINCT_USERS over LOOKBACK_DAYS) and
 * promotes them to learned aliases in search_aliases.
 *
 * ## Runbook
 *
 *   COSMOS_ENDPOINT=... COSMOS_KEY=... \
 *   MIN_DISTINCT_USERS=10 LOOKBACK_DAYS=90 \
 *   node backend/scripts/promote-learned-aliases.cjs
 *
 * Idempotent: the upsertAlias merge logic in the repository ensures
 * re-running doesn't duplicate aliases or lower confidence, and never
 * stomps on admin/static entries.
 *
 * Cron: intended to run once a day via GitHub Actions workflow or an
 * Azure App Service scheduled job. Runtime scales with volume of
 * search_selections; a fresh corpus (thousands of rows) completes in
 * seconds.
 *
 * ## Safety
 *
 * - Never promotes an alias where the query IS the canonical player
 *   name (avoids "eli willits" → alias-of-"Eli Willits" loops).
 * - Never overwrites a static/admin entry — the merge logic in the
 *   repository handles this.
 * - --dry-run flag lists proposed promotions without writing.
 */

const path = require("node:path");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const distSel = path.resolve(__dirname, "..", "dist", "repositories", "searchSelections.repository.js");
  const distAliases = path.resolve(__dirname, "..", "dist", "repositories", "searchAliases.repository.js");

  let findPromotableQueryPairs, upsertAlias;
  try {
    ({ findPromotableQueryPairs } = await import(distSel));
    ({ upsertAlias } = await import(distAliases));
  } catch (err) {
    console.error("Cannot find dist output. Build with `npm run build` or invoke via tsx.");
    console.error(err.message);
    process.exit(1);
  }

  const MIN_DISTINCT_USERS = parseInt(process.env.MIN_DISTINCT_USERS ?? "10", 10);
  const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? "90", 10);

  console.log(
    `[promote-aliases] MIN_DISTINCT_USERS=${MIN_DISTINCT_USERS}  LOOKBACK_DAYS=${LOOKBACK_DAYS}  DRY_RUN=${!!args.dryRun}`,
  );

  const candidates = await findPromotableQueryPairs(MIN_DISTINCT_USERS, LOOKBACK_DAYS);
  console.log(`[promote-aliases] ${candidates.length} candidate promotions`);

  let promoted = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of candidates) {
    // Skip loops: if the query IS the player name (case-insensitive),
    // there's no vocab gap to close.
    if (c.query.toLowerCase() === c.resolvedPlayer.toLowerCase()) {
      skipped++;
      continue;
    }

    console.log(
      `[promote-aliases] ${c.query} → ${c.resolvedPlayer} (${c.distinctUsers} users, ${c.selections} selections)`,
    );

    if (args.dryRun) {
      promoted++;
      continue;
    }

    try {
      await upsertAlias({
        category: "player",
        canonical: c.resolvedPlayer,
        aliases: [c.query],
        source: "learned",
        confidence: 0.85,
        lastConfirmedAt: new Date().toISOString(),
        notes: `Learned from ${c.distinctUsers} users / ${c.selections} selections`,
      });
      promoted++;
    } catch (err) {
      failed++;
      console.warn(`[promote-aliases] upsert failed for ${c.query} → ${c.resolvedPlayer}:`, err?.message ?? err);
    }
  }

  console.log(
    `[promote-aliases] DONE: ${promoted} promoted, ${skipped} skipped, ${failed} failed`,
  );
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
