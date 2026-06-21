// CF-CAT-ENGINE (2026-06-21): sale-title classifier — maps a Cardsight sale
// title to (parallel family, print run, base-auto-or-not). Same logic the
// CF-XMULT and CF-CAT-RECON probes used; promoted here to be the engine's
// single source of truth so probe / analyzer / generator all agree.
//
// CF-X3-clean: uses `\bx[-\s]?fractor\b/i` for the X-Fractor family
// (canonicalized in cardsight.mapper.tokenizeParallel).

export interface ClassifiedSale {
  /** Canonical tier key: "<Color> [<Finish>] <Family> /<printRun>". */
  tierKey: string;
  /** Canonical parallel name without print run (e.g. "Blue X-Fractor"). */
  parallelName: string;
  /** Numeric print run (e.g. 150). null when unparseable. */
  printRun: number | null;
  /** "X-Fractor" | "Refractor" | null (null = base auto). */
  family: "X-Fractor" | "Refractor" | null;
  /** True when this sale is the base-auto reference (unnumbered, no parallel finish). */
  isBaseAuto: boolean;
  /** True when the title contains an auto/autograph/CPA token. */
  isAutograph: boolean;
}

const AUTO_RE = /\b(auto|autograph|cpa|rookieauto|rcauto)\b/i;
const XFRACTOR_RE = /\bx[-\s]?fractors?\b/i;
const REFRACTOR_RE = /\brefractors?\b/i;
const PRINT_RUN_RE = /\/\s*(\d{1,4})\b/;
const ONE_OF_ONE_RE = /\b1\s*\/\s*1\b|\bone[\s-]of[\s-]one\b/i;

const COLORS = [
  "blue", "yellow", "orange", "black", "red", "green",
  "purple", "gold", "aqua", "pink", "fuchsia",
] as const;
type Color = typeof COLORS[number];

const FINISH_DETECTORS: Array<{ key: string; re: RegExp }> = [
  { key: "raywave", re: /\braywave\b/i },
  { key: "shimmer", re: /\bshimmer\b/i },
  { key: "wave", re: /\bwave\b/i },
  { key: "lava", re: /\blava\b/i },
  { key: "atomic", re: /\batomic\b/i },
  { key: "speckle", re: /\bspeckle\b/i },
  { key: "mojo", re: /\bmojo\b/i },
  { key: "hta", re: /\bhta\s+choice|\bchoice\s+refractor/i },
];

const BASE_AUTO_EXCLUSION_COLORS = new RegExp(
  `\\b(${COLORS.join("|")}|magenta|sky|atomic|raywave|mojo|hta|choice|shimmer|wave|lava|speckle|tiffany|sapphire|prizm|padparadscha|superfractor)\\b`,
  "i",
);

function detectColor(title: string): Color | null {
  for (const c of COLORS) if (new RegExp(`\\b${c}\\b`, "i").test(title)) return c;
  return null;
}

function detectFinish(title: string): string | null {
  for (const { key, re } of FINISH_DETECTORS) if (re.test(title)) return key;
  return null;
}

function getPrintRun(title: string): number | null {
  if (ONE_OF_ONE_RE.test(title)) return 1;
  const m = title.match(PRINT_RUN_RE);
  return m ? Number(m[1]) : null;
}

function toTitleCase(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

/**
 * The "isBaseAutoTitle" identity CF-XMULT pinned. A base auto is:
 *   - has an auto/autograph/CPA token, AND
 *   - no X-Fractor and no Refractor family token, AND
 *   - no numbered print run, AND
 *   - no color/finish token that would mark it as a colored parallel
 *
 * This identity must match across the probe, density-analyzer, and
 * worksheet-generator — sharing the function guarantees agreement.
 */
export function isBaseAutoTitle(title: string): boolean {
  if (!AUTO_RE.test(title)) return false;
  if (XFRACTOR_RE.test(title) || REFRACTOR_RE.test(title)) return false;
  if (/\/\s*\d{1,4}\b/.test(title)) return false;
  if (BASE_AUTO_EXCLUSION_COLORS.test(title)) return false;
  return true;
}

export function classifySale(title: string): ClassifiedSale {
  const isAutograph = AUTO_RE.test(title);
  const isXF = XFRACTOR_RE.test(title);
  const isRF = REFRACTOR_RE.test(title) && !isXF;

  if (isBaseAutoTitle(title)) {
    return {
      tierKey: "base-auto",
      parallelName: "Base Auto",
      printRun: null,
      family: null,
      isBaseAuto: true,
      isAutograph,
    };
  }

  if (!isXF && !isRF) {
    return {
      tierKey: "unclassified",
      parallelName: "Unclassified",
      printRun: null,
      family: null,
      isBaseAuto: false,
      isAutograph,
    };
  }

  const family: "X-Fractor" | "Refractor" = isXF ? "X-Fractor" : "Refractor";
  const color = detectColor(title);
  const finish = detectFinish(title);
  const printRun = getPrintRun(title);

  const parts: string[] = [];
  if (color) parts.push(toTitleCase(color));
  if (finish) parts.push(toTitleCase(finish));
  parts.push(family);
  const parallelName = parts.join(" ");
  const tierKey = `${parallelName} /${printRun ?? "??"}`;

  return {
    tierKey,
    parallelName,
    printRun,
    family,
    isBaseAuto: false,
    isAutograph,
  };
}
