/**
 * CF-RELEASE-DECAY-PRIOR (2026-07-05, Drew):
 *
 * Product-lifecycle-aware prior on the trajectory rate for cards
 * that are less than 8 weeks post-release.
 *
 * The problem: a brand-new Bowman Chrome parallel (e.g., Roldy Brito
 * Blue X-Fractor Auto in 2026 Bowman Chrome, released ~3 weeks ago)
 * has hype-priced early sales that DON'T predict the mature market.
 * The card goes:
 *
 *   Week 0-2  (launch)      — hype premium, thin supply, prices peak
 *   Week 2-6  (supply)      — boxes get opened, prices drop
 *   Week 6-8  (baseline)    — supply/demand settles, price stabilizes
 *   Week 8+   (mature)      — price moves with player momentum
 *
 * Applying matched-cohort trend to a launch-week card projects the
 * launch spike FORWARD (wrong direction — market is about to decline
 * to baseline, not continue rising). Removing the rate cap (#287)
 * makes this worse for new releases.
 *
 * The fix: for cards in the first 8 weeks post-release, apply a
 * hand-tuned decay-rate prior. Blend with matched-cohort trend over
 * the transition weeks so week-8 seamlessly hands off to normal
 * trajectory logic.
 *
 * Drew's guidance (2026-07-05):
 *   - 8-week cutoff
 *   - Hand-tuned decay curve, calibrate over time as the corpus grows
 *
 * The schedule constants are the calibration target. As we accumulate
 * comparable release history in the corpus (grade-curve captures
 * persisted to Cosmos), we'll compare predicted-vs-actual weekly
 * medians and adjust each bucket's rate. For now these are informed
 * guesses based on hobby folklore + Bowman-family observation.
 */

/**
 * Approximate release dates for products we currently track. Values
 * are the widely-reported hobby-shop release date; the actual retail
 * street date can vary by a week. Precision isn't critical because
 * the decay curve itself is a rolling window — being off by a few
 * days shifts the applied rate by a small fraction of a percent.
 *
 * Expand this table as new products enter our engine's routing.
 * The key format is `<year>:<normalized-product>` where the product
 * is the lowercased/trimmed `set` field on the card. Bowman family
 * first (immediate need for Brito 2026 Blue X-Fractor).
 */
