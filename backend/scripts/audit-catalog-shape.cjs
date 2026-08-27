#!/usr/bin/env node
/**
 * CF-ONE-COMMAND-FOR-THE-SHAPE (Drew, 2026-08-26).
 *
 * "The more organized it is, the easier it is to find the problems."
 *
 * The problems this week were all found by ad-hoc one-off scripts written into
 * a temp folder, run once, and thrown away -- which meant every question got
 * re-derived from scratch and two answers came back wrong because a `SELECT
 * TOP` in index order was mistaken for a sample. This is those measurements,
 * committed, in one command, so the shape of the catalog is a thing you look
 * at rather than a thing you rebuild.
 *
 * It reports FIVE things, each of which has hidden a real defect:
 *
 *   1. ADDRESSING   is every row at its own slug? 5,369,164 were not, and
 *                   nothing could point-read them. Phase 02 required
 *                   IS_DEFINED(gradeTier) so it saw 1,018 of 2,835,432; the
 *                   re-home required STARTSWITH(id,'hiq:') so it saw none of
 *                   the vendor-shaped ones. Two sweeps, both blind.
 *
 *   2. DUPLICATES   rows-minus-distinct-slugs. Baseball reads as ~2M copies
 *                   until you split it: 1.93M are the ONLY record of that
 *                   card sitting at a vendor id, and 54,553 are true
 *                   duplicates. Deleting on the naive number destroys the
 *                   1.93M. "Duplicate" is a conclusion, not an observation.
 *
 *   3. SHAPE        the fields search and the matcher actually discriminate
 *                   on. CardCatalogEntry declared none of searchTokens
 *                   (99.0%), setName (98.9%) or displayName (89.6%), which
 *                   is why 59 of 61 writers bypassed the canonical path.
 *
 *   4. COVERAGE     catalog rows per sport against SALES per sport. 93.6% of
 *                   the catalog is baseball; baseball is 48.6% of sales.
 *                   Pokemon is 18.9% of sales on 0.7% of the catalog. No
 *                   amount of re-slugging fixes a coverage hole.
 *
 *   5. GRADES       identities vs grade rows, so a grade explosion is visible
 *                   as a ratio rather than as a container that got big.
 *
 * READ-ONLY. Every count is a real COUNT over the container -- there is no
 * sampling here, so nothing in this report can be an index-order artifact.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   SPORT=baseball            optional, scope sections 1-3 to one sport
 */
const { CosmosClient } = require("@azure/cosmos");

