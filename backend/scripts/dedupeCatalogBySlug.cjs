// CF-CATALOG-DEDUPE-BY-SLUG (Drew, 2026-08-10).
// ~120K catalog rows share a hobbyiqCardId with another row but have
// different `id` values (probably older ingesters that used a random
// id, plus newer ingesters that use the slug as id). Keep one canonical
// row per slug; delete the rest.
//
// Merge policy (winner selection when multiple rows share a slug):
//   1. Row whose id === hobbyiqCardId (canonical id shape) wins over
//      random-id rows
//   2. If tied, highest field-fill wins (rows with playerName + photoUrl
//      + team + parallel beat sparse rows)
//   3. If still tied, highest catalogVersion wins (v2 over null)
//   4. If still tied, most-recent _ts wins
//
// Fields to prefer from any losing row (if the winner is missing them):
//   playerName, team, photoUrl, verificationStatus, parallel, printRun,
//   isAuto — anything from a loser that the winner is missing gets
//   merged into the winner via patch. Nothing is silently lost.
//
// Deletions are irreversible. Ships in DRY_RUN mode by default. Only
// flip DRY_RUN=false after the plan output looks right.
//
// Usage:
//   DRY_RUN=true  node backend/scripts/dedupeCatalogBySlug.cjs
//   DRY_RUN=false node backend/scripts/dedupeCatalogBySlug.cjs
//   Optional: MAX_GROUPS=1000  (only process first N dup groups)

const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const MAX_GROUPS = Number(process.env.MAX_GROUPS || 0);
const CONCURRENCY = Math.min(64, Number(process.env.CONCURRENCY || 16));

if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const FIELDS_TO_MERGE = [
  "playerName", "team", "photoUrl", "verificationStatus",
  "parallel", "printRun", "isAuto", "gradeCompany", "gradeValue",
  "gradeTier", "setName", "cardYear",
];

function fillScore(row) {
  let n = 0;
  for (const f of FIELDS_TO_MERGE) if (row[f] !== undefined && row[f] !== null && row[f] !== "") n++;
  return n;
}

function pickWinner(rows) {
  const scored = rows.map(r => ({
    row: r,
    idIsSlug: r.id === r.hobbyiqCardId ? 1 : 0,
    fill: fillScore(r),
    version: Number(r.catalogVersion || 0),
    ts: Number(r._ts || 0),
  }));
  scored.sort((a, b) =>
    b.idIsSlug - a.idIsSlug
    || b.fill - a.fill
    || b.version - a.version
    || b.ts - a.ts
  );
  return { winner: scored[0].row, losers: scored.slice(1).map(s => s.row) };
}

function computeMergePatches(winner, losers) {
  const patches = [];
  for (const f of FIELDS_TO_MERGE) {
    if (winner[f] !== undefined && winner[f] !== null && winner[f] !== "") continue;
    for (const l of losers) {
      if (l[f] !== undefined && l[f] !== null && l[f] !== "") {
        patches.push({ op: "add", path: `/${f}`, value: l[f] });
        break;
      }
    }
  }
  return patches;
}

