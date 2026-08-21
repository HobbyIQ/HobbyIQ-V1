#!/usr/bin/env node
/**
 * CF-SEARCH-PREDICATE-LOSS (2026-08-21). Definitive correctness check for
 * replacing the catalog fallback disjunction with a token-only predicate.
 *
 * WHY THE FIRST PROBE COULD NOT ANSWER THIS. Comparing the row SETS returned
 * by two TOP-N queries is meaningless once both truncate: each returns a
 * different arbitrary N of a larger match set, so "only-old" and "only-new"
 * come out equal and large. That is a truncation artifact, not lost coverage.
 * Only the un-truncated case (erik hartman, 131 rows both sides, identical)
 * carried any signal.
 *
 * So ask the database the question directly, with no TOP at all:
 *
 *     COUNT(1) WHERE (old predicate) AND NOT (new predicate)
 *
 * That is exactly "rows the token predicate would STOP finding". Zero means
 * the replacement loses nothing. Anything else is the real cost, itemised.
 *
 * Also counts the reverse (new AND NOT old) — rows the token predicate GAINS,
 * which the substring predicate was missing.
 *
 * READ-ONLY. COUNTs only, no TOP, so the numbers are exact rather than
 * sampled. That makes it expensive; run it deliberately.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn || conn.length < 40) {
  console.error("FATAL: COSMOS_CONNECTION_STRING missing/truncated");
  process.exit(1);
}

function tokenize(q) {
  return String(q).toLowerCase().split(/[^a-z0-9-]+/).filter((t) => t.length >= 2);
}

const oldPred = (tokens) =>
  tokens
    .map((_, i) =>
      [
        `ARRAY_CONTAINS(c.searchTokens, @t${i})`,
        `(IS_DEFINED(c.playerName) AND CONTAINS(LOWER(c.playerName), @t${i}))`,
        `(IS_DEFINED(c.setKey) AND CONTAINS(LOWER(c.setKey), @t${i}))`,
        `(IS_DEFINED(c.setName) AND CONTAINS(LOWER(c.setName), @t${i}))`,
        `(IS_DEFINED(c["set"]) AND CONTAINS(LOWER(c["set"]), @t${i}))`,
        `(IS_DEFINED(c.cardNumber) AND CONTAINS(LOWER(c.cardNumber), @t${i}))`,
        `(IS_DEFINED(c.parallel) AND CONTAINS(LOWER(c.parallel), @t${i}))`,
        `(IS_DEFINED(c.parallelSlug) AND CONTAINS(LOWER(c.parallelSlug), @t${i}))`,
      ].join(" OR "),
    )
    .join(" OR ");

const newPred = (tokens) =>
  tokens
    .map((_, i) => `EXISTS(SELECT VALUE t FROM t IN c.searchTokens WHERE STARTSWITH(t, @t${i}))`)
    .join(" OR ");

// CF-LOSS-PROBE-SCOPED (2026-08-21). The unscoped COUNT is a full unindexed
// scan of ~35.7M rows and dies on 429 at the restored 20,000 RU/s ceiling.
// Scope it to a year so the answer is EXACT within a stated subset rather
// than unobtainable. --year=0 restores the full scan for a supervised run
// with headroom.
const YEAR = Number(process.argv.find((a) => a.startsWith("--year=")) ?.split("=")[1] ?? 2025);

async function count(container, where, tokens) {
  const spec = {
    query: `SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @pfx)` +
           (YEAR ? ` AND c.year = @yr` : ``) + ` AND (${where})`,
    parameters: [
      { name: "@pfx", value: "hiq:" },
      ...(YEAR ? [{ name: "@yr", value: YEAR }] : []),
      ...tokens.map((t, i) => ({ name: `@t${i}`, value: t })),
    ],
  };
  const t0 = Date.now();
  // Retry on 429 — the whole point of this query is that it is expensive.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { resources } = await container.items.query(spec).fetchAll();
      return { n: Array.isArray(resources) ? resources[0] : null, ms: Date.now() - t0 };
    } catch (e) {
      if (e.code !== 429 && !String(e.message).includes("request rate is too large")) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
    }
  }
  return { n: null, ms: Date.now() - t0, throttled: true };
}

const CASES = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const QUERIES = CASES.length ? CASES : ["erik hartman", "owen cary"];

(async () => {
  const container = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || "hobbyiq")
    .container("card_catalog");

  console.log("[loss-probe] exact COUNTs, no TOP. LOST is the number that decides this.\n");

  for (const q of QUERIES) {
    const tokens = tokenize(q);
    const O = oldPred(tokens);
    const N = newPred(tokens);

    console.log(`── "${q}"  tokens=${JSON.stringify(tokens)}`);
    const lost = await count(container, `(${O}) AND NOT (${N})`, tokens);
    console.log(`   LOST  (old AND NOT new) : ${lost.n}   [${lost.ms}ms]`);
    const gained = await count(container, `(${N}) AND NOT (${O})`, tokens);
    console.log(`   gained(new AND NOT old) : ${gained.n}   [${gained.ms}ms]`);
    console.log(
      lost.n === 0
        ? "   => token predicate loses NOTHING for this query.\n"
        : `   => token predicate would STOP finding ${lost.n} rows. Investigate before shipping.\n`,
    );
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
