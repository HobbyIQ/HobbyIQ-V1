#!/usr/bin/env node
/**
 * CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06) — the DATA half.
 *
 * The display half is fixed in src/ (services/catalog/setNameYear.ts): the
 * pricing wire now strips a leading year and composes the title once. But the
 * reason every client kept getting this wrong is that `setName` is ambiguous
 * IN THE CONTAINER — some rows carry "2023 Topps Heritage" and some carry
 * "Topps Heritage", and nothing tells a reader which it has.
 *
 * This measures that, so the backfill lane that follows is scoped by a number
 * rather than by an impression. It reports:
 *
 *   1. how many card_catalog rows carry a leading 4-digit year in setName
 *   2. how many carry a leading SPLIT year ("2023-24 Panini Prizm") — the
 *      shape the four earlier year-strips in this repo all missed
 *   3. the split by SOURCE, because a whole-source retire or backfill needs
 *      its name (feedback_a_whole_source_retire_needs_its_name)
 *   4. how many of those leading years DISAGREE with the row's own year field,
 *      which is a different defect wearing the same shape and must NOT be
 *      backfilled away — the disagreement is the finding
 *
 * READ-ONLY. Nothing here writes. The backfill it recommends is a separate PR
 * and must go through patchCatalogRowFields, never a raw patch
 * (project_derive_builds_its_own_search_fields).
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 */
const { CosmosClient } = require("@azure/cosmos");

