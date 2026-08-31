/**
 * CF-GAP-DIGEST-TRIAGE (Drew, 2026-08-31). Night-over-night diff of the
 * checklist gap report.
 *
 * WHY. A nightly list of standing gaps reads identically whether the catalog
 * moved or stood still, so the report could not tell Drew that yesterday's
 * ingest actually CLOSED something — the one number that says the pipeline is
 * working ([[feedback_green_workflow_is_not_data_flow]]: verify the write,
 * not the run). The diff makes each morning's mail answer "what changed", and
 * a gap that leaves the report is the receipt.
 *
 * IDENTITY is (sport, year, setKey) — the same triple the gap report groups
 * on and the same one the slug carries. Comparing on anything looser folds
 * two products together and reports a phantom close.
 *
 * A gap that LEAVES the report is CLOSED only in the sense that it no longer
 * qualifies: coverage rose past the bar, or the product fell under the
 * min-comps floor. Both are stated, never conflated into "fixed".
 *
 * Pure: no IO, no writes. The caller loads the prior night's JSON.
 */

import type { GapEntry } from "./gapTriage.service.js";

export function gapKey(g: { sport: string; year: number; setKey: string }): string {
  return `${String(g.sport).toLowerCase()}|${g.year}|${String(g.setKey).toLowerCase()}`;
}

export interface GapDelta {
  readonly sport: string;
  readonly year: number;
  readonly setKey: string;
  readonly compsBefore: number;
  readonly compsAfter: number;
  readonly compsDelta: number;
  readonly checklistRowsBefore: number;
  readonly checklistRowsAfter: number;
  readonly checklistRowsDelta: number;
  readonly uncoveredBefore: number;
  readonly uncoveredAfter: number;
  readonly uncoveredDelta: number;
  readonly coverageBefore: number;
  readonly coverageAfter: number;
}

export interface GapDiff {
  /** Present last night, absent tonight — the gap left the report. */
  readonly closed: readonly GapEntry[];
  /** Absent last night, present tonight. */
  readonly added: readonly GapEntry[];
  /** On both reports, with per-entry movement. */
  readonly changed: readonly GapDelta[];
  /** On both reports and identical on every measured field. */
  readonly unchanged: readonly GapEntry[];
  /** True when there was no prior night to compare against. */
  readonly baseline: boolean;
  readonly priorDate: string | null;
  /** Net movement across everything still on the report. */
  readonly uncoveredClosed: number;
  readonly checklistRowsGained: number;
}

/**
 * Diff tonight's gap list against the prior night's. `priorDate` is carried
 * through for the email; `prior === null` means this is the first run and
 * every entry is reported as a baseline rather than as NEW — calling the
 * first night's whole report "new gaps" is a false alarm by construction.
 */
export function diffGapReports(
  current: readonly GapEntry[],
  prior: readonly GapEntry[] | null,
  priorDate: string | null = null,
): GapDiff {
  if (!prior) {
    return {
      closed: [],
      added: [],
      changed: [],
      unchanged: [...current],
      baseline: true,
      priorDate: null,
      uncoveredClosed: 0,
      checklistRowsGained: 0,
    };
  }

  const byKeyPrior = new Map(prior.map((g) => [gapKey(g), g]));
  const byKeyCurrent = new Map(current.map((g) => [gapKey(g), g]));

  const closed: GapEntry[] = [];
  for (const [k, g] of byKeyPrior) if (!byKeyCurrent.has(k)) closed.push(g);

  const added: GapEntry[] = [];
  const changed: GapDelta[] = [];
  const unchanged: GapEntry[] = [];

  for (const [k, cur] of byKeyCurrent) {
    const before = byKeyPrior.get(k);
    if (!before) { added.push(cur); continue; }
    const moved =
      before.comps !== cur.comps
      || before.checklistRows !== cur.checklistRows
      || before.uncovered !== cur.uncovered;
    if (!moved) { unchanged.push(cur); continue; }
    changed.push({
      sport: cur.sport,
      year: cur.year,
      setKey: cur.setKey,
      compsBefore: before.comps,
      compsAfter: cur.comps,
      compsDelta: cur.comps - before.comps,
      checklistRowsBefore: before.checklistRows,
      checklistRowsAfter: cur.checklistRows,
      checklistRowsDelta: cur.checklistRows - before.checklistRows,
      uncoveredBefore: before.uncovered,
      uncoveredAfter: cur.uncovered,
      uncoveredDelta: cur.uncovered - before.uncovered,
      coverageBefore: before.coverage,
      coverageAfter: cur.coverage,
    });
  }

  // Sort the movers by the work they represent, biggest improvement first.
  changed.sort((a, b) => a.uncoveredDelta - b.uncoveredDelta);
  closed.sort((a, b) => b.uncovered - a.uncovered);
  added.sort((a, b) => b.uncovered - a.uncovered);

  return {
    closed,
    added,
    changed,
    unchanged,
    baseline: false,
    priorDate,
    uncoveredClosed:
      closed.reduce((a, g) => a + g.uncovered, 0)
      + changed.reduce((a, d) => a + Math.max(0, -d.uncoveredDelta), 0),
    checklistRowsGained: changed.reduce((a, d) => a + Math.max(0, d.checklistRowsDelta), 0),
  };
}

/** One line for the email's "what moved" strip. Honest when nothing moved. */
export function diffHeadline(d: GapDiff): string {
  if (d.baseline) return "First run — no prior night to compare against; tonight is the baseline.";
  const bits: string[] = [];
  if (d.closed.length) bits.push(`${d.closed.length} closed`);
  if (d.added.length) bits.push(`${d.added.length} new`);
  if (d.changed.length) bits.push(`${d.changed.length} moved`);
  if (bits.length === 0) return `No change since ${d.priorDate ?? "the prior run"}.`;
  const tail = d.checklistRowsGained > 0
    ? ` · +${d.checklistRowsGained.toLocaleString("en-US")} checklist rows`
    : "";
  return `${bits.join(" · ")} since ${d.priorDate ?? "the prior run"}${tail}`;
}
