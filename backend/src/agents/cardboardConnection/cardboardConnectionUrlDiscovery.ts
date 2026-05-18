/**
 * Cardboard Connection URL Discovery
 * ---------------------------------------------------------------------------
 * Authorization and provenance are documented in `backend/docs/data-sources.md`.
 *
 * Discovers checklist URLs hosted on Cardboard Connection's WordPress uploads:
 *   https://www.cardboardconnection.com/wp-content/uploads/{YYYY}/{MM}/{file}.xlsx
 *
 * Constraints:
 * - Probe cap defaults to 36 URLs per tuple.
 * - 404 is informational and never throws.
 * - Keeps a full attempted URL list for audit.
 */

import { getBrandEntry } from "../beckett/brandRegistry.js";

const CC_UPLOAD_BASE = "https://www.cardboardconnection.com/wp-content/uploads";
const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_CC_MAX_PROBES = 36;
const DEFAULT_PROBE_SPACING_MS = 750;
const ALL_MONTHS: readonly string[] = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
];

const FILENAME_TEMPLATES: readonly string[] = [
  "{year}-{brand}-{sport}-checklist-Excel-spreadsheet.xlsx",
  "{year}-{brand}-{sport}-Checklist-Excel-spreadsheet.xlsx",
  "{year}-{brand}-{sport}-checklist.xlsx",
];

export interface CardboardConnectionDiscoveryInput {
  year: number;
  brand: string;
  sport: string;
  months?: readonly string[];
  timeoutMs?: number;
  maxProbes?: number;
  minSpacingMs?: number;
}

export interface CardboardConnectionDiscoveryAttempt {
  url: string;
  month: string;
  filename: string;
  status: number | "timeout" | "network-error";
  errorMessage?: string;
}

export interface CardboardConnectionDiscoveryResult {
  success: boolean;
  url: string | null;
  attemptedUrls: string[];
  attempts: CardboardConnectionDiscoveryAttempt[];
  statusCode: number | null;
}

export function enumerateCardboardConnectionCandidateUrls(
  input: CardboardConnectionDiscoveryInput,
): Array<{ url: string; month: string; filename: string }> {
  const months = input.months && input.months.length > 0 ? input.months : ALL_MONTHS;
  const brandVariants = resolveBrandVariants(input.brand);
  const sportVariants = resolveSportVariants(input.sport);
  const seriesVariants = resolveSeriesVariants(input.brand, brandVariants);

  const candidates: Array<{ url: string; month: string; filename: string }> = [];
  for (const month of months) {
    for (const brandVariant of brandVariants) {
      for (const seriesVariant of seriesVariants) {
        const fullBrand = [brandVariant, seriesVariant].filter(Boolean).join("-");
        for (const sportVariant of sportVariants) {
          for (const template of FILENAME_TEMPLATES) {
            const filename = template
              .replace("{year}", String(input.year))
              .replace("{brand}", fullBrand)
              .replace("{sport}", sportVariant);
            const url = `${CC_UPLOAD_BASE}/${input.year}/${month}/${filename}`;
            candidates.push({ url, month, filename });
          }
        }
      }
    }
  }

  // Keep order stable but dedupe duplicate URLs produced by overlapping variants.
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

export async function discoverCardboardConnectionChecklistUrl(
  input: CardboardConnectionDiscoveryInput,
): Promise<CardboardConnectionDiscoveryResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxProbes = Math.max(1, input.maxProbes ?? DEFAULT_CC_MAX_PROBES);
  const minSpacingMs = Math.max(0, input.minSpacingMs ?? DEFAULT_PROBE_SPACING_MS);
  const candidates = enumerateCardboardConnectionCandidateUrls(input).slice(0, maxProbes);

  const attempts: CardboardConnectionDiscoveryAttempt[] = [];

  for (const candidate of candidates) {
    await waitForProbeWindow(minSpacingMs);
    const probe = await headProbe(candidate.url, timeoutMs);
    const attempt: CardboardConnectionDiscoveryAttempt = {
      url: candidate.url,
      month: candidate.month,
      filename: candidate.filename,
      status: probe.status,
      errorMessage: probe.errorMessage,
    };
    attempts.push(attempt);

    if (typeof probe.status === "number" && probe.status === 200 && probe.looksLikeXlsx) {
      return {
        success: true,
        url: candidate.url,
        attemptedUrls: attempts.map((a) => a.url),
        attempts,
        statusCode: 200,
      };
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    success: false,
    url: null,
    attemptedUrls: attempts.map((a) => a.url),
    attempts,
    statusCode: last && typeof last.status === "number" ? last.status : null,
  };
}

let lastProbeAtMs = 0;
async function waitForProbeWindow(minSpacingMs: number): Promise<void> {
  const now = Date.now();
  const waitMs = lastProbeAtMs + minSpacingMs - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastProbeAtMs = Date.now();
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
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    const looksLikeXlsx =
      res.status === 200 &&
      (contentType.includes("spreadsheet") ||
        contentType.includes("application/octet-stream") ||
        contentType.includes("zip") ||
        contentLength > 1024);
    return { status: res.status, looksLikeXlsx };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timeout = msg.includes("AbortError") || msg.includes("aborted");
    return {
      status: timeout ? "timeout" : "network-error",
      looksLikeXlsx: false,
      errorMessage: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveBrandVariants(brand: string): readonly string[] {
  const entry = getBrandEntry(brand);
  if (entry?.cardboardConnectionUrlVariants?.length) {
    return entry.cardboardConnectionUrlVariants.map(slugifyToken);
  }
  if (entry?.urlVariants?.length) {
    return entry.urlVariants.map(slugifyToken);
  }
  return [slugifyToken(brand)];
}

function resolveSportVariants(sport: string): readonly string[] {
  const s = slugifyToken(sport);
  return [s];
}

function resolveSeriesVariants(brand: string, brandVariants: readonly string[]): readonly string[] {
  const isTopps = /topps/i.test(brand);
  const alreadySeriesSpecific = brandVariants.some((v) =>
    /(series-1|series-2|update)/i.test(v),
  );
  if (!isTopps || alreadySeriesSpecific) {
    return [""];
  }
  return ["", "Series-1", "Series-2", "Update"];
}

function slugifyToken(input: string): string {
  return input
    .trim()
    .replace(/&/g, "and")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
