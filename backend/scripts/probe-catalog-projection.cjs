#!/usr/bin/env node
/**
 * CF-SEARCH-PROJECTION-PROBE (2026-08-20). Does the WIDTH of the projection
 * drive catalog query cost, independent of row count?
 *
 * WHY THIS SHAPE. A previous attempt at this fix was reverted because it was
 * validated with `SELECT c.id`, while the production query projects ~18 fields
 * including the full searchTokens array. The probe measured something the app
 * never runs. So here both arms use the REAL production field lists, and the
 * only thing that varies is whether c.searchTokens is among them.
 *
 * The WHERE is the indexed anchor (ARRAY_CONTAINS on the token array), not the
 * CONTAINS scan. That is deliberate: it isolates projection cost instead of
 * drowning it in a 35.7M-row scan, and it keeps the probe cheap enough to run
 * against a live account.
 *
 * ARMS ARE INTERLEAVED, and each is run twice. Background load (a concurrent
 * backfill, another tenant) inflates both arms equally, so the RATIO stays
 * meaningful even when the absolute numbers are not. Reporting the median of
 * repeated interleaved runs, not a single timing.
 *
 * READ-ONLY. Issues SELECTs only.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/probe-catalog-projection.cjs
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn || conn.length < 40) {
  console.error("FATAL: COSMOS_CONNECTION_STRING missing/truncated");
  process.exit(1);
}

const TOP = Number(process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] ?? 500);
const REPS = Number(process.argv.find((a) => a.startsWith("--reps="))?.split("=")[1] ?? 2);

// Exactly the production field list from catalogSearch.service.ts:424.
const WIDE =
  'c.id, c.cardNumber, c.playerName, c.sport, c.year, c.setKey, c.setName, c["set"] AS setNameFromSet, ' +
  "c.parallel, c.parallelSlug, c.isAuto, c.printRun, c.searchTokens, c.salesSummary, c.kind, c.imageUrl, " +
  "c.source, c.verificationStatus";

// The same list with ONLY c.searchTokens removed. Nothing else differs.
const NARROW = WIDE.replace("c.searchTokens, ", "");

// Tokens from the documented fuzzy verification set.
const TOKENS = ["gonzalez", "hartman", "carey", "ohtani"];

async function timeQuery(container, fields, token) {
  const spec = {
    query:
      `SELECT TOP ${TOP} ${fields} FROM c ` +
      `WHERE STARTSWITH(c.id, 'hiq:') AND ARRAY_CONTAINS(c.searchTokens, @t)`,
    parameters: [{ name: "@t", value: token }],
  };
  const t0 = Date.now();
  let rows = 0;
  let ru = 0;
  const it = container.items.query(spec, { maxItemCount: -1 });
  while (it.hasMoreResults()) {
    const page = await it.fetchNext();
    rows += (page.resources ?? []).length;
    ru += page.requestCharge ?? 0;
  }
  return { ms: Date.now() - t0, rows, ru: Math.round(ru) };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

(async () => {
  const container = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || "hobbyiq")
    .container("card_catalog");

  console.log(`[probe] TOP=${TOP} reps=${REPS} — arms interleaved, median reported`);
  console.log(`[probe] WIDE   = production projection (18 fields, incl. searchTokens)`);
  console.log(`[probe] NARROW = identical, MINUS c.searchTokens\n`);

  const results = [];
  for (const token of TOKENS) {
    const wide = [];
    const narrow = [];
    let rowsW = 0;
    let rowsN = 0;
    let ruW = 0;
    let ruN = 0;
    for (let i = 0; i < REPS; i++) {
      // Interleaved on purpose — see header.
      const w = await timeQuery(container, WIDE, token);
      const n = await timeQuery(container, NARROW, token);
      wide.push(w.ms);
      narrow.push(n.ms);
      rowsW = w.rows; rowsN = n.rows; ruW = w.ru; ruN = n.ru;
    }
    const mw = median(wide);
    const mn = median(narrow);
    results.push({ token, mw, mn, rowsW, rowsN, ruW, ruN });
    console.log(
      `  ${token.padEnd(10)} wide ${String(mw).padStart(6)}ms (${ruW} RU)   ` +
      `narrow ${String(mn).padStart(6)}ms (${ruN} RU)   ` +
      `speedup ${(mw / Math.max(mn, 1)).toFixed(2)}x   rows ${rowsW}/${rowsN}`,
    );
  }

  console.log("\n── summary ──");
  const rowsMatch = results.every((r) => r.rowsW === r.rowsN);
  console.log(`row counts identical across arms : ${rowsMatch ? "YES" : "NO — projection changed the result set!"}`);
  const totW = results.reduce((s, r) => s + r.mw, 0);
  const totN = results.reduce((s, r) => s + r.mn, 0);
  console.log(`total wide   : ${totW}ms`);
  console.log(`total narrow : ${totN}ms`);
  console.log(`overall      : ${(totW / Math.max(totN, 1)).toFixed(2)}x`);
  console.log("\nAbsolute values are inflated by any concurrent load; the RATIO is the finding.");
})().catch((e) => { console.error(e); process.exit(1); });