const RELEASE_DATES: Record<string, string> = {
  // ── 2026 releases ───────────────────────────────────────────────────
  // Bowman family
  "2026:bowman chrome": "2026-06-11",
  "2026:bowman chrome baseball": "2026-06-11",
  "2026:bowman": "2026-04-16",
  "2026:bowman baseball": "2026-04-16",
  "2026:bowman draft": "2026-12-10",
  "2026:bowman draft baseball": "2026-12-10",
  "2026:bowman draft chrome": "2026-12-10",
  "2026:bowman sterling": "2026-11-19",
  "2026:bowman platinum": "2026-08-27",
  "2026:bowman mega box": "2026-08-13",
  "2026:bowman's best": "2026-10-15",
  "2026:bowmans best": "2026-10-15",
  // Topps family
  "2026:topps series 1": "2026-02-11",
  "2026:topps series 1 baseball": "2026-02-11",
  "2026:topps series 2": "2026-06-10",
  "2026:topps series 2 baseball": "2026-06-10",
  "2026:topps update": "2026-10-14",
  "2026:topps update baseball": "2026-10-14",
  "2026:topps chrome": "2026-08-13",
  "2026:topps chrome baseball": "2026-08-13",
  "2026:topps chrome update": "2026-11-05",
  "2026:topps heritage": "2026-03-04",
  "2026:topps finest": "2026-09-24",
  "2026:topps stadium club": "2026-09-17",
  "2026:topps stadium club chrome": "2026-10-01",
  "2026:topps tier one": "2026-07-16",
  "2026:topps tribute": "2026-08-06",
  "2026:topps allen & ginter": "2026-07-09",
  "2026:topps allen and ginter": "2026-07-09",
  "2026:topps gypsy queen": "2026-04-30",
  "2026:topps gold label": "2026-11-12",
  // ── 2025 releases (kept so late-year lookups on prior-year new-adjacents work) ──
  // Bowman family
  "2025:bowman chrome": "2025-06-12",
  "2025:bowman chrome baseball": "2025-06-12",
  "2025:bowman": "2025-04-24",
  "2025:bowman baseball": "2025-04-24",
  "2025:bowman draft": "2025-12-11",
  "2025:bowman draft chrome": "2025-12-11",
  "2025:bowman sterling": "2025-11-20",
  "2025:bowman platinum": "2025-08-28",
  "2025:bowman mega box": "2025-08-14",
  "2025:bowman's best": "2025-10-16",
  "2025:bowmans best": "2025-10-16",
  // Topps family
  "2025:topps series 1": "2025-02-12",
  "2025:topps series 1 baseball": "2025-02-12",
  "2025:topps series 2": "2025-06-11",
  "2025:topps series 2 baseball": "2025-06-11",
  "2025:topps update": "2025-10-15",
  "2025:topps update baseball": "2025-10-15",
  "2025:topps chrome": "2025-08-14",
  "2025:topps chrome baseball": "2025-08-14",
  "2025:topps chrome update": "2025-11-06",
  "2025:topps heritage": "2025-03-05",
  "2025:topps finest": "2025-09-25",
  "2025:topps stadium club": "2025-09-18",
  "2025:topps stadium club chrome": "2025-10-02",
  "2025:topps tier one": "2025-07-17",
  "2025:topps tribute": "2025-08-07",
  "2025:topps allen & ginter": "2025-07-10",
  "2025:topps allen and ginter": "2025-07-10",
  "2025:topps gypsy queen": "2025-05-01",
  "2025:topps gold label": "2025-11-13",
  // ── Basketball (Panini) ─────────────────────────────────────────────
  // Panini is currently the primary NBA licensee — the license was
  // extended through 2025-26 season products, but Fanatics may take
  // over 2026-27+. Keep 2024-25 + 2025-26 season products only for now.
  "2024:panini prizm basketball": "2025-03-19",   // 2024-25 season, dropped Mar 2025
  "2025:panini prizm basketball": "2026-03-18",   // 2025-26 season, dropping Mar 2026
  "2024:panini select basketball": "2025-02-05",
  "2025:panini select basketball": "2026-02-04",
  "2024:panini donruss basketball": "2024-11-06", // 2024-25 season, dropped Nov 2024
  "2025:panini donruss basketball": "2025-11-05",
  "2024:panini national treasures basketball": "2025-04-30",
  "2025:panini national treasures basketball": "2026-04-29",
  "2024:panini mosaic basketball": "2025-01-22",
  "2025:panini mosaic basketball": "2026-01-21",
  "2024:panini optic basketball": "2025-01-08",
  "2025:panini optic basketball": "2026-01-07",
  // ── Football (Panini) ───────────────────────────────────────────────
  "2024:panini prizm football": "2024-11-27",
  "2025:panini prizm football": "2025-11-26",
  "2024:panini donruss football": "2024-08-21",
  "2025:panini donruss football": "2025-08-20",
  "2024:panini select football": "2024-12-11",
  "2025:panini select football": "2025-12-10",
  "2024:panini contenders football": "2025-05-14",
  "2025:panini contenders football": "2026-05-13",
  "2024:panini national treasures football": "2025-05-28",
  "2025:panini national treasures football": "2026-05-27",
  "2024:panini phoenix football": "2024-09-04",
  "2025:panini phoenix football": "2025-09-03",
  // ── Hockey (Upper Deck) ─────────────────────────────────────────────
  "2024:upper deck series 1 hockey": "2024-10-16",
  "2025:upper deck series 1 hockey": "2025-10-15",
  "2024:upper deck series 2 hockey": "2025-02-19",
  "2025:upper deck series 2 hockey": "2026-02-18",
  "2024:upper deck spx hockey": "2024-12-04",
  "2025:upper deck spx hockey": "2025-12-03",
  "2024:upper deck the cup hockey": "2025-08-06",
  "2025:upper deck the cup hockey": "2026-08-05",
};

/** Cutoff: cards older than this many weeks post-release use pure
 *  matched-cohort trend (release decay signal fully retired). */
const MAX_WEEKS_FOR_DECAY = 8;

/**
 * Piecewise decay schedule. Each row: "for weeks [prevMax, maxWeeks],
 * apply decayRatePerWeek with `blend` weight against matched-cohort".
 *
 * Rate values are NEGATIVE (this is a decay). blend=1.0 means pure
 * decay (ignore matched-cohort). blend=0.0 would mean pure matched-
 * cohort (schedule effectively silent).
 *
 * Trajectory transition: launch → mid-life → mature. Blend decays
 * from 1.0 at launch to 0.25 at week 8, then hands off completely.
 */
interface DecayBucket {
  maxWeeks: number;
  decayRatePerWeek: number;
  blend: number;
}
const DECAY_SCHEDULE: DecayBucket[] = [
  { maxWeeks: 2, decayRatePerWeek: -0.12, blend: 1.00 },
  { maxWeeks: 4, decayRatePerWeek: -0.08, blend: 0.75 },
  { maxWeeks: 6, decayRatePerWeek: -0.05, blend: 0.50 },
  { maxWeeks: 8, decayRatePerWeek: -0.02, blend: 0.25 },
];

export interface ReleaseDecayResult {
  /** Bounded per-week decay rate (negative). */
  decayRatePerWeek: number;
  /** Weight to apply when blending with matched-cohort trend (0-1).
   *  1.0 = use decay only. 0.0 = use matched-cohort only. Between:
   *  finalRate = decayRatePerWeek × blend + matchedCohortRate × (1 - blend). */
  blend: number;
  /** Weeks since release, rounded to 1 decimal. For telemetry. */
  weeksSinceRelease: number;
  /** Set-year key we matched (for telemetry — helps debug mismatches). */
  matchedKey: string;
}

