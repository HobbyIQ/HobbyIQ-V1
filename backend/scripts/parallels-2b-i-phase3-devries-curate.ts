#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Issue #25 Phase 3 — Stage 5: De Vries autograph-set tier curation
//
// Writes 6 owner-approved parallel_attributes records for the
// "2024 Bowman Chrome Prospects Autograph" set so the Phase 3 tier-anchored
// engine can resolve a same-set peer pool for the De Vries Blue Refractor /150
// dev test.
//
// Tiers locked by owner 2026-05-17 (auto bump vs Skenes non-auto baseline):
//   Base Auto                  → 3
//   Refractor Auto /499        → 4
//   Blue Refractor Auto /150   → 5   ← the De Vries subject
//   Gold Refractor Auto /50    → 7
//   Red Refractor Auto /5      → 8
//   Superfractor Auto 1/1      → 8
//
// Idempotent via upsertParallelAttributes. Verifies after write.
//
// Run from repo root:
//   npx --yes tsx backend/scripts/parallels-2b-i-phase3-devries-curate.ts
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

// ─── Load .env.harness-local ────────────────────────────────────────────────

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
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null && k && v) process.env[k] = v;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TARGET_SET = "2024 Bowman Chrome Prospects Autograph";
const REVIEW_DATE = "2026-05-17";
const REVIEWED_BY = "owner";
const SCHEMA_VERSION = 1;
const IS_AUTO = true;

interface Stage5Record {
  parallelName: string;
  color: string | null;
  printRun: number | null;
  parentVariant: string | null;
  tierWithinSet: number;
  variantAliases: string[];
}

const RECORDS: Stage5Record[] = [
  {
    parallelName: "Base Auto",
    color: null,
    printRun: null,
    parentVariant: null,
    tierWithinSet: 3,
    variantAliases: ["Base Auto", "Base Autograph", "Auto"],
  },
  {
    parallelName: "Refractor Auto",
    color: null,
    printRun: 499,
    parentVariant: "Base Auto",
    tierWithinSet: 4,
    variantAliases: ["Refractor Auto", "Refractor Autograph"],
  },
  {
    parallelName: "Blue Refractor Auto",
    color: "Blue",
    printRun: 150,
    parentVariant: "Refractor Auto",
    tierWithinSet: 5,
    variantAliases: ["Blue Refractor Auto", "Blue Refractor Autograph", "Blue Auto"],
  },
  {
    parallelName: "Gold Refractor Auto",
    color: "Gold",
    printRun: 50,
    parentVariant: "Refractor Auto",
    tierWithinSet: 7,
    variantAliases: ["Gold Refractor Auto", "Gold Refractor Autograph", "Gold Auto"],
  },
  {
    parallelName: "Red Refractor Auto",
    color: "Red",
    printRun: 5,
    parentVariant: "Refractor Auto",
    tierWithinSet: 8,
    variantAliases: ["Red Refractor Auto", "Red Refractor Autograph", "Red Auto"],
  },
  {
    parallelName: "Superfractor Auto",
    color: "Superfractor",
    printRun: 1,
    parentVariant: "Refractor Auto",
    tierWithinSet: 8,
    variantAliases: ["Superfractor Auto", "Superfractor Autograph", "Superfractor"],
  },
];

function buildRecord(o: Stage5Record): ParallelAttributesRecord {
  return {
    id: parallelAttributesId(TARGET_SET, o.parallelName, IS_AUTO),
    set: TARGET_SET,
    parallelName: o.parallelName,
    color: o.color,
    printRun: o.printRun,
    isAutograph: IS_AUTO,
    parentVariant: o.parentVariant,
    tierWithinSet: o.tierWithinSet,
    variantAliases: o.variantAliases,
    sourceCitation: {
      type: "owner-knowledge",
      date: REVIEW_DATE,
      note:
        "Issue #25 Phase 3 Stage 5 — De Vries auto-set tiers locked by owner 2026-05-17",
    },
    lastReviewedAt: `${REVIEW_DATE}T00:00:00Z`,
    reviewedBy: REVIEWED_BY,
    schemaVersion: SCHEMA_VERSION,
  };
}

async function main(): Promise<void> {
  if (!process.env.COSMOS_CONNECTION_STRING && !process.env.COSMOS_ENDPOINT) {
    throw new Error(
      "COSMOS_CONNECTION_STRING or COSMOS_ENDPOINT must be set (load backend/.env.harness-local)",
    );
  }

  console.log("─── Phase 3 Stage 5 — De Vries auto-set tier curation ────────────");
  console.log(`Target set : ${TARGET_SET}`);
  console.log(`Records    : ${RECORDS.length} (all isAutograph=true)`);
  console.log("");

  const { parallelAttributes } = await getParallelsContainers();

  // Pre-state
  console.log("[pre-state] reading current tierWithinSet per record …");
  for (const o of RECORDS) {
    const id = parallelAttributesId(TARGET_SET, o.parallelName, IS_AUTO);
    try {
      const { resource } = await parallelAttributes
        .item(id, TARGET_SET)
        .read<ParallelAttributesRecord>();
      const before =
        resource && Object.prototype.hasOwnProperty.call(resource, "tierWithinSet")
          ? resource.tierWithinSet
          : "(absent)";
      console.log(`  ${o.parallelName.padEnd(24)} before=${before}`);
    } catch (err) {
      const status = (err as { code?: number })?.code;
      if (status === 404) {
        console.log(`  ${o.parallelName.padEnd(24)} before=(not found)`);
      } else {
        throw err;
      }
    }
  }
  console.log("");

  // Upsert
  console.log("[upsert] writing 6 records via upsertParallelAttributes …");
  for (const o of RECORDS) {
    const rec = buildRecord(o);
    const resp = await upsertParallelAttributes(parallelAttributes, rec);
    const statusCode = (resp as { statusCode?: number }).statusCode ?? 0;
    console.log(
      `  ${o.parallelName.padEnd(24)} tier=${o.tierWithinSet} statusCode=${statusCode}`,
    );
  }
  console.log("");

  // Verify
  console.log("[verify] re-reading each record and asserting tierWithinSet …");
  let failures = 0;
  for (const o of RECORDS) {
    const id = parallelAttributesId(TARGET_SET, o.parallelName, IS_AUTO);
    const { resource } = await parallelAttributes
      .item(id, TARGET_SET)
      .read<ParallelAttributesRecord>();
    const tier = resource?.tierWithinSet;
    const isValid =
      typeof tier === "number" &&
      Number.isInteger(tier) &&
      tier === o.tierWithinSet;
    const mark = isValid ? "OK " : "FAIL";
    console.log(
      `  [${mark}] ${o.parallelName.padEnd(24)} expected=${o.tierWithinSet} got=${tier ?? "null"}`,
    );
    if (!isValid) failures += 1;
  }
  console.log("");

  if (failures > 0) {
    console.error(`[FAIL] ${failures} record(s) did not verify with the expected tier`);
    process.exit(1);
  }
  console.log("[OK] All 6 De Vries auto-set tier records present and correct.");
}

main().catch((err) => {
  console.error("[parallels-2b-i-phase3-devries-curate] fatal:", err);
  process.exit(1);
});
