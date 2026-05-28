// CF-PLAYERNAME-CANONICALIZATION (2026-05-28) — one-shot backfill
// that populates `playerNameNormalized` on every existing player_trends
// document.
//
// Idempotent: re-running this is safe. If a doc already has the field
// with the correct value, it's skipped. If the field is missing or
// stale (e.g. canonicalization logic changed), it's recomputed.
//
// Safety properties:
//   - Read all then write all (no streaming). 76 records as of
//     2026-05-28. If the cohort grows substantially, switch to
//     a streaming pattern with progress + rate-limit awareness.
//   - Each upsert preserves the existing document; only adds /
//     updates the playerNameNormalized field.
//   - Does NOT swap the read path. The read path's migration
//     fallback (LOWER(playerName)) continues to work; this backfill
//     just makes the primary canonical query also succeed for these
//     pre-existing rows.
//
// Required env: COSMOS_CONNECTION_STRING
//
// Usage:
//   COSMOS_CONNECTION_STRING=<from-az> node backend/scripts/playertrends-canonicalization-backfill.cjs [--dry-run]
//
// --dry-run prints the proposed updates without writing.

const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = "hobbyiq";
const CONTAINER = "player_trends";
const DRY_RUN = process.argv.includes("--dry-run");

// MUST match types/playerScore.ts:canonicalizePlayerName exactly.
// Duplicated here because this script is CommonJS / runs standalone
// (no TS toolchain). Keep in sync if the TS helper changes.
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

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const client = new CosmosClient(conn);
  const c = client.database(DB_NAME).container(CONTAINER);

  console.log(JSON.stringify({ event: "backfill_start", dryRun: DRY_RUN, db: DB_NAME, container: CONTAINER }));

  const { resources } = await c.items.query("SELECT * FROM c").fetchAll();
  console.log(JSON.stringify({ event: "scan_done", totalDocs: resources.length }));

  let skipped_correct = 0;
  let updated_added = 0;
  let updated_changed = 0;
  let errors = 0;

  for (const doc of resources) {
    const desired = canonicalizePlayerName(doc.playerName);
    const current = doc.playerNameNormalized;

    if (current === desired) {
      skipped_correct += 1;
      continue;
    }

    const isAdd = current == null;

    if (DRY_RUN) {
      console.log(JSON.stringify({
        event: isAdd ? "would_add" : "would_change",
        id: doc.id,
        playerName: doc.playerName,
        currentNormalized: current ?? null,
        desiredNormalized: desired,
      }));
      if (isAdd) updated_added += 1; else updated_changed += 1;
      continue;
    }

    try {
      const updated = { ...doc, playerNameNormalized: desired };
      await c.items.upsert(updated);
      console.log(JSON.stringify({
        event: isAdd ? "added" : "changed",
        id: doc.id,
        playerName: doc.playerName,
        currentNormalized: current ?? null,
        desiredNormalized: desired,
      }));
      if (isAdd) updated_added += 1; else updated_changed += 1;
    } catch (err) {
      errors += 1;
      console.error(JSON.stringify({
        event: "error",
        id: doc.id,
        playerName: doc.playerName,
        message: err && err.message ? err.message : String(err),
        code: err && err.code,
      }));
    }
  }

  console.log(JSON.stringify({
    event: "backfill_done",
    dryRun: DRY_RUN,
    totalDocs: resources.length,
    skipped_correct,
    updated_added,
    updated_changed,
    errors,
  }));
}

main().catch((e) => { console.error("FATAL:", e && e.message || e); process.exit(1); });