function normalizeSetKey(year: number | string, setName: string): string {
  const y = String(year).trim();
  let s = setName.trim().toLowerCase().replace(/\s+/g, " ");
  // CH sometimes returns set names with the year prefixed
  // ("2026 bowman chrome"), sometimes without ("bowman chrome").
  // Strip a leading `<year> ` to normalize both shapes.
  const yearPrefix = new RegExp(`^${y}\\s+`);
  s = s.replace(yearPrefix, "");
  return `${y}:${s}`;
}

/**
 * Return the release-decay prior for a card, or null when:
 *   - year / set aren't provided
 *   - the set isn't in our release-date table (unknown product)
 *   - the card is older than MAX_WEEKS_FOR_DECAY (mature — pure trend)
 *   - the "release date" is in the future (year hasn't dropped yet)
 *
 * Silent no-throw. Returns null on any parse error.
 */
/**
 * Extracted pure computation: given a resolved release ISO date and
 * a "now", return the decay bucket that applies. Callers use this
 * from BOTH the sync hard-coded-table lookup AND the async auto-
 * detect fallback, so the decay curve stays canonical across both
 * discovery paths.
 */
function computeDecayFromReleaseDate(
  releaseIsoDate: string,
  matchedKey: string,
  now: Date,
): ReleaseDecayResult | null {
  const releaseMs = Date.parse(releaseIsoDate);
  if (!Number.isFinite(releaseMs)) return null;
  const nowMs = now.getTime();
  const daysSinceRelease = (nowMs - releaseMs) / (24 * 3600 * 1000);
  if (daysSinceRelease < 0) return null;
  const weeksSinceRelease = daysSinceRelease / 7;
  if (weeksSinceRelease >= MAX_WEEKS_FOR_DECAY) return null;
  for (const bucket of DECAY_SCHEDULE) {
    if (weeksSinceRelease < bucket.maxWeeks) {
      return {
        decayRatePerWeek: bucket.decayRatePerWeek,
        blend: bucket.blend,
        weeksSinceRelease: Math.round(weeksSinceRelease * 10) / 10,
        matchedKey,
      };
    }
  }
  return null;
}

export function getReleaseDecayForCard(
  year: number | string | null | undefined,
  setName: string | null | undefined,
  now: Date = new Date(),
): ReleaseDecayResult | null {
  if (!year || !setName) return null;
  if (typeof setName !== "string" || setName.trim().length === 0) return null;
  const key = normalizeSetKey(year, setName);
  const releaseIsoDate = RELEASE_DATES[key];
  if (!releaseIsoDate) return null;
  return computeDecayFromReleaseDate(releaseIsoDate, key, now);
}

/**
 * CF-RELEASE-AUTO-DETECT (2026-07-05, Drew): async variant that falls
 * back to the auto-detector when the set isn't in the hard-coded
 * RELEASE_DATES table. Extends decay coverage to long-tail products
 * automatically, without me having to maintain the table for every
 * regional / one-off release CH tracks.
 *
 * Order-of-operations:
 *   1. Sync hard-coded lookup (fast, deterministic, curated)
 *   2. Auto-detect via additions-summary (adds one CH call — cached
 *      30 days per set once the release date is found)
 *
 * Returns null when neither path yields a release date, or when the
 * card is > 8 weeks post-release. Silent no-throw.
 */
export async function getReleaseDecayForCardAsync(
  year: number | string | null | undefined,
  setName: string | null | undefined,
  now: Date = new Date(),
): Promise<ReleaseDecayResult | null> {
  const hardCoded = getReleaseDecayForCard(year, setName, now);
  if (hardCoded) return hardCoded;

  // Only try auto-detect when the sync lookup produced NO date. If it
  // produced a date but the card is >8wk post-release, respect that —
  // the auto-detect can't "unmature" a card just because we're missing
  // the set's key. Guard on year+set being provided (auto-detect
  // requires both).
  if (!year || !setName || typeof setName !== "string" || setName.trim().length === 0) {
    return null;
  }
  const key = normalizeSetKey(year, setName);
  // Was the key found in RELEASE_DATES? If yes, hard-coded returned
  // null for a reason (pre-release or past 8wk) — don't override.
  if (RELEASE_DATES[key]) return null;

  // Lazy-import to avoid circular dep — releaseAutoDetect ↔ releaseDecayPrior.
  const { detectReleaseDateForSet } = await import("./releaseAutoDetect.service.js");
  const detected = await detectReleaseDateForSet(year, setName, now).catch(() => null);
  if (!detected) return null;
  return computeDecayFromReleaseDate(detected, `${key}:auto`, now);
}

/** Test hook — exposes the table + schedule for calibration tooling
 *  without exporting mutable state. */
export const __testing__ = {
  RELEASE_DATES,
  DECAY_SCHEDULE,
  MAX_WEEKS_FOR_DECAY,
};
