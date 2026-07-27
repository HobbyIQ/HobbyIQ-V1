// HobbyIQ web — backend fetch helper. Talks to the same Node/TS API
// that serves iOS. Session model is `x-session-id` header on every
// authenticated call; token is minted by /api/auth/signin and stored
// in localStorage (matches how iOS keeps its session token via
// Keychain — same wire contract).

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

const SESSION_KEY = "hobbyiq_session_id";

export function getStoredSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_KEY);
}

export function setStoredSessionId(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_KEY, id);
}

export function clearStoredSessionId(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
}

export interface AuthUser {
  userId: string;
  email: string;
  username?: string | null;
  fullName?: string | null;
  plan?: "free" | "collector" | "investor" | "pro_seller" | string;
  expiresAt?: string | null;
  entitlementOverride?: "free" | "collector" | "investor" | "pro_seller" | null;
}

// Backend contract (authService.AuthResult): { success, user?, sessionId?, error? }
// Note: /signin and /register return HTTP 200 EVEN ON FAILURE (bad creds return
// 200 with success:false + error). So gating on res.ok is not enough — must
// also check body.success.
interface AuthResponse {
  success: boolean;
  user?: AuthUser;
  sessionId?: string;
  error?: string;
}

export interface ApiError {
  status: number;
  code?: string;
  message: string;
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.auth !== false) {
    const sid = getStoredSessionId();
    if (sid) headers["x-session-id"] = sid;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      code: body.error ?? undefined,
      message: body.error ?? body.reason ?? res.statusText,
    };
    throw err;
  }
  return body as T;
}

function throwIfAuthFailed(body: AuthResponse): asserts body is AuthResponse & {
  success: true;
  sessionId: string;
  user: AuthUser;
} {
  if (!body.success || !body.sessionId || !body.user) {
    const err: ApiError = {
      status: 401,
      code: "auth_failed",
      message: body.error ?? "Invalid credentials",
    };
    throw err;
  }
}

// ─── Auth ──────────────────────────────────────────────────────────

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const body = await request<AuthResponse>("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    auth: false,
  });
  throwIfAuthFailed(body);
  setStoredSessionId(body.sessionId);
  return body.user;
}

export async function signUp(email: string, password: string): Promise<AuthUser> {
  const body = await request<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    auth: false,
  });
  throwIfAuthFailed(body);
  setStoredSessionId(body.sessionId);
  return body.user;
}

export async function fetchSessionUser(): Promise<AuthUser | null> {
  const sid = getStoredSessionId();
  if (!sid) return null;
  try {
    const res = await request<{ success: boolean; user?: AuthUser }>(
      "/api/auth/session",
    );
    return res.success && res.user ? res.user : null;
  } catch {
    clearStoredSessionId();
    return null;
  }
}

export async function signOut(): Promise<void> {
  const sid = getStoredSessionId();
  clearStoredSessionId();
  if (!sid) return;
  try {
    await request("/api/auth/signout", { method: "POST" });
  } catch {
    // best-effort server invalidation; local token already cleared
  }
}

// ─── Portfolio ─────────────────────────────────────────────────────

// Subset of the PortfolioHoldingWire shape (defined in
// backend/src/services/portfolioiq/responseAssembly.ts) — only fields
// the web dashboard actually reads. All money is dollars-float, per unit
// unless the field name says "total".
export interface PortfolioHolding {
  id: string;
  playerName?: string | null;
  cardTitle?: string | null;
  cardYear?: number | null;
  product?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  serialNumber?: string | null;
  isAuto?: boolean | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  quantity: number;
  purchasePrice?: number | null;
  purchaseDate?: string | null;
  purchaseSource?: string | null;
  totalCostBasis?: number | null;
  fairMarketValue?: number | null;   // per unit (observed FMV)
  currentValue?: number | null;      // fmv × qty; cost-proxy fallback when fmv null — do not trust as "value"
  totalProfitLoss?: number | null;
  totalProfitLossPct?: number | null;
  valuationStatus?: "observed" | "estimated" | "pending" | null;
  // Per-unit estimate when no observed FMV exists.
  estimatedValue?: number | null;
  estimateLow?: number | null;
  estimateHigh?: number | null;
  estimateBasis?: string | null;
  estimateConfidence?:
    | "estimate"
    | "rough"
    | "ballpark"
    | "no-data"
    | "insufficient"
    | null;
  // Backend-computed "what the UI should show" — combines observed FMV
  // and estimates and marks the source. Prefer this over currentValue.
  displayableValue?: number | null;
  displayableValueSource?: string | null;
  photos?: string[] | null;
  notes?: string | null;
  lastUpdated?: string | null;
}

