/**
 * Beckett Checklist S3 Fetcher
 * ---------------------------------------------------------------------------
 * Downloads Beckett's publicly-hosted `.xlsx` checklist files from their
 * S3 bucket. Authorization for this use is recorded in
 * `backend/docs/data-sources.md` (owner-attested permission from Beckett).
 *
 * Source URL pattern:
 *   https://beckett-www.s3.amazonaws.com/news/news-content/uploads/
 *       {YYYY}/{MM}/{Year}-{Brand}-{Sport}-Checklist[-N].xlsx
 *
 * Both the upload month and the optional `-N` filename suffix vary across
 * sets, so this module tries plausible combinations and reports which URL
 * eventually returned a valid `.xlsx` payload. All attempts are logged.
 *
 * Phase A: fetch + return raw bytes only. No production writes.
 */

const S3_HOST = "https://beckett-www.s3.amazonaws.com";
const S3_PATH_PREFIX = "/news/news-content/uploads";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;

/**
 * Months Beckett most commonly uses for baseball checklist uploads. Tried in
 * this order when the caller does not pin `month`. Ordering reflects observed
 * release-window patterns (spring/early-summer for the flagship Bowman/Topps
 * baseball sets, later months for follow-on products).
 */
const DEFAULT_MONTH_TRY_ORDER: readonly string[] = [
  "04",
  "05",
  "03",
  "06",
  "07",
  "02",
  "08",
  "09",
  "10",
  "11",
  "12",
  "01",
];

/** Filename suffix variants. Bare first, then `-2`, `-3` re-uploads. */
const DEFAULT_SUFFIX_TRY_ORDER: readonly string[] = ["", "-2", "-3", "-4"];

export interface BeckettChecklistInput {
  /** 4-digit year, e.g. 2022. */
  year: number;
  /** Brand fragment as it appears in the URL, e.g. "Bowman", "Topps-Chrome". */
  brand: string;
  /** Sport fragment, e.g. "Baseball", "Football", "Basketball". */
  sport: string;
  /**
   * Optional override: 2-digit month string ("04") or array of months to try
   * in order. When omitted, falls back to {@link DEFAULT_MONTH_TRY_ORDER}.
   */
  month?: string | readonly string[];
  /**
   * Optional override: suffix string ("" / "-2") or array. When omitted,
   * tries bare → "-2" → "-3" → "-4".
   */
  suffix?: string | readonly string[];
  /** Override the default 30s per-attempt timeout. */
  timeoutMs?: number;
  /** Override the default 3 retries per URL. */
  maxRetries?: number;
}

export interface BeckettFetchAttempt {
  url: string;
  status: number | "timeout" | "network-error";
  bytes: number;
  attempt: number;
  retry: number;
  errorMessage?: string;
}

export interface BeckettFetchResult {
  /** Raw `.xlsx` bytes. */
  bytes: Uint8Array;
  /** The URL that finally returned a valid `.xlsx`. */
  url: string;
  /** Month and suffix tokens that succeeded. */
  month: string;
  suffix: string;
  /** Every URL attempted, in order, for full audit trail. */
  attempts: BeckettFetchAttempt[];
}

export class BeckettFetchError extends Error {
  readonly attempts: BeckettFetchAttempt[];
  constructor(message: string, attempts: BeckettFetchAttempt[]) {
    super(message);
    this.name = "BeckettFetchError";
    this.attempts = attempts;
  }
}

/**
 * Build the canonical URL for a given (year, month, brand, sport, suffix).
 */
export function buildBeckettChecklistUrl(args: {
  year: number;
  month: string;
  brand: string;
  sport: string;
  suffix: string;
}): string {
  const { year, month, brand, sport, suffix } = args;
  const filename = `${year}-${brand}-${sport}-Checklist${suffix}.xlsx`;
  return `${S3_HOST}${S3_PATH_PREFIX}/${year}/${month}/${filename}`;
}

function normalizeList(
  override: string | readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] {
  if (override === undefined) return fallback;
  if (typeof override === "string") return [override];
  if (override.length === 0) return fallback;
  return override;
}

/**
 * Fetch the checklist `.xlsx` for the given (year, brand, sport). Walks
 * candidate (month × suffix) combinations until one returns a non-empty
 * payload whose magic bytes match a ZIP container (`.xlsx` is a zip).
 *
 * Every attempt — including 404s and timeouts — is logged to stdout via
 * `[beckettFetcher]` so an owner reviewing logs can see exactly what was
 * tried. The full attempt list is also returned on success and attached to
 * `BeckettFetchError` on failure.
 */
