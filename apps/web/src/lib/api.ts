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

export async function addHolding(h: AddHoldingInput): Promise<{ success: boolean; holding?: PortfolioHolding; error?: string }> {
  return await request("/api/portfolio/holdings", {
    method: "POST",
    body: JSON.stringify(h),
  });
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

export async function updateHolding(id: string, patch: Partial<AddHoldingInput>): Promise<{ success: boolean; holding?: PortfolioHolding }> {
  return await request(`/api/portfolio/holdings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
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

export async function addWatchlist(
  args: { playerId?: string; playerName: string; league?: "MLB" | "MiLB" | "All" },
): Promise<{ success: boolean }> {
  // Backend requires playerId OR playerName; when only playerName is
  // supplied, resolveAddablePlayer() maps it to a persistable playerId.
  // Some non-MLB players won't resolve — 404 handled by the caller.
  return await request("/api/dailyiq/watchlist", {
    method: "POST",
    body: JSON.stringify({
      playerId: args.playerId ?? "",
      playerName: args.playerName,
      ...(args.league ? { league: args.league } : {}),
    }),
  });
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
