#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Issue #25 Phase 3 — Stage 5: De Vries Blue Refractor /150 dev test
//
// Exercises the env-gated Phase 3 tier-anchored predicted-range fallback
// end-to-end against the real CompIQ estimate service. Reads CARD_HEDGE_API_KEY
// and COSMOS_CONNECTION_STRING from backend/.env.harness-local, sets
// COMPIQ_PHASE3_TIER_ANCHORED=true, and calls computeEstimate() directly.
//
// Goal: observe a non-null `predictedRangePhase3` low/high pair when Phase 2
// returns {low: null, high: null} (or otherwise see the diagnostics path).
//
// Owner expectation (from prompt): rough sanity target $900–$1,500.
// We do NOT assert exact dollars — this is a diagnostic run. The script
// dumps the full predictedRangePhase3 block plus peer-pool composition
// for owner review BEFORE Stage 6 PR.
//
// Run from repo root:
//   npx --yes tsx backend/scripts/parallels-2b-i-phase3-devries-test.ts
//
// REQUIRES:
//   - parallels-2b-i-phase3-devries-curate.ts run first (tier records present)
//   - CARD_HEDGE_API_KEY valid in .env.harness-local
//   - COSMOS_CONNECTION_STRING valid in .env.harness-local
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

// ─── Load .env.harness-local BEFORE importing the service ───────────────────

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

// CRITICAL: enable Phase 3 fallback before importing the service.
process.env.COMPIQ_PHASE3_TIER_ANCHORED = "true";