const f = (n) => Number(n).toLocaleString();
const pad = (n, w = 12) => f(n).padStart(w);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—").padStart(7);

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog");

  const q = async (sql) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try {
        return (await cat.items.query(sql, { maxItemCount: -1 }).fetchAll()).resources;
      } catch (e) {
        if (!/too large|429|timeout/i.test(String(e.message)) || a >= 10) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };
  const count = async (where) =>
    (await q(`SELECT VALUE COUNT(1) FROM c${where ? " WHERE " + where : ""}`))[0];

  // A leading 4-digit year, as Cosmos SQL can express it without a regex:
  // the first four chars are digits and the fifth is a space or a hyphen.
  // Restricted to 19xx/20xx so a card number like "1234 " cannot qualify.
  const LEAD = `IS_STRING(c.setName) AND LENGTH(c.setName) > 5
    AND (STARTSWITH(c.setName,'19') OR STARTSWITH(c.setName,'20'))
    AND IS_NUMBER(StringToNumber(SUBSTRING(c.setName,0,4)))`;
  const PLAIN = `${LEAD} AND SUBSTRING(c.setName,4,1) = ' '`;
  const SPLIT = `${LEAD} AND SUBSTRING(c.setName,4,1) = '-'`;

  // Identity rows only — grade rows are per-tier children of an identity and
  // would double-count the same setName (project_d21_grade_curve...).
  const IDENT = `NOT IS_DEFINED(c.gradeTier)`;

  console.log(`\nLEADING YEAR IN setName — card_catalog   ${new Date().toISOString().slice(0, 16)}Z`);
  console.log("=".repeat(72));
  console.log("READ-ONLY. No writes. Backfill is a separate lane.\n");

  const total = await count(IDENT);
  const withSet = await count(`${IDENT} AND IS_STRING(c.setName) AND c.setName != ''`);
  console.log(`identity rows                 ${pad(total)}`);
  console.log(`  ... with a setName          ${pad(withSet)} ${pct(withSet, total)}\n`);

  const lead = await count(`${IDENT} AND ${LEAD}`);
  const plain = await count(`${IDENT} AND ${PLAIN}`);
  const split = await count(`${IDENT} AND ${SPLIT}`);
  console.log(`1. LEADING YEAR — the display defect`);
  console.log(`   any leading year           ${pad(lead)} ${pct(lead, withSet)} of named rows`);
  console.log(`     "2023 Topps Heritage"    ${pad(plain)} ${pct(plain, withSet)}`);
  console.log(`     "2023-24 Panini Prizm"   ${pad(split)} ${pct(split, withSet)}   <- the shape every`);
  console.log(`   ${" ".repeat(52)}earlier strip missed\n`);

  // ── 2. by source ─────────────────────────────────────────────────────────
  console.log(`2. BY SOURCE — a backfill lane needs its name`);
  const bySource = await q(
    `SELECT c.source, COUNT(1) AS n FROM c WHERE ${IDENT} AND ${LEAD} GROUP BY c.source`,
  );
  const srcTotals = await q(
    `SELECT c.source, COUNT(1) AS n FROM c WHERE ${IDENT} AND IS_STRING(c.setName) AND c.setName != '' GROUP BY c.source`,
  );
  const totalBy = new Map(srcTotals.map((r) => [String(r.source ?? "(none)"), r.n]));
  bySource.sort((a, b) => b.n - a.n);
  console.log(`   ${"source".padEnd(38)}${"leading-year".padStart(13)}${"of source".padStart(11)}`);
  for (const r of bySource) {
    const name = String(r.source ?? "(none)");
    console.log(`   ${name.slice(0, 37).padEnd(38)}${pad(r.n, 13)}${pct(r.n, totalBy.get(name) ?? 0)}`);
  }
  console.log(`   ${"TOTAL".padEnd(38)}${pad(lead, 13)}\n`);

  // ── 3. the year that disagrees ───────────────────────────────────────────
  // A leading year that is NOT this row's year is a DIFFERENT defect: the row
  // contradicts itself. It must not be stripped — the strip would launder it.
  console.log(`3. AGREEMENT — which leading years are actually duplicates?`);
  const agree = await count(
    `${IDENT} AND ${PLAIN} AND IS_DEFINED(c.year) AND StringToNumber(SUBSTRING(c.setName,0,4)) = c.year`,
  );
  const disagree = await count(
    `${IDENT} AND ${PLAIN} AND IS_DEFINED(c.year) AND StringToNumber(SUBSTRING(c.setName,0,4)) != c.year`,
  );
  const noYear = await count(`${IDENT} AND ${PLAIN} AND (NOT IS_DEFINED(c.year) OR c.year = null)`);
  console.log(`   agrees with c.year         ${pad(agree)} ${pct(agree, plain)}   <- safe to strip`);
  console.log(`   DISAGREES with c.year      ${pad(disagree)} ${pct(disagree, plain)}   <- do NOT strip;`);
  console.log(`   ${" ".repeat(52)}the row contradicts`);
  console.log(`   ${" ".repeat(52)}itself and that is`);
  console.log(`   ${" ".repeat(52)}the finding`);
  console.log(`   row has no year at all     ${pad(noYear)} ${pct(noYear, plain)}   <- cannot judge; park\n`);

  // ── 4. the doubled ones already stored ───────────────────────────────────
  const doubled = await count(
    `${IDENT} AND ${PLAIN} AND IS_DEFINED(c.year)
     AND StringToNumber(SUBSTRING(c.setName,0,4)) = c.year
     AND CONTAINS(c.setName, CONCAT(ToString(c.year), ' ', ToString(c.year), ' '))`,
  );
  console.log(`4. ALREADY DOUBLED IN STORAGE`);
  console.log(`   "2023 2023 Topps Heritage" ${pad(doubled)}   <- the bug written down`);
  console.log(`   ${" ".repeat(52)}(one strip leaves one year)\n`);

  console.log("=".repeat(72));
  console.log(`RECOMMENDATION — separate PR, not this one:`);
  console.log(`  normalizer rule: store setName WITHOUT a leading year when that`);
  console.log(`  year equals the row's own year field (seasons included). The year`);
  console.log(`  field is the one the display prepends.`);
  console.log(`  backfill: ${f(agree)} rows via patchCatalogRowFields (NEVER a raw`);
  console.log(`  patch — it rebuilds searchTokens/displayName with the row).`);
  console.log(`  park:     ${f(disagree)} disagreeing + ${f(noYear)} year-less rows, report-only.\n`);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
