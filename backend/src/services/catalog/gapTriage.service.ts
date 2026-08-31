/**
 * CF-GAP-DIGEST-TRIAGE (Drew, 2026-08-31: approved the nightly measure +
 * classify). Classifies every entry in the nightly checklist-gap report
 * BEFORE the digest email renders, so the list Drew reads is triaged rather
 * than raw.
 *
 * WHY. The gap report answers "which products do our sales need a checklist
 * for" honestly, but it cannot say WHY a product is on the list — and the
 * why decides who acts. Measured across the report's own history, the list
 * mixes four unrelated conditions that were being read as one work queue:
 *
 *   VOCAB-TWIN       we ALREADY OWN the checklist, under another setKey.
 *                    Fetching re-downloads what we hold and spends publisher
 *                    goodwill, while the real defect — a key nothing joins
 *                    on — survives untouched
 *                    ([[feedback_missing_checklist_is_usually_a_wrong_key]]:
 *                    of four remaining targets, THREE were already ours).
 *   UNRELEASED       the product does not exist yet. No source can publish a
 *                    checklist for a set that has not been printed.
 *   IMPOSSIBLE-COMPS a future release that nevertheless carries comps. A card
 *                    cannot sell before it exists, so the SLUG is wrong, not
 *                    the checklist — route to slug repair, never to
 *                    acquisition.
 *   UNREACHABLE      real, released, correctly keyed — and no wired lane
 *                    covers it. Dispatching acquisition burns a run to
 *                    discover that again.
 *
 * WHAT REMAINS after those four is DISPATCHABLE: a genuine hole a wired lane
 * can actually reach. That list is frequently EMPTY, and the digest says so
 * plainly rather than implying work exists — a headline that reads "12 gaps"
 * when all 12 are twins is how a report stops being read.
 *
 * ZERO WRITES. This module is pure: it takes gap entries and probe inputs and
 * returns tags. It reads no container and mutates nothing.
 */

import { productSetKeyForName, isProductSetKey, spellForEra } from "./productSetKeys.js";

/** One entry as checklist-gap-report.cjs emits it. */
export interface GapEntry {
  readonly sport: string;
  readonly year: number;
  readonly setKey: string;
  readonly comps: number;
  readonly distinctNumbers: number;
  readonly checklistRows: number;
  readonly coverage: number;
  readonly uncovered: number;
}

export type GapTag =
  | "VOCAB-TWIN"
  | "UNRELEASED"
  | "IMPOSSIBLE-COMPS"
  | "UNREACHABLE"
  | "DISPATCHABLE";

/** Where a tagged gap's work belongs. Only `acquire` is a checklist fetch. */
export type GapRoute = "none" | "slug-repair" | "vocab-repair" | "acquire" | "wait";

export interface GapTriageResult {
  readonly tag: GapTag;
  /** One sentence, rendered verbatim in the email. */
  readonly reason: string;
  readonly route: GapRoute;
  /** VOCAB-TWIN only: the setKey that actually holds the checklist. */
  readonly twinSetKey?: string;
  /** VOCAB-TWIN only: checklist-backed rows found under the twin. */
  readonly twinChecklistRows?: number;
  /** UNREACHABLE only: why no lane covers it. */
  readonly laneReason?: string;
}

export interface ClassifiedGap extends GapEntry, GapTriageResult {}

/**
 * A checklist-backed twin probe: given a candidate setKey, how many
 * CHECKLIST-BACKED catalog rows sit under it for this (sport, year)?
 *
 * Injected rather than queried here so this module stays pure and the
 * classifier is testable without Cosmos. The caller supplies the same
 * checklist-source filter the gap report itself uses — a vendor-row count
 * would resurrect exactly the inflation the report exists to defeat
 * (bowman-draft-chrome: 23,899 rows, ZERO checklist-backed).
 */
export type TwinProbe = (
  sport: string,
  year: number,
  candidateSetKey: string,
) => Promise<number>;

/**
 * Release-date probe. Returns the product's release date (ISO yyyy-mm-dd) when
 * a lane exposes it, or null when no lane does — null means UNKNOWN, never
 * "released" ([[feedback_every_ingest_uses_the_one_checklist_format]]: blank
 * means unknown). Callers that have no lane pass `noReleaseDateProbe`.
 */
export type ReleaseDateProbe = (
  sport: string,
  year: number,
  setKey: string,
) => Promise<string | null>;

export const noReleaseDateProbe: ReleaseDateProbe = async () => null;

/**
 * A twin candidate must beat the gap's own checklist count by this factor to
 * count as the real home of the product. A twin with the SAME thin coverage
 * is not a twin, it is the same hole spelled twice — and "we already own it"
 * is a claim that stops acquisition, so it has to be paid for in evidence.
 */