// Lazy import handle, populated in main() to avoid top-level await
// (tsx defaults to CJS output for .ts which forbids top-level await).
type ComputeEstimateFn = (
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
let computeEstimate: ComputeEstimateFn;

// ─── Subject (locked by owner 2026-05-17) ───────────────────────────────────
// Leo De Vries — Blue Refractor /150 Auto (Bowman Chrome Prospects Autograph).
// Owner sanity target: predictedRange midpoint roughly $900–$1,500.

const SUBJECT = {
  playerName: "Leo De Vries",
  cardYear: 2024,
  product: "Bowman Chrome Prospects Autograph",
  parallel: "Blue Refractor",
  isAuto: true,
  gradeCompany: "Raw",
} as const;

// Fallback spelling variants if Card Hedge titles the player differently.
const SUBJECT_FALLBACK = {
  ...SUBJECT,
  playerName: "Leo DeVries",
} as const;

interface MaybePredictedRange {
  low: number | null;
  high: number | null;
  source?: string;
  diagnostics?: Record<string, unknown> | null;
  peerPoolDiagnostics?: Record<string, unknown> | null;
}

function dumpPhase3Section(result: Record<string, unknown>): void {
  const p3 = result.predictedRangePhase3 as MaybePredictedRange | null | undefined;
  console.log("");
  console.log("─── predictedRangePhase3 ────────────────────────────────────────");
  if (p3 == null) {
    console.log("  (null — Phase 3 path did not run; check env flag + Phase 2 outcome)");
    return;
  }
  console.log(`  source       : ${p3.source ?? "(absent)"}`);
  console.log(
    `  range        : ${p3.low == null ? "null" : `$${p3.low}`} - ${p3.high == null ? "null" : `$${p3.high}`}`,
  );
  if (p3.peerPoolDiagnostics) {
    console.log("  peerPool:");
    console.log(JSON.stringify(p3.peerPoolDiagnostics, null, 4));
  }
  if (p3.diagnostics) {
    console.log("  tierDiagnostics:");
    console.log(JSON.stringify(p3.diagnostics, null, 4));
  }
}

function dumpPhase2Section(result: Record<string, unknown>): void {
  console.log("");
  console.log("─── predictedRangeResult (Phase 2) ──────────────────────────────");
  const p2 = result.predictedRangeResult as MaybePredictedRange | null | undefined;
  if (p2 == null) {
    console.log("  (absent)");
    return;
  }
  console.log(
    `  range        : ${p2.low == null ? "null" : `$${p2.low}`} - ${p2.high == null ? "null" : `$${p2.high}`}`,
  );
}

function dumpTopLine(result: Record<string, unknown>): void {
  console.log("");
  console.log("─── headline ────────────────────────────────────────────────────");
  console.log(`  cardTitle        : ${result.cardTitle ?? "(absent)"}`);
  console.log(`  fairMarketValue  : ${result.fairMarketValue ?? "(absent)"}`);
  console.log(`  quickSaleValue   : ${result.quickSaleValue ?? "(absent)"}`);
  console.log(`  premiumValue     : ${result.premiumValue ?? "(absent)"}`);
  const comps = result.comps as unknown[] | undefined;
  console.log(`  comp count       : ${Array.isArray(comps) ? comps.length : "(absent)"}`);
}

function dumpPhase3MultiplierAnchored(result: Record<string, unknown>): void {
  console.log("");
  console.log("─── Phase 3 REBUILD: multiplier-anchored predictedRange ────────");
  const src = result.predictedRangeSource as string | null | undefined;
  const range = result.predictedRange as { low: number; high: number } | null | undefined;
  const diag = result.predictedRangeDiagnostics as Record<string, unknown> | null | undefined;
  console.log(`  predictedRangeSource : ${src ?? "(absent)"}`);
  if (range && range.low != null && range.high != null) {
    console.log(`  predictedRange       : $${range.low} - $${range.high}`);
    const mid = (range.low + range.high) / 2;
    console.log(`  midpoint             : $${mid.toFixed(2)}  (owner target ~$900-$1500)`);
  } else {
    console.log(`  predictedRange       : null`);
  }
  if (diag) {
    console.log("  diagnostics:");
    console.log(JSON.stringify(diag, null, 4));
  }
}

async function runOnce(
  label: string,
  subject: Record<string, unknown>,
): Promise<void> {
  console.log("════════════════════════════════════════════════════════════════");
  console.log(` ${label}`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("Subject:", JSON.stringify(subject, null, 2));
  console.log("");

  const t0 = Date.now();
  let result: Record<string, unknown>;
  try {
    result = await computeEstimate(subject);
  } catch (err) {
    console.error("[FAIL] computeEstimate threw:", err);
    return;
  }
  const ms = Date.now() - t0;
  console.log(`computeEstimate completed in ${ms}ms`);

  dumpTopLine(result);
  dumpPhase2Section(result);
  dumpPhase3Section(result);
  dumpPhase3MultiplierAnchored(result);
}

async function main(): Promise<void> {
  if (!process.env.CARD_HEDGE_API_KEY) {
    throw new Error("CARD_HEDGE_API_KEY missing (load backend/.env.harness-local)");
  }
  if (!process.env.COSMOS_CONNECTION_STRING && !process.env.COSMOS_ENDPOINT) {
    throw new Error(
      "COSMOS_CONNECTION_STRING or COSMOS_ENDPOINT missing (load backend/.env.harness-local)",
    );
  }
  console.log(
    `[env] COMPIQ_PHASE3_TIER_ANCHORED=${process.env.COMPIQ_PHASE3_TIER_ANCHORED}`,
  );

  const mod = await import("../src/services/compiq/compiqEstimate.service.js");
  computeEstimate = mod.computeEstimate as unknown as ComputeEstimateFn;

  await runOnce("Attempt 1: playerName = 'Caleb Bonemer'", SUBJECT);
  await runOnce("Attempt 2: playerName = 'Caleb Bonner' (fallback spelling)", SUBJECT_FALLBACK);

  console.log("");
  console.log("[done] Stage 5 dev test complete — review output above.");
  console.log("        STOP here; do NOT open the Stage 6 PR without owner sign-off.");
}

main().catch((err) => {
  console.error("[parallels-2b-i-phase3-devries-test] fatal:", err);
  process.exit(1);
});
