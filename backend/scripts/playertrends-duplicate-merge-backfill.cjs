// CF-PLAYERTRENDS-DUPLICATE-RECORDS (2026-05-28) — one-shot cleanup that
// merges existing slug-form player_trends records into their canonical
// numeric counterparts.
//
// Pairs are identified by shared playerNameNormalized (CF-PLAYERNAME-
// CANONICALIZATION, shipped b51b763 same day). For each duplicate set
// containing exactly one numeric record and one or more slug records:
//   1. Copy each player_trend_history snapshot from the slug partition
//      to the numeric partition (existence-checked per snapshot for
//      idempotency; Cosmos disallows in-place partition-key mutation).
//   2. Delete the slug's player_trends record.
//   3. Delete source snapshots from the slug partition (404-tolerant).
//
// Mirrors the write-path helper `mergeSlugRecordsIfPresent` in
// backend/src/services/playerScore/playerScore.service.ts. Logic is
// duplicated here because this script is CommonJS / standalone (no TS
// toolchain). Keep in sync if the service helper changes.
//
// Safety properties:
//   - Idempotent: re-runs skip already-copied snapshots and tolerate
//     already-deleted source rows.
//   - --dry-run prints the planned actions without writing.
//   - Partial-failure semantics match the write path: the slug parent
//     record is deleted regardless of per-snapshot copy errors so the
//     dup never reappears on the next upsert; partial state is logged
//     via the aggregated `playerScore_slug_merge_partial_failure` event.
//   - Defensive: numeric-vs-numeric duplicate sets are logged and
//     skipped (shouldn't exist under MLB id uniqueness).
//
// Required env: COSMOS_CONNECTION_STRING
//
// Usage:
//   COSMOS_CONNECTION_STRING=<from-az> node backend/scripts/playertrends-duplicate-merge-backfill.cjs [--dry-run]
//
// Expected dry-run output as of 2026-05-28: 4 duplicate sets surfaced
// (Mike Trout, Ken Griffey Jr., Bobby Cox, John Gil) per Phase 1 survey.

const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = "hobbyiq";
const TRENDS_CONTAINER = "player_trends";
const HISTORY_CONTAINER = "player_trend_history";
const DRY_RUN = process.argv.includes("--dry-run");

const NUMERIC_PLAYER_ID_RE = /^\d+$/;

