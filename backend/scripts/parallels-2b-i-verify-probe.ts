#!/usr/bin/env node
// READ-ONLY verification probe for PR #36. No writes.
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

const SET = "2024 Bowman Chrome Baseball";

async function runQuery(container: any, res: string, columns: string): Promise<any[]> {
  const q = {
    query: `SELECT ${columns} FROM c WHERE c["set"] = @set AND CONTAINS(LOWER(c.player), @p) AND c.attributeResolution = @res`,
    parameters: [
      { name: "@set", value: SET },
      { name: "@p", value: "skenes" },
      { name: "@res", value: res },
    ],
  };
  const { resources } = await container.items.query(q, { partitionKey: SET }).fetchAll();
  return resources;
}

async function main() {
  const client = buildCosmosClient();
  const { chCardIndex, parallelAttributes } = await getParallelsContainers(client);

  const matched = await runQuery(
    chCardIndex,
    "matched",
    "c.id, c.cardId, c.number, c.variantRaw, c.attributeKey, c.printRun, c.tierWithinSet, c.isAutograph"
  );
  const quarantined = await runQuery(
    chCardIndex,
    "unmatched_pending_insert_curation",
    "c.id, c.cardId, c.number, c.variantRaw, c.detectedInsertPrefix, c.attributeKey, c.attributeResolution"
  );
  const unmatchedVariant = await runQuery(
    chCardIndex,
    "unmatched-variant",
    "c.id, c.cardId, c.number, c.variantRaw, c.attributeResolution"
  );

  // Fetch parallel_attributes referenced by matched rows
  const pAttrQuery = {
    query: `SELECT c.id, c.attributeKey, c.printRun, c.tierWithinSet, c.isAutograph FROM c WHERE c["set"] = @set AND CONTAINS(LOWER(c.player), @p)`,
    parameters: [
      { name: "@set", value: SET },
      { name: "@p", value: "skenes" },
    ],
  };
  const { resources: parallels } = await parallelAttributes.items
    .query(pAttrQuery, { partitionKey: SET })
    .fetchAll();

  const out = {
    matched,
    quarantined,
    unmatchedVariant,
    parallels,
    summary: {
      matchedCount: matched.length,
      quarantinedCount: quarantined.length,
      unmatchedVariantCount: unmatchedVariant.length,
      uniqueInsertPrefixes: Array.from(new Set(quarantined.map((r: any) => r.detectedInsertPrefix))).sort(),
      matchedNumericCheck: matched.map((r: any) => ({ number: r.number, numeric: /^\d+$/.test(String(r.number ?? "")) })),
      quarantinedNumericCheck: quarantined.map((r: any) => ({ number: r.number, pureNumeric: /^\d+$/.test(String(r.number ?? "")) })),
      quarantinedAttributeKeyNullAll: quarantined.every((r: any) => r.attributeKey == null),
      uniqueQuarantinedVariantRaw: Array.from(new Set(quarantined.map((r: any) => r.variantRaw))).sort(),
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("[probe] FAILED:", e);
  process.exit(1);
});