// Prefer explicit fmv → estimate → null. NEVER fall back to cost-proxy
// for a display value; that's what caused the "$1539 value" bug where a
// PSA 10 estimated at $1531 was rendered as its $1539 cost basis.
export function holdingDisplayValue(h: PortfolioHolding): number | null {
  const qty = Math.max(1, h.quantity ?? 1);
  if (h.fairMarketValue != null) return h.fairMarketValue * qty;
  if (h.estimatedValue != null) return h.estimatedValue * qty;
  return null;
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  totalGainLoss: number;
  totalGainLossPct: number;
  cardCount: number;
  observedValue: number;
  estimatedValue: number;
  estimatedCount: number;
  pendingCount: number;
  observedPct: number;
  displayableTotalValue?: number;
  observedCostBasis?: number;
  observedGainLoss?: number;
  observedGainLossPct?: number;
}

export interface PortfolioResponse {
  success: boolean;
  userId: string;
  items: PortfolioHolding[];
  summary: PortfolioSummary;
}

export async function fetchPortfolio(): Promise<PortfolioResponse> {
  return await request<PortfolioResponse>("/api/portfolio/");
}

// ─── Market movers ─────────────────────────────────────────────────

// Matches shape returned by GET /api/compiq/market-trend/top-movers
// (compiq.routes.ts:2586). Delta shape is roughly:
//   { pct: number | null, absolute?: number | null, direction?: "up"|"down"|"flat", ... }
// but we treat it as loose because the exact interface isn't exported.
export interface MarketDelta {
  pct?: number | null;
  absolute?: number | null;
  direction?: "up" | "down" | "flat" | null;
  window?: string;
  currentValue?: number | null;
  priorValue?: number | null;
}

export interface MarketMover {
  playerName: string;
  delta: MarketDelta;
  confidence: "high" | "low" | "none";
}

export interface MarketMoversResponse {
  success: boolean;
  window: { selected: "1d" | "7d" | "30d"; pct30dLabel: string };
  limit: number;
  movers: MarketMover[];
  poolSize: number;
}

export async function fetchMarketMovers(
  window: "1d" | "7d" | "30d" = "7d",
  limit = 20,
): Promise<MarketMoversResponse> {
  return await request<MarketMoversResponse>(
    `/api/compiq/market-trend/top-movers?window=${window}&limit=${limit}`,
  );
}

// ─── Card search + FMV ─────────────────────────────────────────────

// Matches backend/src/types/cardIdentity.ts:CardIdentity — only the
// fields the web UI actually consumes.
export interface SearchCandidate {
  candidateId: string;  // e.g. "cardsight:<uuid>" or "psa:<cert>"
  source: string;
  attribution: "authoritative" | "ranked";
  confidence: number;
  player: string | null;
  year: number | null;
  brand: string | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  variation: string | null;
  isAuto: boolean;
  serialNumber: string | null;
  title: string;
  imageUrl: string | null;
  // Populated on cert-source candidates (PSA/BGS/SGC/CGC lookups) — the
  // graders return the card's slabbed grade + cert number authoritatively.
  // Absent on ranked catalog candidates.
  grade?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  certNumber?: string | null;
  parallels?: Array<{ id: string; name: string; numberedTo?: number | null }>;
  attributes?: string[];
}

export interface SearchResponse {
  success?: boolean;
  input: {
    raw: string;
    detectedMode: "cert" | "freetext";
    recognizingGraders?: string[];
  };
  candidates: SearchCandidate[];
  warnings: string[];
}

export async function searchCards(input: string, hint?: "cert" | "freetext"): Promise<SearchResponse> {
  return await request<SearchResponse>("/api/search/cards", {
    method: "POST",
    body: JSON.stringify({ input, ...(hint ? { hint } : {}) }),
  });
}