async function main() {
  const client = new CosmosClient(CONN);
  const cat = client.database("hobbyiq").container("card_catalog");
  const t0 = Date.now();

  console.log("[scan] loading all (id, cardId, hobbyiqCardId) tuples — may take a few minutes");
  const iter = cat.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId
            FROM c
            WHERE IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ""`,
  }, { maxItemCount: 5000 });

  const bySlug = new Map();
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      const arr = bySlug.get(r.hobbyiqCardId) || [];
      arr.push({ id: r.id, cardId: r.cardId ?? r.id, slug: r.hobbyiqCardId });
      bySlug.set(r.hobbyiqCardId, arr);
    }
    if (scanned % 250000 === 0) console.log(`  scanned=${scanned.toLocaleString()}  distinct-slugs=${bySlug.size.toLocaleString()}`);
  }

  const dupGroups = [...bySlug.entries()].filter(([, rows]) => rows.length > 1);
  const totalExtras = dupGroups.reduce((s, [, rows]) => s + (rows.length - 1), 0);

  console.log("");
  console.log("[plan]");
  console.log(`  total rows scanned      : ${scanned.toLocaleString()}`);
  console.log(`  distinct slugs          : ${bySlug.size.toLocaleString()}`);
  console.log(`  slugs with duplicates   : ${dupGroups.length.toLocaleString()}`);
  console.log(`  extra rows to delete    : ${totalExtras.toLocaleString()}`);

  if (dupGroups.length === 0) {
    console.log("");
    console.log("[done] no duplicates found.");
    return;
  }

  const groupsToProcess = MAX_GROUPS > 0 ? dupGroups.slice(0, MAX_GROUPS) : dupGroups;
  console.log(`  processing              : ${groupsToProcess.length.toLocaleString()} groups`);
  if (MAX_GROUPS > 0 && groupsToProcess.length < dupGroups.length) {
    console.log(`  (capped by MAX_GROUPS=${MAX_GROUPS})`);
  }

  console.log("");
  console.log("[detail] reading full rows for winner-picking (this is the expensive part)");
  let mergePatched = 0, deleted = 0, deleteFailed = 0, mergeFailed = 0;
  const inflight = new Set();
  let processedGroups = 0;
  for (const [slug, stubs] of groupsToProcess) {
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const task = (async () => {
      // Fetch full rows for the group
      const fullRows = [];
      for (const s of stubs) {
        try {
          const { resource } = await cat.item(s.id, s.cardId).read();
          if (resource) fullRows.push(resource);
        } catch {}
      }
      if (fullRows.length <= 1) return;
      const { winner, losers } = pickWinner(fullRows);
      const patches = computeMergePatches(winner, losers);

      if (DRY_RUN) {
        processedGroups++;
        if (processedGroups <= 5) {
          console.log(`  [sample] slug=${slug}`);
          console.log(`    winner id=${winner.id}  fill=${fillScore(winner)}  patches=${patches.length}`);
          for (const l of losers) console.log(`    loser  id=${l.id}  fill=${fillScore(l)}`);
        }
        return;
      }

      // Apply merge patches to winner (only if any fields to merge in)
      if (patches.length > 0) {
        try {
          await cat.item(winner.id, winner.cardId ?? winner.id).patch(patches);
          mergePatched++;
        } catch (err) {
          mergeFailed++;
          if (mergeFailed <= 5) console.warn(`  merge-fail slug=${slug}: ${err && err.message}`);
        }
      }
      // Delete losers
      for (const l of losers) {
        try {
          await cat.item(l.id, l.cardId ?? l.id).delete();
          deleted++;
          if (deleted % 5000 === 0) console.log(`  deleted ${deleted.toLocaleString()}/${totalExtras.toLocaleString()}`);
        } catch (err) {
          const code = err && (err.code ?? err.statusCode);
          if (code === 404) { deleted++; continue; }
          deleteFailed++;
          if (deleteFailed <= 5) console.warn(`  delete-fail id=${l.id}: ${err && err.message}`);
        }
      }
    })().finally(() => inflight.delete(task));
    inflight.add(task);
  }
  await Promise.all([...inflight]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done]");
  if (DRY_RUN) {
    console.log("[DRY_RUN] no writes. Set DRY_RUN=false to apply the plan above.");
  } else {
    console.log(`  merge patches applied : ${mergePatched.toLocaleString()}`);
    console.log(`  merge failures        : ${mergeFailed.toLocaleString()}`);
    console.log(`  losers deleted        : ${deleted.toLocaleString()}`);
    console.log(`  delete failures       : ${deleteFailed.toLocaleString()}`);
  }
  console.log(`  elapsed               : ${elapsed}s`);
}

main().catch(e => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
