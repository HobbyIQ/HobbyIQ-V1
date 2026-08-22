// CF-TOKEN-COVERAGE-CANARY (2026-08-20). Cron-driven canary that asks the
// DATA how much of card_catalog is missing searchTokens, and fails loudly when
// coverage regresses.
//
// MOTIVATING CASE. The "Nightly searchTokens backfill" ran GREEN every night
// for months while structurally unable to touch almost anything: its scan was
// scoped `WHERE c.source = 'cardsight' AND c.sport = @sp`, and Cardsight was
// retired from matching on 2026-08-16. Measured 2026-08-20: 3,030,193 rows had
// no searchTokens.
//
// The cost was not cosmetic. searchTokens is the ONLY index-accelerated
// predicate catalogSearch has (ARRAY_CONTAINS). A row without them cannot be
// found by the fast anchor arm, so the request falls through to fallback
// queries carrying seven unindexed CONTAINS branches — a scan of ~35.7M rows.
// Measured effect on /api/compiq/search: catalogMs averaged 31,214ms on cache
// HITS while the pricing engine itself cost 6ms.
//
// WHY A CANARY AND NOT A GREENER JOB. Nothing about the backfill's exit code
// was ever wrong; it did exactly what it was scoped to do. Three separate
// numbers that same day read as complete while being wrong: this job's green
// runs, an enrichment report whose buckets summed to 98.4%, and a bulk error
// counter that under-reported unwritten rows 19x by counting batches instead of
// rows. Counters describe the run. Only a query describes the data.
//
// See feedback_green_workflow_is_not_data_flow.
//
// CF-TOKEN-COVERAGE-STALENESS (2026-08-22). The canary above counted EMPTY
// token arrays. That is not the same question as "are the tokens right".
//
// A row written by an older builder is non-empty, so it counted as covered,
// while missing the canonical fields the searcher relies on. It then misses
// every indexed arm and falls through to the unindexed scans at full cost —
// invisibly, with the canary green. On 2026-08-21 this canary reported 27,253
// missing and "OK" while the catalog was believed to be ~58% stale. It was in
// fact not stale at all, but the canary could not have said so either way,
// which is the defect: a check that cannot fail is not a check.
//
// So sample rows and recompute. Cheap (a few hundred point reads), and it
// uses the SAME builders the backfill writes with — see searchTokenBuilders.
//
// Exit codes:  0 = within threshold   1 = regression (alert)   2 = misconfigured

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

// The SAME builders the backfill writes with. Importing rather than copying is
// the point: a canary carrying its own copy cannot notice the builder changing
// underneath it.
const {
  classifyRowTokens,
  TOKEN_SOURCE_FIELDS,
} = require(path.join(__dirname, "comp-quality/searchTokenBuilders.cjs"));

// Sized off the 2026-08-20 backfill. After it, steady state should be small —
// only newly-ingested rows awaiting their next nightly pass. A sustained number
// far above that means the backfill is scoped wrong again, or has stopped.
const MAX_MISSING = Number(process.env.MAX_MISSING_TOKENS || 250000);