// price-by-id response is very rich; we type the fields the UI reads.
// Full type spans compiq.routes.ts:1261+. Money = dollars-float.
export interface PriceGradeBreakdownEntry {
  gradeCompany?: string;
  gradeValue?: number;
  count?: number;
  medianPrice?: number;
  meanPrice?: number;
  lastSalePrice?: number;
  lastSaleDate?: string;
  windowDays?: number;
}

export interface PriceGradedEstimate {
  gradeCompany: string;
  gradeValue: number;
  estimatedValue?: number | null;
  estimateLow?: number | null;
  estimateHigh?: number | null;
  fairMarketValue: null;  // always null per contract — display-only, not train
  estimateConfidence?: "estimate" | "rough" | "ballpark" | "no-data" | "insufficient" | null;
  estimateBasis?: string | null;
}

export interface PriceByIdResponse {
  success: boolean;
  cardsightCardId: string;
  summary?: string;
  marketTier?: { value?: number; high?: number };
  buyZone?: [number, number];
  holdZone?: [number, number];
  sellZone?: [number, number];
  fairMarketValueLive?: number | null;
  marketValue?: number | null;
  predictedPrice?: number | null;
  predictedPriceRange?: [number, number] | null;
  confidence?: number;
  approximate?: boolean;
  outOfScopeReason?: string | null;
  source?: string;
  recentComps?: Array<{
    price: number;
    soldDate: string;
    grader?: string | null;
    gradeValue?: number | null;
    parallel?: string | null;
    marketplace?: string;
    listingUrl?: string;
  }>;
  gradeBreakdown?: PriceGradeBreakdownEntry[];
  gradedEstimates?: PriceGradedEstimate[];
  cardImageUrl?: string | null;
  cardImageThumbUrl?: string | null;
  gradeUsed?: string | null;
  compsUsed?: number;
  compsAvailable?: number;
  daysSinceNewestComp?: number | null;
  lastSale?: {
    price?: number;
    soldDate?: string;
    grader?: string | null;
    gradeValue?: number | null;
  } | null;
}

