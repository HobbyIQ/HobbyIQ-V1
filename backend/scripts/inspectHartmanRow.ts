#!/usr/bin/env -S node --experimental-strip-types
// Inspect one of the Hartman mis-tagged rows to see why the backfill missed it.
import { CosmosClient } from "@azure/cosmos";

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  const { resources } = await sc.items.query({
    query: "SELECT * FROM c WHERE c.hobbyiqCardId = @s AND c.source = 'cardsight' AND c.soldAt >= @cutoff ORDER BY c.soldAt DESC",
    parameters: [
      { name: "@s", value: "hiq:baseball:2026:bowman:cpa-eha:blue-refractor:auto" },
      { name: "@cutoff", value: new Date(Date.now() - 30 * 86400000).toISOString() },
    ],
  }).fetchAll();

  console.log(`\n▸ ${resources.length} Hartman :blue-refractor:auto Cardsight rows in last 30 days`);
  for (const r of resources as Array<Record<string, unknown>>) {
    console.log(`\n  ─────`);
    console.log(`  id:              ${r.id}`);
    console.log(`  cardId:          ${r.cardId}`);
    console.log(`  hobbyiqCardId:   ${r.hobbyiqCardId}`);
    console.log(`  playerName:      ${r.playerName}`);
    console.log(`  cardYear:        ${r.cardYear}`);
    console.log(`  setName:         ${r.setName}`);
    console.log(`  cardNumber:      ${r.cardNumber}`);
    console.log(`  parallel:        ${r.parallel}`);
    console.log(`  isAuto:          ${r.isAuto}`);
    console.log(`  sport:           ${r.sport}`);
    console.log(`  source:          ${r.source}`);
    console.log(`  title:           ${r.title}`);
  }
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
