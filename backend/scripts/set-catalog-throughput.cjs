#!/usr/bin/env node
/**
 * CF-CATALOG-RU-LIFT (2026-08-20). Read or set the autoscale ceiling on a
 * Cosmos container, via the DATA plane.
 *
 * WHY DATA PLANE. The CI principal holds only Website Contributor on HobbyIQ3
 * and has no Cosmos control-plane rights, so `az cosmosdb ...` cannot do this.
 * The account key in COSMOS_CONNECTION_STRING can, through the offer resource.
 *
 * WHY THIS EXISTS. Measured 2026-08-20: card_catalog sits at an autoscale max
 * of 20,000 RU/s while holding ~35.7M rows that every /search scans. A bounded
 * backfill of 20,000 rows produced 25,014 throttle-retries and landed only
 * 1,746 rows at 3,614/min — indistinguishable from the per-item baseline of
 * ~3,350/min. Bulk batching and concurrency bought nothing because RU, not
 * round trips, is the constraint.
 *
 * DEFAULTS TO READ-ONLY. --set is required to change anything, and the current
 * value is always printed first so it can be restored.
 *
 * Usage:
 *   node scripts/set-catalog-throughput.cjs                          # read
 *   node scripts/set-catalog-throughput.cjs --set=100000             # raise
 *   node scripts/set-catalog-throughput.cjs --set=20000              # restore
 *   node scripts/set-catalog-throughput.cjs --container=sold_comps
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const CONTAINER = arg("container", "card_catalog");
const SET = arg("set", null);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn || conn.length < 40) {
  console.error("FATAL: COSMOS_CONNECTION_STRING missing/truncated");
  process.exit(1);
}

(async () => {
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const container = db.container(CONTAINER);

  const offer = await container.readOffer();
  if (!offer.resource) {
    console.error(`FATAL: ${CONTAINER} has no dedicated offer (shared database throughput?)`);
    process.exit(1);
  }

  const content = offer.resource.content || {};
  const auto = content.offerAutopilotSettings;
  const currentMax = auto ? auto.maxThroughput : null;

  console.log(`container            : ${CONTAINER}`);
  console.log(`offer id             : ${offer.resource.id}`);
  console.log(`mode                 : ${auto ? "AUTOSCALE" : "MANUAL"}`);
  console.log(`current autoscale max: ${currentMax ?? "(n/a)"} RU/s`);
  console.log(`manual throughput    : ${content.offerThroughput ?? "(n/a)"}`);
  console.log(`max ever provisioned : ${content.offerMinimumThroughputParameters?.maxThroughputEverProvisioned ?? "?"}`);
  console.log(`replace pending      : ${content.isOfferReplacePending}`);

  if (SET === null) {
    console.log("\nREAD-ONLY. Pass --set=<RU> to change.");
    return;
  }
  if (!auto) {
    console.error("\nFATAL: container is not autoscale — refusing to convert modes here.");
    process.exit(1);
  }

  const target = Number(SET);
  if (!Number.isFinite(target) || target < 1000 || target % 1000 !== 0) {
    console.error(`\nFATAL: --set must be a multiple of 1000 and >= 1000 (got ${SET})`);
    process.exit(1);
  }
  if (content.isOfferReplacePending) {
    console.error("\nFATAL: an offer replace is already pending — wait for it to settle.");
    process.exit(1);
  }

  console.log(`\n*** RESTORE VALUE: --set=${currentMax}  (write this down) ***`);
  console.log(`changing autoscale max ${currentMax} -> ${target} RU/s ...`);

  const body = {
    ...offer.resource,
    content: {
      ...content,
      offerAutopilotSettings: { ...auto, maxThroughput: target },
    },
  };

  await client.offer(offer.resource.id).replace(body);

  const after = await container.readOffer();
  const newMax = after.resource?.content?.offerAutopilotSettings?.maxThroughput;
  console.log(`now                  : ${newMax} RU/s`);
  console.log(newMax === target ? "OK — applied." : "WARNING — value did not take; re-read before assuming.");
  console.log("\nAutoscale bills for the level actually reached each hour and scales back down when idle.");
  console.log(`Restore with: node scripts/set-catalog-throughput.cjs --container=${CONTAINER} --set=${currentMax}`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
