// One-time hot-fix: align Verlander BDP129 holding's `cardId` to its
// canonical `hobbyiqCardId` so the card link (and all downstream reads
// keyed by cardId — recent comps, grade curve queries via that slug) go
// to the right card. The stripped slug currently points at Troy Glaus
// 2005 Bowman Chrome #129 base.
//
// Idempotent: skips if cardId already matches hobbyiqCardId.
const { CosmosClient } = require("@azure/cosmos");

const TARGET_USER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const TARGET_HOLDING = "bba3b7ad-32d1-44a5-8a77-e798183ae290";
// Current WRONG slug (from user-entered "Bowman Chrome Draft Picks & Prospects" typo).
const CURRENT_WRONG_HIQ = "hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto";
// Correct RESOLVED slug (from catalogMatcher — real product is Bowman Draft P&P, no Chrome).
// Confirmed 20+ recent TCA/Cardsight comps live here.
const CORRECT_HIQ = "hiq:baseball:2005:bowman-draft:bdp129:base:no-auto";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const portfolio = db.container("portfolio");

  const { resource: doc } = await portfolio.item(TARGET_USER, TARGET_USER).read();
  if (!doc) { console.error("User doc not found:", TARGET_USER); process.exit(3); }

  const raw = doc.holdings || {};
  const isArray = Array.isArray(raw);
  const holdingsAsArr = isArray ? raw : Object.values(raw);
  const target = holdingsAsArr.find((h) => h.id === TARGET_HOLDING);
  if (!target) { console.error("Holding not found:", TARGET_HOLDING); process.exit(4); }

  console.log("BEFORE:");
  console.log("  cardId:         ", target.cardId);
  console.log("  hobbyiqCardId:  ", target.hobbyiqCardId);

  if (target.hobbyiqCardId === CORRECT_HIQ && target.cardId === CORRECT_HIQ) {
    console.log("Already at correct catalog-resolved slug — no change.");
    return;
  }
  // Sanity: existing slug must be the known-wrong one we're fixing.
  // Refuse if it drifted somewhere else — safer to hand-check.
  if (target.hobbyiqCardId !== CURRENT_WRONG_HIQ && target.hobbyiqCardId !== CORRECT_HIQ) {
    console.error("Unexpected current hobbyiqCardId, aborting for safety. Got:", target.hobbyiqCardId);
    process.exit(5);
  }

  target.hobbyiqCardId = CORRECT_HIQ;
  target.cardId = CORRECT_HIQ;
  // Also correct the setName so future recomputes stay on the right slug.
  target.setName = "2005 Bowman Draft Picks & Prospects";
  // Force reprice on next read.
  target.lastUpdated = null;
  target.predictedPriceUpdatedAt = null;
  target.fairMarketValue = null;
  target.marketValue = null;

  await portfolio.item(TARGET_USER, TARGET_USER).replace(doc);
  console.log("AFTER:");
  console.log("  cardId:         ", target.cardId);
  console.log("  hobbyiqCardId:  ", target.hobbyiqCardId);
  console.log("Aligned successfully. Reprice will run on next refresh.");
}

main().catch((e) => { console.error(e); process.exit(1); });