export async function fetchBeckettChecklist(
  input: BeckettChecklistInput,
): Promise<BeckettFetchResult> {
  const {
    year,
    brand,
    sport,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = input;

  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new BeckettFetchError(`Invalid year: ${year}`, []);
  }
  if (!brand || typeof brand !== "string") {
    throw new BeckettFetchError(`Invalid brand: ${String(brand)}`, []);
  }
  if (!sport || typeof sport !== "string") {
    throw new BeckettFetchError(`Invalid sport: ${String(sport)}`, []);
  }

  const months = normalizeList(input.month, DEFAULT_MONTH_TRY_ORDER);
  const suffixes = normalizeList(input.suffix, DEFAULT_SUFFIX_TRY_ORDER);

  const attempts: BeckettFetchAttempt[] = [];
  let attemptCounter = 0;

  for (const month of months) {
    for (const suffix of suffixes) {
      attemptCounter += 1;
      const url = buildBeckettChecklistUrl({ year, month, brand, sport, suffix });

      const got = await fetchWithRetries({
        url,
        timeoutMs,
        maxRetries,
        attemptCounter,
        attempts,
      });

      if (got && looksLikeXlsx(got)) {
        console.log(
          `[beckettFetcher] OK url=${url} bytes=${got.byteLength} ` +
            `(${attempts.length} total attempt(s))`,
        );
        return { bytes: got, url, month, suffix, attempts };
      }
    }
  }

  const message =
    `Beckett checklist not found for ${year} ${brand} ${sport} ` +
    `after ${attempts.length} attempt(s). ` +
    `Tried months=[${months.join(",")}] suffixes=[${suffixes.join(",")}].`;
  console.warn(`[beckettFetcher] FAIL ${message}`);
  throw new BeckettFetchError(message, attempts);
}

async function fetchWithRetries(args: {
  url: string;
  timeoutMs: number;
  maxRetries: number;
  attemptCounter: number;
  attempts: BeckettFetchAttempt[];
}): Promise<Uint8Array | null> {
  const { url, timeoutMs, maxRetries, attemptCounter, attempts } = args;

  for (let retry = 0; retry <= maxRetries; retry += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      const status = res.status;

      if (!res.ok) {
        attempts.push({
          url,
          status,
          bytes: 0,
          attempt: attemptCounter,
          retry,
        });
        console.log(
          `[beckettFetcher] miss url=${url} status=${status} ` +
            `attempt=${attemptCounter} retry=${retry}`,
        );

        // 404 means this (month, suffix) combo simply doesn't exist —
        // no point retrying. Skip ahead to the next candidate.
        if (status === 404) return null;

        // For 5xx, fall through to backoff + retry.
        if (status >= 500 && retry < maxRetries) {
          await sleep(DEFAULT_BACKOFF_MS * 2 ** retry);
          continue;
        }
        return null;
      }

      const buf = new Uint8Array(await res.arrayBuffer());
      attempts.push({
        url,
        status,
        bytes: buf.byteLength,
        attempt: attemptCounter,
        retry,
      });
      console.log(
        `[beckettFetcher] hit  url=${url} status=${status} ` +
          `bytes=${buf.byteLength} attempt=${attemptCounter} retry=${retry}`,
      );
      return buf;
    } catch (err) {
      const isAbort =
        err instanceof Error && err.name === "AbortError";
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      attempts.push({
        url,
        status: isAbort ? "timeout" : "network-error",
        bytes: 0,
        attempt: attemptCounter,
        retry,
        errorMessage,
      });
      console.log(
        `[beckettFetcher] err  url=${url} ` +
          `kind=${isAbort ? "timeout" : "network-error"} ` +
          `attempt=${attemptCounter} retry=${retry} msg=${errorMessage}`,
      );

      if (retry < maxRetries) {
        await sleep(DEFAULT_BACKOFF_MS * 2 ** retry);
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `.xlsx` files are zip archives. A real `.xlsx` payload starts with the
 * ZIP local-file-header magic bytes `PK\x03\x04`. Reject anything else —
 * an HTML error page or a tiny placeholder will not match.
 */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return (
    bytes[0] === 0x50 && // 'P'
    bytes[1] === 0x4b && // 'K'
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}
