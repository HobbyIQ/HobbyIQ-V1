#!/usr/bin/env node
// One-shot cleanup: delete Skenes ch_card_index rows that were mistakenly
// written as `attributeResolution: "matched"` against main-set Base despite
// having non-numeric (insert) numbers. Schema PR #37 §5.7. Issue #33.
//
// Run from backend/:
//   $env:COSMOS_KEY = az cosmosdb keys list --name hobbyiq-comps `
//     --resource-group rg-hobbyiq-dev --query primaryMasterKey -o tsv
//   npx --yes tsx scripts/parallels-2b-i-cleanup-insert-rows.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { buildCosmosClient, getParallelsContainers } from "../src/services/parallelsReference/ingestion.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env.harness-local");
if (fs.existsSync(envFile)) {
  const raw = fs.readFileSync(envFile, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (process.env[k] == null && k && v) process.env[k] = v;
  }
}

const TARGET_SET = "2024 Bowman Chrome Baseball";
const TARGET_PLAYER_TOKEN = "skenes";

async function main(): Promise<void> {
  if (!process.env.COSMOS_KEY && !process.env.COSMOS_CONNECTION_STRING) {
    throw new Error("COSMOS_KEY (or COSMOS_CONNECTION_STRING) must be set in env.");
  }
  const client = buildCosmosClient();
  const { chCardIndex } = await getParallelsContainers(client);

  console.log(`[cleanup] querying ch_card_index partition '${TARGET_SET}' for Skenes matched rows...`);
  const query = {
    query:
      "SELECT c.id, c[\"set\"] AS setName, c.number, c.variantRaw, c.player, c.attributeKey FROM c " +
      "WHERE c[\"set\"] = @set AND c.attributeResolution = @res AND CONTAINS(LOWER(c.player), @playerTok)",
    parameters: [
      { name: "@set", value: TARGET_SET },
      { name: "@res", value: "matched" },
      { name: "@playerTok", value: TARGET_PLAYER_TOKEN },
    ],
  };

  const { resources } = await chCardIndex.items
    .query<{ id: string; setName: string; number: string; variantRaw: string; player: string; attributeKey: string }>(query, {
      partitionKey: TARGET_SET,
    })
    .fetchAll();

  console.log(`[cleanup] fetched ${resources.length} matched Skenes rows total`);

  const offenders = resources.filter((r) => !/^\d+$/.test(String(r.number ?? "").trim()));
  console.log(`[cleanup] offenders (non-numeric number written as matched): ${offenders.length}`);
  for (const o of offenders) {
    console.log("  ", JSON.stringify(o));
  }

  if (offenders.length === 0) {
    console.log("[cleanup] nothing to delete. Done.");
    return;
  }

  for (const o of offenders) {
    const res = await chCardIndex.item(o.id, o.setName).delete();
    console.log(`[cleanup] delete id='${o.id}' status=${res.statusCode}`);
  }
  console.log("[cleanup] Done.");
}

main().catch((err) => {
  console.error("[cleanup] FATAL:", err?.stack ?? err);
  process.exit(1);
});
