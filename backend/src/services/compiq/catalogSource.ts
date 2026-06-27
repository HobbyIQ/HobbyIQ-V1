// ─────────────────────────────────────────────────────────────────────────────
// catalogSource.ts — vendor-neutral catalog/pricing data-source seam.
//
// CF-CARDSIGHT-REMOVAL Wave 3b (2026-06-27): Cardsight was fully removed as a
// data source. CardHedge (via cardsight.router.ts → cardhedge.client.ts) is the
// sole comp source. This module preserves the legacy type shapes and the
// runtime function signatures that the surviving graded-pricing / market-read /
// route consumers depend on, but every runtime function returns an EMPTY /
// "notFound" result — there is no external catalog source wired anymore.
//
// Why a seam instead of deleting the call sites: every consumer already handles
// the empty/`notFound` path (the live client returned exactly these shapes when
// the API key was absent), so routing them here degrades graded projections,
// card-image proxying, autocomplete, and import-resolve to graceful no-ops
// without touching their control flow. If a real catalog source is wired in the
// future, implement it here behind these same signatures.
//
// Type names retain the historical `Cardsight*` prefix purely to avoid a
// rename churn across ~6 consumer files; they describe generic catalog/pricing
// shapes and carry no vendor coupling.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Catalog / detail types ──────────────────────────────────────────────────

export interface CardsightCatalogResult {
  id: string;
  name: string;
  number: string;
  releaseName: string;
  setName: string;
  year: number;
  player?: string;
}

export interface CardsightParallel {
  id: string;
  name: string;
  numberedTo?: number;
}

export interface CardsightCardDetail {
  id: string;
  name: string;
  number: string;
  releaseName: string;
  setName: string;
  year: number;
  parallels: CardsightParallel[];
  attributes?: string[];
  /** Set to true when the card was not found. Never throws. */
  notFound?: boolean;
}

export interface CardsightSaleRecord {
  title: string;
  price: number;
  date: string | null;
  source: string;
  url: string | null;
  image_url?: string | null;
  parallel_id?: string | null;
  parallel_name?: string | null;
}

export interface CardsightGradedEntry {
  grade_value: string;
  count: number;
  records: CardsightSaleRecord[];
}

export interface CardsightGradedCompany {
  company_name: string;
  grades: CardsightGradedEntry[];
}

export interface CardsightPricingCard {
  card_id?: string;
  name?: string;
  number?: string;
  set?: {
    set_id?: string;
    name?: string;
    year?: string;
    release?: string;
  };
}

export interface CardsightPricingResponse {
  card?: CardsightPricingCard;
  raw: { count: number; records: CardsightSaleRecord[] };
  graded: CardsightGradedCompany[];
  meta: { total_records: number; last_sale_date: string | null };
  /** Set to true when the card was not found. Never throws. */
  notFound?: boolean;
  __parallelIdFilterFellBack?: boolean;
  freshness?: "fresh" | "stale";
}

export interface CardsightImageResponse {
  bytes: Buffer;
  contentType: string;
  /** Set when the upstream returned 404 / no source. */
  notFound?: boolean;
}

// ─── Resolve types (legacy mapper surface) ───────────────────────────────────

export interface CompIQQueryInput {
  playerName: string;
  cardYear?: string | number;
  product?: string;
  parallel?: string;
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: string;
  isAuto?: boolean;
}

export interface CardsightResolution {
  cardId: string | null;
  parallelId: string | null;
  matchConfidence: "exact" | "likely" | "none";
  warnings: string[];
}

// ─── Error types (retained for callers that branch on them) ──────────────────

export class CardsightApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "CardsightApiError";
  }
}

export class CardsightNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardsightNotFoundError";
  }
}

export class CardsightValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "CardsightValidationError";
  }
}

// ─── Runtime stubs (no external source — empty/`notFound` results) ────────────

const EMPTY_PRICING: CardsightPricingResponse = {
  raw: { count: 0, records: [] },
  graded: [],
  meta: { total_records: 0, last_sale_date: null },
};

/** Catalog search — no source wired; always empty. */
export async function searchCatalog(
  _query: string,
  _opts: { year?: string | number; take?: number } = {},
): Promise<CardsightCatalogResult[]> {
  return [];
}

/** Card detail — no source wired; returns a `notFound` shell so callers
 *  gracefully degrade (empty parallels / attributes). */
export async function getCardDetail(cardId: string): Promise<CardsightCardDetail> {
  return {
    id: cardId,
    name: "",
    number: "",
    releaseName: "",
    setName: "",
    year: 0,
    parallels: [],
    attributes: [],
    notFound: true,
  };
}

/** Card image proxy — no source wired; always `notFound`. */
export async function getCardImage(_cardId: string): Promise<CardsightImageResponse> {
  return { bytes: Buffer.alloc(0), contentType: "", notFound: true };
}

/** Type-ahead — no source wired; always empty. */
export async function autocompleteCards(
  _query: string,
  _opts: { take?: number } = {},
): Promise<string[]> {
  return [];
}

/** Pricing — no source wired; always `notFound` so market-read / graded
 *  projection paths skip cleanly. */
export async function getPricing(
  _cardId: string,
  _opts: { parallelId?: string } = {},
): Promise<CardsightPricingResponse> {
  return { ...EMPTY_PRICING, notFound: true };
}

/** Card-id resolve — no source wired; always "none". */
export async function resolveCardId(
  _input: CompIQQueryInput,
): Promise<CardsightResolution> {
  return {
    cardId: null,
    parallelId: null,
    matchConfidence: "none",
    warnings: ["catalog source removed"],
  };
}
