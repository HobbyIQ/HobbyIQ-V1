// CF-BACKFILL-CH-SALES-FILL-GAP (Drew, 2026-08-11). CH audit revealed a
// 24-34% gap on graded flagship cards (Trout 2011 Update PSA 10 = 94
// CH vs 62 ours; Ohtani 2018 Update PSA 10 = 102 CH vs 78 ours). Root
// cause is either (a) daily-export file omissions, (b) grade parsing
// misses, or (c) both. This script fills the gap:
//
//  1. Rank top-N vendor cardIds by our current comp count.
//  2. For each cardId × grade tier, call CH /cards/comps with count=2000.
//  3. Construct the deterministic sold_comps ID
//     (`cardhedge::ch-fill::${cardId}::${sale_date}::${price_cents}`) and
//     skip if row already exists.
//  4. For net-new sales, resolve the hiq: slug via a template row from
//     our existing sold_comps for the same vendor cardId, then write.
//
// Env:
//   CARD_HEDGE_API_KEY, COSMOS_CONNECTION_STRING required
//   APPLY=true         write (default dry-run)
//   TOP_N=1000         how many cards to backfill (default 1000)
//   CONCURRENCY=4      parallel CH calls
//   MIN_COMPS=10       skip cards with fewer than N existing comps

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const TOP_N = Number(process.env.TOP_N || 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const MIN_COMPS = Number(process.env.MIN_COMPS || 10);

const CH_BASE = "https://api.cardhedger.com/v1";
const CH_HEAD = {
  "X-API-Key": process.env.CARD_HEDGE_API_KEY,
  "Content-Type": "application/json",
};
const GRADES = ["Raw", "PSA 10", "PSA 9", "PSA 8", "BGS 10", "BGS 9.5", "SGC 10", "SGC 9.5"];

async function chComps(cardId, grade, count = 100, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${CH_BASE}/cards/comps`, {
        method: "POST",
        headers: CH_HEAD,
        body: JSON.stringify({ card_id: cardId, count, grade, include_raw_prices: true }),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
      if (!res.ok) return { error: `HTTP ${res.status}`, sales: [] };
      const body = await res.json();
      return { sales: Array.isArray(body?.raw_prices) ? body.raw_prices : [] };
    } catch (e) { if (i === tries - 1) return { error: e.message, sales: [] }; }
  }
  return { error: "retries exhausted", sales: [] };
}

async function main() {
  if (!process.env.CARD_HEDGE_API_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(1); }
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const sc = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database("hobbyiq").container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  topN=${TOP_N}  minComps=${MIN_COMPS}  concurrency=${CONCURRENCY}`);

  // Step 1: rank vendor cardIds by scanning cardId column and aggregating
  // in memory. Cross-partition GROUP BY + ORDER BY + TOP was returning a
  // gateway error under RU pressure — this streaming approach is
  // gentler on Cosmos (single scan, no aggregation-plan cost).
  console.log("\n[step 1] ranking vendor cardIds by our comp count");
  const iter = sc.items.query({
    query: `SELECT c.cardId FROM c WHERE c.source='cardhedge' AND IS_DEFINED(c.cardId) AND c.cardId != null`,
  }, { maxItemCount: 1000, enableCrossPartitionQuery: true });
  const counts = new Map();
  let scanned = 0;
  async function fetchWithRetry(tries = 15) {
    for (let i = 0; i < tries; i++) {
      try { return await iter.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) { await new Promise(r => setTimeout(r, (err.retryAfterInMs || 2000*(i+1)) + 500)); continue; }
        throw err;
      }
    }
    throw new Error("fetchNext exhausted");
  }
  while (iter.hasMoreResults()) {
    const { resources } = await fetchWithRetry();
    for (const r of resources) {
      if (!r.cardId) continue;
      scanned++;
      counts.set(r.cardId, (counts.get(r.cardId) || 0) + 1);
    }
    if (scanned % 200000 === 0) console.log(`   scanned=${scanned.toLocaleString()}  distinct=${counts.size.toLocaleString()}`);
  }
  console.log(`   TOTAL scanned=${scanned.toLocaleString()}  distinct cardIds=${counts.size.toLocaleString()}`);
  const cards = [...counts.entries()]
    .filter(([_, n]) => n >= MIN_COMPS)
    .map(([cardId, n]) => ({ cardId, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, TOP_N);
  console.log(`   ${cards.length} cardIds selected (top ${TOP_N} with >= ${MIN_COMPS} comps each)`);

  let totalFetched = 0, totalNew = 0, totalExisting = 0, totalFailed = 0;
  const t0 = Date.now();

  async function processCard(card, idx) {
    const { resources: tpl } = await sc.items.query({
      query: `SELECT TOP 1 c.hobbyiqCardId, c.playerName, c.sport, c.cardYear, c.setKey, c.cardNumber, c.parallel, c.isAuto, c.printRun
              FROM c WHERE c.cardId=@id AND IS_STRING(c.hobbyiqCardId)`,
      parameters: [{ name: "@id", value: card.cardId }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    if (tpl.length === 0) return;
    const t = tpl[0];

    for (const grade of GRADES) {
      const res = await chComps(card.cardId, grade, 100);
      if (res.error) { totalFailed++; continue; }
      totalFetched += res.sales.length;
      for (const s of res.sales) {
        if (!s?.sale_date || s?.price == null) continue;
        const priceCents = Math.round(Number(s.price) * 100);
        const id = `cardhedge::ch-fill::${card.cardId}::${s.sale_date}::${priceCents}`;
        const exists = await sc.items.query({
          query: `SELECT VALUE COUNT(1) FROM c WHERE c.id=@id`,
          parameters: [{ name: "@id", value: id }],
        }, { enableCrossPartitionQuery: true }).fetchAll();
        if ((exists.resources[0] || 0) > 0) { totalExisting++; continue; }
        totalNew++;
        if (!APPLY) continue;
        let gradeCompany = null, gradeValue = null;
        if (grade !== "Raw") {
          const m = grade.match(/^(PSA|BGS|SGC|CGC|HGA)\s+(\d+(?:\.\d+)?)$/i);
          if (m) { gradeCompany = m[1].toUpperCase(); gradeValue = Number(m[2]); }
        }
        const doc = {
          id,
          cardId: t.hobbyiqCardId,
          hobbyiqCardId: t.hobbyiqCardId,
          source: "cardhedge",
          sourceVariant: "ch-fill-gap-2026-08-11",
          vendorCardId: card.cardId,
          playerName: t.playerName,
          sport: t.sport,
          cardYear: t.cardYear,
          setKey: t.setKey,
          cardNumber: t.cardNumber,
          parallel: t.parallel,
          isAuto: t.isAuto,
          printRun: t.printRun,
          gradeCompany, gradeValue,
          price: Number(s.price),
          soldAt: s.sale_date,
          observedAt: new Date().toISOString(),
          title: s?.title || null,
        };
        try { await sc.items.upsert(doc); }
        catch (e) { totalFailed++; if (totalFailed < 5) console.warn(`  fail ${id}: ${e.message}`); }
      }
    }
    if ((idx + 1) % 25 === 0 || idx === 0) {
      const dur = ((Date.now()-t0)/1000).toFixed(0);
      console.log(`  card ${idx+1}/${cards.length}  fetched=${totalFetched.toLocaleString()} new=${totalNew.toLocaleString()} existing=${totalExisting.toLocaleString()} failed=${totalFailed}  ${dur}s`);
    }
  }

  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < cards.length) {
      const i = nextIdx++;
      await processCard(cards[i], i);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const dur = ((Date.now()-t0)/1000).toFixed(0);
  console.log(`\n[done ${dur}s]`);
  console.log(`  cards processed:    ${cards.length}`);
  console.log(`  CH sales fetched:   ${totalFetched.toLocaleString()}`);
  console.log(`  already in pool:    ${totalExisting.toLocaleString()}`);
  console.log(`  ${APPLY ? "wrote (new)" : "would write"}: ${totalNew.toLocaleString()}`);
  console.log(`  failed:             ${totalFailed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
