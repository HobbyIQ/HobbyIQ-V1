/**
 * Cardboard Connection Checklist Fetcher
 * ---------------------------------------------------------------------------
 * Authorization and provenance are documented in `backend/docs/data-sources.md`.
 *
 * Fetches WordPress-hosted checklist workbooks and validates ZIP magic bytes.
 * This module is intentionally conservative for WordPress hosting stability:
 * - 750ms minimum spacing between requests
 * - 30s per-attempt timeout
 * - 3 retries with exponential backoff
 * - full per-attempt logging
 */

import {
  discoverCardboardConnectionChecklistUrl,
  type CardboardConnectionDiscoveryResult,
} from "./cardboardConnectionUrlDiscovery.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const MIN_REQUEST_SPACING_MS = 750;

let lastRequestAtMs = 0;

export interface CardboardConnectionFetchInput {
  year: number;
  brand: string;
  sport: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Optional optimization for callers that already ran discovery. */
  resolvedUrl?: string;
  /** Optional discovery result for audit passthrough. */
  discoveryResult?: CardboardConnectionDiscoveryResult;
}

export interface CardboardConnectionFetchAttempt {
  url: string;
  status: number | "timeout" | "network-error";
  bytes: number;
  retry: number;
  errorMessage?: string;
}

export interface CardboardConnectionFetchResult {
  bytes: Uint8Array;
  url: string;
  discovery: CardboardConnectionDiscoveryResult;
  fetchAttempts: CardboardConnectionFetchAttempt[];
}

export class CardboardConnectionFetchError extends Error {
  readonly discovery: CardboardConnectionDiscoveryResult | null;
  readonly attempts: CardboardConnectionFetchAttempt[];

  constructor(
    message: string,
    discovery: CardboardConnectionDiscoveryResult | null,
    attempts: CardboardConnectionFetchAttempt[],
  ) {
    super(message);
    this.name = "CardboardConnectionFetchError";
    this.discovery = discovery;
    this.attempts = attempts;
  }
}

export async function fetchCardboardConnectionChecklist(
  input: CardboardConnectionFetchInput,
): Promise<CardboardConnectionFetchResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;

  const discovery =
    input.discoveryResult ??
    (input.resolvedUrl
      ? {
          success: true,
          url: input.resolvedUrl,
          attemptedUrls: [input.resolvedUrl],
          attempts: [],
          statusCode: 200,
        }
      : await discoverCardboardConnectionChecklistUrl({
          year: input.year,
          brand: input.brand,
          sport: input.sport,
        }));

  if (!discovery.success || !discovery.url) {
    throw new CardboardConnectionFetchError(
      `Cardboard Connection checklist not found for ${input.year} ${input.brand} ${input.sport}`,
      discovery,
      [],
    );
  }

  const fetchAttempts: CardboardConnectionFetchAttempt[] = [];
  for (let retry = 0; retry <= maxRetries; retry += 1) {
    await waitForRequestWindow();
    const got = await fetchOnce(discovery.url, timeoutMs);
    fetchAttempts.push({
      url: discovery.url,
      status: got.status,
      bytes: got.bytes?.byteLength ?? 0,
      retry,
      errorMessage: got.errorMessage,
    });

    console.log(
      `[ccFetcher] url=${discovery.url} status=${String(got.status)} bytes=${
        got.bytes?.byteLength ?? 0
      } retry=${retry}`,
    );

    if (got.bytes && looksLikeXlsx(got.bytes)) {
      return {
        bytes: got.bytes,
        url: discovery.url,
        discovery,
        fetchAttempts,
      };
    }

    // 404 is informational and not worth retrying forever; we still retry until
    // maxRetries to satisfy the explicit retry contract and absorb transient
    // WordPress edge-cache propagation windows.
    if (retry < maxRetries) {
      await sleep(DEFAULT_BACKOFF_MS * 2 ** retry);
    }
  }

  throw new CardboardConnectionFetchError(
    `Failed to download valid .xlsx for ${input.year} ${input.brand} ${input.sport}`,
    discovery,
    fetchAttempts,
  );
}

interface FetchOnceResult {
  status: number | "timeout" | "network-error";
  bytes: Uint8Array | null;
  errorMessage?: string;
}

async function fetchOnce(url: string, timeoutMs: number): Promise<FetchOnceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { status: res.status, bytes: null };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, bytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timeout = msg.includes("AbortError") || msg.includes("aborted");
    return {
      status: timeout ? "timeout" : "network-error",
      bytes: null,
      errorMessage: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRequestWindow(): Promise<void> {
  const now = Date.now();
  const waitMs = lastRequestAtMs + MIN_REQUEST_SPACING_MS - now;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastRequestAtMs = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}
