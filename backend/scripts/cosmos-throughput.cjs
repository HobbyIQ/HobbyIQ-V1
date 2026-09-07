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
//   node scripts/cosmos-throughput.cjs --report                          # all four

const { CosmosClient } = require("@azure/cosmos");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const DB = arg("database", "hobbyiq");
const CONTAINER = arg("container", "");
const MAX = arg("max", "");
const REPORT = process.argv.includes("--report");

// CF-THROUGHPUT-REPORT (2026-09-07). The four containers whose throughput is a
// standing cost decision. `--report` reads all of them and prints a table; it
// never writes. Keep this list in sync with docs/GO-LIVE-CHECKLIST.md
// "Cosmos throughput".
const REPORT_CONTAINERS = ["sold_comps", "card_catalog", "ch_daily_sales", "portfolio"];

// The autoscale floor is max(1000, storage floor, highest-ever-max / 10) and
// Azure names it only in a rejection. Over the DATA plane the offer does not
// carry it, so the report shows the highest-ever-derived component we CAN see
// (max/10) and labels it as such -- an under-estimate is possible when the
// highest-ever max exceeds today's. `az cosmosdb sql container throughput show
// --query resource.minimumThroughput` is the authoritative read.
const billedFloor = (max) => Math.round(max / 10);

(async () => {
  if (!process.env.COSMOS_CONNECTION_STRING) throw new Error("COSMOS_CONNECTION_STRING not set");

  if (REPORT) {
    const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
    const rows = [];
    for (const name of REPORT_CONTAINERS) {
      try {
        const { resource: o } = await client.database(DB).container(name).readOffer();
        if (!o) { rows.push([name, "n/a", "n/a", "no container-level offer"]); continue; }
        const auto = o.content && o.content.offerAutopilotSettings;
        rows.push(auto
          ? [name, "autoscale", String(auto.maxThroughput), `~${billedFloor(auto.maxThroughput)} RU/s billed idle`]
          : [name, "manual", String(o.content.offerThroughput), `${o.content.offerThroughput} RU/s billed flat`]);
      } catch (e) {
        rows.push([name, "ERROR", "-", e.message]);
      }
    }
    const head = ["container", "mode", "max RU/s", "floor / note"];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd();
    console.log(line(head));
    console.log(w.map((n) => "-".repeat(n)).join("  "));
    for (const r of rows) console.log(line(r));
    return;
  }

  if (!CONTAINER) throw new Error("--container=<name> required (or --report)");

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

  // CF-THROUGHPUT-FLOOR-IS-A-MOVING-TARGET (2026-09-07).
  //
  // The autoscale minimum is highest-ever-provisioned / 10, so it RISES every
  // time anything provisions this container higher and never falls. A caller's
  // hardcoded idle number is therefore correct only until the next spike:
  // nightly-slug-backfill's teardown asserted 4000 (floor was 8000), then
  // 8000 (floor moved to 10000), and BOTH times the teardown failed on every
  // single run and left sold_comps parked at the 40000 working ceiling — the
  // exact bill the scale-down exists to avoid. A cost guard that fails open is
  // worse than none, because it reports success on the way up and silence on
  // the way down.
  //
  // Azure names the real minimum in its rejection ("Minimum limit 10000 is
  // because of Highest RUs provisioned 100000"). When the ONLY reason the
  // target was refused is that it sits under that floor, land on the floor: it
  // is the cheapest reachable setting, which is what the caller was asking for.
  // Any other rejection still throws — this widens no other failure.
  const setMax = async (value) => {
    offer.content.offerAutopilotSettings.maxThroughput = value;
    await client.offer(offer.id).replace(offer);
  };

  let intended = target;
  try {
    await setMax(target);
  } catch (e) {
    const floor = Number(/required minimum throughput (\d+)/i.exec(e.message || "")?.[1]);
    if (!Number.isFinite(floor) || floor <= target) throw e;
    console.log(`${CONTAINER}: ${target} is below the autoscale floor Azure reports (${floor}) — using the floor`);
    intended = floor;
    await setMax(floor);
  }

  // Read back. A silent no-op would leave the account parked at the working
  // ceiling, which is exactly the bill this scaling exists to avoid.
  const { resource: after } = await container.readOffer();
  const landed = after.content.offerAutopilotSettings.maxThroughput;
  console.log(`${CONTAINER}: autoscale max ${current} -> ${landed} (billed floor ~${Math.round(landed / 10)} RU/s)`);
  if (landed !== intended) {
    throw new Error(`readback mismatch: asked for ${intended}, Cosmos reports ${landed}`);
  }
})().catch((e) => {
  console.error(`throughput: ${e.message}`);
  process.exit(1);
});
