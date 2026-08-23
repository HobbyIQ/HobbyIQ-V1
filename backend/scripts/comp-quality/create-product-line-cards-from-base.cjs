// Create the product-line card for a base card we already hold, where a real
// sale proves that card exists.
//
// THE CHECKLIST IS USUALLY NOT MISSING. That was the Tiffany finding and it is
// the reason this tool exists rather than a scraper: a product line reuses the
// base set's checklist with a different finish, so the identity is already in
// our catalog under the base setKey. 3,161 of 3,181 homeless Tiffany sales
// (99.4%) were sitting on a base card we already held. Nothing needed fetching.
//
// WHY THIS IS NOT THE SYNTHETIC-PARALLEL TEMPLATE THAT WAS REJECTED 2026-08-11.
// A template enumerates a set and mints a row for every card in it, asserting
// existence from a checklist. This requires BOTH:
//
//   IDENTITY   copied from a checklist-backed base row we already hold —
//              player, number, year, sport, set. Never derived, never guessed.
//   EXISTENCE  proven by an actual observed sale of that card, stranded on the
//              base row with nowhere to go.
//
// So it creates the cards people actually trade, not a full enumeration. No
// sale, no row. Every row records derivedFromCardId and the sale count that
// justified it, so any one of them can be traced back to why it is here.
//
// Shares its line definitions with refile-product-line-sales.cjs — same bases,
// same era, same destination rule. Two copies of that config is how the
// earlier one-off scripts drifted apart.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/create-product-line-cards-from-base.cjs
//     LINE=sapphire     required
//     APPLY=true        write the catalog rows (default: report only)
//     CONCURRENCY=4
const { CosmosClient } = require("@azure/cosmos");
const { LINES } = require("./refile-product-line-sales.cjs");

const LINE = String(process.env.LINE || "").trim().toLowerCase();
const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

const seg = (s, i) => {
  const p = String(s || "").split(":");
  return p[0] === "hiq" && p.length > i ? p[i] : null;
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const cfg = LINES[LINE];
  if (!cfg) {
    console.error(`FATAL: LINE must be one of: ${Object.keys(LINES).join(", ")}`);
    process.exit(2);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL CREATE CATALOG ROWS" : "report only"}   line: ${cfg.word}\n`);

  const { resources: raw } = await sold.items.query({
    query: `SELECT c.hobbyiqCardId, c.playerName, c.title FROM c
            WHERE CONTAINS(LOWER(c.title), @w)
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
              AND NOT CONTAINS(c.hobbyiqCardId, @w)`,
    parameters: [{ name: "@w", value: cfg.word }],
  }).fetchAll();

  // Same guards as the refile, so the two tools agree on what is in scope.
  const wordRe = new RegExp(cfg.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const wanted = new Map();   // destination slug -> { base slug, sales }
  for (const r of raw) {
    const y = Number(seg(r.hobbyiqCardId, 2));
    const base = seg(r.hobbyiqCardId, 3);
    if (!(y >= cfg.era[0] && y <= cfg.era[1]) || !cfg.bases.includes(base)) continue;
    if (wordRe.test(String(r.playerName || ""))) continue;
    if ((cfg.titleExcludes ?? []).some((re) => re.test(String(r.title || "")))) continue;
    const parts = String(r.hobbyiqCardId).split(":");
    const par = cfg.parallelFromTitle ? cfg.parallelFromTitle(r.title) : null;
    for (const d of new Set(cfg.dest(base))) {
      const n = [...parts];
      n[3] = d;
      if (par && n.length > 5) n[5] = par;
      const id = n.join(":");
      if (!wanted.has(id)) wanted.set(id, { base: r.hobbyiqCardId, sales: 0 });
      wanted.get(id).sales++;
    }
  }
  console.log(`distinct ${cfg.word} cards a real sale is asking for: ${wanted.size}`);

  // Which already exist? Never overwrite a card we hold.
  const ids = [...wanted.keys()];
  const have = new Set();
  for (let i = 0; i < ids.length; i += 60) {
    const ch = ids.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) have.add(x.id);
  }
  const missing = ids.filter((id) => !have.has(id));
  console.log(`  already in the catalog                    : ${have.size}`);
  console.log(`  missing                                   : ${missing.length}`);

  // Identity comes from the BASE row, never from the sale title.
  const baseIds = [...new Set(missing.map((id) => wanted.get(id).base))];
  const baseRows = new Map();
  for (let i = 0; i < baseIds.length; i += 40) {
    const ch = baseIds.slice(i, i + 40);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT * FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) baseRows.set(x.id, x);
  }

  const toCreate = [];
  let noBase = 0;
  for (const id of missing) {
    const w = wanted.get(id);
    const b = baseRows.get(w.base);
    if (!b) { noBase++; continue; }
    toCreate.push({ id, base: b, sales: w.sales, parallelSeg: seg(id, 5) });
  }
  console.log(`  base row exists to copy identity from     : ${toCreate.length}`);
  console.log(`  no base row either                        : ${noBase}   (nothing to derive from)`);

  const bySet = new Map();
  const srcMix = new Map();
  for (const t of toCreate) {
    const k = `${seg(t.id, 2)} ${seg(t.id, 3)}`;
    bySet.set(k, (bySet.get(k) || 0) + 1);
    srcMix.set(t.base.source || "(none)", (srcMix.get(t.base.source || "(none)") || 0) + 1);
  }
  console.log("\nby set:");
  for (const [k, v] of [...bySet].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(v).padStart(6)}  ${k}`);
  console.log("\nsource of the base rows identity is copied from:");
  for (const [k, v] of [...srcMix].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${String(v).padStart(6)}  ${k}`);
  console.log("\nsample:");
  for (const t of toCreate.slice(0, 6)) {
    console.log(`   ${t.base.playerName} #${t.base.cardNumber}  (${t.sales} sale${t.sales === 1 ? "" : "s"} waiting)`);
    console.log(`      ${String(t.id).slice(4)}`);
  }

  if (!APPLY) { console.log("\nReport only — nothing written. Re-run with APPLY=true."); return; }

  let made = 0, failed = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= toCreate.length) return;
      const { id, base, sales, parallelSeg } = toCreate[i];
      const doc = {
        ...base,
        id,
        cardId: id,
        setKey: seg(id, 3),
        setName: `${base.setName || base.setKey} ${cfg.word.charAt(0).toUpperCase()}${cfg.word.slice(1)}`,
        // The parallel comes from the destination slug, which the refile derived
        // from the sale title — a Gold Sapphire card is not base Sapphire.
        parallel: parallelSeg && parallelSeg !== "base"
          ? parallelSeg.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
          : (base.parallel ?? null),
        source: `derived-from-base-checklist-${cfg.word}-2026-08-23`,
        derivedFromCardId: base.id,
        derivedReason: `${cfg.word} edition of a checklist-backed base card; ${sales} observed sale(s) prove this card exists`,
        derivedAt: new Date().toISOString(),
      };
      delete doc._rid; delete doc._self; delete doc._etag; delete doc._attachments; delete doc._ts;
      try {
        await cat.items.create(doc);
        made++;
        if (made % 500 === 0) process.stdout.write(`  ...${made}/${toCreate.length}\n`);
      } catch (e) {
        if (e && e.code === 409) continue;
        failed++;
        if (failed <= 3) console.log(`  create failed ${id}: ${e.code} ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nCREATED: ${made}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