const SPORT = process.env.SPORT || "";
const f = (n) => Number(n).toLocaleString();
const pad = (n, w = 14) => f(n).padStart(w);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—").padStart(7);

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq");
  const cat = db.container("card_catalog"), sc = db.container("sold_comps");

  const q = async (container, where) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try {
        return (await container.items.query(`SELECT VALUE COUNT(1) FROM c${where ? " WHERE " + where : ""}`).fetchAll()).resources[0];
      } catch (e) {
        if (!/too large|429/i.test(String(e.message)) || a >= 10) throw e;
        await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
      }
    }
  };
  const scope = SPORT ? `c.sport = '${SPORT}'` : "";
  const and = (w) => (scope ? `${scope} AND ${w}` : w);

  console.log(`\nCATALOG SHAPE${SPORT ? ` — ${SPORT}` : ""}   ${new Date().toISOString().slice(0, 16)}Z`);
  console.log("=".repeat(64));

  const total = await q(cat, scope);
  console.log(`\nrows${pad(total, 44)}`);

  // ── 1. addressing ────────────────────────────────────────────────────────
  console.log(`\n1. ADDRESSING — can a point read reach it?`);
  const atOwn = await q(cat, and("c.id = c.cardId"));
  const wrongPk = await q(cat, and("c.id != c.cardId"));
  const noPk = await q(cat, and("NOT IS_DEFINED(c.cardId) OR c.cardId = null"));
  const notSlug = await q(cat, and("NOT STARTSWITH(c.id,'hiq:')"));
  console.log(`   at its own address     ${pad(atOwn)} ${pct(atOwn, total)}`);
  console.log(`   wrong partition key    ${pad(wrongPk)} ${pct(wrongPk, total)}`);
  console.log(`   NO partition key       ${pad(noPk)} ${pct(noPk, total)}`);
  console.log(`   id is not a hiq slug   ${pad(notSlug)} ${pct(notSlug, total)}`);
  const unreachable = wrongPk + noPk;
  console.log(`   ${unreachable ? "UNREACHABLE           " : "all reachable         "} ${pad(unreachable)} ${pct(unreachable, total)}`);

  // ── 2. duplicates ────────────────────────────────────────────────────────
  console.log(`\n2. DUPLICATES — and what they really are`);
  const idWhere = and("NOT IS_DEFINED(c.gradeTier) AND IS_STRING(c.hobbyiqCardId)");
  const idRows = await q(cat, idWhere);
  const distinct = (await cat.items.query(
    `SELECT VALUE COUNT(1) FROM (SELECT DISTINCT VALUE c.hobbyiqCardId FROM c WHERE ${idWhere})`).fetchAll()).resources[0];
  const extra = idRows - distinct;
  const secondCopies = await q(cat, `${idWhere} AND c.id != c.hobbyiqCardId`);
  console.log(`   identity rows          ${pad(idRows)}`);
  console.log(`   distinct slugs         ${pad(distinct)}`);
  console.log(`   TRUE duplicates        ${pad(extra)} ${pct(extra, idRows)}`);
  console.log(`   sitting at a vendor id ${pad(secondCopies)}   <- of these, only ${f(extra)} have a twin;`);
  console.log(`   ${" ".repeat(37)}the rest are the ONLY copy and must be`);
  console.log(`   ${" ".repeat(37)}re-homed, never deleted`);

  // ── 3. shape ─────────────────────────────────────────────────────────────
  console.log(`\n3. SHAPE — the fields the matcher discriminates on`);
  for (const [label, field] of [
    ["setName", "c.setName"], ["searchTokens", "c.searchTokens"], ["displayName", "c.displayName"],
    ["parallel", "c.parallel"], ["playerName", "c.playerName"], ["printRun", "c.printRun"],
  ]) {
    const n = await q(cat, and(`IS_DEFINED(${field}) AND ${field} != null`));
    console.log(`   ${label.padEnd(22)}${pad(n)} ${pct(n, total)}`);
  }

  // ── 4. coverage ──────────────────────────────────────────────────────────
  if (!SPORT) {
    console.log(`\n4. COVERAGE — catalog against DEMAND (sales), not against itself`);
    const { resources: c } = await cat.items.query("SELECT c.sport AS k, COUNT(1) AS n FROM c GROUP BY c.sport").fetchAll();
    const { resources: s } = await sc.items.query("SELECT c.sport AS k, COUNT(1) AS n FROM c GROUP BY c.sport").fetchAll();
    const cm = new Map(c.map((r) => [String(r.k), r.n])), sm = new Map(s.map((r) => [String(r.k), r.n]));
    const ct = c.reduce((a, r) => a + r.n, 0), st = s.reduce((a, r) => a + r.n, 0);
    console.log(`   sport            catalog   share |      sales   share | sales per row`);
    for (const k of [...sm.keys()].sort((a, b) => (sm.get(b) ?? 0) - (sm.get(a) ?? 0)).slice(0, 10)) {
      const cn = cm.get(k) ?? 0, sn = sm.get(k) ?? 0;
      const ratio = cn ? (sn / cn).toFixed(2) : "—";
      const flag = cn && sn / cn > 2 ? "  <- UNDER-COVERED" : "";
      console.log(`   ${k.padEnd(12)}${pad(cn, 12)} ${pct(cn, ct)} |${pad(sn, 11)} ${pct(sn, st)} | ${String(ratio).padStart(8)}${flag}`);
    }
  }

  // ── 5. grades ────────────────────────────────────────────────────────────
  console.log(`\n5. GRADES — identities against grade rows`);
  const graded = await q(cat, and("IS_DEFINED(c.gradeTier)"));
  console.log(`   identities             ${pad(total - graded)} ${pct(total - graded, total)}`);
  console.log(`   grade rows             ${pad(graded)} ${pct(graded, total)}`);
  if (total - graded > 0) console.log(`   grade rows per identity${String((graded / (total - graded)).toFixed(2)).padStart(15)}`);
  const impossible = await q(cat, and("CONTAINS(c.id,':psa-9-5')"));
  console.log(`   PSA 9.5 (never issued) ${pad(impossible)}${impossible ? "   <- must be 0" : ""}`);
  console.log("");
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(1); });
