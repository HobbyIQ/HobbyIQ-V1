#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Issue #25 Phase 3 REBUILD — Stage 2: parallel_attributes catalog rebuild
//
// (a) DELETE the 5 stale Skenes records that were written under the wrong set
//     name ("2024 Bowman Chrome Baseball" — Skenes BCP-125 is actually in
//     "2024 Bowman Chrome Prospects").
// (b) WRITE comprehensive parallel_attributes records for two sets, one
//     record per (parallelName, isAutograph) pair, using the Chrome/Draft
//     multiplier table's exact naming convention:
//       • "2024 Bowman Chrome Prospects"             (isAutograph = false)
//       • "2024 Bowman Chrome Prospects Autograph"   (isAutograph = true)
//
// "Printing Plate" entries are SKIPPED (1/1, rarely sold, no useful comp data).
// HTA Choice Black is also 1/1 — included since it's part of the rainbow.
//
// Idempotent via upsertParallelAttributes. Verifies after write.
//
// Run from repo root:
//   npx --yes tsx backend/scripts/parallels-2b-i-phase3-rebuild-catalog.ts
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

import {
  CHROME_DRAFT_MULTIPLIERS,
  type ChromeDraftColorTier,
} from "../src/services/compiq/chromeDraftMultipliers.js";

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null && k && v) process.env[k] = v;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const NON_AUTO_SET = "2024 Bowman Chrome Prospects";
const AUTO_SET = "2024 Bowman Chrome Prospects Autograph";
const REVIEW_DATE = "2026-05-17";
const REVIEWED_BY = "owner";
const SCHEMA_VERSION = 1;

const STALE_SKENES_SET = "2024 Bowman Chrome Baseball";
const STALE_PARALLELS = ["Base", "Refractor", "Blue Refractor", "Gold Refractor", "Red Refractor"];

// colorTier → informational integer tierWithinSet (UI grouping only — the
// Phase 3 engine reads parallelName directly via the multiplier table and
// does NOT consume this integer).
const COLOR_TIER_TO_INT: Readonly<Record<ChromeDraftColorTier, number>> = Object.freeze({
  "Base":        1,
  "Early Color": 2,
  "Atomic Tier": 3,
  "Blue Tier":   4,
  "Green Tier":  5,
  "Yellow Tier": 5,
  "Gold Tier":   6,
  "Orange Tier": 7,
  "Black Tier":  8,
  "Red Tier":    8,
  "1/1 Tier":    9,
  "HTA":         0, // overridden by print run for HTA
});

function hta_tier_by_printrun(printRun: number | null): number {
  if (printRun === null) return 1;
  if (printRun >= 500) return 1;
  if (printRun >= 100) return 1;
  if (printRun >= 50) return 5;
  if (printRun >= 25) return 6;
  if (printRun >= 10) return 7;
  if (printRun >= 5) return 8;
  return 9; // 1/1
}

