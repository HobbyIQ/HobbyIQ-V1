#!/usr/bin/env node
/**
 * CF-EBAY-TAXONOMY-DRIFT (Drew, 2026-07-21). Nightly self-healing
 * check for eBay category 261328 (Sports Trading Cards) schema
 * changes. Fetches getItemAspectsForCategory + getItemConditionPolicies
 * via client-credentials OAuth and compares against a committed
 * baseline. Alerts on drift so the descriptor ID map + condition
 * enum in ebayListing.service.ts can be updated before a real
 * publish breaks.
 *
 * Runbook:
 *   EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... \
 *     node backend/scripts/ebay-taxonomy-drift-check.cjs
 *
 * Exit 0 = no drift. Exit 1 = drift detected (workflow fails visibly).
 *
 * Baseline: backend/data/ebay-taxonomy-baseline-261328.json
 * Update baseline by running with --update-baseline flag (reviewed
 * PR ships the diff).
 */
const fs = require("fs");
const path = require("path");

const CATEGORY_ID  = process.env.EBAY_CATEGORY_ID  ?? "261328";
const MARKETPLACE  = process.env.EBAY_MARKETPLACE_ID ?? "EBAY_US";
const BASELINE_PATH = path.join(__dirname, "..", "data", `ebay-taxonomy-baseline-${CATEGORY_ID}.json`);
const UPDATE_BASELINE = process.argv.includes("--update-baseline");

const EBAY_BASE_API = process.env.EBAY_ENV === "sandbox"
  ? "https://api.sandbox.ebay.com"
  : "https://api.ebay.com";

async function getAppToken() {
  const clientId     = process.env.EBAY_CLIENT_ID ?? "";
  const clientSecret = process.env.EBAY_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    console.error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set");
    process.exit(2);
  }
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const res = await fetch(`${EBAY_BASE_API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`eBay client-credentials failed (${res.status}): ${text}`);
    process.exit(2);
  }
  const data = await res.json();
  return data.access_token;
}

async function ebayGet(token, path) {
  const res = await fetch(`${EBAY_BASE_API}${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay GET ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

/** Extract a stable, comparable shape from the raw eBay response.
 *  Ignores counts and localization noise — only tracks the shape iOS
 *  and buildConditionDescriptors depend on. */
function extractSchema({ aspects, conditionPolicies }) {
  return {
    conditionIds: (conditionPolicies?.itemConditionPolicies?.[0]?.itemConditions ?? [])
      .map(c => ({ id: c.conditionId, name: c.conditionDescription }))
      .sort((a, b) => Number(a.id) - Number(b.id)),
    requiredAspects: (aspects?.aspects ?? [])
      .filter(a => a.aspectConstraint?.aspectRequired === true)
      .map(a => a.localizedAspectName)
      .sort(),
    aspectNames: (aspects?.aspects ?? [])
      .map(a => a.localizedAspectName)
      .sort(),
  };
}

(async () => {
  const token = await getAppToken();

  const treeIdRes = await ebayGet(token,
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(MARKETPLACE)}`);
  const treeId = treeIdRes.categoryTreeId;

  const [aspects, conditionPolicies] = await Promise.all([
    ebayGet(token, `/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${CATEGORY_ID}`),
    ebayGet(token, `/sell/metadata/v1/marketplace/${MARKETPLACE}/get_item_condition_policies?filter=categoryIds:{${CATEGORY_ID}}`),
  ]);

  const live = extractSchema({ aspects, conditionPolicies });
  const meta = { marketplace: MARKETPLACE, categoryId: CATEGORY_ID, treeId, checkedAt: new Date().toISOString() };
  const output = { meta, schema: live };

  if (UPDATE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(output, null, 2) + "\n");
    console.log(`Baseline written to ${BASELINE_PATH}`);
    process.exit(0);
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`No baseline at ${BASELINE_PATH}. Run once with --update-baseline to seed.`);
    process.exit(2);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const baseSchema = baseline.schema;

  const drift = [];
  const sameKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!sameKeys(baseSchema.conditionIds, live.conditionIds)) {
    drift.push({ field: "conditionIds", was: baseSchema.conditionIds, now: live.conditionIds });
  }
  if (!sameKeys(baseSchema.requiredAspects, live.requiredAspects)) {
    drift.push({ field: "requiredAspects", was: baseSchema.requiredAspects, now: live.requiredAspects });
  }
  if (!sameKeys(baseSchema.aspectNames, live.aspectNames)) {
    const wasSet = new Set(baseSchema.aspectNames);
    const nowSet = new Set(live.aspectNames);
    const added = live.aspectNames.filter(x => !wasSet.has(x));
    const removed = baseSchema.aspectNames.filter(x => !nowSet.has(x));
    drift.push({ field: "aspectNames", added, removed });
  }

  if (drift.length === 0) {
    console.log(`OK: category ${CATEGORY_ID} matches baseline (${baseSchema.aspectNames.length} aspects, ${baseSchema.conditionIds.length} conditions)`);
    process.exit(0);
  }

  console.error(`DRIFT DETECTED in category ${CATEGORY_ID}:`);
  console.error(JSON.stringify(drift, null, 2));
  console.error("");
  console.error("Update the baseline after reviewing:");
  console.error("  node backend/scripts/ebay-taxonomy-drift-check.cjs --update-baseline");
  process.exit(1);
})().catch(e => { console.error(e.message); process.exit(2); });
