/**
 * Beckett URL Discovery Layer
 * ---------------------------------------------------------------------------
 * Phase A.2 sweep helper. The Phase A fetcher assumes you know the filename
 * shape; at sweep scale (2009–2026 × ~10 brands) you don't.
 *
 * This module enumerates the plausible URL candidates for a given
 * `(year, brand, sport)` tuple and HEAD-probes each one. The first probe that
 * returns a 200 + `.xlsx` content-type wins. Everything else (404s, brand
 * variants Beckett uses inconsistently, suffix permutations) is logged into
 * an audit trail so the orchestrator can tune the variant table over time.
 *
 * Out of scope here: actually downloading the file body — discovery returns
 * the matched URL and the orchestrator hands it to `fetchBeckettChecklist`
 * for the byte-level fetch.
 *
 * Beckett's S3 bucket allows anonymous HEAD requests; we use HEAD to keep the
 * probe cheap (no body transfer for misses).
 */

const S3_HOST = "https://beckett-www.s3.amazonaws.com";
const S3_PATH_PREFIX = "/news/news-content/uploads";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Default cap on total HEAD probes per (year, brand) tuple. Phase A.3 spec
 * targets ~24-72 probes per tuple before declaring a miss; cap is
 * configurable per-call.
 */
export const DEFAULT_MAX_PROBES = 72;

import { getBrandEntry } from "./brandRegistry.js";

/**
 * Sport placement variants. Beckett has been observed to publish baseball
 * checklists under three filename shapes:
 *
 *   `{year}-{Variant}-{Sport}-Checklist{suffix}.xlsx` — the common case
 *   `{year}-{Variant}-Checklist-{Sport}{suffix}.xlsx` — some Heritage, Topps
 *   `{year}-{Variant}-Checklist{suffix}.xlsx`         — sport omitted
 */
type SportPlacement = "prefix" | "suffix" | "omitted";
const SPORT_PLACEMENTS: readonly SportPlacement[] = ["prefix", "suffix", "omitted"];

/**
 * Canonical brand → list of variants Beckett has been observed to use in
 * filenames. The FIRST variant is always the preferred/canonical form.
 *
 * Phase A.3: when the brand is present in the brand registry, that
 * registry's `urlVariants` field takes precedence over this table. This
 * static map is kept as a fallback for ad-hoc brand strings.
 */
export const BRAND_VARIANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Bowman: ["Bowman"],
  "Bowman Chrome": ["Bowman-Chrome", "BowmanChrome", "Bowman-Chrome-HTA"],
  "Bowman Draft": ["Bowman-Draft", "Bowman-Chrome-Draft", "BowmanDraft", "Bowman-Draft-Picks-and-Prospects"],
  "Bowman Sterling": ["Bowman-Sterling", "BowmanSterling"],
  "Bowman Platinum": ["Bowman-Platinum", "BowmanPlatinum"],
  "Bowman's Best": ["Bowmans-Best", "Bowman-s-Best", "BowmansBest", "Bowmans-Best-Baseball"],
  "Bowman Mega": ["Bowman-Mega", "BowmanMega", "Bowman-Mega-Box"],
  "Bowman Inception": ["Bowman-Inception", "BowmanInception"],
  "Bowman Transcendent": ["Bowman-Transcendent", "BowmanTranscendent"],
  "Bowman Heritage": ["Bowman-Heritage", "BowmanHeritage"],
});

/**
 * Months tried in order. Front-loaded with release windows that match the
 * typical Bowman family upload cadence observed in the Phase A fixture
 * (April/May for flagship, September/October for Chrome/Draft, etc.).
 */
const ALL_MONTHS: readonly string[] = [
  "04", "05", "03", "09", "10", "06", "07", "08", "11", "12", "02", "01",
];

/** Filename suffix variants tried per (year, month, brand) combo. */
const SUFFIX_TRY_ORDER: readonly string[] = ["", "-2", "-3", "-4"];