export async function fetchPriceById(input: {
  cardsightCardId: string;
  gradeCompany?: string;
  gradeValue?: number;
  parallelName?: string;
}): Promise<PriceByIdResponse> {
  return await request<PriceByIdResponse>("/api/compiq/price-by-id", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Strip the "cardsight:" prefix from a search candidate id to get the
// UUID needed by price-by-id. Returns null for non-cardsight candidates.
export function candidateIdToCardsightId(candidateId: string): string | null {
  if (candidateId.startsWith("cardsight:")) return candidateId.slice("cardsight:".length);
  return null;
}

// ─── Account / settings ────────────────────────────────────────────

// GET /api/entitlements/me returns the resolved plan + features/caps.
// Full shape is broad; we type only what the settings page reads.
export interface EntitlementsMeResponse {
  success: boolean;
  plan: "free" | "collector" | "investor" | "pro_seller" | string;
  entitlementOverride?: "free" | "collector" | "investor" | "pro_seller" | null;
  features?: Record<string, boolean>;
  caps?: Record<string, unknown>;
}

export async function fetchEntitlements(): Promise<EntitlementsMeResponse> {
  return await request<EntitlementsMeResponse>("/api/entitlements/me");
}

export async function setUsername(username: string): Promise<{ success: boolean; error?: string }> {
  return await request<{ success: boolean; error?: string }>("/api/auth/username", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export async function deleteAccount(): Promise<{ success: boolean }> {
  return await request<{ success: boolean }>("/api/account/", {
    method: "DELETE",
    body: JSON.stringify({ confirm: "DELETE_MY_ACCOUNT" }),
  });
}

// ─── Portfolio mutations ───────────────────────────────────────────

export interface AddHoldingInput {
  playerName?: string;
  cardTitle?: string;
  cardYear?: number;
  product?: string;
  parallel?: string;
  cardNumber?: string;
  serialNumber?: string;
  isAuto?: boolean;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  quantity: number;
  purchasePrice?: number;
  purchaseDate?: string;
  purchaseSource?: string;
  notes?: string;
  cardsightCardId?: string;
  cardsightGradeId?: string;
}

export interface AddHoldingResult {
  success: boolean;
  id?: string;
  message?: string;
  error?: string;
}

// Backend returns { message: "Holding saved", id: "<uuid>" } on success,
// NOT { success: true }. request() throws on non-2xx HTTP, so any return
// from this function is a success by construction.
export async function addHolding(h: AddHoldingInput): Promise<AddHoldingResult> {
  const raw = await request<{ message?: string; id?: string; error?: string }>(
    "/api/portfolio/holdings",
    { method: "POST", body: JSON.stringify(h) },
  );
  // Defensively check for both shapes: modern { message, id } and any
  // legacy { success } if the route ever grew that field.
  const looksSaved = typeof raw.id === "string" || raw.message === "Holding saved";
  return {
    success: looksSaved,
    id: raw.id,
    message: raw.message,
    error: looksSaved ? undefined : raw.error,
  };
}

export async function fetchHolding(id: string): Promise<PortfolioHolding> {
  return await request<PortfolioHolding>(`/api/portfolio/holdings/${encodeURIComponent(id)}`);
}

export interface HoldingPricePoint {
  at: string;
  value: number;
  source?: string;
}

export async function fetchHoldingHistory(id: string): Promise<{ holdingId: string; count: number; points: HoldingPricePoint[] }> {
  return await request(`/api/portfolio/holdings/${encodeURIComponent(id)}/history`);
}

// Backend returns { message: "Holding updated", id, holding, entry } — NOT
// { success: true, holding }. Normalize so callers see the modern shape.
// request() throws on non-2xx, so a successful return is a success by
// construction.
export async function updateHolding(id: string, patch: Partial<AddHoldingInput>): Promise<{ success: boolean; holding?: PortfolioHolding; message?: string }> {
  const raw = await request<{ message?: string; id?: string; holding?: PortfolioHolding; entry?: { holding?: PortfolioHolding } }>(
    `/api/portfolio/holdings/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  const holding = raw.holding ?? raw.entry?.holding;
  return {
    success: typeof raw.id === "string" || raw.message === "Holding updated" || holding != null,
    holding,
    message: raw.message,
  };
}

export async function deleteHolding(id: string): Promise<{ success: boolean }> {
  return await request(`/api/portfolio/holdings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function sellHolding(id: string, salePrice: number, saleDate?: string): Promise<{ success: boolean }> {
  return await request(`/api/portfolio/holdings/${encodeURIComponent(id)}/sell`, {
    method: "POST",
    body: JSON.stringify({ salePrice, saleDate: saleDate ?? new Date().toISOString().slice(0, 10) }),
  });
}

// ─── Value history ─────────────────────────────────────────────────

export interface ValueHistoryResponse {
  success: boolean;
  asOf: string;
  totalDisplayable: number;
  rangeLow?: number;
  rangeHigh?: number;
  observedValue: number;
  estimatedValue: number;
  change30d?: { deltaValue?: number; deltaPct?: number };
  historySeries: Array<{ date: string; total: number }>;
}

export async function fetchValueHistory(): Promise<ValueHistoryResponse> {
  return await request<ValueHistoryResponse>("/api/portfolio/value-history");
}

// ─── Insights (weekly brief + sell radar + notable sales) ─────────

export interface WeeklyBriefMove {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  movePct: number;
  latestValue: number;
}

export interface WeeklyBriefResponse {
  period: string;
  generatedAt: string;
  headline: string;
  summary: {
    holdings: number;
    alerts: number;
    criticalAlerts: number;
    feedbackEvents?: number;
    recommendationFollowRatePct?: number;
  };
  topWinners?: WeeklyBriefMove[];
  topLosers?: WeeklyBriefMove[];
  recommendations?: string[];
}

export async function fetchWeeklyBrief(): Promise<WeeklyBriefResponse> {
  return await request<WeeklyBriefResponse>("/api/portfolio/insights/weekly-brief");
}

export interface SellRadarCandidate {
  holdingId: string;
  player: string;
  cardTitle: string;
  graderTier: string;
  currentMarketValue: number | null;
  purchasePrice: number | null;
  unrealizedGainUsd: number | null;
  velocityPerWeek: number;
  velocityBaseline: number;
  velocityMultiple: number;
  playerMomentum: number;
  playerDirection: "up" | "flat" | "down";
  reason: string;
  urgencyScore: number;
}

export interface SellRadarResponse {
  count: number;
  candidates: SellRadarCandidate[];
}

export async function fetchSellNowRadar(): Promise<SellRadarResponse> {
  return await request<SellRadarResponse>("/api/portfolio/sell-now-radar");
}

export interface NotableSale {
  cardId: string;
  player: string;
  year: number;
  cardSet: string;
  variant: string;
  number: string;
  grade: string;
  grader: string;
  price: number;
  saleDate: string;
  imageUrl: string;
  listingUrl: string;
  sourceLabel: "eBay" | "Goldin" | "Heritage" | "Fanatics Collect" | "Private" | null;
}

export interface NotableSalesResponse {
  count: number;
  sales: NotableSale[];
}

export async function fetchNotableSales(opts: { minPrice?: number; days?: number; limit?: number } = {}): Promise<NotableSalesResponse> {
  const params = new URLSearchParams();
  if (opts.minPrice != null) params.set("minPrice", String(opts.minPrice));
  if (opts.days != null) params.set("days", String(opts.days));
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const q = params.toString();
  return await request<NotableSalesResponse>(`/api/portfolio/notable-sales${q ? `?${q}` : ""}`);
}

// ─── eBay ──────────────────────────────────────────────────────────

export interface EbayStatus {
  success: boolean;
  connected: boolean;
  ebayUserId?: string;
  connectedUser?: string;
  connectedAt?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
}

export interface EbayAuthUrlResponse {
  success: boolean;
  authUrl: string;
  reconnected?: boolean;
}

export interface EbayPolicy {
  policyId?: string;
  name?: string;
  description?: string;
  [k: string]: unknown;
}

export interface EbayPoliciesResponse {
  success: boolean;
  paymentPolicies?: EbayPolicy[];
  returnPolicies?: EbayPolicy[];
  fulfillmentPolicies?: EbayPolicy[];
  locations?: unknown[];
}

export async function fetchEbayStatus(): Promise<EbayStatus> {
  return await request<EbayStatus>("/api/ebay/status");
}

export async function fetchEbayConnectUrl(): Promise<EbayAuthUrlResponse> {
  // ?platform=web tells the OAuth callback to redirect back to
  // /app/ebay?connected=true instead of the iOS hobbyiq:// deep link.
  return await request<EbayAuthUrlResponse>("/api/ebay/connect/start?platform=web");
}

export async function reconnectEbay(): Promise<EbayAuthUrlResponse> {
  return await request<EbayAuthUrlResponse>("/api/ebay/connect/restart?platform=web");
}

export async function disconnectEbay(): Promise<{ success: boolean }> {
  return await request("/api/ebay/disconnect", { method: "DELETE" });
}

export async function fetchEbayPolicies(): Promise<EbayPoliciesResponse> {
  return await request<EbayPoliciesResponse>("/api/ebay/policies");
}

// ─── eBay listing prepare + publish (per-holding) ─────────────────

export interface EbayListingPrepared {
  success: boolean;
  holdingId: string;
  identity: {
    playerName: string | null;
    cardYear: number | null;
    setName: string | null;
    parallel: string | null;
    cardNumber: string | null;
    isAuto: boolean;
    isRookie: boolean;
    team: string | null;
    sport: string | null;
  };
  condition: {
    isGraded: boolean;
    gradingCompany: string | null;
    grade: string | null;
    certNumber: string | null;
    conditionEstimate: string | null;
    conditionNotes: string | null;
  };
  categoryAspects: {
    league: string | null;
    type: string | null;
    countryOfManufacture: string | null;
    yearManufactured: number | null;
    season: number | null;
    language: string | null;
  };
  photos: string[];
  listing: {
    quantity: number;
    priceCents: number;
    bestOfferEnabled: boolean;
    bestOfferMinPriceCents: number | null;
    description: string;
    titleSuggested: string;
  };
  validation: {
    requiredMissing: string[];
    warnings: string[];
    readyToPublish: boolean;
  };
}

export interface EbayPublishResult {
  success: boolean;
  offerId?: string;
  listingId?: string;
  error?: string;
  requiredMissing?: string[];
}

export async function prepareEbayListing(holdingId: string): Promise<EbayListingPrepared> {
  return await request<EbayListingPrepared>("/api/ebay/listings/prepare", {
    method: "POST",
    body: JSON.stringify({ holdingId }),
  });
}

export async function publishEbayListing(
  payload: EbayListingPrepared,
): Promise<EbayPublishResult> {
  const {
    holdingId,
    identity,
    condition,
    categoryAspects,
    photos,
    listing,
  } = payload;
  return await request<EbayPublishResult>("/api/ebay/listings/publish", {
    method: "POST",
    body: JSON.stringify({
      holdingId,
      identity,
      condition,
      categoryAspects,
      photos,
      listing,
    }),
  });
}

// ─── Alerts ────────────────────────────────────────────────────────

export type PriceAlertDirection = "above" | "below";

export interface PriceAlertCardSnapshot {
  playerName: string;
  year?: number | null;
  setName?: string | null;
  cardNumber?: string | null;
  grade?: string | null;
  variant?: string | null;
  printRun?: number | null;
  isRookie?: boolean | null;
}

export interface PriceAlert {
  alertId: string;
  userId: string;
  cardId: string;
  playerName: string;
  targetPrice: number;
  direction: PriceAlertDirection;
  currentPrice: number | null;
  createdAt: string;
  triggeredAt: string | null;
  isActive: boolean;
  cardSnapshot: PriceAlertCardSnapshot | null;
}

export interface AlertPreferences {
  userId: string;
  dailyIQAlerts: boolean;
  priceAlerts: boolean;
  updatedAt: string | null;
}

export async function fetchAlerts(): Promise<{ success: boolean; alerts: PriceAlert[] }> {
  return await request("/api/alerts/");
}

export async function fetchAlertPreferences(): Promise<{ success: boolean; preferences: AlertPreferences }> {
  return await request("/api/alerts/preferences");
}

export async function updateAlertPreferences(patch: { dailyIQAlerts?: boolean; priceAlerts?: boolean }): Promise<{ success: boolean; preferences: AlertPreferences }> {
  return await request("/api/alerts/preferences", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function createPriceAlert(input: {
  cardId: string;
  playerName: string;
  targetPrice: number;
  direction: PriceAlertDirection;
  currentPrice?: number | null;
  cardSnapshot?: PriceAlertCardSnapshot | null;
}): Promise<{ success: boolean; alert?: PriceAlert }> {
  return await request("/api/alerts/", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deletePriceAlert(alertId: string): Promise<{ success: boolean }> {
  return await request(`/api/alerts/${encodeURIComponent(alertId)}`, {
    method: "DELETE",
  });
}

// ─── PlayerIQ ──────────────────────────────────────────────────────

export type PlayerIQDirection = "rising" | "falling" | "stable";
export type PlayerConfidence = "high" | "medium" | "low";

export interface PlayerMarketScore {
  marketScore: number;
  marketDirection: PlayerIQDirection;
  avgTrendPct: number;
  totalSamples: number;
  cardCount: number;
  topCardName: string | null;
  confidence: PlayerConfidence;
}

export interface PlayerPerformanceScore {
  performanceScore: number;
  performanceDirection: PlayerIQDirection;
  momentumRatio: number;
  statLine: string | null;
  statGroup: "hitting" | "pitching" | null;
  milestone: string | null;
  confidence: PlayerConfidence;
}

export interface PlayerScore {
  id: string;
  playerId: string;
  playerName: string;
  mlbPlayerId: number | null;
  team: string | null;
  position: string | null;
  league: "MLB" | "MiLB" | "unknown";
  level: string | null;
  market: PlayerMarketScore;
  performance: PlayerPerformanceScore;
  playerIQScore: number;
  playerIQLabel: string;
  playerIQDirection: PlayerIQDirection;
  updatedAt: string;
  dataSource: "realtime_estimate" | "nightly_job" | "manual_seed";
  confidence: PlayerConfidence;
}

export interface PlayerHistoryPoint {
  playerIQScore: number;
  playerIQDirection: PlayerIQDirection;
  playerIQLabel: string;
  marketScore: number;
  performanceScore: number;
  updatedAt: string;
  dataSource: string;
}

export interface PlayerHistoryResponse {
  playerName: string;
  playerId: string | null;
  points: PlayerHistoryPoint[];
  count: number;
}

export interface PlayerTopResponse {
  players: PlayerScore[];
  count: number;
  generatedAt: string;
}

export async function fetchPlayerByName(name: string): Promise<PlayerScore> {
  return await request<PlayerScore>(`/api/playeriq/${encodeURIComponent(name)}`);
}

export async function fetchPlayerHistory(name: string, limit = 30): Promise<PlayerHistoryResponse> {
  return await request<PlayerHistoryResponse>(`/api/playeriq/${encodeURIComponent(name)}/history?limit=${limit}`);
}

export async function fetchTopPlayers(opts: { limit?: number; direction?: PlayerIQDirection } = {}): Promise<PlayerTopResponse> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.direction) params.set("direction", opts.direction);
  const q = params.toString();
  return await request<PlayerTopResponse>(`/api/playeriq/top${q ? `?${q}` : ""}`);
}

// ─── DailyIQ ───────────────────────────────────────────────────────

export interface DailyPlayer {
  playerId: string;
  playerName: string;
  team?: string | null;
  position?: string | null;
  league?: string | null;
  onWatchlist?: boolean;
  headline?: string | null;
  movement?: { performanceDelta?: number | null; direction?: "up" | "down" | "flat" };
  imageUrl?: string | null;
}

export interface DailyBriefResponse {
  date: string;
  generatedAt?: string;
  lastUpdated?: string;
  mlb?: DailyPlayer[];
  milb?: DailyPlayer[];
  risers?: DailyPlayer[];
  fallers?: DailyPlayer[];
  breakouts?: DailyPlayer[];
  watchlist?: DailyPlayer[];
}

export async function fetchDailyBrief(): Promise<DailyBriefResponse> {
  return await request<DailyBriefResponse>("/api/dailyiq/brief");
}

// ─── Watchlist ─────────────────────────────────────────────────────

export interface WatchlistItem {
  watchlistItemId: string;
  playerId: string;
  playerName: string;
  team?: string | null;
  position?: string | null;
  league?: string | null;
  createdAt: string;
  onWatchlist?: boolean;
  movement?: { performanceDelta?: number | null; direction?: "up" | "down" | "flat" };
}

export interface WatchlistResponse {
  userId: string;
  date: string;
  count: number;
  watchlist: WatchlistItem[];
}

export async function fetchWatchlist(): Promise<WatchlistResponse> {
  return await request<WatchlistResponse>("/api/dailyiq/watchlist");
}

// Backend returns { message: "Added to watchlist", watchlistItemId, ... }
// on success, NOT { success: true }. request() throws on non-2xx.
export async function addWatchlist(
  args: { playerId?: string; playerName: string; league?: "MLB" | "MiLB" | "All" },
): Promise<{ success: boolean; watchlistItemId?: string; message?: string }> {
  const raw = await request<{ message?: string; watchlistItemId?: string; error?: string }>(
    "/api/dailyiq/watchlist",
    {
      method: "POST",
      body: JSON.stringify({
        playerId: args.playerId ?? "",
        playerName: args.playerName,
        ...(args.league ? { league: args.league } : {}),
      }),
    },
  );
  const looksSaved = typeof raw.watchlistItemId === "string" || raw.message === "Added to watchlist";
  return {
    success: looksSaved,
    watchlistItemId: raw.watchlistItemId,
    message: raw.message,
  };
}

// ─── Public marketing stats (unauthenticated) ─────────────────────

export interface PublicStats {
  soldCompsIndexed: number;
  cardsWithSlug: number;
  categories: number;
  sportsCovered: string[];
  vendorsIngested: string[];
  generatedAt: string;
}

export async function fetchPublicStats(): Promise<PublicStats> {
  return await request<PublicStats>("/api/stats/public", { auth: false });
}

// ─── Autocomplete (public suggest) ─────────────────────────────────

export interface SuggestionsResponse {
  query: string;
  suggestions: string[];
}

// GET /api/compiq/suggest is unauthenticated per compiq.routes.ts:674.
// Query length must be > 0; empty query returns { suggestions: [] }.
export async function fetchSuggestions(q: string, take = 8): Promise<SuggestionsResponse> {
  const query = q.trim();
  if (!query) return { query: "", suggestions: [] };
  return await request<SuggestionsResponse>(
    `/api/compiq/suggest?q=${encodeURIComponent(query)}&take=${take}`,
    { auth: false },
  );
}

export async function removeWatchlist(playerId: string): Promise<{ success: boolean }> {
  return await request(`/api/dailyiq/watchlist/${encodeURIComponent(playerId)}`, {
    method: "DELETE",
  });
}
