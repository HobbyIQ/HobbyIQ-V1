#!/usr/bin/env node
// CF-PROTOTYPE-NEIGHBOR-LOOKUP (Drew, 2026-07-30). Live-corpus test
// of findNeighborComps + summarizeByDistance. Point it at a known
// cardId; it returns the axis-drop tree and per-distance comp count.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   PROTOTYPE_CARDID             — target slug (default: Eric Hartman auto)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { findNeighborComps, compositeFilterFromCardId, summarizeByDistance } =
  require(path.join(backend, "dist/services/portfolioiq/findNeighborComps.service.js"));

const TARGET = process.env.PROTOTYPE_CARDID || "hiq:baseball:2026:bowman-chrome:cpa-eha:gold-refractor:auto:num-50";

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[prototype-neighbor-lookup]`);
  console.log(`  target: ${TARGET}\n`);

  const filter = compositeFilterFromCardId(TARGET);
  console.log(`  derived filter:`, JSON.stringify(filter, null, 2));
  console.log();

  const comps = await findNeighborComps(sc, filter, {
    maxDistance: 6,
    minComps: 20,
    maxComps: 100,
    recencyDays: 730,
  });

  console.log(`  Neighbor comps found: ${comps.length}\n`);
  const summary = summarizeByDistance(comps);
  console.log(`  By distance:`);
  summary.forEach(s => {
    const dropped = s.droppedAxes.length > 0 ? ` [dropped: ${s.droppedAxes.join(", ")}]` : "";
    console.log(`    distance ${s.distance}: ${s.count} comps${dropped}`);
  });

  console.log(`\n  Sample 8 (closest first):`);
  comps.slice(0, 8).forEach(c => {
    const d = c.doc;
    console.log(`    d=${c.distance} score=${c.matchScore.toFixed(2)} $${d.price} ${d.soldAt?.slice(0,10)} ${d.hobbyiqCardId}`);
    if (d.composite) {
      const comp = d.composite;
      console.log(`      composite: edition=${comp.edition} color=${comp.colorFamily} finish=${comp.finishModifier} ref=${comp.isRefractor}`);
    }
  });
}

main().catch(e => { console.error(e); process.exit(1); });
