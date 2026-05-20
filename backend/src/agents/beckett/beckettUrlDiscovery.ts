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

  const out: DiscoveryAttempt[] = [];
  for (const variant of brandVariants) {
    for (const month of months) {
      for (const placement of SPORT_PLACEMENTS) {
        for (const suffix of suffixes) {
          const filename = renderFilename(input.year, variant, input.sport, placement, suffix);
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
  return out;
}

function renderFilename(
  year: number,
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
  return BRAND_VARIANTS[brand] ?? [brand];
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
