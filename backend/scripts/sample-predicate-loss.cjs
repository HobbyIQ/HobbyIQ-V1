#!/usr/bin/env node
/**
 * CF-LOSS-SAMPLE (2026-08-21). Show WHAT the token predicate would stop
 * finding, not just how many.
 *
 * The count alone cannot decide the swap. `erik hartman` loses 788 rows in
 * year 2025 — but CONTAINS matches substrings ANYWHERE in a field, so "erik"
 * also reaches Frederik, Derik and Erikson. If the lost rows are substring
 * noise the swap is an IMPROVEMENT in precision; if they are real Hartmans
 * reachable only via a non-tokenised field, it is a regression.
 *
 * Same discipline as everything else this week: read a sample before
 * believing a number.
 *
 * READ-ONLY.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn || conn.length < 40) { console.error("FATAL: no connection string"); process.exit(1); }

const YEAR = Number(process.argv.find((a) => a.startsWith("--year="))?.split("=")[1] ?? 2025);
const TOP = Number(process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 15);
const QUERIES = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const tokenize = (q) => String(q).toLowerCase().split(/[^a-z0-9-]+/).filter((t) => t.length >= 2);

const oldPred = (tokens) =>
  tokens.map((_, i) => [
    `ARRAY_CONTAINS(c.searchTokens, @t${i})`,
    `(IS_DEFINED(c.playerName) AND CONTAINS(LOWER(c.playerName), @t${i}))`,
    `(IS_DEFINED(c.setKey) AND CONTAINS(LOWER(c.setKey), @t${i}))`,
    `(IS_DEFINED(c.setName) AND CONTAINS(LOWER(c.setName), @t${i}))`,
    `(IS_DEFINED(c["set"]) AND CONTAINS(LOWER(c["set"]), @t${i}))`,
    `(IS_DEFINED(c.cardNumber) AND CONTAINS(LOWER(c.cardNumber), @t${i}))`,
    `(IS_DEFINED(c.parallel) AND CONTAINS(LOWER(c.parallel), @t${i}))`,
    `(IS_DEFINED(c.parallelSlug) AND CONTAINS(LOWER(c.parallelSlug), @t${i}))`,
  ].join(" OR ")).join(" OR ");

const newPred = (tokens) =>
  tokens.map((_, i) => `EXISTS(SELECT VALUE t FROM t IN c.searchTokens WHERE STARTSWITH(t, @t${i}))`).join(" OR ");

(async () => {
  const container = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || "hobbyiq")
    .container("card_catalog");

  for (const q of QUERIES) {
    const tokens = tokenize(q);
    console.log(`\n── "${q}"  tokens=${JSON.stringify(tokens)}  (year=${YEAR})`);
    const spec = {
      query:
        `SELECT TOP ${TOP} c.playerName, c.setKey, c.cardNumber, c.parallel, c.searchTokens ` +
        `FROM c WHERE STARTSWITH(c.id, @pfx) AND c.year = @yr ` +
        `AND (${oldPred(tokens)}) AND NOT (${newPred(tokens)})`,
      parameters: [
        { name: "@pfx", value: "hiq:" },
        { name: "@yr", value: YEAR },
        ...tokens.map((t, i) => ({ name: `@t${i}`, value: t })),
      ],
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { resources } = await container.items.query(spec).fetchAll();
        if (!resources.length) { console.log("   (none)"); break; }
        for (const r of resources) {
          const toks = Array.isArray(r.searchTokens) ? r.searchTokens : [];
          console.log(`   ${String(r.playerName || "(no name)").padEnd(26)} ${String(r.setKey || "?").padEnd(24)} #${r.cardNumber || "?"}`);
          console.log(`      tokens(${toks.length}): ${JSON.stringify(toks.slice(0, 10))}`);
        }
        break;
      } catch (e) {
        if (e.code !== 429 && !String(e.message).includes("request rate is too large")) { console.error("   ERR", e.message); break; }
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
      }
    }
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
