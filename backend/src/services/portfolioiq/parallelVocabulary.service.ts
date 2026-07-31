// CF-PARALLEL-VOCABULARY (Drew, 2026-07-30). Loads the living
// parallel-vocabulary.json registry into memory (once, module-load
// time) and exposes typed accessors for the composite parallel
// parser + ladder validator.
//
// Registry format is documented in the JSON's own comments and in
// docs/parallel-vocabulary-reference.md. Confidence tiers:
//   verified  — safe to use as a promotion gate (auto-approve)
//   probable  — informational; may flag mismatches but never gate
//   unverified — flag-only; never used to promote or reject
//
// Longest-match-first is enforced at the aliases layer: aliases are
// sorted by length descending before matching, so "gold vinyl" always
// beats "gold" and "blue wave" always beats "blue".

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────

export type Confidence = "verified" | "probable" | "unverified";

export interface EditionEntry {
  canonical: string;
  aliases: string[];
  poolingRule: "isolate" | "merge";
  confidence: Confidence;
}

export interface ColorEntry {
  aliases: string[];
  confidence: Confidence;
  trap?: string;
  note?: string;
}

export interface FinishModifierEntry {
  aliases: string[];
  confidence: Confidence;
  channel?: string;
  premium?: string;
  note?: string;
}

export interface LadderTier {
  // Schema variance (expanded 2026-07-30 vocab): early Bowman/Topps
  // ladders use `color`; new basketball/football/premium ladders use
  // `name`. Accept either — accessor `tierKey(t)` normalizes.
  color?: string;
  name?: string;
  run: number | null | string;   // string for calendar-year/anniversary-number etc.
  confidence?: Confidence;
  note?: string;
  priceTierOverride?: string;
  sharesBaseNumber?: boolean;
}

/** Normalized tier key — accepts both `color` and `name` forms. */
export function tierKey(t: LadderTier): string {
  return String(t.color ?? t.name ?? "").toUpperCase();
}

export interface LadderEntry {
  appliesTo: string[];
  eraStart?: number;
  eraEnd?: number;
  poolingRule?: string;
  multiplierCohort?: string;
  tiers: LadderTier[];
}

export interface ParallelVocabulary {
  $schema: string;
  notes: string;
  editionTokens: Record<string, EditionEntry>;
  colorFamilies: Record<string, ColorEntry>;
  finishModifiers: Record<string, FinishModifierEntry>;
  ladders: Record<string, LadderEntry>;
  serialSemantics: {
    jerseyMatch: { action: string; neverAutoMultiply: boolean };
    firstSerial: { action: string };
    lastSerial: { action: string };
    oneOfOneHierarchy: string[];
    impossibleSerialForLadder: { action: string };
  };
  crossVendorVocabulary: {
    panini_to_topps_equivalents: Record<string, string>;
  };
  // CF-COMPOSITE-V3 (Drew, 2026-07-31). Optional in the schema — vocab
  // versions prior to v2 did not include eraRegistry. Consumers guard
  // for absence and fall back to null era.
  eraRegistry?: Record<string, {
    years: [number, number];
    parallelModel?: string;
    pricingAxis?: string;
  }>;
}

// ─── Loader ──────────────────────────────────────────────────────────

let _cache: ParallelVocabulary | null = null;

/** Load + validate the vocabulary. Cached per process. */
export function loadParallelVocabulary(): ParallelVocabulary {
  if (_cache) return _cache;
  // Prefer dist/data path when running from dist (backend compiled),
  // fall back to src-relative in dev. The copy-static-data-to-dist
  // build step mirrors backend/data → backend/dist/data.
  const candidates = [
    join(__dirname, "..", "..", "..", "data", "parallel-vocabulary.json"),
    join(__dirname, "..", "..", "data", "parallel-vocabulary.json"),
    join(process.cwd(), "backend", "data", "parallel-vocabulary.json"),
    join(process.cwd(), "data", "parallel-vocabulary.json"),
  ];
  let lastErr: Error | null = null;
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as ParallelVocabulary;
      // Minimal schema sanity: require the four registries.
      if (!parsed.editionTokens || !parsed.colorFamilies || !parsed.finishModifiers || !parsed.ladders) {
        throw new Error(`parallel-vocabulary.json at ${p} missing required top-level keys`);
      }
      _cache = parsed;
      return parsed;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw new Error(`parallel-vocabulary.json not found in any candidate path. Last error: ${lastErr?.message}`);
}

/** Reset the cache — for tests only. */
export function __resetParallelVocabularyForTests(): void {
  _cache = null;
}

// ─── Alias-index accessors ───────────────────────────────────────────

