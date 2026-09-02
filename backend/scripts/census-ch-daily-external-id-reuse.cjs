#!/usr/bin/env node
/**
 * census-ch-daily-external-id-reuse.cjs -- READ-ONLY. Measures whether the
 * "same sourceExternalId = same sale" discriminator is sound for CardHedge
 * daily rows.
 *
 * WHY THIS EXISTS. A report held that ch-daily ingest reuses ONE externalId
 * across DISTINCT sales -- specifically that `ch-daily::162790851436` sat on
 * four rows at four prices/grades (1850 PSA 10, 159 PSA 9, 150 PSA 9, 59.77
 * raw) and `ch-daily::178824610306` on two. If true, that would poison the
 * sameness proof the triage's TRUE-DUPE class and the dedup scripts rely on
 * (collision-triage.cjs `externalIdOf`), because a shared id would no longer
 * mean a shared sale.
 *
 * WHAT THE MEASUREMENT FOUND (2026-09-02, prod hobbyiq/sold_comps):
 *
 *   - ch-daily rows carry TWO id shapes, both live:
 *       bare       `ch-daily::<price_history_id>`
 *       composite  `ch-daily::<price_history_id>::<soldAt>::<price-in-cents>`
 *     In the 6,000 most recent ch-daily rows: 3,089 composite / 2,911 bare.
 *
 *   - The segment that REPEATS is the leading `price_history_id`, and it is
 *     CardHedge's identifier for the CARD, not for a sale. One such id
 *     legitimately spans years of sales at every grade -- base
 *     `1627908514367x488979553047805950` carries 144 rows from 2021 to 2026.
 *
 *   - The FULL sourceExternalId does NOT repeat. Over the 40,000 most recent
 *     ch-daily rows: 40,000 distinct ids, ZERO on more than one row, and so
 *     zero carrying more than one price.
 *
 *   - The three ids named in the report resolve the same way:
 *       162790851436  144 rows / 140 distinct full ids / 4 repeated
 *       178824610306   29 rows /  29 distinct full ids / 0 repeated
 *       178774714651    5 rows /   5 distinct full ids / 0 repeated
 *     The reported "quartet" (1850 PSA 10 / 159 PSA 9 / 150 PSA 9 / 59.77
 *     raw) is four DIFFERENT composite ids that share a card id, and
 *     178774714651 is five different CARDS sold in one batch -- the $1,900
 *     Maddux PSA 10 among them, on its own unique id.
 *
 *   - The 4 repeated ids under 162790851436 are the INVERSE of the reported
 *     defect, and they are real: each is ONE sale stored TWICE, under two
 *     cardId partitions -- the `hiq:` slug and the bare vendor id --
 *     with identical docId, price, grade and soldAt:
 *       $149.99 raw 2026-07-15T02:52  hiq:baseball:1987:topps:70t:base:no-auto
 *       $149.99 raw 2026-07-15T02:52  1627908514367x488979553047805950
 *     Same id AND same price is precisely the TRUE-DUPE shape, so the
 *     discriminator classes them correctly today. They are a split-pool
 *     artifact for the D29 re-key to resolve, not a discriminator defect --
 *     and note the price/soldAt tiebreak proposed for "hardening" would have
 *     classed these four as same-sale too, i.e. changed nothing.
 *
 * CONCLUSION: the discriminator is sound as written. `externalIdOf` returns
 * the FULL trimmed string and never splits on "::", so these rows already
 * read as distinct and cannot collapse. No hardening was applied, because a
 * price/soldAt tiebreak would guard a condition that does not occur while
 * cutting against standing doctrine (34af996: "different sourceExternalId is
 * two real sales, not a collision"). Pinned by
 * tests/chDailyExternalIdNeverCollapses.test.ts.
 *
 * If a future ingest change DOES start reusing a full id across sales, this
 * script is how you find out: `idsOnMoreThanOneRow` goes non-zero.
 *
 * Usage (read-only; never writes):
 *   COSMOS_CONNECTION_STRING=... node scripts/census-ch-daily-external-id-reuse.cjs [--limit 40000]
 */
const { CosmosClient } = require("@azure/cosmos");

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i > -1 ? Math.max(1, Number(process.argv[i + 1]) || 40000) : 40000;
})();

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(m) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required (read-only)."); process.exit(2); }
  const pool = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  const q = async (query, parameters = []) =>
    (await retry(() => pool.items.query({ query, parameters }, { maxItemCount: 1000 }).fetchAll())).resources;

  console.log(`=== ch-daily sourceExternalId reuse census (READ-ONLY, newest ${LIMIT}) ===\n`);

  const rows = await q(
    `SELECT TOP ${LIMIT} c.sourceExternalId, c.price, c.gradeCompany, c.gradeValue, c.soldAt, c.cardId
     FROM c WHERE STARTSWITH(c.sourceExternalId, 'ch-daily::') ORDER BY c.soldAt DESC`);

  let composite = 0, bare = 0;
  const byFull = new Map();
  for (const r of rows) {
    const id = String(r.sourceExternalId);
    (id.slice("ch-daily::".length).includes("::") ? composite++ : bare++, void 0);
    let a = byFull.get(id); if (!a) { a = []; byFull.set(id, a); }
    a.push(r);
  }
  const repeated = [...byFull.entries()].filter(([, rs]) => rs.length > 1);
  const multiPrice = repeated.filter(([, rs]) => new Set(rs.map((x) => Math.round(Number(x.price) * 100))).size > 1);

  console.log(`rows scanned            ${rows.length}`);
  console.log(`  id shape: composite   ${composite}   (ch-daily::<card>::<soldAt>::<cents>)`);
  console.log(`  id shape: bare        ${bare}   (ch-daily::<price_history_id>)`);
  console.log(`distinct full ids       ${byFull.size}`);
  console.log(`idsOnMoreThanOneRow     ${repeated.length}      <-- the discriminator breaks if non-zero`);
  console.log(`  ...with >1 price      ${multiPrice.length}`);
  for (const [id, rs] of multiPrice.slice(0, 5)) {
    console.log(`   SAMPLE ${id}`);
    for (const r of rs) console.log(`      $${r.price}  ${r.gradeCompany || "raw"}${r.gradeValue ?? ""}  ${String(r.soldAt).slice(0, 19)}`);
  }

  // The three ids from the original report, checked by name.
  console.log(`\n--- the reported ids, by name ---`);
  for (const base of ["162790851436", "178824610306", "178774714651"]) {
    const hit = await q(
      "SELECT c.sourceExternalId, c.price, c.gradeCompany, c.gradeValue, c.soldAt FROM c WHERE CONTAINS(c.sourceExternalId, @b)",
      [{ name: "@b", value: base }]);
    const ids = new Map();
    for (const r of hit) ids.set(String(r.sourceExternalId), (ids.get(String(r.sourceExternalId)) ?? 0) + 1);
    const rep = [...ids.values()].filter((n) => n > 1).length;
    console.log(`  ${base}  rows=${String(hit.length).padStart(4)}  distinctFullIds=${String(ids.size).padStart(4)}  repeatedFullIds=${rep}`);
  }
  console.log(`\nA repeatedFullIds of 0 means the shared segment is the CARD id, not a sale id.`);
}

main().catch((e) => { console.error("ERR", e?.message ?? e); process.exit(3); });
