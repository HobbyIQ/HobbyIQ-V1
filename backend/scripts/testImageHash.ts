#!/usr/bin/env -S npx tsx
// Smoke test — compute pHash for a real CH card image and self-compare.
import { computeImageHash, classifyImageMatch, hammingDistance } from "../src/services/portfolioiq/imageVerify.service.js";
import { CosmosClient } from "@azure/cosmos";

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");

  // Grab 5 catalog entries with reference images
  const { resources } = await cat.items.query({
    query: "SELECT TOP 5 c.id, c.playerName, c.parallel, c.referenceImage FROM c WHERE IS_DEFINED(c.referenceImage)",
  }).fetchAll();
  console.log(`\n▸ Testing on ${resources.length} catalog entries with reference images`);

  const hashes: Array<{ slug: string; url: string; hash: string; label: string }> = [];
  for (const r of resources as Array<{ id: string; playerName: string; parallel: string; referenceImage: { url: string } }>) {
    const t0 = Date.now();
    const hash = await computeImageHash(r.referenceImage.url);
    const ms = Date.now() - t0;
    console.log(`  ${r.playerName} · ${r.parallel}  hash=${hash ?? "NULL"}  (${ms}ms)`);
    if (hash) hashes.push({ slug: r.id, url: r.referenceImage.url, hash, label: `${r.playerName} · ${r.parallel}` });
  }

  // Self-compare (should be match)
  console.log(`\n▸ Self-compare (should be identical, distance=0):`);
  for (const h of hashes) {
    const r = classifyImageMatch(h.hash, h.hash);
    console.log(`  ${h.label}  →  ${r.verdict}  distance=${r.distance}`);
  }

  // Cross-compare — different cards should mostly be "mismatch"
  console.log(`\n▸ Cross-compare (different cards):`);
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      const d = hammingDistance(hashes[i].hash, hashes[j].hash);
      const r = classifyImageMatch(hashes[i].hash, hashes[j].hash);
      console.log(`  ${hashes[i].label}  vs  ${hashes[j].label}  →  ${r.verdict}  distance=${d}`);
    }
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
