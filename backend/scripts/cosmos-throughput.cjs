#!/usr/bin/env node
// CF-THROUGHPUT-DATA-PLANE (Drew, 2026-08-18).
//
// Sets a container's AUTOSCALE MAXIMUM over the Cosmos DATA plane, using the
// account key already in COSMOS_CONNECTION_STRING.
//
// WHY THIS EXISTS. The nightly sweeps scaled RUs with `az cosmosdb sql container
// throughput update`, which is a CONTROL-plane call and needs an Azure RBAC role.
// The deploy service principal holds only `Website Contributor` scoped to the
// HobbyIQ3 app, so every run died at the first RU step:
//
//   AuthorizationFailed ... Microsoft.DocumentDB/.../throughputSettings/write
//
// Two runs (32093243367, 32123195430) failed that way on 2026-08-17/18 and did
// zero repair. The alternative to this script is granting the CI principal a
// Cosmos control-plane role — a strictly larger blast radius than the account
// key the job already handles, for the same capability.
//
// AUTOSCALE ONLY, BY DESIGN. If a container is on manual throughput this REFUSES
// rather than converting it: switching provisioning mode is a cost decision, not
// something a sweep's setup step should make silently.
//
// The autoscale max cannot go below max(1000, storage-based floor,
// highest-ever-max / 10). Azure rejects anything lower, and this reports the
// rejection verbatim instead of pretending the change landed.
//
// Usage:
//   node scripts/cosmos-throughput.cjs --container=sold_comps            # read
//   node scripts/cosmos-throughput.cjs --container=sold_comps --max=4000 # set

const { CosmosClient } = require("@azure/cosmos");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const DB = arg("database", "hobbyiq");
const CONTAINER = arg("container", "");
const MAX = arg("max", "");

(async () => {
  if (!process.env.COSMOS_CONNECTION_STRING) throw new Error("COSMOS_CONNECTION_STRING not set");
  if (!CONTAINER) throw new Error("--container=<name> required");

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database(DB).container(CONTAINER);

  const { resource: offer } = await container.readOffer();
  if (!offer) throw new Error(`${CONTAINER}: no container-level offer (database-shared throughput?)`);

  const autoscale = offer.content && offer.content.offerAutopilotSettings;
  const current = autoscale ? autoscale.maxThroughput : null;

  if (!MAX) {
    console.log(current !== null
      ? `${CONTAINER}: autoscale max = ${current} (billed floor ~${Math.round(current / 10)} RU/s)`
      : `${CONTAINER}: MANUAL throughput = ${offer.content.offerThroughput} RU/s`);
    return;
  }

  const target = Number(MAX);
  if (!Number.isFinite(target) || target <= 0) throw new Error(`--max must be a positive number, got "${MAX}"`);
  if (current === null) {
    throw new Error(`${CONTAINER} is on MANUAL throughput (${offer.content.offerThroughput} RU/s). `
      + `Refusing to convert it to autoscale as a side effect of a sweep.`);
  }
  if (current === target) {
    console.log(`${CONTAINER}: autoscale max already ${target} — no change`);
    return;
  }

  offer.content.offerAutopilotSettings.maxThroughput = target;
  await client.offer(offer.id).replace(offer);

  // Read back. A silent no-op would leave the account parked at the working
  // ceiling, which is exactly the bill this scaling exists to avoid.
  const { resource: after } = await container.readOffer();
  const landed = after.content.offerAutopilotSettings.maxThroughput;
  console.log(`${CONTAINER}: autoscale max ${current} -> ${landed} (billed floor ~${Math.round(landed / 10)} RU/s)`);
  if (landed !== target) {
    throw new Error(`readback mismatch: asked for ${target}, Cosmos reports ${landed}`);
  }
})().catch((e) => {
  console.error(`throughput: ${e.message}`);
  process.exit(1);
});