export interface UrlDiscoveryInput {
  year: number;
  /** Canonical brand label — prefers `brandRegistry.urlVariants`, falls back to `BRAND_VARIANTS`. */
  brand: string;
  sport: string;
  /** Override default month sweep order. */
  months?: readonly string[];
  /** Override default suffix sweep. */
  suffixes?: readonly string[];
  /** Per-probe HEAD timeout. Defaults to 15s. */
  timeoutMs?: number;
  /** Cap on total probes (HEAD requests). Defaults to {@link DEFAULT_MAX_PROBES}. */
  maxProbes?: number;
}

export interface DiscoveryAttempt {
  url: string;
  brandVariant: string;
  month: string;
  suffix: string;
  /** Sport placement that produced this candidate filename. */
  sportPlacement: SportPlacement;
  /**
   * Legacy: `true` when sport was included in the filename (prefix or suffix
   * placement), `false` when omitted. Kept for backwards compatibility with
   * A.2 staged audit logs.
   */
  withSport: boolean;
  status: number | "timeout" | "network-error";
  errorMessage?: string;
}

export interface DiscoveryResult {
  success: boolean;
  /** Matched URL when `success === true`, else null. */
  url: string | null;
  /** Matched HTTP status when success, else best-effort last status. */
  statusCode: number | null;
  /** All probed URLs, in order — audit trail. */
  attempts: DiscoveryAttempt[];
  /** Brand variant that succeeded (or null on miss). */
  matchedBrandVariant: string | null;
  /** True when a non-primary brand variant won (signals table needs tuning). */
  matchedNonPrimaryVariant: boolean;
}

/**
 * Build every candidate URL for a tuple. Pure — no I/O. Useful for tests
 * and dry-runs.
 *
 * Resolution order:
 *   - Variant list is taken from `brandRegistry.getBrandEntry(brand).urlVariants`
 *     when present, otherwise from the static {@link BRAND_VARIANTS} map,
 *     otherwise `[brand]`.
 *   - Three sport placements are probed: `{Variant}-{Sport}-Checklist`,
 *     `{Variant}-Checklist-{Sport}`, and `{Variant}-Checklist` (sport omitted).
 *   - Probe order: variant outer → month → sport placement → suffix.
 */
export function enumerateCandidateUrls(input: UrlDiscoveryInput): DiscoveryAttempt[] {
  const brandVariants = resolveBrandVariants(input.brand);
  const months = input.months ?? ALL_MONTHS;
  const suffixes = input.suffixes ?? SUFFIX_TRY_ORDER;

  const yearTokens = yearTokensFor(input.year, input.sport);

  const out: DiscoveryAttempt[] = [];
  for (const variant of brandVariants) {
    for (const yearToken of yearTokens) {
      for (const month of months) {
        for (const placement of SPORT_PLACEMENTS) {
          // "omitted" does not interpolate the sport, so casing is irrelevant —
          // emitting both would just duplicate every probe and eat the cap.
          const casings = placement === "omitted" ? [input.sport] : sportCasings(input.sport);
          for (const sportCasing of casings) {
            for (const suffix of suffixes) {
              const filename = renderFilename(yearToken, variant, sportCasing, placement, suffix);
              const url = `${S3_HOST}${S3_PATH_PREFIX}/${input.year}/${month}/${filename}`;
              out.push({
                url,
                brandVariant: variant,
                month,
                suffix,
                sportPlacement: placement,
                withSport: placement !== "omitted",
                status: 0,
              });
            }
          }
        }
      }
    }
  }

  // CF-BECKETT-PROBE-ORDER (Drew, 2026-08-13). Adding season tokens tripled the
  // candidate space to ~1,700 per tuple, and the nested loops walk the EXOTIC
  // dimensions (suffix -2/-3/-4, sport placement, lowercase sport) before
  // finishing the months — so a real file in a late month sat past the probe
  // cap and was reported missing. Live example: 2024-25 Panini Prizm Basketball
  // exists at /2025/02/ and was still "not found" after 400 probes.
  //
  // Order by how Beckett actually names things instead: no suffix, sport as
  // prefix, capitalised sport. That shape covers essentially every observed
  // hit, so the common case now resolves within (yearTokens × months) probes —
  // ~36 — and the odd shapes remain reachable behind it rather than crowding
  // it out. Stable sort, so month/variant/season order is preserved inside a
  // tier.
  const tier = (a: DiscoveryAttempt): number =>
    (a.suffix === "" ? 0 : 4) +
    (a.sportPlacement === "prefix" ? 0 : a.sportPlacement === "suffix" ? 1 : 2);
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => tier(x.a) - tier(y.a) || x.i - y.i)
    .map(({ a }) => a);
}

