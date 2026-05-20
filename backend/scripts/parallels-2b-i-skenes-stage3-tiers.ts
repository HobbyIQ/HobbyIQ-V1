#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Issue #25 Phase 3 — Stage 3: Skenes tierWithinSet ingestion + verification
//
// Writes the 5 owner-locked Skenes parallel_attributes records to the dev
// `hobbyiq-comps` Cosmos account with the canonical Phase 3 tierWithinSet
// values, using the existing idempotent ingestion.upsertParallelAttributes
// pathway. Verifies the post-write state with a per-id Cosmos read and
// fails loudly if any record ends up with a null/undefined/out-of-range
// tierWithinSet.
//
// Run from repo root:
//   npx --yes tsx backend/scripts/parallels-2b-i-skenes-stage3-tiers.ts
//
// Reads COSMOS_CONNECTION_STRING / COSMOS_ENDPOINT / COSMOS_KEY from
// backend/.env.harness-local. Targets DEV ONLY by design.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import {
  getParallelsContainers,
  parallelAttributesId,
  upsertParallelAttributes,
  type ParallelAttributesRecord,
} from "../src/services/parallelsReference/ingestion.js";

// ─── Load .env.harness-local (dev creds) ────────────────────────────────────

const here = path.dirname(url.fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env.harness-local");
if (fs.existsSync(envFile)) {
  const raw = fs.readFileSync(envFile, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null && k && v) process.env[k] = v;
  }
}

// ─── Constants (locked by Phase 3 prompt 2026-05-17) ────────────────────────

const TARGET_SET = "2024 Bowman Chrome Baseball";
const REVIEW_DATE = "2026-05-17"; // Phase 3 prompt date
const REVIEWED_BY = "owner";
const SCHEMA_VERSION = 1;

interface Stage3Record {
  parallelName: string;
  color: string | null;
  printRun: number | null;
  parentVariant: string | null;
  tierWithinSet: number;
  variantAliases: string[];
}

// The 5 records, exactly as approved in the Q1 response.
const RECORDS: Stage3Record[] = [
  {
    parallelName: "Base",
    color: null,
    printRun: null,
    parentVariant: null,
    tierWithinSet: 1,
    variantAliases: ["Base", "Base - Catching"],
  },
  {
    parallelName: "Refractor",
    color: null,
    printRun: 899,
    parentVariant: "Base",
    tierWithinSet: 2,
    variantAliases: ["Refractor"],
  },
  {
    parallelName: "Blue Refractor",
    color: "Blue",
    printRun: 150,
    parentVariant: "Refractor",
    tierWithinSet: 4,
    variantAliases: ["Blue Refractor", "Blue"],
  },
  {
    parallelName: "Gold Refractor",
    color: "Gold",
    printRun: 50,
    parentVariant: "Refractor",
    tierWithinSet: 6,
    variantAliases: ["Gold Refractor", "Gold"],
  },
  {
    parallelName: "Red Refractor",
    color: "Red",
    printRun: 5,
    parentVariant: "Refractor",
    tierWithinSet: 7,
    variantAliases: ["Red Refractor", "Red"],
  },
];