function parsePrintRun(pr: string): number | null {
  if (pr === "unnumbered") return null;
  if (pr === "1/1") return 1;
  const m = pr.match(/^\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

function colorFromParallelName(name: string): string | null {
  const lc = name.toLowerCase();
  const colors = [
    "blue", "green", "gold", "red", "orange", "black",
    "purple", "yellow", "speckle", "atomic", "superfractor",
  ];
  for (const c of colors) if (lc.includes(c)) return c.charAt(0).toUpperCase() + c.slice(1);
  return null;
}

// ─── Record builders ────────────────────────────────────────────────────────

interface RecordSpec {
  set: string;
  parallelName: string;
  isAutograph: boolean;
  color: string | null;
  printRun: number | null;
  tierWithinSet: number;
  variantAliases: string[];
  parentVariant: string | null;
}

function buildSpecs(set: string, isAutograph: boolean): RecordSpec[] {
  const out: RecordSpec[] = [];
  for (const entry of Object.values(CHROME_DRAFT_MULTIPLIERS)) {
    // Skip Printing Plate per prompt.
    if (entry.parallelName === "Printing Plate") continue;
    // Per Stage-2 prompt: same parallelName works for both auto and non-auto
    // EXCEPT "Base Auto" which is intrinsically autograph. For non-auto, the
    // equivalent of "Base Auto" is just "Base" (unnumbered base card).
    let parallelName = entry.parallelName;
    if (entry.parallelName === "Base Auto") {
      parallelName = isAutograph ? "Base Auto" : "Base";
    }
    const printRun = parsePrintRun(entry.printRun);
    const tier =
      entry.colorTier === "HTA"
        ? hta_tier_by_printrun(printRun)
        : COLOR_TIER_TO_INT[entry.colorTier];
    out.push({
      set,
      parallelName,
      isAutograph,
      color: colorFromParallelName(parallelName),
      printRun,
      tierWithinSet: tier,
      variantAliases: aliases(parallelName, isAutograph),
      parentVariant: parentOf(parallelName),
    });
  }
  return out;
}

function aliases(parallelName: string, isAutograph: boolean): string[] {
  const out = new Set<string>();
  out.add(parallelName);
  // " Refractor"-suffixed alias for color parallels
  if (
    /^(Blue|Green|Gold|Red|Orange|Black|Purple|Yellow|Speckle|Atomic)/.test(parallelName) &&
    !/Refractor$/.test(parallelName) &&
    parallelName !== "Speckle"
  ) {
    out.add(`${parallelName} Refractor`);
  }
  // Auto suffix variants
  if (isAutograph) {
    out.add(`${parallelName} Auto`);
    out.add(`${parallelName} Autograph`);
  }
  return [...out];
}

function parentOf(parallelName: string): string | null {
  if (parallelName === "Base" || parallelName === "Base Auto" || parallelName === "Refractor") return null;
  return "Refractor";
}

function toRecord(spec: RecordSpec, colorTierLabel: ChromeDraftColorTier | null): ParallelAttributesRecord {
  return {
    id: parallelAttributesId(spec.set, spec.parallelName, spec.isAutograph),
    set: spec.set,
    parallelName: spec.parallelName,
    color: spec.color,
    printRun: spec.printRun,
    isAutograph: spec.isAutograph,
    parentVariant: spec.parentVariant,
    tierWithinSet: spec.tierWithinSet,
    variantAliases: spec.variantAliases,
    sourceCitation: {
      type: "owner-multiplier-table",
      date: REVIEW_DATE,
      note: `Issue #25 Phase 3 REBUILD — chromeDraftMultipliers-v1; colorTier=${colorTierLabel ?? "n/a"}`,
    } as any,
    lastReviewedAt: `${REVIEW_DATE}T00:00:00Z`,
    reviewedBy: REVIEWED_BY,
    schemaVersion: SCHEMA_VERSION,
  };
}

function colorTierForSpec(spec: RecordSpec): ChromeDraftColorTier | null {
  // Re-lookup via the multiplier table using the spec.parallelName (or
  // "Base Auto" fallback for the non-auto "Base").
  const lookupKey = spec.parallelName === "Base" ? "Base Auto" : spec.parallelName;
  const e = CHROME_DRAFT_MULTIPLIERS[lookupKey];
  return e?.colorTier ?? null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.COSMOS_CONNECTION_STRING && !process.env.COSMOS_ENDPOINT) {
    throw new Error("COSMOS_CONNECTION_STRING or COSMOS_ENDPOINT must be set (load backend/.env.harness-local)");
  }

  console.log("─── Phase 3 REBUILD — Stage 2: parallel_attributes catalog rebuild ──");
  const { parallelAttributes } = await getParallelsContainers();

  // (a) DELETE 5 stale Skenes records
  console.log("");
  console.log(`[delete] removing 5 stale records under "${STALE_SKENES_SET}" …`);
  let deleted = 0;
  let notFound = 0;
  for (const parallelName of STALE_PARALLELS) {
    const id = parallelAttributesId(STALE_SKENES_SET, parallelName, false);
    try {
      await parallelAttributes.item(id, STALE_SKENES_SET).delete();
      console.log(`  deleted  : ${id}`);
      deleted += 1;
    } catch (err) {
      const status = (err as { code?: number })?.code;
      if (status === 404) {
        console.log(`  not found: ${id}`);
        notFound += 1;
      } else {
        throw err;
      }
    }
  }
  console.log(`[delete] complete — deleted=${deleted}, notFound=${notFound}`);

  // (b) WRITE non-auto set
  console.log("");
  console.log(`[write] "${NON_AUTO_SET}" (isAutograph=false) …`);
  const nonAutoSpecs = buildSpecs(NON_AUTO_SET, false);
  let writeOk = 0;
  for (const spec of nonAutoSpecs) {
    const rec = toRecord(spec, colorTierForSpec(spec));
    const resp = await upsertParallelAttributes(parallelAttributes, rec);
    const statusCode = (resp as { statusCode?: number }).statusCode ?? 0;
    if (statusCode === 200 || statusCode === 201) writeOk += 1;
    console.log(
      `  ${spec.parallelName.padEnd(24)} pr=${String(spec.printRun ?? "—").padEnd(4)} tier=${spec.tierWithinSet} status=${statusCode}`,
    );
  }
  console.log(`[write] non-auto complete — ${writeOk}/${nonAutoSpecs.length} ok`);

  // (c) WRITE auto set
  console.log("");
  console.log(`[write] "${AUTO_SET}" (isAutograph=true) …`);
  const autoSpecs = buildSpecs(AUTO_SET, true);
  let writeAutoOk = 0;
  for (const spec of autoSpecs) {
    const rec = toRecord(spec, colorTierForSpec(spec));
    const resp = await upsertParallelAttributes(parallelAttributes, rec);
    const statusCode = (resp as { statusCode?: number }).statusCode ?? 0;
    if (statusCode === 200 || statusCode === 201) writeAutoOk += 1;
    console.log(
      `  ${spec.parallelName.padEnd(24)} pr=${String(spec.printRun ?? "—").padEnd(4)} tier=${spec.tierWithinSet} status=${statusCode}`,
    );
  }
  console.log(`[write] auto complete — ${writeAutoOk}/${autoSpecs.length} ok`);

  // (d) VERIFY count per set
  console.log("");
  console.log("[verify] post-write Cosmos counts …");
  for (const set of [NON_AUTO_SET, AUTO_SET]) {
    const query = {
      query: 'SELECT VALUE COUNT(1) FROM c WHERE c["set"] = @targetSet',
      parameters: [{ name: "@targetSet", value: set }],
    };
    const { resources } = await parallelAttributes.items.query<number>(query, { partitionKey: set }).fetchAll();
    const n = resources[0] ?? 0;
    console.log(`  ${set.padEnd(48)} count=${n}`);
  }

  console.log("");
  console.log("─── Stage 2 catalog rebuild complete. ───────────────────────────────");
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exitCode = 1;
});