/**
 * CF-BECKETT-SEASON-YEAR (Drew, 2026-08-13: "check for basketball football and
 * hocket, we need it").
 *
 * Basketball and hockey are SEASON-dated products — "2023-24 Panini Prizm
 * Basketball", "2024-25 O-Pee-Chee Hockey" — and Beckett names the file to
 * match. We only ever rendered a single year, so those files were never
 * enumerated and every basketball/hockey seed came back "no checklist
 * published". That is ~15,300 of the queue's demand written off as unservable
 * while the checklists were sitting there.
 *
 * Probed 2026-08-13, single-year vs season for the same product:
 *
 *   2024-Panini-Prizm-Basketball-Checklist.xlsx      not found
 *   2023-24-Panini-Prizm-Basketball-Checklist.xlsx   FOUND
 *   2024-25-Panini-Prizm-Basketball-Checklist.xlsx   FOUND
 *   2024-25-Topps-Chrome-Basketball-Checklist.xlsx   FOUND
 *   2024-25-O-Pee-Chee-Hockey-Checklist.xlsx         FOUND
 *
 * Baseball and football stay single-year (2024-Panini-Prizm-Football resolves),
 * so season tokens are added only for the season sports — otherwise every
 * baseball probe would triple for nothing and eat the probe cap.
 *
 * The plain year is emitted FIRST so single-year products still resolve in one
 * probe, and BOTH adjacent seasons are tried because a seed's `year` may be
 * either half of the season it came from. The upload-year folder stays
 * `input.year`, which is what actually hosts these: 2024-25 lives under /2025/.
 */
const SEASON_SPORTS = new Set(["basketball", "hockey"]);

export function yearTokensFor(year: number, sport: string): readonly string[] {
  const plain = String(year);
  if (!SEASON_SPORTS.has(String(sport ?? "").trim().toLowerCase())) return [plain];
  const yy = (y: number) => String(y % 100).padStart(2, "0");
  return [plain, `${year - 1}-${yy(year)}`, `${year}-${yy(year + 1)}`];
}

/**
 * CF-BECKETT-SPORT-CASE (Drew, 2026-08-13). S3 object keys are CASE-SENSITIVE,
 * and callers pass the sport in our canonical lowercase form ("baseball").
 * Beckett capitalises it in the filename, so every candidate was rendered as
 *
 *   2024-Bowman-Chrome-baseball-Checklist.xlsx     (probed, always 403/404)
 *   2024-Bowman-Chrome-Baseball-Checklist.xlsx     (the file that exists)
 *
 * and the real URL was never even enumerated — 432 candidates, 72 probes, zero
 * hits, for a file sitting at the first month the sweep would have tried.
 * Discovery could not succeed for ANY tuple, which is why the seed drainer
 * reported every release as "no checklist published".
 *
 * Both capitalisations are emitted rather than just the fixed one: the sweep is
 * cheap HEAD probes, and Beckett has not been perfectly consistent across
 * years. Capitalised goes first so the common case resolves in one probe.
 */
function sportCasings(sport: string): readonly string[] {
  const raw = String(sport ?? "").trim();
  if (!raw) return [""];
  const capitalised = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return capitalised === raw ? [raw] : [capitalised, raw];
}

function renderFilename(
  year: number | string,
  variant: string,
  sport: string,
  placement: SportPlacement,
  suffix: string,
): string {
  switch (placement) {
    case "prefix":
      return `${year}-${variant}-${sport}-Checklist${suffix}.xlsx`;
    case "suffix":
      return `${year}-${variant}-Checklist-${sport}${suffix}.xlsx`;
    case "omitted":
      return `${year}-${variant}-Checklist${suffix}.xlsx`;
  }
}

