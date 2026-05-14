/**
 * Snapshot diff — human-readable summary first, full JSON delta second.
 *
 * Reviewers should be able to triage a 1,000-case Tier 3 diff in two
 * minutes by reading the summary alone.
 */

export interface PathChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface PriceDelta {
  caseId: string;
  before: number | null;
  after: number | null;
  absDelta: number;
  pctDelta: number | null;
}

export interface DiffSummary {
  totalCases: number;
  changedCases: number;
  priceDeltas: PriceDelta[];
  magnitudeBuckets: {
    "<1%": number;
    "1-5%": number;
    "5-15%": number;
    "15-50%": number;
    ">50%": number;
    "now_null": number;
    "was_null": number;
  };
  topPriceDiffs: PriceDelta[];
  fieldChangeCounts: Record<string, number>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function diffObjects(
  before: unknown,
  after: unknown,
  basePath = ""
): PathChange[] {
  const changes: PathChange[] = [];
  if (Object.is(before, after)) return changes;

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of [...keys].sort()) {
      const childPath = basePath ? `${basePath}.${k}` : k;
      changes.push(...diffObjects(before[k], after[k], childPath));
    }
    return changes;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      changes.push({ path: `${basePath}.length`, before: before.length, after: after.length });
    }
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      changes.push(...diffObjects(before[i], after[i], `${basePath}[${i}]`));
    }
    return changes;
  }

  if (!Object.is(before, after)) {
    changes.push({ path: basePath || "$", before, after });
  }
  return changes;
}

function extractPrice(snapshot: unknown): number | null {
  if (!isPlainObject(snapshot)) return null;
  const candidates = [
    "fairMarketValue",
    "fairMarketValueLive",
    "effectiveFmv",
    "marketTier",
    "predicted_price_72h",
  ];
  for (const c of candidates) {
    const v = snapshot[c];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function bucketFor(pctDelta: number | null, before: number | null, after: number | null): keyof DiffSummary["magnitudeBuckets"] {
  if (before === null && after !== null) return "was_null";
  if (after === null && before !== null) return "now_null";
  if (pctDelta === null) return "<1%";
  const abs = Math.abs(pctDelta);
  if (abs < 0.01) return "<1%";
  if (abs < 0.05) return "1-5%";
  if (abs < 0.15) return "5-15%";
  if (abs < 0.5) return "15-50%";
  return ">50%";
}

export interface CasePair {
  caseId: string;
  before: unknown;
  after: unknown;
}

export function summarize(pairs: CasePair[]): DiffSummary {
  const summary: DiffSummary = {
    totalCases: pairs.length,
    changedCases: 0,
    priceDeltas: [],
    magnitudeBuckets: {
      "<1%": 0,
      "1-5%": 0,
      "5-15%": 0,
      "15-50%": 0,
      ">50%": 0,
      "now_null": 0,
      "was_null": 0,
    },
    topPriceDiffs: [],
    fieldChangeCounts: {},
  };

  for (const { caseId, before, after } of pairs) {
    const changes = diffObjects(before, after);
    if (changes.length === 0) continue;
    summary.changedCases++;
    for (const c of changes) {
      summary.fieldChangeCounts[c.path] = (summary.fieldChangeCounts[c.path] ?? 0) + 1;
    }
    const pBefore = extractPrice(before);
    const pAfter = extractPrice(after);
    if (pBefore !== pAfter) {
      const absDelta = Math.abs((pAfter ?? 0) - (pBefore ?? 0));
      const pctDelta =
        pBefore !== null && pBefore !== 0 && pAfter !== null
          ? (pAfter - pBefore) / pBefore
          : null;
      const delta: PriceDelta = {
        caseId,
        before: pBefore,
        after: pAfter,
        absDelta,
        pctDelta,
      };
      summary.priceDeltas.push(delta);
      summary.magnitudeBuckets[bucketFor(pctDelta, pBefore, pAfter)]++;
    }
  }

  summary.topPriceDiffs = [...summary.priceDeltas]
    .sort((a, b) => b.absDelta - a.absDelta)
    .slice(0, 10);

  return summary;
}

export function formatSummary(summary: DiffSummary): string {
  const lines: string[] = [];
  lines.push(`Cases compared: ${summary.totalCases}`);
  lines.push(`Cases changed:  ${summary.changedCases}`);
  if (summary.changedCases === 0) {
    lines.push("No diffs.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("Price magnitude distribution:");
  for (const [bucket, count] of Object.entries(summary.magnitudeBuckets)) {
    if (count > 0) lines.push(`  ${bucket.padEnd(10)} ${count}`);
  }
  lines.push("");
  lines.push("Top 10 largest price diffs:");
  for (const d of summary.topPriceDiffs) {
    const pct = d.pctDelta === null ? "n/a" : `${(d.pctDelta * 100).toFixed(1)}%`;
    lines.push(
      `  ${d.caseId.padEnd(40)} ${String(d.before).padStart(10)} -> ${String(d.after).padEnd(10)} (Δ${d.absDelta.toFixed(2)}, ${pct})`
    );
  }
  lines.push("");
  lines.push("Top changed fields:");
  const ranked = Object.entries(summary.fieldChangeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [path, count] of ranked) {
    lines.push(`  ${count.toString().padStart(4)}  ${path}`);
  }
  return lines.join("\n");
}
