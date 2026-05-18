// SportsCardsPro / PriceCharting client.
//
// PriceCharting hosts the SportsCardsPro API. Auth is a `t=<token>` query
// param on every request. Token is loaded from process.env.SPORTSCARDSPRO_API_TOKEN
// and never logged.
//
// Docs (loose): https://www.pricecharting.com/api-documentation
// Base:         https://www.pricecharting.com
// Endpoints used by HobbyIQ:
//   GET /api/product   ?t=&id=         single product by SCP id
//   GET /api/product   ?t=&q=          single product by query (best-match)
//   GET /api/products  ?t=&q=          search (returns multiple)
//
// Prices in the JSON are integer cents (e.g. "loose-price": 4599 -> $45.99).

const BASE_URL = "https://www.pricecharting.com";
const DEFAULT_TIMEOUT_MS = 20_000;

export class SportsCardsProAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SportsCardsProAuthError";
  }
}

export class SportsCardsProRequestError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
    this.name = "SportsCardsProRequestError";
  }
}

function getToken(): string {
  const t = process.env.SPORTSCARDSPRO_API_TOKEN;
  if (!t || t.trim().length === 0) {
    throw new SportsCardsProAuthError(
      "SPORTSCARDSPRO_API_TOKEN is missing. Set it in backend/.env.harness-local for local dev, or in Azure App Settings for prod.",
    );
  }
  return t.trim();
}

/** Append `t=<token>` to a URLSearchParams instance without exposing the token elsewhere. */
function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const u = new URL(path, BASE_URL);
  u.searchParams.set("t", getToken());
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Scrub the `t=...` query param from any URL we might log or surface. */
function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("t")) u.searchParams.set("t", "REDACTED");
    return u.toString();
  } catch {
    return url.replace(/([?&])t=[^&]*/g, "$1t=REDACTED");
  }
}

async function getJson<T = unknown>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = buildUrl(path, params);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SportsCardsProRequestError(0, `network error GET ${scrubUrl(url)} -> ${msg}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SportsCardsProAuthError(
      `SportsCardsPro auth rejected (HTTP ${res.status}). Token may be invalid, expired, or the wrong subscription tier.`,
    );
  }
  if (!res.ok) {
    throw new SportsCardsProRequestError(res.status, `SportsCardsPro HTTP ${res.status} on ${scrubUrl(url)}`);
  }
  return (await res.json()) as T;
}

/** Response shape (subset) for /api/product. */
export interface ScpProduct {
  status: string;
  id?: string | number;
  "product-name"?: string;
  "console-name"?: string;
  "loose-price"?: number;
  "cib-price"?: number;
  "new-price"?: number;
  "manual-only-price"?: number;
  "box-only-price"?: number;
  "release-date"?: string;
  [key: string]: unknown;
}

/** Response shape (subset) for /api/products (search). */
export interface ScpProductsResponse {
  status: string;
  products?: ScpProduct[];
  [key: string]: unknown;
}

/** GET /api/product?id=<id> */
export async function getProductById(id: string | number): Promise<ScpProduct> {
  return getJson<ScpProduct>("/api/product", { id });
}

/** GET /api/product?q=<query> — best-match single product. */
export async function getProductByQuery(query: string): Promise<ScpProduct> {
  return getJson<ScpProduct>("/api/product", { q: query });
}

/** GET /api/products?q=<query> — search returning multiple products. */
export async function searchProducts(query: string): Promise<ScpProductsResponse> {
  return getJson<ScpProductsResponse>("/api/products", { q: query });
}

/** Public helper for logs — never returns the raw token. */
export const _internal = { scrubUrl };