function resolveBrandVariants(brand: string): readonly string[] {
  const registryEntry = getBrandEntry(brand);
  if (registryEntry && registryEntry.urlVariants.length > 0) {
    return registryEntry.urlVariants;
  }
  const known = BRAND_VARIANTS[brand];
  if (known) return known;
  // CF-BECKETT-BRAND-SPACES (Drew, 2026-08-13). The fallback returned the brand
  // VERBATIM, so any brand absent from both the registry and BRAND_VARIANTS —
  // which is every Panini product — rendered a filename containing spaces:
  //
  //   2024-25-Panini Prizm-Basketball-Checklist.xlsx   (probed, never exists)
  //   2024-25-Panini-Prizm-Basketball-Checklist.xlsx   (the file that exists)
  //
  // BRAND_VARIANTS only covers the Bowman family, so the Bowman/Topps brands
  // resolved via the registry and hid this. Beckett hyphenates spaces in every
  // observed filename; emit that form first, and keep the raw string as a
  // fallback in case a brand genuinely contains no separator.
  const hyphenated = brand.trim().replace(/\s+/g, "-");
  return hyphenated === brand ? [brand] : [hyphenated, brand];
}

/**
 * Probe Beckett's S3 bucket with HEAD requests until a candidate returns 200
 * (and looks like an `.xlsx` by content-type/length). Returns the first
 * matching URL and the complete probe log.
 *
 * Failure semantics:
 *  - 404 on every candidate → `success: false`, no throw. This is normal:
 *    Bowman Mega 2009 just doesn't exist.
 *  - Network-level failures (DNS, timeout) on every candidate → `success:
 *    false`. These are surfaced in `attempts` for review.
 *  - We do NOT throw — the orchestrator decides what's an error.
 */
export async function discoverBeckettChecklistUrl(
  input: UrlDiscoveryInput,
): Promise<DiscoveryResult> {
  const allCandidates = enumerateCandidateUrls(input);
  const maxProbes = Math.max(1, input.maxProbes ?? DEFAULT_MAX_PROBES);
  const candidates = allCandidates.slice(0, maxProbes);
  const probed: DiscoveryAttempt[] = [];
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const brandVariants = resolveBrandVariants(input.brand);
  const primaryVariant = brandVariants[0]!;

  for (const candidate of candidates) {
    const result = await headProbe(candidate.url, timeoutMs);
    const attempt: DiscoveryAttempt = {
      ...candidate,
      status: result.status,
      errorMessage: result.errorMessage,
    };
    probed.push(attempt);

    if (typeof result.status === "number" && result.status === 200) {
      // Validate it looks like an xlsx (content-length sane, type correct).
      if (result.looksLikeXlsx) {
        const matchedNonPrimary = candidate.brandVariant !== primaryVariant;
        return {
          success: true,
          url: candidate.url,
          statusCode: 200,
          attempts: probed,
          matchedBrandVariant: candidate.brandVariant,
          matchedNonPrimaryVariant: matchedNonPrimary,
        };
      }
      // 200 but not an xlsx — keep probing, log it for the audit trail.
    }
  }

  return {
    success: false,
    url: null,
    statusCode:
      probed.length > 0 && typeof probed[probed.length - 1]!.status === "number"
        ? (probed[probed.length - 1]!.status as number)
        : null,
    attempts: probed,
    matchedBrandVariant: null,
    matchedNonPrimaryVariant: false,
  };
}

interface ProbeResult {
  status: number | "timeout" | "network-error";
  looksLikeXlsx: boolean;
  errorMessage?: string;
}

async function headProbe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    const contentType = res.headers.get("content-type") ?? "";
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    // S3 commonly returns "application/octet-stream" for xlsx — accept either
    // that, the canonical xlsx mime, or a sensible content-length (>1KB).
    const looksLikeXlsx =
      res.status === 200 &&
      (contentType.includes("application/octet-stream") ||
        contentType.includes("spreadsheetml") ||
        contentType.includes("application/vnd.openxmlformats") ||
        contentLength > 1024);
    return { status: res.status, looksLikeXlsx };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.includes("AbortError")) {
      return { status: "timeout", looksLikeXlsx: false, errorMessage: msg };
    }
    return { status: "network-error", looksLikeXlsx: false, errorMessage: msg };
  } finally {
    clearTimeout(timer);
  }
}
