// CF-CAT-ENGINE (2026-06-21): worksheet generator. Emits a reviewable TS
// patch capturing the engine's proposed `baseRelativePremium` values for
// owner PR-review. NEVER applied to the live multiplier table — the
// owner cherry-picks values into chromeDraftMultipliers.ts via PR, which
// is the CF-C apply-governance invariant in code-review form.

import type { TierAnalysisResult } from "./densityAnalyzer.js";
import { MIN_EMPIRICAL_N } from "./densityAnalyzer.js";
import type { BaseRelativePremium } from "../../services/compiq/chromeDraftMultipliers.js";

export interface WorksheetMeta {
  /** The scope label this worksheet was generated for. */
  scopeLabel: string;
  /** ISO timestamp when the engine ran. */
  generatedAt: string;
  /** Cardsight call count for traceability. */
  cardsProbed: number;
  cardsErrored: number;
  /** The n threshold the engine used for empirical promotion. */
  minEmpiricalN: number;
}

export interface WorksheetTierProposal {
  tierKey: string;
  density: TierAnalysisResult["density"];
  /** Proposed BaseRelativePremium for the row. Always emitted — */
  /** owner reviews then copies values into chromeDraftMultipliers.ts. */
  proposed: BaseRelativePremium | null;
  /** Provenance verdict reason for the worksheet header. */
  provenanceReason: string;
  /** Firm-now flag (n_strict ≥ MIN_EMPIRICAL_N on base axis). */
  firmNow: boolean;
  /** Ref-relative companion centerpoint, when mechanism1 needs it derived. */
  refRelativeCenterpoint: number | null;
  refRelativeNStrict: number;
  /** Per-card audit detail. */
  pairedStrictDetail: Array<{ player: string; ratio: number; numN: number; denN: number }>;
}

export interface Worksheet {
  meta: WorksheetMeta;
  proposals: WorksheetTierProposal[];
}

