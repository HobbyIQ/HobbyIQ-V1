// CF-BACKFILL-RE-CLEAN (Drew, 2026-08-08). Retro-clean existing
// sold_comps rows whose playerName carries insert-subset descriptors
// ("Shohei Ohtani Pitching Jersey", "Debut Shohei Ohtani",
// "SHOHEI OHTANI 2018 2018", etc.). The normalizer patch in
// holdingFieldNormalizer.service.ts (commit 160b5547) fixes forward
// ingest; this script fixes the ~3.9M historical rows.
//
// Approach per row:
//   1. Load row + apply normalizer
//   2. If playerName changed OR sport changed → recompute hobbyiqCardId
//   3. Patch { playerName, hobbyiqCardId } if changed
//
// SAFETY GUARDS:
//   · Dry-run by default (APPLY=true required)
//   · SAMPLE_ONLY=true → first BATCH_SIZE rows only, dry-run stats
//   · Only patches when playerName ACTUALLY changed (idempotent)
//   · Concurrency-bounded + 429 backoff
//   · Continuation-token paginated (resume-safe on crash)
//   · Reports both dry-run and apply stats
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 do the patches (else dry-run)
//   SAMPLE_ONLY=true           first BATCH_SIZE rows, log stats, exit
//   BATCH_SIZE                 rows per page (default 500)
//   MAX_ROWS                   total cap (default 5,000,000 = all)
//   CONCURRENCY                parallel patches (default 12)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");

const APPLY = process.env.APPLY === "true";
const SAMPLE_ONLY = process.env.SAMPLE_ONLY === "true";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const MAX_ROWS = Number(process.env.MAX_ROWS || 5_000_000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);

