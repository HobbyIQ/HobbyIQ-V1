// Create the Tiffany card for a base card we already hold, where a real sale
// proves the Tiffany variant exists.
//
// WHY THIS IS NOT A TEMPLATE, because the rule is "no synthetic parallels —
// actuals only" (2026-08-11) and this creates catalog rows.
//
// A template would enumerate every card in a set and mint a parallel row for
// each, asserting cards exist because a checklist says the parallel exists.
// That is what was rejected, and rightly.
//
// This does the opposite. Every row created here needs BOTH:
//
//   1. IDENTITY from a checklist-backed base row we already hold. Player,
//      number, year, sport and set name are copied, never derived or guessed.
//      3,046 of 3,161 come from baseballcardpedia.
//   2. EXISTENCE proven by an actual observed transaction. A Tiffany card is
//      created only where a real sale, titled Tiffany, is sitting on that base
//      card with nowhere to go.
//
// So the count is 884 distinct cards, not the ~5,000 a full Tiffany checklist
// enumeration would produce. No sale, no row.
//
// WHAT THIS FIXES. 3,181 Tiffany sales have no Tiffany card to belong to, so
// they sit on the base card and drag its price. Measured on the one that
// surfaced this: 1987 Topps Traded Tiffany Maddux #70T PSA 10 — 28 Tiffany
// sales at a $999.95 median pooled with 320 base sales at $122.50.
//
// THE SET-KEY GUARD. A base row's own setKey decides the destination:
//   topps -> topps-tiffany, topps-traded -> topps-traded-tiffany,
//   bowman -> bowman-tiffany.
// EXCEPT: Topps Traded numbers carry a T suffix ("70T"), and some of those are
// misfiled under plain `topps`. Minting topps-tiffany:70t from a misfiled base
// row would propagate the error into a brand new card. Those are excluded and
// counted — the base row has to be corrected first.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/create-tiffany-cards-from-base.cjs
//     APPLY=true       write the catalog rows (default: report only)
//     CONCURRENCY=4
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const [ERA_FROM, ERA_TO] = String(process.env.YEARS || "1984-1992").split("-").map(Number);
const BASE_KEYS = new Set(["topps", "topps-traded", "bowman"]);

const seg = (s, i) => {
  const p = String(s || "").split(":");
  return p[0] === "hiq" && p.length > i ? p[i] : null;
};
const tiffanyKeyFor = (setKey) => `${setKey}-tiffany`;
/** Topps Traded numbering: 1T..132T. A T-suffixed number under plain `topps`
 *  means the BASE row is misfiled, not that we found a Topps Tiffany card. */
const looksTraded = (cardNumber) => /^\d+\s*T$/i.test(String(cardNumber || "").trim());

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL CREATE CATALOG ROWS" : "report only"}\n`);

  const { resources: raw } = await sold.items.query({
    query: `SELECT c.hobbyiqCardId, c.playerName, c.title FROM c
            WHERE CONTAINS(LOWER(c.title), "tiffany")
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
              AND NOT CONTAINS(c.hobbyiqCardId, "tiffany")`,
  }).fetchAll();

  // Same era/brand/player guards as the refile — a Tiffany parallel only
  // existed for Topps and Bowman in 1984-1992, and "Tiffany" is also a person.
  const salesByBase = new Map();
  for (const r of raw) {
    const y = Number(seg(r.hobbyiqCardId, 2));
    if (!(y >= ERA_FROM && y <= ERA_TO)) continue;
    if (!BASE_KEYS.has(seg(r.hobbyiqCardId, 3))) continue;
    if (/tiffany/i.test(String(r.playerName || ""))) continue;
    salesByBase.set(r.hobbyiqCardId, (salesByBase.get(r.hobbyiqCardId) || 0) + 1);
  }
  const baseSlugs = [...salesByBase.keys()];
  console.log(`base cards carrying homeless Tiffany sales: ${baseSlugs.length}`);

  // Fetch the base rows — identity comes from these, never from the sale title.
  const baseRows = new Map();
  for (let i = 0; i < baseSlugs.length; i += 60) {
    const ch = baseSlugs.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT * FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) baseRows.set(x.id, x);
  }

  const planned = [];
  let noBase = 0, tradedMisfiled = 0, alreadyExists = 0;
  const wantIds = [];
  for (const slug of baseSlugs) {
    const b = baseRows.get(slug);
    if (!b) { noBase++; continue; }
    const setKey = seg(slug, 3);
    if (setKey === "topps" && looksTraded(b.cardNumber)) { tradedMisfiled++; continue; }
    const parts = String(slug).split(":");
    parts[3] = tiffanyKeyFor(setKey);
    const newId = parts.join(":");
    wantIds.push(newId);
    planned.push({ newId, base: b, sales: salesByBase.get(slug) });
  }
  // Never overwrite a card we already have.
  const have = new Set();
  for (let i = 0; i < wantIds.length; i += 60) {
    const ch = wantIds.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) have.add(x.id);
  }
  const toCreate = planned.filter((p) => { if (have.has(p.newId)) { alreadyExists++; return false; } return true; });

  console.log(`  base row missing, nothing to copy from   : ${noBase}`);
  console.log(`  T-suffixed number under plain topps      : ${tradedMisfiled}   (base row is misfiled — fix that first)`);
  console.log(`  tiffany card already exists              : ${alreadyExists}`);
  console.log(`  TO CREATE                                : ${toCreate.length}`);

  const bySet = new Map();
  for (const p of toCreate) {
    const k = `${seg(p.newId, 2)} ${seg(p.newId, 3)}`;
    bySet.set(k, (bySet.get(k) || 0) + 1);
  }
  console.log("\nby set:");
  for (const [k, v] of [...bySet].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);
  console.log("\nsample:");
  for (const p of toCreate.slice(0, 6)) {
    console.log(`   ${p.base.playerName} #${p.base.cardNumber}  (${p.sales} sale${p.sales === 1 ? "" : "s"} waiting)`);
    console.log(`      ${p.newId.slice(4)}`);
  }

  if (!APPLY) { console.log("\nReport only — nothing written. Re-run with APPLY=true."); return; }

  let made = 0, failed = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= toCreate.length) return;
      const { newId, base, sales } = toCreate[i];
      const doc = {
        ...base,
        id: newId,
        cardId: newId,
        setKey: seg(newId, 3),
        setName: `${base.setName || base.setKey} Tiffany`,
        parallel: base.parallel ?? null,
        // Provenance, so this row can always be traced back to why it exists.
        source: "derived-from-base-checklist-2026-08-23",
        derivedFromCardId: base.id,
        derivedReason: `Tiffany edition of a checklist-backed base card; ${sales} observed Tiffany sale(s) prove this card exists`,
        derivedAt: new Date().toISOString(),
      };
      delete doc._rid; delete doc._self; delete doc._etag; delete doc._attachments; delete doc._ts;
      try {
        await cat.items.create(doc);
        made++;
        if (made % 200 === 0) process.stdout.write(`  ...${made}/${toCreate.length}\n`);
      } catch (e) {
        if (e && e.code === 409) { continue; }
        failed++;
        if (failed <= 3) console.log(`  create failed ${newId}: ${e.code} ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nCREATED: ${made}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