function buildRecord(o: Stage3Record): ParallelAttributesRecord {
  return {
    id: parallelAttributesId(TARGET_SET, o.parallelName, false),
    set: TARGET_SET,
    parallelName: o.parallelName,
    color: o.color,
    printRun: o.printRun,
    isAutograph: false,
    parentVariant: o.parentVariant,
    tierWithinSet: o.tierWithinSet,
    variantAliases: o.variantAliases,
    sourceCitation: {
      type: "owner-knowledge",
      date: REVIEW_DATE,
      note: "Issue #25 Phase 3 — tierWithinSet locked by owner 2026-05-17",
    },
    lastReviewedAt: `${REVIEW_DATE}T00:00:00Z`,
    reviewedBy: REVIEWED_BY,
    schemaVersion: SCHEMA_VERSION,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.COSMOS_CONNECTION_STRING && !process.env.COSMOS_ENDPOINT) {
    throw new Error(
      "COSMOS_CONNECTION_STRING or COSMOS_ENDPOINT must be set (load backend/.env.harness-local)",
    );
  }

  console.log("─── Phase 3 Stage 3 — Skenes tierWithinSet ingestion ─────────────");
  console.log(`Target set : ${TARGET_SET}`);
  console.log(`Records    : ${RECORDS.length}`);
  console.log("");

  const { parallelAttributes } = await getParallelsContainers();

  // ─── Pre-state ───
  console.log("[pre-state] reading current tierWithinSet per record …");
  for (const o of RECORDS) {
    const id = parallelAttributesId(TARGET_SET, o.parallelName, false);
    try {
      const { resource } = await parallelAttributes
        .item(id, TARGET_SET)
        .read<ParallelAttributesRecord>();
      const before =
        resource && Object.prototype.hasOwnProperty.call(resource, "tierWithinSet")
          ? resource.tierWithinSet
          : "(absent)";
      console.log(`  ${o.parallelName.padEnd(20)} before=${before}`);
    } catch (err) {
      const status = (err as { code?: number })?.code;
      if (status === 404) {
        console.log(`  ${o.parallelName.padEnd(20)} before=(not found)`);
      } else {
        throw err;
      }
    }
  }
  console.log("");

  // ─── Upsert ───
  console.log("[upsert] writing 5 records via upsertParallelAttributes …");
  for (const o of RECORDS) {
    const rec = buildRecord(o);
    const resp = await upsertParallelAttributes(parallelAttributes, rec);
    const statusCode = (resp as { statusCode?: number }).statusCode ?? 0;
    console.log(
      `  ${o.parallelName.padEnd(20)} tier=${o.tierWithinSet} statusCode=${statusCode}`,
    );
  }
  console.log("");

  // ─── Verification: read back per record ───
  console.log("[verify] re-reading each record and asserting tierWithinSet …");
  let failures = 0;
  for (const o of RECORDS) {
    const id = parallelAttributesId(TARGET_SET, o.parallelName, false);
    const { resource } = await parallelAttributes
      .item(id, TARGET_SET)
      .read<ParallelAttributesRecord>();
    const tier = resource?.tierWithinSet;
    const isValid =
      typeof tier === "number" && Number.isInteger(tier) && tier === o.tierWithinSet;
    const mark = isValid ? "OK " : "FAIL";
    console.log(
      `  [${mark}] ${o.parallelName.padEnd(20)} expected=${o.tierWithinSet} got=${tier ?? "null"}`,
    );
    if (!isValid) failures += 1;
  }
  console.log("");

  // ─── Cross-check: cross-partition query for safety ───
  console.log("[verify] cross-check query for null tierWithinSet in target set …");
  // NOTE: `set` is a reserved keyword in Cosmos SQL when unqualified — but as a
  // property path (c.set) it's fine. The earlier failure was the parameter name
  // `@set` colliding with the parser; rename to `@targetSet`.
  const querySpec = {
    query:
      "SELECT c.parallelName, c.tierWithinSet FROM c WHERE c[\"set\"] = @targetSet AND (NOT IS_NUMBER(c.tierWithinSet) OR c.tierWithinSet = null)",
    parameters: [{ name: "@targetSet", value: TARGET_SET }],
  };
  const { resources: nulls } = await parallelAttributes.items
    .query<{ parallelName: string; tierWithinSet: unknown }>(querySpec, {
      partitionKey: TARGET_SET,
    })
    .fetchAll();
  if (nulls.length > 0) {
    console.error(
      `  [WARN] ${nulls.length} record(s) in '${TARGET_SET}' still have null tierWithinSet (outside the 5 Stage 3 records):`,
    );
    for (const n of nulls) {
      console.error(`    - ${n.parallelName} (tier=${String(n.tierWithinSet)})`);
    }
  } else {
    console.log(`  [OK] no null tierWithinSet records in set '${TARGET_SET}'.`);
  }

  console.log("");
  if (failures > 0) {
    console.error(`STAGE 3 FAILED — ${failures} record(s) did not verify.`);
    process.exit(1);
  }
  console.log("STAGE 3 COMPLETE — all 5 Skenes records have correct tierWithinSet.");
}

main().catch((err) => {
  console.error("Stage 3 fatal:", err);
  process.exit(1);
});
