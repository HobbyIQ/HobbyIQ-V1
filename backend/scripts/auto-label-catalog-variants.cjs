#!/usr/bin/env node
// CF-AUTO-LABEL-CATALOG-VARIANTS (Drew, 2026-08-02).
//
// Autonomous variant labeling using labelerAiSuggest. Walks unlabeled
// card_catalog rows in portfolio-priority order (hot cards first),
// calls Azure OpenAI to suggest a canonical parallel + print run,
// and writes canonicalLabel back only when the model returns
// confidence="high".
//
// Medium/low-confidence suggestions are left for human review in the
// labeler UI. Guardrails prevent runaway false-positives:
//   - Only writes on confidence="high"
//   - Skips rows missing critical fields (no cardNumber, no player)
//   - Skips rows where playerName is a parallel word (system bug —
//     needs manual review after fix-catalog-parallel-as-player)
//   - Emits __autoLabeledAt marker so re-runs skip already-labeled
//
// Env:
//   COSMOS_CONNECTION_STRING       required
//   AZURE_OPENAI_ENDPOINT          required
//   AZURE_OPENAI_API_KEY           required
//   AZURE_OPENAI_DEPLOYMENT        required
//   BACKFILL_APPLY                 true|false (default false = dry)
//   BACKFILL_MAX_MINUTES           per-slice cap (default 25)
//   BACKFILL_CONCURRENCY           parallel workers (default 4 to respect rate limits)

const { CosmosClient } = require("@azure/cosmos");

let suggestFromDist;
try {
  ({ suggestLabelFromCatalogVariant: suggestFromDist } =
    require("../dist/services/portfolioiq/labelerAiSuggest.service.js"));
} catch (e) {
  console.error("Cannot import suggestLabelFromCatalogVariant from dist — build backend first");
  console.error(e.message); process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 4));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_DEPLOYMENT) {
  console.error("Azure OpenAI env vars required (endpoint/key/deployment)"); process.exit(1);
}

// Parallel-word blocklist — rows where playerName matches means the
// parallel-as-player bug hasn't been fixed for this row yet. Skip so
// we don't compound the wrong identity.
const PARALLEL_WORDS = new Set([
  "superfractor", "refractor", "sapphire", "mini diamond", "x-fractor", "xfractor",
  "speckle", "wave", "ray wave", "shimmer", "lava", "grass",
  "mojo refractor", "mojo", "lazer refractor", "lazer",
  "sunflower seeds", "pop corn", "popcorn", "peanuts", "gum ball", "gumball", "sparkle",
  "red lava", "blue lava", "green lava", "gold lava",
  "red shimmer", "blue shimmer", "green shimmer", "gold shimmer",
  "red wave", "blue wave", "green wave", "gold wave", "orange wave", "purple wave",
  "chrome", "autograph", "base", "rookie", "image variation", "sterling",
  "blue", "red", "gold", "orange", "green", "purple", "pink", "yellow", "aqua",
]);
function isParallelWord(name) {
  if (!name || typeof name !== "string") return false;
  return PARALLEL_WORDS.has(name.trim().toLowerCase());
}

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function withRetry(fn, attempts = 4, baseMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[auto-label-catalog-variants] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES}`);

  // Only cardhedge-source rows that lack a canonicalLabel AND haven't
  // been auto-labeled yet. Prefer rows with images (multimodal AI is
  // sharper).
  const query = "SELECT c.id, c.cardId, c.player, c.playerName, c.year, c.number, c.cardNumber, " +
                "c.setName, c.set, c.releaseName, c.imageUrl, c.chVariant, c.variant " +
                "FROM c WHERE c.source = 'cardhedge' " +
                "AND (NOT IS_DEFINED(c.canonicalLabel)) " +
                "AND (NOT IS_DEFINED(c.__autoLabeledAt))";
  const iter = cc.items.query({ query }, { maxItemCount: 200 });

  const stats = { scanned: 0, skipParallelPlayer: 0, skipMissingFields: 0, aiCalled: 0, aiHigh: 0, aiMedium: 0, aiLow: 0, aiFailed: 0, labeled: 0, errors: 0 };
  const inFlight = [];

  async function processRow(row) {
    try {
      const player = String(row.playerName ?? row.player ?? "").trim();
      const cardNumber = String(row.cardNumber ?? row.number ?? "").trim();
      const set = String(row.setName ?? row.set ?? row.releaseName ?? "").trim();
      const year = Number(row.year);
      const chVariant = String(row.chVariant ?? row.variant ?? "").trim();

      if (!player || !cardNumber || !year || !chVariant) { stats.skipMissingFields++; return; }
      if (isParallelWord(player)) { stats.skipParallelPlayer++; return; }

      stats.aiCalled++;
      const result = await suggestFromDist({
        chVariant,
        set,
        cardNumber,
        cardYear: year,
        playerName: player,
        imageUrl: row.imageUrl ?? null,
      });
      if (!result) { stats.aiFailed++; return; }

      if (result.confidence === "high") stats.aiHigh++;
      else if (result.confidence === "medium") stats.aiMedium++;
      else stats.aiLow++;

      // ONLY auto-write on high confidence
      if (result.confidence !== "high") return;

      const canonicalLabel = {
        parallel: result.parallel,
        isRefractor: result.isRefractor,
        printRun: result.printRun,
        setSlug: set,   // caller reads
        labeledBy: "auto-ai",
        labeledAt: new Date().toISOString(),
        aiReasoning: result.reasoning,
      };

      if (!APPLY) { stats.labeled++; return; }

      try {
        const { resource } = await cc.item(row.id, row.cardId).read();
        if (!resource) { stats.errors++; return; }
        resource.canonicalLabel = canonicalLabel;
        resource.__autoLabeledAt = new Date().toISOString();
        await withRetry(() => cc.items.upsert(resource));
        stats.labeled++;
      } catch { stats.errors++; }
    } catch { stats.errors++; }
  }

  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ time cap"); break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      stats.scanned++;
      inFlight.push(processRow(row).catch(() => { stats.errors++; }));
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
      if (stats.scanned % 500 === 0) {
        console.log(`  scanned=${stats.scanned} aiCalled=${stats.aiCalled} labeled=${stats.labeled} med=${stats.aiMedium} low=${stats.aiLow} skip=${stats.skipMissingFields + stats.skipParallelPlayer} err=${stats.errors + stats.aiFailed}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:               ${stats.scanned}`);
  console.log(`  skipped (missing fields): ${stats.skipMissingFields}`);
  console.log(`  skipped (parallel-as-player): ${stats.skipParallelPlayer}`);
  console.log(`  AI called:             ${stats.aiCalled}`);
  console.log(`    high confidence:     ${stats.aiHigh}  ← auto-labeled`);
  console.log(`    medium confidence:   ${stats.aiMedium}  (left for human)`);
  console.log(`    low confidence:      ${stats.aiLow}    (left for human)`);
  console.log(`    failed:              ${stats.aiFailed}`);
  console.log(`  labeled:               ${stats.labeled}`);
  console.log(`  errors:                ${stats.errors}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); });