// Staleness is measured on a SAMPLE, so the threshold is a share, not a count.
//
// KNOWN CURRENT LEVEL: 5.07% (36/710) as of 2026-08-22, and it is not noise —
// it is the CF-TOKEN-FOLD-TO-MATCH-SEARCHER gap. Rows whose fields carry
// apostrophes or diacritics were tokenised before the builder folded them, so
// they lack the ASCII forms users type: "acuna" does not reach Ronald Acuña,
// "aguero" does not reach Sergio Agüero.
//
// It was set at 8 rather than 2 deliberately, because the gap was real and a
// permanently-red cron is how the previous generation of this check stopped
// being read at all. 8% still caught what this canary is FOR — a scope or
// builder regression shows up in the tens of percent.
//
// NOW LOWERED TO 2. The re-tokenisation pass ran 2026-08-22 and the number came
// down as predicted, measured on two consecutive clean runs:
//
//   before   5.07%  (36/710)
//   pass 2   1.69%  (12/708)
//   pass 3   0.99%  ( 7/708)
//
// 2% is deliberately close to the measured 0.99%. That is the point — the fold
// gap is cleared, so anything that reopens it should go red rather than hide
// under headroom sized for a backlog that no longer exists. Note the sample is
// ~708 rows, so 2% is about 14 stale rows: expect single-row jitter, and treat
// a red as "look", not "certainly broken".
//
// MAX_MISSING is a separate axis and is NOT clean: 24,720 rows still lack
// tokens (up from 16,226 after pass 2), because pass 3 lost ~56k rows to RU
// throttling. That is under the 250,000 threshold and is a coverage backlog,
// not staleness — dedup the catalog before spending RU on another pass.
const MAX_STALE_PCT = Number(process.env.MAX_STALE_TOKENS_PCT || 2);
const STALE_SAMPLE_PER_YEAR = Number(process.env.STALE_SAMPLE_PER_YEAR || 60);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) {
    console.error("::error::COSMOS_CONNECTION_STRING required");
    process.exit(2);
  }

  const cc = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || "hobbyiq")
    .container("card_catalog");

  const missingPredicate =
    "(NOT IS_DEFINED(c.searchTokens) OR c.searchTokens = null OR ARRAY_LENGTH(c.searchTokens) = 0)";

  const { resources: totals } = await cc.items
    .query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @pfx) AND ${missingPredicate}`,
      parameters: [{ name: "@pfx", value: "hiq:" }],
    })
    .fetchAll();

  const missing = Array.isArray(totals) ? totals[0] : null;
  if (typeof missing !== "number") {
    console.error("::error::[token-coverage] count query returned no value — treating as FAILURE");
    process.exit(1);
  }

  console.log(`[token-coverage] rows missing searchTokens: ${missing.toLocaleString()}`);
  console.log(`[token-coverage] threshold:                 ${MAX_MISSING.toLocaleString()}`);

  // Break down by sport, because the historical failure was a SCOPE bug: one
  // sport covered and the rest silently ignored. A single total would have
  // looked healthy while football sat at zero coverage.
  try {
    const { resources: bySport } = await cc.items
      .query({
        query:
          `SELECT c.sport AS sport, COUNT(1) AS n FROM c ` +
          `WHERE STARTSWITH(c.id, @pfx) AND ${missingPredicate} ` +
          `GROUP BY c.sport`,
        parameters: [{ name: "@pfx", value: "hiq:" }],
      })
      .fetchAll();
    if (bySport && bySport.length) {
      console.log("[token-coverage] missing by sport:");
      for (const r of bySport.sort((a, b) => (b.n || 0) - (a.n || 0))) {
        console.log(`    ${String(r.sport ?? "(unset)").padEnd(12)} ${String(r.n).padStart(10)}`);
      }
    }
  } catch (e) {
    console.warn(`[token-coverage] per-sport breakdown unavailable: ${e.message}`);
  }

  // ── Staleness sample ─────────────────────────────────────────────────────
  //
  // Sample per YEAR so a regression confined to recent product cannot be
  // diluted by twelve healthy years, and vary the sample with an INDEXED
  // predicate on playerName. A cross-partition ORDER BY ... OFFSET is the
  // obvious way to sample and it is unusable here: it timed out at 2 minutes
  // against this container.
  let staleFound = 0;
  let staleChecked = 0;
  const staleByYear = [];
  try {
    const thisYear = new Date().getUTCFullYear();
    for (let y = thisYear - 11; y <= thisYear; y++) {
      const { resources } = await cc.items
        .query({
          query:
            `SELECT TOP ${STALE_SAMPLE_PER_YEAR} ${TOKEN_SOURCE_FIELDS.join(', ')} ` +
            `FROM c WHERE STARTSWITH(c.id, @pfx) AND c.year = @y ` +
            `AND STARTSWITH(c.playerName, @ltr)`,
          parameters: [
            { name: "@pfx", value: "hiq:" },
            { name: "@y", value: y },
            // Rotate the letter by year so successive runs do not all sample
            // the same slice of the index.
            { name: "@ltr", value: "BCGMRST"[y % 7] },
          ],
        })
        .fetchAll();
      if (!resources.length) continue;
      let stale = 0;
      let checked = 0;
      for (const row of resources) {
        const verdict = classifyRowTokens(row);
        // "empty" is already counted by the exact query above; counting it
        // here too would double-punish the same rows.
        if (verdict === "empty") continue;
        checked++;
        if (verdict === "stale") stale++;
      }
      if (!checked) continue;
      staleFound += stale;
      staleChecked += checked;
      staleByYear.push({ year: y, stale, checked });
    }
  } catch (e) {
    console.warn(`[token-coverage] staleness sample unavailable: ${e.message}`);
  }

  const stalePct = staleChecked ? (staleFound / staleChecked) * 100 : 0;
  if (staleChecked) {
    console.log(
      `[token-coverage] stale tokens: ${staleFound}/${staleChecked} sampled ` +
        `(${stalePct.toFixed(2)}%, threshold ${MAX_STALE_PCT}%)`,
    );
    const worst = staleByYear.filter((r) => r.stale > 0).sort((a, b) => b.stale - a.stale);
    if (worst.length) {
      console.log("[token-coverage] stale by year:");
      for (const r of worst) console.log(`    ${r.year}  ${r.stale}/${r.checked}`);
    }
  } else {
    // Never let "I sampled nothing" read as "nothing is wrong".
    console.error(
      "::error::[token-coverage] staleness sample checked ZERO rows — the check did not run. " +
        "Treating as FAILURE rather than reporting a clean bill from no evidence.",
    );
    process.exit(1);
  }

  if (stalePct > MAX_STALE_PCT) {
    console.error(
      `::error::[token-coverage] ${stalePct.toFixed(2)}% of sampled rows carry STALE searchTokens ` +
        `(threshold ${MAX_STALE_PCT}%). These rows are non-empty, so the missing-tokens count ` +
        `above reports them as covered — but they lack tokens the current builder produces, so ` +
        `catalogSearch's indexed arms miss them and /search falls back to scanning ~35.7M rows. ` +
        `Re-run the backfill WITHOUT missing-only for the affected years.`,
    );
    process.exit(1);
  }

  if (missing > MAX_MISSING) {
    console.error(
      `::error::[token-coverage] ${missing.toLocaleString()} rows lack searchTokens ` +
        `(threshold ${MAX_MISSING.toLocaleString()}). catalogSearch cannot use its index for these, ` +
        `so /search falls back to scanning ~35.7M rows. Check the nightly backfill's SCOPE ` +
        `(--sport, source filter) before assuming it merely needs another run.`,
    );
    process.exit(1);
  }

  console.log("[token-coverage] OK — within threshold.");
}

main().catch((e) => {
  console.error("::error::[token-coverage] FAILED:", e?.message || e);
  process.exit(1);
});
