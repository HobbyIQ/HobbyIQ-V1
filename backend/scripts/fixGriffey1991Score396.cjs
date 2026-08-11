// CF-GRIFFEY-91-SCORE-FIX (Drew, 2026-08-10). Fix two problems for Drew's
// 1991 Score Ken Griffey Jr #396 PSA 10 holding:
//
//  A) Holding has hobbyiqCardId=null → falls back to weak cross-setkey
//     lookup with 4 comps → FMV $16.28. Attach canonical slug:
//     hiq:baseball:1991:score:396:base:no-auto
//
//  B) 137 sold_comps rows live under wrong setKey:
//     hiq:baseball:1991:1991-score-baseball:396:base:no-auto
//     (TCA/CardHedge emitted raw setName "1991 Score Baseball" verbatim
//     instead of canonical "score"). Re-slug them to the canonical.
//
// After: Drew's PSA 10 holding pulls 10 PSA 10 comps (median $125)
// instead of 4 mixed-grade comps → FMV jumps from $16.28 to ~$125.

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const DREW_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const HOLDING_ID = "ccf2e618-934a-489d-b46a-39be8eb18768";
const CANONICAL_SLUG = "hiq:baseball:1991:score:396:base:no-auto";
const WRONG_SLUG = "hiq:baseball:1991:1991-score-baseball:396:base:no-auto";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(conn).database("hobbyiq");
  const portfolio = db.container("portfolio");
  const sold = db.container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}`);

  // ==== A) attach slug to holding ====
  console.log(`\n[A] attach hobbyiqCardId to holding ${HOLDING_ID}`);
  const { resource: doc } = await portfolio.item(DREW_ID, DREW_ID).read();
  const h = doc.holdings?.[HOLDING_ID];
  if (!h) { console.error("  holding not found"); process.exit(1); }
  console.log(`    before: hobbyiqCardId=${h.hobbyiqCardId}  fmv=$${h.fairMarketValue}`);
  if (APPLY) {
    doc.holdings[HOLDING_ID].hobbyiqCardId = CANONICAL_SLUG;
    doc.holdings[HOLDING_ID].hobbyiqCardIdSource = "manual-remap-2026-08-10";
    doc.holdings[HOLDING_ID].lastUpdated = new Date().toISOString();
    await portfolio.item(DREW_ID, DREW_ID).replace(doc);
    console.log(`    after: hobbyiqCardId=${CANONICAL_SLUG}`);
  }

  // ==== B) re-slug 137 wrong-setKey rows ====
  console.log(`\n[B] re-slug rows from ${WRONG_SLUG} → ${CANONICAL_SLUG}`);
  const { resources } = await sold.items.query({
    query: `SELECT c.id, c.cardId FROM c WHERE c.hobbyiqCardId = @s`,
    parameters: [{ name: "@s", value: WRONG_SLUG }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`    found ${resources.length} row(s)`);
  let touched = 0, failed = 0;
  for (const r of resources) {
    if (!APPLY) { touched++; continue; }
    try {
      await sold.item(r.id, r.cardId).patch([
        { op: "set", path: "/hobbyiqCardId", value: CANONICAL_SLUG },
        { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
        { op: "set", path: "/reslugedFrom", value: WRONG_SLUG },
        { op: "set", path: "/reslugedReason", value: "CF-GRIFFEY-91-SCORE-FIX: setKey 1991-score-baseball→score" },
      ]);
      touched++;
    } catch (err) {
      const code = err && err.code;
      if (code === 429) {
        const wait = (err.retryAfterInMs || 500) + 100;
        await new Promise((r) => setTimeout(r, wait));
        try {
          await sold.item(r.id, r.cardId).patch([
            { op: "set", path: "/hobbyiqCardId", value: CANONICAL_SLUG },
            { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
            { op: "set", path: "/reslugedFrom", value: WRONG_SLUG },
            { op: "set", path: "/reslugedReason", value: "CF-GRIFFEY-91-SCORE-FIX: setKey 1991-score-baseball→score" },
          ]);
          touched++;
          continue;
        } catch (err2) {
          console.warn(`    fail(retry) ${r.id}: ${err2.message || err2}`);
          failed++;
          continue;
        }
      }
      console.warn(`    fail ${r.id}: ${err.message || err}`);
      failed++;
    }
  }
  console.log(`    touched=${touched} failed=${failed}`);

  if (APPLY) {
    const { resources: after } = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: CANONICAL_SLUG }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`\n  ${CANONICAL_SLUG} now has ${after[0]} row(s)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