// MUST match types/playerScore.ts:canonicalizePlayerName exactly.
// Duplicated for the same reason as the canonicalization backfill.
function canonicalizePlayerName(name) {
  if (!name) return "";
  return String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,'’‘`]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function copyAndDeleteHistorySnapshots(history, fromPlayerId, toPlayerId) {
  let snapshots;
  try {
    const { resources } = await history.items
      .query(
        {
          query: 'SELECT * FROM c WHERE c["playerId"] = @pid',
          parameters: [{ name: "@pid", value: fromPlayerId }],
        },
        { partitionKey: fromPlayerId },
      )
      .fetchAll();
    snapshots = resources;
  } catch (err) {
    return { copied: 0, skipped: 0, errors: 1, planned: 0 };
  }

  let copied = 0;
  let skipped = 0;
  let errors = 0;
  const planned = snapshots.length;

  for (const s of snapshots) {
    const suffix = s.id.startsWith(`${fromPlayerId}_`)
      ? s.id.slice(fromPlayerId.length + 1)
      : String(
          (typeof s.snapshotAt === "string" && Date.parse(s.snapshotAt))
            || Date.now(),
        );
    const newId = `${toPlayerId}_${suffix}`;

    if (DRY_RUN) {
      // Existence-check the target so dry-run reports what a real run
      // would actually do (copy vs. skip) rather than always claiming a
      // full copy.
      let existsAtTarget = false;
      try {
        const { resource } = await history.item(newId, toPlayerId).read();
        if (resource) existsAtTarget = true;
      } catch (err) {
        if (err && err.code !== 404) {
          errors += 1;
          continue;
        }
      }
      if (existsAtTarget) skipped += 1; else copied += 1;
      continue;
    }

    let existsAtTarget = false;
    try {
      const { resource } = await history.item(newId, toPlayerId).read();
      if (resource) existsAtTarget = true;
    } catch (err) {
      if (err && err.code !== 404) {
        errors += 1;
        continue;
      }
    }

    if (existsAtTarget) {
      try {
        await history.item(s.id, fromPlayerId).delete();
      } catch (_) { /* tolerate */ }
      skipped += 1;
      continue;
    }

    try {
      await history.items.create({ ...s, id: newId, playerId: toPlayerId });
      copied += 1;
    } catch (err) {
      errors += 1;
      continue;
    }

    try {
      await history.item(s.id, fromPlayerId).delete();
    } catch (_) { /* tolerate */ }
  }

  return { copied, skipped, errors, planned };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const client = new CosmosClient(conn);
  const trends = client.database(DB_NAME).container(TRENDS_CONTAINER);
  const history = client.database(DB_NAME).container(HISTORY_CONTAINER);

  console.log(JSON.stringify({
    event: "merge_backfill_start",
    dryRun: DRY_RUN,
    db: DB_NAME,
    trendsContainer: TRENDS_CONTAINER,
    historyContainer: HISTORY_CONTAINER,
  }));

  const { resources: all } = await trends.items.query("SELECT * FROM c").fetchAll();
  console.log(JSON.stringify({ event: "scan_done", totalDocs: all.length }));

  const byCanonical = new Map();
  for (const r of all) {
    const key = r.playerNameNormalized || canonicalizePlayerName(r.playerName);
    if (!key) continue;
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(r);
  }

  const duplicateKeys = [...byCanonical.entries()].filter(([_, rs]) => rs.length > 1);
  console.log(JSON.stringify({
    event: "duplicate_scan_done",
    distinctPlayers: byCanonical.size,
    duplicateSets: duplicateKeys.length,
  }));

  let setsProcessed = 0;
  let setsSkippedNumericCollision = 0;
  let setsSkippedNoNumeric = 0;
  let slugRecordsDeleted = 0;
  let totalHistoryCopied = 0;
  let totalHistorySkipped = 0;
  let totalHistoryErrors = 0;
  let partialFailures = 0;

  for (const [canonical, records] of duplicateKeys) {
    const numerics = records.filter((r) => NUMERIC_PLAYER_ID_RE.test(r.id));
    const slugs = records.filter((r) => !NUMERIC_PLAYER_ID_RE.test(r.id));

    if (numerics.length === 0) {
      // No canonical to merge into. Surfaces CF-PLAYERTRENDS-SLUG-RE-
      // RESOLUTION territory — leave for follow-up CF.
      console.warn(JSON.stringify({
        event: "merge_skipped_no_numeric",
        canonical,
        slugIds: slugs.map((r) => r.id),
      }));
      setsSkippedNoNumeric += 1;
      continue;
    }

    if (numerics.length > 1) {
      // Defensive: shouldn't happen under MLB id uniqueness.
      console.warn(JSON.stringify({
        event: "merge_skipped_numeric_collision",
        canonical,
        numericIds: numerics.map((r) => r.id),
      }));
      setsSkippedNumericCollision += 1;
      continue;
    }

    const numeric = numerics[0];

    for (const slug of slugs) {
      const histCounts = await copyAndDeleteHistorySnapshots(
        history,
        slug.playerId,
        numeric.playerId,
      );

      totalHistoryCopied += histCounts.copied;
      totalHistorySkipped += histCounts.skipped;
      totalHistoryErrors += histCounts.errors;

      if (DRY_RUN) {
        console.log(JSON.stringify({
          event: "would_merge_slug",
          canonical,
          numericId: numeric.id,
          numericPlayerId: numeric.playerId,
          slugId: slug.id,
          slugPlayerId: slug.playerId,
          historyPlanned: histCounts.planned,
          historyCopied: histCounts.copied,
          historySkipped: histCounts.skipped,
          historyErrors: histCounts.errors,
        }));
        slugRecordsDeleted += 1; // count as planned
        if (histCounts.errors > 0) partialFailures += 1;
        continue;
      }

      try {
        await trends.item(slug.id, slug.playerId).delete();
        slugRecordsDeleted += 1;
        console.log(JSON.stringify({
          event: "slug_record_merged",
          canonical,
          numericId: numeric.id,
          numericPlayerId: numeric.playerId,
          slugId: slug.id,
          slugPlayerId: slug.playerId,
          historyCopied: histCounts.copied,
          historySkipped: histCounts.skipped,
          historyErrors: histCounts.errors,
        }));
        if (histCounts.errors > 0) {
          partialFailures += 1;
          console.warn(JSON.stringify({
            event: "playerScore_slug_merge_partial_failure",
            source: "playertrends-duplicate-merge-backfill",
            canonical,
            numericId: numeric.id,
            slugId: slug.id,
            historyCopied: histCounts.copied,
            historySkipped: histCounts.skipped,
            historyErrors: histCounts.errors,
          }));
        }
      } catch (err) {
        if (err && err.code === 404) {
          // Already deleted by a concurrent process / earlier run.
          console.log(JSON.stringify({
            event: "slug_record_already_deleted",
            canonical,
            slugId: slug.id,
          }));
        } else {
          console.error(JSON.stringify({
            event: "slug_record_delete_failed",
            canonical,
            slugId: slug.id,
            message: err && err.message ? err.message : String(err),
            code: err && err.code,
          }));
        }
      }
    }

    setsProcessed += 1;
  }

  console.log(JSON.stringify({
    event: "merge_backfill_done",
    dryRun: DRY_RUN,
    totalDocs: all.length,
    duplicateSets: duplicateKeys.length,
    setsProcessed,
    setsSkippedNumericCollision,
    setsSkippedNoNumeric,
    slugRecordsDeleted,
    totalHistoryCopied,
    totalHistorySkipped,
    totalHistoryErrors,
    partialFailures,
  }));
}

main().catch((e) => { console.error("FATAL:", e && e.message || e); process.exit(1); });