export function buildWorksheet(
  meta: Omit<WorksheetMeta, "minEmpiricalN">,
  analyses: ReadonlyArray<TierAnalysisResult>,
): Worksheet {
  const proposals: WorksheetTierProposal[] = analyses.map((a) => {
    const sampleBaseRange = a.baseRelative.sampleBaseRange;
    const topBaseBucketRatio = a.baseRelative.topBaseBucketRatio;
    const proposed: BaseRelativePremium | null =
      a.baseRelative.centerpoint !== null && a.baseRelative.range !== null
        ? {
            value: round3(a.baseRelative.centerpoint),
            range: [round3(a.baseRelative.range[0]), round3(a.baseRelative.range[1])],
            n: a.baseRelative.nStrict,
            basis: "base_auto_paired",
            provenance: a.provenance.provenance,
            calibratedAt: meta.generatedAt,
            // CF-BUILD-B fields — optional in schema, always emitted by engine.
            ...(sampleBaseRange !== null
              ? { sampleBaseRange: [round2(sampleBaseRange[0]), round2(sampleBaseRange[1])] as [number, number] }
              : {}),
            topBaseBucketRatio: topBaseBucketRatio !== null ? round3(topBaseBucketRatio) : null,
          }
        : null;
    return {
      tierKey: a.tierKey,
      density: a.density,
      proposed,
      provenanceReason: a.provenance.reason,
      firmNow: a.firmNow,
      refRelativeCenterpoint:
        a.refRelative.centerpoint !== null ? round3(a.refRelative.centerpoint) : null,
      refRelativeNStrict: a.refRelative.nStrict,
      pairedStrictDetail: a.baseRelative.pairedStrict.map((p) => ({
        player: p.playerName,
        ratio: round3(p.ratio),
        numN: p.numeratorN,
        denN: p.denominatorN,
      })),
    };
  });
  return {
    meta: { ...meta, minEmpiricalN: MIN_EMPIRICAL_N },
    proposals,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Render the worksheet as a TS file the owner reviews/cherry-picks into
 * chromeDraftMultipliers.ts via PR. Output shape: a top-of-file banner
 * with scope + caveats, then per-tier blocks with the proposed
 * BaseRelativePremium literal in copy-pasteable form, plus density audit
 * + per-card detail.
 *
 * The file is intentionally NOT importable — it carries no exports the
 * engine reads. It's a code-review artifact, not a runtime input.
 */
export function renderWorksheetAsTs(worksheet: Worksheet): string {
  const lines: string[] = [];
  lines.push(`// CF-CAT-ENGINE WORKSHEET — DO NOT IMPORT, DO NOT AUTO-APPLY.`);
  lines.push(`//`);
  lines.push(`// Scope:        ${worksheet.meta.scopeLabel}`);
  lines.push(`// Generated at: ${worksheet.meta.generatedAt}`);
  lines.push(`// Cards probed: ${worksheet.meta.cardsProbed} (errored: ${worksheet.meta.cardsErrored})`);
  lines.push(`// Empirical gate: n_strict ≥ ${worksheet.meta.minEmpiricalN}`);
  lines.push(`//`);
  lines.push(`// REVIEW PROCESS:`);
  lines.push(`//   1. For each tier the engine proposed, decide whether to merge.`);
  lines.push(`//   2. Cherry-pick the BaseRelativePremium literal into the matching`);
  lines.push(`//      BowmanFamilyEntry in chromeDraftMultipliers.ts under the`);
  lines.push(`//      \`baseRelativePremium\` field.`);
  lines.push(`//   3. Provenance values:`);
  lines.push(`//        "empirical"            — engine cleared n_strict ≥ ${worksheet.meta.minEmpiricalN}; unlocks T3 collision-win.`);
  lines.push(`//        "sibling_provisional"  — engine held below the gate; row stays`);
  lines.push(`//                                 visible but T3 collision-win stays blocked.`);
  lines.push(`//`);
  lines.push(`// This worksheet is a CODE-REVIEW ARTIFACT, not a runtime input.`);
  lines.push("");

  // Firm-now tiers first (empirical), then provisional.
  const firmNow = worksheet.proposals.filter((p) => p.firmNow && p.proposed);
  const provisional = worksheet.proposals.filter((p) => !p.firmNow && p.proposed);
  const empty = worksheet.proposals.filter((p) => !p.proposed);

  lines.push(`// ─── FIRM-NOW (${firmNow.length}): cleared the empirical gate ───────────────`);
  lines.push("");
  for (const p of firmNow) lines.push(...renderProposal(p));

  lines.push(`// ─── PROVISIONAL (${provisional.length}): below the empirical gate ─────────`);
  lines.push("");
  for (const p of provisional) lines.push(...renderProposal(p));

  if (empty.length > 0) {
    lines.push(`// ─── NO PAIRED DATA (${empty.length}): no relaxed paired sales — not emitted as proposals ───`);
    lines.push("");
    for (const p of empty) {
      lines.push(`//   ${p.tierKey} — totalSales=${p.density.totalSales} distinctCards=${p.density.distinctCards}`);
    }
  }

  return lines.join("\n") + "\n";
}

function renderProposal(p: WorksheetTierProposal): string[] {
  const lines: string[] = [];
  lines.push(`// ─ ${p.tierKey} ─`);
  lines.push(`//   density: totalSales=${p.density.totalSales} distinctCards=${p.density.distinctCards}`);
  lines.push(`//   base-auto paired: strictN=${p.density.baseAuto.strictN} relaxedN=${p.density.baseAuto.relaxedN}`);
  lines.push(`//   Ref/499 paired:   strictN=${p.density.ref499.strictN} relaxedN=${p.density.ref499.relaxedN}`);
  lines.push(`//   verdict: ${p.provenanceReason}`);
  if (p.refRelativeCenterpoint !== null) {
    lines.push(`//   Ref-relative companion (mechanism1 axis): ${p.refRelativeCenterpoint}× (n_strict=${p.refRelativeNStrict})`);
  }
  if (p.pairedStrictDetail.length > 0) {
    lines.push(`//   per-card strict-paired detail:`);
    for (const d of p.pairedStrictDetail) {
      lines.push(`//     ${d.player.padEnd(28)} ratio=${d.ratio.toFixed(3)}  (BXF n=${d.numN} / base n=${d.denN})`);
    }
  }
  if (p.proposed) {
    lines.push(`//   PROPOSED baseRelativePremium (cherry-pick into the matching BowmanFamilyEntry):`);
    lines.push(`//     baseRelativePremium: {`);
    lines.push(`//       value: ${p.proposed.value},`);
    lines.push(`//       range: [${p.proposed.range[0]}, ${p.proposed.range[1]}],`);
    lines.push(`//       n: ${p.proposed.n},`);
    lines.push(`//       basis: "base_auto_paired",`);
    lines.push(`//       provenance: "${p.proposed.provenance}",`);
    lines.push(`//       calibratedAt: "${p.proposed.calibratedAt}",`);
    if (p.proposed.sampleBaseRange !== undefined) {
      lines.push(`//       sampleBaseRange: [${p.proposed.sampleBaseRange[0]}, ${p.proposed.sampleBaseRange[1]}],`);
    }
    if (p.proposed.topBaseBucketRatio !== undefined) {
      lines.push(`//       topBaseBucketRatio: ${p.proposed.topBaseBucketRatio === null ? "null" : p.proposed.topBaseBucketRatio},`);
    }
    lines.push(`//     },`);
  }
  lines.push("");
  return lines;
}