interface AliasIndex<T> {
  entries: Array<{ canonical: string; alias: string; value: T }>;
}

let _editionAliasIndex: AliasIndex<EditionEntry> | null = null;
let _colorAliasIndex: AliasIndex<ColorEntry> | null = null;
let _finishAliasIndex: AliasIndex<FinishModifierEntry> | null = null;

function buildAliasIndex<T extends { aliases: string[] }>(
  registry: Record<string, T>,
  canonicalKey: (k: string, v: T) => string,
): AliasIndex<T> {
  const entries: AliasIndex<T>["entries"] = [];
  for (const [key, value] of Object.entries(registry)) {
    for (const alias of value.aliases) {
      entries.push({ canonical: canonicalKey(key, value), alias: alias.toLowerCase(), value });
    }
  }
  // Longest-match-first ordering — mandatory per framework rules.
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return { entries };
}

/** Match a single alias from the edition registry against a lowercase
 *  title. Returns the canonical name (e.g., "SAPPHIRE") when found,
 *  null otherwise. Longest-match-first. */
export function matchEditionAlias(lowercaseTitle: string): { canonical: string; value: EditionEntry } | null {
  if (!_editionAliasIndex) {
    const vocab = loadParallelVocabulary();
    _editionAliasIndex = buildAliasIndex(vocab.editionTokens, (_k, v) => v.canonical);
  }
  for (const e of _editionAliasIndex.entries) {
    if (matchesAsWord(lowercaseTitle, e.alias)) return { canonical: e.canonical, value: e.value };
  }
  return null;
}

/** Same shape for color families — returns COLOR_UPPER_CASE key.
 *
 *  Two-pass: prefer any SPECIFIC color over the generic REFRACTOR
 *  fallback. This handles "Blue Wave Refractor" — BLUE wins over
 *  the standalone "refractor" alias even though both match. Without
 *  this, alphabetical/length ordering picks REFRACTOR because
 *  "refractor" appears as a word before "blue refractor" resolves. */
export function matchColorFamilyAlias(lowercaseTitle: string): { canonical: string; value: ColorEntry } | null {
  if (!_colorAliasIndex) {
    const vocab = loadParallelVocabulary();
    _colorAliasIndex = buildAliasIndex(vocab.colorFamilies, (k, _v) => k);
  }
  // Pass 1: specific colors only — skip entries where canonical is REFRACTOR
  // (fallback bucket). Still longest-match-first inside the specific set.
  for (const e of _colorAliasIndex.entries) {
    if (e.canonical === "REFRACTOR") continue;
    if (matchesAsWord(lowercaseTitle, e.alias)) return { canonical: e.canonical, value: e.value };
  }
  // Pass 2: REFRACTOR fallback (bare "refractor" as its own color tier).
  for (const e of _colorAliasIndex.entries) {
    if (e.canonical !== "REFRACTOR") continue;
    if (matchesAsWord(lowercaseTitle, e.alias)) return { canonical: e.canonical, value: e.value };
  }
  return null;
}

/** Same shape for finish modifiers. */
export function matchFinishModifierAlias(lowercaseTitle: string): { canonical: string; value: FinishModifierEntry } | null {
  if (!_finishAliasIndex) {
    const vocab = loadParallelVocabulary();
    _finishAliasIndex = buildAliasIndex(vocab.finishModifiers, (k, _v) => k);
  }
  for (const e of _finishAliasIndex.entries) {
    if (matchesAsWord(lowercaseTitle, e.alias)) return { canonical: e.canonical, value: e.value };
  }
  return null;
}

/** Word-boundary match: alias must be surrounded by word boundaries
 *  in the title to avoid false positives (e.g., "prizmania" shouldn't
 *  match "prizm"). Uses regex \b for word breaks; alias may itself
 *  contain internal spaces. */
