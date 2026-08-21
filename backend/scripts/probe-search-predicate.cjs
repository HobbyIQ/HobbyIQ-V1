#!/usr/bin/env node
/**
 * CF-SEARCH-PREDICATE-PROBE (2026-08-21). A/B the catalog fallback predicate:
 * the current 8-per-token disjunction versus a token-only one.
 *
 * WHAT IS BEING COMPARED.
 *
 *   OLD  per token: ARRAY_CONTAINS(searchTokens) OR CONTAINS(playerName) OR
 *        CONTAINS(setKey) OR CONTAINS(setName) OR CONTAINS(set) OR
 *        CONTAINS(cardNumber) OR CONTAINS(parallel) OR CONTAINS(parallelSlug)
 *        -- 7 of the 8 are unindexed, and one unindexed branch in an OR forces
 *        a scan of ~35.7M rows regardless of the indexed branch.
 *
 *   NEW  per token: EXISTS(SELECT VALUE t FROM t IN c.searchTokens
 *                          WHERE STARTSWITH(t, @tN))
 *        -- index-accelerated, and STARTSWITH subsumes exact match, so one
 *        predicate replaces eight.
 *
 * WHY CORRECTNESS COMES FIRST. CONTAINS matches SUBSTRINGS anywhere in a
 * field; token STARTSWITH matches only from a token boundary. Those are not
 * the same relation. "chrome" reaches setKey "bowman-chrome" under CONTAINS,
 * and under the new shape only because buildSearchText splits setKey on
 * hyphens into separate tokens. That assumption is exactly what this probe
 * tests, per gate case, on live data.
 *
 * The gate is the documented fuzzy set (2026-08-15):
 *   justin gonzalez  -- currently FAILS (returns other Gonzalezes, 14.9s)
 *   erik hartman / owen cary / justin gonzales -- currently pass
 *
 * READ-ONLY. SELECTs only.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/probe-search-predicate.cjs
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn || conn.length < 40) {
  console.error("FATAL: COSMOS_CONNECTION_STRING missing/truncated");
  process.exit(1);
}

const TOP = Number(process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 200);

// The projection the anchor arms already use — narrow on purpose.
const FIELDS =
  "c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c.parallel, c.isAuto";

function tokenize(q) {
  return String(q).toLowerCase().split(/[^a-z0-9-]+/).filter((t) => t.length >= 2);
}

function oldPredicate(tokens) {
  const parts = [];
  tokens.forEach((_, i) => {
    parts.push(`ARRAY_CONTAINS(c.searchTokens, @t${i})`);
    parts.push(`(IS_DEFINED(c.playerName) AND CONTAINS(LOWER(c.playerName), @t${i}))`);
    parts.push(`(IS_DEFINED(c.setKey) AND CONTAINS(LOWER(c.setKey), @t${i}))`);
    parts.push(`(IS_DEFINED(c.setName) AND CONTAINS(LOWER(c.setName), @t${i}))`);
    parts.push(`(IS_DEFINED(c["set"]) AND CONTAINS(LOWER(c["set"]), @t${i}))`);
    parts.push(`(IS_DEFINED(c.cardNumber) AND CONTAINS(LOWER(c.cardNumber), @t${i}))`);
    parts.push(`(IS_DEFINED(c.parallel) AND CONTAINS(LOWER(c.parallel), @t${i}))`);
    parts.push(`(IS_DEFINED(c.parallelSlug) AND CONTAINS(LOWER(c.parallelSlug), @t${i}))`);
  });
  return parts.join(" OR ");
}

function newPredicate(tokens) {
  return tokens
    .map((_, i) => `EXISTS(SELECT VALUE t FROM t IN c.searchTokens WHERE STARTSWITH(t, @t${i}))`)
    .join(" OR ");
}

async function run(container, predicate, tokens, budgetMs) {
  const spec = {
    query: `SELECT TOP ${TOP} ${FIELDS} FROM c WHERE STARTSWITH(c.id, @pfx) AND (${predicate})`,
    parameters: [
      { name: "@pfx", value: "hiq:" },
      ...tokens.map((t, i) => ({ name: `@t${i}`, value: t })),
    ],
  };
  const t0 = Date.now();
  const it = container.items.query(spec, { maxItemCount: TOP });
  const ids = new Set();
  let ru = 0;
  let timedOut = false;
  try {
    while (it.hasMoreResults()) {
      if (Date.now() - t0 > budgetMs) { timedOut = true; break; }
      const page = await it.fetchNext();
      ru += page.requestCharge ?? 0;
      for (const r of page.resources ?? []) ids.add(r.id);
      if (ids.size >= TOP) break;
    }
  } catch (e) {
    return { ms: Date.now() - t0, ids, ru: Math.round(ru), err: e.message };
  }
  return { ms: Date.now() - t0, ids, ru: Math.round(ru), timedOut };
}

const CASES = ["justin gonzalez", "erik hartman", "owen cary", "justin gonzales"];
const BUDGET_MS = Number(process.argv.find((a) => a.startsWith("--budget="))?.split("=")[1] ?? 90000);

(async () => {
  const container = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || "hobbyiq")
    .container("card_catalog");

  console.log(`[predicate-probe] TOP=${TOP} budget=${BUDGET_MS}ms — NEW arm first so it is not`);
  console.log(`[predicate-probe] flattered by a cache the OLD arm warmed.\n`);

  for (const q of CASES) {
    const tokens = tokenize(q);
    console.log(`── "${q}"  tokens=${JSON.stringify(tokens)}`);

    const nu = await run(container, newPredicate(tokens), tokens, BUDGET_MS);
    const old = await run(container, oldPredicate(tokens), tokens, BUDGET_MS);

    const fmt = (r) =>
      `${String(r.ms).padStart(7)}ms  rows=${String(r.ids.size).padStart(4)}  RU=${String(r.ru).padStart(7)}` +
      (r.timedOut ? "  [BUDGET EXCEEDED]" : "") + (r.err ? `  ERR=${r.err.slice(0, 40)}` : "");

    console.log(`   NEW  ${fmt(nu)}`);
    console.log(`   OLD  ${fmt(old)}`);

    // Correctness: what did OLD find that NEW did not? That is the risk.
    const lostIds = [...old.ids].filter((id) => !nu.ids.has(id));
    const gained = [...nu.ids].filter((id) => !old.ids.has(id));
    console.log(`   overlap=${[...nu.ids].filter((i) => old.ids.has(i)).length}  ` +
                `ONLY-OLD=${lostIds.length}  only-new=${gained.length}`);
    if (lostIds.length) console.log(`   ONLY-OLD sample: ${lostIds.slice(0, 3).join(" | ")}`);
    if (old.ms > 0 && nu.ms > 0) console.log(`   speedup=${(old.ms / Math.max(nu.ms, 1)).toFixed(1)}x`);
    console.log("");
  }

  console.log("ONLY-OLD is the number that matters: rows the token predicate would STOP finding.");
  console.log("A timed-out OLD arm means its true row set is unknown — treat ONLY-OLD as a floor.");
})().catch((e) => { console.error(e); process.exit(1); });
