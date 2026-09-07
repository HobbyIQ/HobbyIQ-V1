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
//   RUN_MINUTES                    the work loop's budget (default 110)
//   RESERVE_MS / VERIFY_MS         unit reserve / verify cap (see THE CLOCK)
//   BACKFILL_CONCURRENCY           parallel workers (default 4 to respect rate limits)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");

let suggestFromDist;
try {
  ({ suggestLabelFromCatalogVariant: suggestFromDist } =
    require("../dist/services/portfolioiq/labelerAiSuggest.service.js"));
} catch (e) {
  console.error("Cannot import suggestLabelFromCatalogVariant from dist — build backend first");
  console.error(e.message); process.exit(2);
}

const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 4));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane WRITES card_catalog rows
// (canonicalLabel + __autoLabeledAt) and had a LOCAL time cap rather than a
// budget: BACKFILL_MAX_MINUTES, defaulting to 25, checked at the TOP of the
// page loop with no unit reserve, and signalling continuation through
// RELAUNCH_NEEDED rather than the marker every other budgeted lane prints.
//
// THAT CAP WAS NOT A BUDGET, and the difference is not cosmetic:
//   - It reserved NOTHING for the unit still in flight, so a page admitted at
//     24m59s got to run its 200 AI calls to completion past expiry -- the exact
//     loop-top defect #1799 named, and the unit here is unusually expensive.
//   - It sat at 25 minutes under a 150-minute ceiling, so it never actually
//     protected anything; the real exposure was a page train that outran the
//     step while the operator believed a cap was holding.
//   - Its RELAUNCH_NEEDED protocol reads a POSITIVE signal of work remaining,
//     which is sound while the lane cannot be killed -- but a killed step prints
//     no line at all, `RN` parses empty, and the runner's RELAUNCH_NEEDED step
//     falls to a `::warning::` that does NOT fail the job. So a killed run went
//     GREEN with the work half done: #1906's defect in a second protocol.
//
// It now takes the same three-constant clock as every other lane, and moves
// onto the MARKER protocol, whose relaunch step (#1913's three-way shape)
// distinguishes a budget stop from a clean finish from a KILL and fails loudly
// on the third.
//
// THE UNIT IS ONE PAGE of up to 200 catalog rows (maxItemCount: 200), and the
// page is the right unit rather than the row because the loop cannot stop
// inside one: the page is fetched whole, then drained through a
// CONCURRENCY-wide (default 4) window. What makes this lane's reserve LARGER
// than a Cosmos-only lane's is what a row costs: each one is an AZURE OPENAI
// call -- seconds, not milliseconds, and rate-limited (the default concurrency
// of 4 is itself set to respect that) -- followed by a read and an upsert. 200
// rows four at a time is fifty serial waves of a multi-second model call, so
// the reserve is FIVE MINUTES rather than the ninety seconds a pure-Cosmos page
// takes, and it is checked BEFORE the page is fetched so the page whose fifty
// AI waves would overrun is never STARTED.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 5 + 1 + 1 = 117m under the 150m ceiling: 33 minutes of margin.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 5 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

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


async function withRetry(fn, attempts = 4, baseMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 200));
    }
  }
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[auto-label-catalog-variants] apply=${APPLY} concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  // Only cardhedge-source rows that lack a canonicalLabel AND haven't
  // been auto-labeled yet. Prefer rows with images (multimodal AI is
  // sharper).
  // CF-COSMOS-RESERVED-SET-AVOID (Drew, 2026-08-02). `set` is a Cosmos
  // SQL reserved word. Aliasing corrupts field access; simpler to just
  // drop it from SELECT and rely on setName / releaseName.
  const query = "SELECT c.id, c.cardId, c.player, c.playerName, c.year, c.number, c.cardNumber, " +
                "c.setName, c.releaseName, c.imageUrl, c.chVariant, c.variant " +
                "FROM c WHERE c.source = 'cardhedge' " +
                "AND (NOT IS_DEFINED(c.canonicalLabel)) " +
                "AND (NOT IS_DEFINED(c.__autoLabeledAt))";
  const iter = cc.items.query({ query }, { maxItemCount: 200 });

  const stats = { scanned: 0, skipParallelPlayer: 0, skipMissingFields: 0, aiCalled: 0, aiHigh: 0, aiMedium: 0, aiLow: 0, aiFailed: 0, labeled: 0, errors: 0 };
  const inFlight = [];
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count here: the loop DISCOVERS rows page by page, so a row never fetched was
  // never seen and is not part of `intended` (feedback: a slice is not a sibling
  // counter).
  let stoppedAtBudget = false;

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
    // THE PRE-CHECK: above the unit's work, and BEFORE the page is fetched
    // rather than after its fifty waves of AI calls have been issued.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
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
      // The inner break only leaves the row walk; the outer `while` re-checks
      // the same clock at the top, so the budget is honoured PER RUN rather
      // than per page (#1947's retire-impossible-grade-rows lesson).
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
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

  // RECONCILE OVER WHAT WAS SEEN. `intended` is the rows this run actually
  // decided to label -- the high-confidence suggestions -- so the identity holds
  // whether the loop finished or the budget stopped it. A medium/low suggestion
  // is a DECISION not to write, which is a skip, not a loss.
  if (APPLY) {
    const intended = stats.aiHigh;
    console.log(`  reconciled: intended ${intended} = written ${stats.labeled} + failed ${stats.errors}`);
    if (stats.labeled + stats.errors !== intended) {
      console.error("  !! RECONCILE MISMATCH -- a high-confidence label was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "auto-label-catalog-variants",
      intended, written: stats.labeled, skipped: 0, failed: stats.errors,
    });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation never re-pays for work already done: a labeled row carries"
      + " __autoLabeledAt and the scan query excludes it by name, so the next pass spends its"
      + " AI budget only on rows this one never reached.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