function loadHelpers() {
  const normP = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "holdingFieldNormalizer.service.js");
  const slugP = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  return {
    normalizeHoldingFields: require(normP).normalizeHoldingFields,
    computeHobbyIqCardId: require(slugP).computeHobbyIqCardId,
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database("hobbyiq").container("sold_comps");
  const { normalizeHoldingFields, computeHobbyIqCardId } = loadHelpers();

  console.log(`[re-clean] apply=${APPLY}  sample=${SAMPLE_ONLY}  batch=${BATCH_SIZE}  max=${MAX_ROWS}  conc=${CONCURRENCY}`);

  const stats = {
    seen: 0,
    unchanged: 0,          // normalizer produced same playerName
    playerNameChanged: 0,  // playerName was cleaned
    slugChanged: 0,        // hobbyiqCardId also recomputed differently
    patched: 0,            // actually written
    errored: 0,
    changeReasons: new Map(),  // rule name → count
    samples: [],           // first N examples of change
  };
  const startMs = Date.now();

  let continuation = undefined;
  outer: while (stats.seen < MAX_ROWS) {
    const iter = sc.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.sport
              FROM c`,
    }, { maxItemCount: BATCH_SIZE, continuationToken: continuation });
    let resources, continuationToken;
    try {
      const r = await iter.fetchNext();
      resources = r.resources;
      continuationToken = r.continuationToken;
    } catch (err) {
      if (err?.code === 429) {
        const wait = Number(err?.retryAfterInMs ?? 5000);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
    if (!resources || resources.length === 0) break;

    // Compute normalized version + slug for each row
    const patches = [];
    for (const row of resources) {
      stats.seen++;
      if (stats.seen > MAX_ROWS) break outer;
      const before = row.playerName;
      if (!before) { stats.unchanged++; continue; }
      const result = normalizeHoldingFields({
        playerName: before,
        cardYear: row.cardYear,
        setName: row.setName,
        cardNumber: row.cardNumber,
        parallel: row.parallel,
        isAuto: row.isAuto ?? false,
        printRun: row.printRun ?? null,
        product: null,
      });
      const after = result.fields.playerName;
      if (after === before) { stats.unchanged++; continue; }
      stats.playerNameChanged++;
      for (const ch of result.changes) {
        stats.changeReasons.set(ch.rule, (stats.changeReasons.get(ch.rule) || 0) + 1);
      }
      // Recompute hobbyiqCardId if we have enough identity
      let newSlug = row.hobbyiqCardId;
      if (row.sport && typeof row.cardYear === "number" && row.setName && row.cardNumber) {
        try {
          newSlug = computeHobbyIqCardId({
            sport: row.sport,
            year: row.cardYear,
            setKey: row.setName,
            cardNumber: row.cardNumber,
            parallel: row.parallel || "Base",
            isAuto: row.isAuto ?? false,
            printRun: row.printRun ?? null,
          });
          if (newSlug !== row.hobbyiqCardId) stats.slugChanged++;
        } catch { /* leave slug alone */ }
      }
      if (stats.samples.length < 5) {
        stats.samples.push({
          id: row.id.slice(0, 45),
          before,
          after,
          slugBefore: row.hobbyiqCardId,
          slugAfter: newSlug,
        });
      }
      if (APPLY && !SAMPLE_ONLY) {
        patches.push({ id: row.id, cardId: row.cardId, playerName: after, hobbyiqCardId: newSlug });
      }
    }

    // Apply patches with bounded concurrency
    if (patches.length > 0) {
      for (let i = 0; i < patches.length; i += CONCURRENCY) {
        const chunk = patches.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(chunk.map(async (p) => {
          const pk = p.cardId || p.id;
          for (let a = 0; a < 5; a++) {
            try {
              const ops = [{ op: "add", path: "/playerName", value: p.playerName }];
              if (p.hobbyiqCardId) ops.push({ op: "add", path: "/hobbyiqCardId", value: p.hobbyiqCardId });
              await sc.item(p.id, pk).patch(ops);
              return;
            } catch (err) {
              const code = err?.code ?? err?.statusCode;
              if (code === 429 && a < 4) {
                const wait = Number(err?.retryAfterInMs ?? (200 * Math.pow(2, a)));
                await new Promise(res => setTimeout(res, wait));
                continue;
              }
              if (code === 404) return; // already gone
              throw err;
            }
          }
        }));
        for (const r of results) {
          if (r.status === "fulfilled") stats.patched++;
          else { stats.errored++; if (stats.errored <= 3) console.warn(`  patch err: ${r.reason?.message?.slice(0, 100)}`); }
        }
      }
    }

    const rate = stats.seen / Math.max(1, (Date.now() - startMs) / 1000);
    console.log(`  page: seen=${stats.seen} changed=${stats.playerNameChanged} patched=${stats.patched} err=${stats.errored} rate=${rate.toFixed(0)}/s`);

    if (SAMPLE_ONLY) break;
    if (!continuationToken) break;
    continuation = continuationToken;
  }

  console.log(`\n=== RE-CLEAN SUMMARY ===`);
  console.log(`  apply:              ${APPLY}`);
  console.log(`  seen:               ${stats.seen.toLocaleString()}`);
  console.log(`  unchanged:          ${stats.unchanged.toLocaleString()}`);
  console.log(`  playerName changed: ${stats.playerNameChanged.toLocaleString()}  (${(stats.playerNameChanged / Math.max(1, stats.seen) * 100).toFixed(2)}%)`);
  console.log(`  slug also changed:  ${stats.slugChanged.toLocaleString()}`);
  console.log(`  patched:            ${stats.patched.toLocaleString()}`);
  console.log(`  errored:            ${stats.errored.toLocaleString()}`);
  console.log(`  elapsed:            ${Math.round((Date.now() - startMs) / 1000)}s`);
  console.log(`\n  change reasons:`);
  for (const [rule, n] of [...stats.changeReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${rule.padEnd(45)} ${n.toLocaleString()}`);
  }
  console.log(`\n  Sample changes (first ${stats.samples.length}):`);
  for (const s of stats.samples) {
    console.log(`    ${s.id}`);
    console.log(`      "${s.before}"`);
    console.log(`   → "${s.after}"`);
    if (s.slugBefore !== s.slugAfter) console.log(`      slug: ${s.slugBefore || "(null)"}  →  ${s.slugAfter || "(null)"}`);
  }
  if (!APPLY) console.log(`\n  [dry-run] no writes. Rerun with APPLY=true.`);
}

main().catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