export const _TWIN_MIN_RATIO = 3;

/** A twin also needs this many checklist-backed rows outright, so a 0-vs-1
 *  comparison can never clear the ratio gate on noise. */
export const _TWIN_MIN_ROWS = 25;

/**
 * CF-LANE-REACHABILITY (measured 2026-08-25, [[reference_checklist_source_health]]).
 *
 * The static lane table. Each lane states the era/scope it can actually serve,
 * so a gap outside every lane is named UNREACHABLE instead of being dispatched
 * into a run that was always going to miss.
 *
 * cardboardconnection is DELIBERATELY ABSENT: the domain stopped resolving
 * 2026-08-17 and was re-confirmed dead 2026-08-22 (HTTP 000 from Drew's own
 * machine). It is still wired as rung 1 of the acquisition ladder, where it
 * costs a timeout and fails silently — counting it as coverage here would
 * relabel unreachable gaps as dispatchable and send Drew to a dead domain.
 */
export interface Lane {
  readonly name: string;
  /** Inclusive year floor, or null for no floor. */
  readonly minYear: number | null;
  /** Inclusive year ceiling, or null for no ceiling. */
  readonly maxYear: number | null;
  /** Sports served, or null for all. */
  readonly sports: readonly string[] | null;
  readonly note: string;
}

export const LANES: readonly Lane[] = [
  {
    name: "checklistinsider",
    minYear: 2022,
    maxYear: null,
    sports: null,
    note: "insider indexes 2022+ only",
  },
  {
    name: "hobbymonitor",
    minYear: 2024,
    maxYear: null,
    sports: null,
    note: "modern current-releases index (~100 entries), Panini-heavy",
  },
  {
    name: "baseballcardpedia",
    minYear: null,
    maxYear: null,
    sports: ["baseball"],
    note: "BCP is baseball-only",
  },
  {
    name: "beckett",
    minYear: null,
    maxYear: null,
    sports: null,
    note: "XLSX archive, current releases; the only vintage candidate",
  },
];

/** Every lane that can serve this (sport, year), by the static table. */
export function lanesFor(sport: string, year: number): Lane[] {
  const sp = String(sport ?? "").trim().toLowerCase();
  return LANES.filter((l) => {
    if (l.minYear !== null && year < l.minYear) return false;
    if (l.maxYear !== null && year > l.maxYear) return false;
    if (l.sports && !l.sports.includes(sp)) return false;
    return true;
  });
}

/**
 * The canonical spelling of this gap's setKey, or null when the vocabulary
 * does not rule on it. `spellForEra` applies the Donruss era ruling so a 1990
 * `panini-donruss` gap resolves to `donruss` rather than being called its own
 * twin (Panini did not own Donruss until 2009).
 */
export function canonicalTwinOf(setKey: string, year: number): string | null {
  const key = String(setKey ?? "").trim().toLowerCase();
  if (!key) return null;
  const spelled = productSetKeyForName(key);
  const candidate = spelled ? spellForEra(spelled, year) : spellForEra(key, year);
  if (!candidate || candidate === key) return null;
  // Only propose a candidate the vocabulary actually knows as a product.
  return isProductSetKey(candidate) ? candidate : null;
}

/** True when the release date lies strictly after `asOf` (both ISO dates). */
export function isFutureRelease(releaseDate: string | null, asOf: string): boolean {
  if (!releaseDate) return false;
  return releaseDate.slice(0, 10) > asOf.slice(0, 10);
}

export interface ClassifyOptions {
  readonly twinProbe: TwinProbe;
  readonly releaseDateProbe?: ReleaseDateProbe;
  /** ISO yyyy-mm-dd the run is judged against. */
  readonly asOf: string;
}

/**
 * Classify one gap. Order matters and is doctrine, not convenience:
 *
 *   1. IMPOSSIBLE-COMPS before UNRELEASED — same date probe, but comps on a
 *      future release CONTRADICT the date, and the contradiction is the more
 *      actionable finding (a wrong slug, routed to repair).
 *   2. VOCAB-TWIN before UNREACHABLE — a product we already own is not
 *      unreachable, and calling it unreachable hides an owned checklist
 *      behind a lane excuse.
 *   3. UNREACHABLE last among the negatives, so a reachable real hole falls
 *      through to DISPATCHABLE.
 */