function matchesAsWord(title: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\W)${escaped}($|\\W)`, "i");
  return re.test(title);
}

// ─── Ladder lookups ──────────────────────────────────────────────────

/** Find the ladder for a (productLine, year) tuple. Returns null when
 *  no ladder covers this combination — caller decides whether to
 *  allow-with-caveat or quarantine. */
export function findLadder(productLine: string, year: number | null | undefined): LadderEntry | null {
  const vocab = loadParallelVocabulary();
  const pl = String(productLine ?? "").toLowerCase();
  for (const entry of Object.values(vocab.ladders)) {
    const matchesProduct = entry.appliesTo.some(p => p.toLowerCase() === pl);
    if (!matchesProduct) continue;
    if (entry.eraStart && year != null && year < entry.eraStart) continue;
    if (entry.eraEnd && year != null && year > entry.eraEnd) continue;
    return entry;
  }
  return null;
}

/** Given (productLine, year, colorFamily, serialRun) validate against
 *  the known ladder. Returns:
 *    - matched-verified   → known tier at verified confidence
 *    - matched-probable   → known tier at probable/unverified confidence
 *    - no-ladder          → we have no ladder covering this product+era
 *    - color-not-in-ladder → color isn't in the ladder (rare/new color)
 *    - impossible-serial  → color IS in ladder but serialRun mismatches
 *    - unnumbered-ok / numbered-ok → serialRun matches null/numeric expectation */
export type LadderVerdict =
  | { verdict: "matched-verified"; tier: LadderTier }
  | { verdict: "matched-probable"; tier: LadderTier }
  | { verdict: "no-ladder" }
  | { verdict: "color-not-in-ladder" }
  | { verdict: "impossible-serial"; expectedRun: number | null | string; observedRun: number | null };

// CF-COMPOSITE-V3-ERA (Drew, 2026-07-31). Map a card year to its era
// key ("E0_vintage" | "E1_factory" | ... | "E4_modern"). Returns null
// when the vocab has no eraRegistry or the year falls outside every
// bucket. Consumers use the era to swap pricing axis
// (condition_grade_pop for vintage vs ladderCurves for modern) and to
// pick era-appropriate defaults elsewhere.
export function resolveEra(year: number | null | undefined): string | null {
  if (year == null || !Number.isFinite(year)) return null;
  const vocab = loadParallelVocabulary();
  const registry = vocab.eraRegistry;
  if (!registry) return null;
  for (const [key, entry] of Object.entries(registry)) {
    const [lo, hi] = entry.years;
    if (year >= lo && year <= hi) return key;
  }
  return null;
}

// CF-COMPOSITE-V3-PANINI-EQUIV (Drew, 2026-07-31). For a panini-*
// productLine, map the composite.colorFamily to the topps-side
// equivalent for cross-vendor pooling. E.g., a Panini Silver Prizm
// maps to REFRACTOR so it can pool with a Topps Chrome Refractor
// under the composite-neighbor axis-drop path. Returns null when the
// mapping is context-dependent (e.g., Panini "Mojo") or when the
// product isn't panini-* (Topps rows don't need remapping).
export function resolvePaniniColorEquivalent(
  productLine: string | null | undefined,
  colorFamily: string | null | undefined,
): string | null {
  if (!productLine || !colorFamily) return null;
  if (!/^panini/i.test(productLine)) return null;
  const vocab = loadParallelVocabulary();
  const map = vocab.crossVendorVocabulary?.panini_to_topps_equivalents;
  if (!map) return null;
  // Registry keys are human strings ("silver prizm"); the composite
  // colorFamily is uppercase canonical ("PRIZM"). Check by canonical
  // slugify — lowercase + hyphenate.
  const target = String(colorFamily).toLowerCase().replace(/_/g, " ");
  for (const [alias, equivalent] of Object.entries(map)) {
    if (String(alias).toLowerCase() === target) {
      // Filter out non-parallel meta keys like "note".
      if (equivalent === "context-dependent" || alias === "note") return null;
      return equivalent;
    }
  }
  return null;
}

export function validateAgainstLadder(
  productLine: string,
  year: number | null | undefined,
  colorFamily: string,
  serialRun: number | null,
): LadderVerdict {
  const ladder = findLadder(productLine, year);
  if (!ladder) return { verdict: "no-ladder" };
  const color = String(colorFamily ?? "").toUpperCase();
  const tier = ladder.tiers.find(t => tierKey(t) === color);
  if (!tier) return { verdict: "color-not-in-ladder" };

  const expected = tier.run;
  // Numeric equality check (with tolerance for the special string
  // markers "calendarYear" / "anniversaryNumber" that vary per year).
  if (typeof expected === "number") {
    if (serialRun === expected) {
      return tier.confidence === "verified"
        ? { verdict: "matched-verified", tier }
        : { verdict: "matched-probable", tier };
    }
    return { verdict: "impossible-serial", expectedRun: expected, observedRun: serialRun };
  }
  if (expected === null) {
    // Unnumbered tier — observed should be null.
    if (serialRun == null) {
      return tier.confidence === "verified"
        ? { verdict: "matched-verified", tier }
        : { verdict: "matched-probable", tier };
    }
    return { verdict: "impossible-serial", expectedRun: null, observedRun: serialRun };
  }
  // String marker (calendarYear / anniversaryNumber) — can't strictly
  // validate at this layer; return probable-match so caller doesn't
  // gate on it.
  return { verdict: "matched-probable", tier };
}