export async function classifyGap(
  gap: GapEntry,
  opts: ClassifyOptions,
): Promise<ClassifiedGap> {
  const releaseProbe = opts.releaseDateProbe ?? noReleaseDateProbe;
  const releaseDate = await releaseProbe(gap.sport, gap.year, gap.setKey);
  const future = isFutureRelease(releaseDate, opts.asOf);

  // 1. A future release that already has sales. The card cannot have sold
  //    before it existed, so the comps are misfiled under this slug.
  if (future && gap.comps > 0) {
    return {
      ...gap,
      tag: "IMPOSSIBLE-COMPS",
      reason:
        `releases ${releaseDate} (after ${opts.asOf}) yet carries ${gap.comps.toLocaleString("en-US")} comps — `
        + `a card cannot sell before it exists, so the slug is wrong`,
      route: "slug-repair",
    };
  }

  // 2. Genuinely not out yet. Nothing to fetch and nothing to repair.
  if (future) {
    return {
      ...gap,
      tag: "UNRELEASED",
      reason: `releases ${releaseDate}, after ${opts.asOf} — no publisher can have a checklist yet`,
      route: "wait",
    };
  }

  // 3. Do we already own this product under another spelling?
  const twin = canonicalTwinOf(gap.setKey, gap.year);
  if (twin) {
    const twinRows = await opts.twinProbe(gap.sport, gap.year, twin);
    const beatsRatio = twinRows >= Math.max(_TWIN_MIN_ROWS, gap.checklistRows * _TWIN_MIN_RATIO);
    if (beatsRatio) {
      return {
        ...gap,
        tag: "VOCAB-TWIN",
        reason:
          `${twinRows.toLocaleString("en-US")} checklist-backed rows already sit under "${twin}" `
          + `vs ${gap.checklistRows.toLocaleString("en-US")} here — we own this checklist, under another key`,
        route: "vocab-repair",
        twinSetKey: twin,
        twinChecklistRows: twinRows,
      };
    }
  }

  // 4. Real, released, correctly keyed — but can any wired lane serve it?
  const lanes = lanesFor(gap.sport, gap.year);
  if (lanes.length === 0) {
    return {
      ...gap,
      tag: "UNREACHABLE",
      reason: `no wired lane covers ${gap.sport} ${gap.year} — acquisition would miss by construction`,
      route: "none",
      laneReason: LANES.map((l) => `${l.name}: ${l.note}`).join("; "),
    };
  }

  return {
    ...gap,
    tag: "DISPATCHABLE",
    reason:
      `${gap.uncovered.toLocaleString("en-US")} cards uncovered, reachable via `
      + `${lanes.map((l) => l.name).join(" / ")}`,
    route: "acquire",
  };
}

export interface TriageSummary {
  readonly asOf: string;
  readonly total: number;
  readonly byTag: Record<GapTag, number>;
  readonly gaps: readonly ClassifiedGap[];
  /** The only entries an acquisition dispatch should ever be handed. */
  readonly dispatchable: readonly ClassifiedGap[];
}

/** Classify a whole report. Sequential by design: the twin probe is a Cosmos
 *  query per candidate and the nightly list is tens of entries, not thousands. */
export async function classifyGaps(
  gaps: readonly GapEntry[],
  opts: ClassifyOptions,
): Promise<TriageSummary> {
  const out: ClassifiedGap[] = [];
  for (const g of gaps) out.push(await classifyGap(g, opts));
  const byTag: Record<GapTag, number> = {
    "VOCAB-TWIN": 0,
    UNRELEASED: 0,
    "IMPOSSIBLE-COMPS": 0,
    UNREACHABLE: 0,
    DISPATCHABLE: 0,
  };
  for (const g of out) byTag[g.tag]++;
  return {
    asOf: opts.asOf,
    total: out.length,
    byTag,
    gaps: out,
    dispatchable: out.filter((g) => g.tag === "DISPATCHABLE"),
  };
}

/**
 * The honest headline. When nothing is dispatchable it SAYS so — the count of
 * gaps is not the count of work, and a headline that conflates them trains
 * Drew to ignore the mail.
 */
export function triageHeadline(s: TriageSummary): string {
  if (s.total === 0) return "No gaps on the report.";
  const d = s.dispatchable.length;
  const cards = s.dispatchable.reduce((a, g) => a + g.uncovered, 0);
  if (d === 0) {
    const parts: string[] = [];
    if (s.byTag["VOCAB-TWIN"]) parts.push(`${s.byTag["VOCAB-TWIN"]} already ours under another key`);
    if (s.byTag["IMPOSSIBLE-COMPS"]) parts.push(`${s.byTag["IMPOSSIBLE-COMPS"]} misslugged`);
    if (s.byTag.UNRELEASED) parts.push(`${s.byTag.UNRELEASED} not released yet`);
    if (s.byTag.UNREACHABLE) parts.push(`${s.byTag.UNREACHABLE} unreachable by any wired lane`);
    return `Nothing to dispatch — all ${s.total} gaps triage away (${parts.join(", ")}).`;
  }
  return `${d} of ${s.total} gaps are dispatchable — ${cards.toLocaleString("en-US")} cards a wired lane can reach.`;
}
