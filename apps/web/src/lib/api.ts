// HobbyIQ web — backend fetch helper. Talks to the same Node/TS API
// that serves iOS. Session model is `x-session-id` header on every
// authenticated call; token is minted by /api/auth/signin and stored
// in localStorage (matches how iOS keeps its session token via
// Keychain — same wire contract).

// Exported so a caller that cannot use `request()` — funnelTelemetry.ts
// needs `keepalive` and a swallowed failure — still points at the same
// origin rather than resolving the base a second, drifting way.
export const API_BASE =
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
  publicShareEnabled?: boolean;
  stripeCustomerId?: string;
  stripeSubscriptionStatus?: string;
  // CF-EMAIL-VERIFICATION (Drew, 2026-07-27).
  emailVerified?: boolean;
  emailVerificationPending?: boolean;
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
  /**
   * CF-PRO-SELLER-WORKSPACE (2026-09-02). The tier the backend says this
   * call needs, lifted off the 402 body that `requireEntitlement` writes
   * ({ error: "subscription_required", requiredTier, currentTier, feature }).
   * Only present on entitlement rejections. Callers that render an upsell
   * can name the actual tier instead of guessing "Pro Seller" — the matrix
   * in backend/src/config/entitlements.ts is the one authority on which
   * tier owns which feature, and it has moved before.
   */
  requiredTier?: string | null;
  /** The gated feature key from the same 402 body, for telemetry/debugging. */
  feature?: string | null;
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.auth !== false) {
    const sid = getStoredSessionId();
    if (sid) headers["x-session-id"] = sid;
  }
  // CF-REQUEST-TIMEOUT (Drew, 2026-08-10). fetch() has no default
  // timeout — a hung server silently pinned every save-button to
  // "Saving…" forever (reported on BuyerIQ Add Target). 30s default
  // is generous for interactive routes; callers can override with
  // { timeoutMs } for known-slow operations.
  const timeoutMs = init.timeoutMs ?? 30_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: init.signal ?? ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // Aborted-by-timeout surfaces as AbortError; other network fails
    // as TypeError. Rethrow as our shape so upstream catch() handles
    // uniformly.
    const isAbort = (err as Error)?.name === "AbortError";
    const apiErr: ApiError = {
      status: isAbort ? 408 : 0,
      code: isAbort ? "timeout" : "network",
      message: isAbort
        ? `Request timed out after ${Math.round(timeoutMs / 1000)}s`
        : (err as Error)?.message ?? "Network error",
    };
    throw apiErr;
  }
  clearTimeout(timer);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      code: body.error ?? undefined,
      message: body.error ?? body.reason ?? res.statusText,
      // Additive: absent on every response that does not carry them, so
      // existing callers that only read status/code/message are unaffected.
      requiredTier: typeof body.requiredTier === "string" ? body.requiredTier : undefined,
      feature: typeof body.feature === "string" ? body.feature : undefined,
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

// Backend /api/auth/register requires a `username` matching
// [a-zA-Z0-9_.-]{3,30}. The web form doesn't ask for one — derive a
// valid handle from the email local-part, retry with a random suffix
// on the "Username already taken" collision. User can rename later
// from account settings (setUsernameForSession).
// CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). `acceptedTerms` records the
// user's agreement at the moment the account is created. The signup form
// will not submit without it, so it is always true here — it is an explicit
// parameter rather than a hardcoded literal so that a future caller which
// creates accounts some other way has to make the same decision on purpose.
export async function signUp(
  email: string,
  password: string,
  inviteCode?: string,
  acceptedTerms = true,
): Promise<AuthUser> {
  const baseUsername = deriveUsernameFromEmail(email);
  let username = baseUsername;
  const trimmedInvite = inviteCode?.trim() || undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = await request<AuthResponse>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          username,
          inviteCode: trimmedInvite,
          acceptedTerms,
        }),
        auth: false,
      });
      throwIfAuthFailed(body);
      setStoredSessionId(body.sessionId);
      return body.user;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "Username already taken" && attempt < 2) {
        const suffix = Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(0, 4) || "0001";
        username = `${baseUsername.slice(0, 25)}-${suffix}`;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Couldn't create a unique handle — try a different email.");
}

function deriveUsernameFromEmail(email: string): string {
  const localPart = (email.split("@")[0] ?? "").trim();
  const sanitized = localPart.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (sanitized.length >= 3) return sanitized.slice(0, 30);
  // Local part is too short or got sanitized to nothing (e.g. all `+`
  // or non-ASCII). Synthesize a valid handle they can rename later.
  const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(0, 6) || "user01";
  return `hiq-${rand}`;
}

export async function fetchSessionUser(): Promise<AuthUser | null> {
  const sid = getStoredSessionId();
  if (!sid) return null;
  try {
    const res = await request<{ success: boolean; user?: AuthUser }>(
      "/api/auth/session",
    );
    return res.success && res.user ? res.user : null;
  } catch (err) {
    // CF-SESSION-PERSIST (Drew, 2026-08-11). ONLY clear the stored
    // token when the server explicitly rejects it as invalid (401 /
    // 403). Prior behavior cleared on ANY error — transient 500s,
    // 429 throttles, network blips, or timeouts all logged the user
    // out and forced re-login. With Cosmos throttled by concurrent
    // bg work today, sessions were dying every few minutes.
    const status = (err as ApiError | undefined)?.status;
    if (status === 401 || status === 403) {
      clearStoredSessionId();
    }
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

// ─── PricingEnvelope (canonical) ────────────────────────────────────
//
// CF-PRICING-ENVELOPE (Drew, 2026-07-31). Mirror of
// backend/src/types/pricingEnvelope.ts. Kept in sync manually today;
// TODO(monorepo-shared-types): extract into packages/types/ so backend
// + web bind ONE source file. Until then, any change on either side
// MUST be mirrored.
//
// The canonical pricing surface iOS + web both bind to. Additive to
// the legacy flat fields on PortfolioHolding below — those flats
// remain during migration and will be deleted in a follow-up CF once
// both clients cut over.

export interface PricingEnvelope {
  headline: {
    value: number | null;
    valueSource: "observed" | "estimated" | "cost-proxy" | "unpriced";
    perUnit: number | null;
    quantity: number;
  };
  observed: {
    fairMarketValue: number | null;
    total: number | null;
  };
  estimate: {
    value: number | null;
    low: number | null;
    high: number | null;
    range: { low: number; high: number } | null;
    confidence: "estimate" | "rough" | "ballpark" | "no-data" | null;
    basisNote: string | null;
  } | null;
  method: {
    kind:
      | "direct-comp"
      | "cross-parallel"
      | "sibling"
      | "grade-cross-raw"
      | "composite-neighbor"
      | "ladder-fallback"
      | "our-pool"
      | "legacy-engine"
      | "cardhedge-last-sale"
      | "resolver-fallback"
      | "manual"
      | "unknown";
    label: string;
    ladderRung: string | null;
    compsUsed: number | null;
  };
  confidence: {
    pricing: number | null;
    liquidity: number | null;
    timing: number | null;
  };
  predicted: {
    value: number | null;
    range: { low: number; high: number } | null;
    mechanism: string | null;
    attribution: Record<string, unknown> | null;
    updatedAt: string | null;
  } | null;
  trend: {
    trendIQ: unknown | null;
    movementDirection: "up" | "down" | "flat" | null;
    broaderTrendPctPerMonth: number | null;
    updatedAt: string | null;
  };
  bands: {
    quickSale: number | null;
    premium: number | null;
    suggestedList: number | null;
    buyZone: [number, number] | null;
    holdZone: [number, number] | null;
    sellZone: [number, number] | null;
  } | null;
  provenance: {
    vendor:
      | "cardhedge"
      | "cardsight"
      | "hobbyiq-pool"
      | "ebay"
      | "manual"
      | null;
    vendorUpdatedAt: string | null;
    /** Which pipeline wrote the number. "unified-pricing" is the one
     *  valuation path's persist site (D17 holdingValuation.ts); its rung
     *  rides in `pricingSourceMeta.method`. */
    pricingSource: "our-pool" | "legacy-engine" | "unified-pricing" | "sibling-estimate" | null;
    pricingSourceMeta:
      | { slug: string; method: string; compsUsed: number }
      | null;
    /** CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03). The
     *  caveats this price must be read with, as the writer stamped them. */
    pricingLabels?: PricingLabel[];
    selfAnchored?: { own: number; total: number } | null;
    nearestGradedAnchor: {
      grade: string;
      price: number;
      daysOld: number;
      sampleSize: number;
      confidence: number;
    } | null;
    lastSaleSurface: {
      price: number;
      date: string | null;
      compCount: number;
    } | null;
    modelExpectation: unknown | null;
    modelSignal: unknown | null;
  };
  quality: {
    score: number | null;
    flaggedCompCount: number | null;
    sources: string[];
    freshness: "Live" | "Updated Today" | "Yesterday" | "Needs refresh";
    lastPricedAt: string | null;
  };
  composite: {
    era: string | null;
    colorFamily: string | null;
    finishModifier: string | null;
    edition: string | null;
    ladderVerdict: string | null;
    paniniColorEquivalent: string | null;
  } | null;
  population: {
    psa: { total: number; byGrade: Record<string, number> } | null;
    bgs: { total: number; byGrade: Record<string, number> } | null;
    sgc: { total: number; byGrade: Record<string, number> } | null;
    cgc: { total: number; byGrade: Record<string, number> } | null;
  } | null;
}

// Subset of the PortfolioHoldingWire shape (defined in
// backend/src/services/portfolioiq/responseAssembly.ts) — only fields
// the web dashboard actually reads. All money is dollars-float, per unit
// unless the field name says "total".
//
// Migration in progress (CF-PRICING-ENVELOPE, 2026-07-31): the flat
// legacy fields (fairMarketValue, estimatedValue, valuationStatus,
// etc.) remain during the migration window. New reads should prefer
// `pricing.*` — the flats stay populated by the backend for one
// release, then get deleted in a follow-up CF.
/** CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03). A caveat the
 *  reader is entitled to see beside a price. The codes are the backend's
 *  closed vocabulary (ebaySellDraft.service.ts `SellDraftLabel`); `text` is
 *  the sentence the sell draft uses, served verbatim so every surface says
 *  the same thing in the same words. */
export interface PricingLabel {
  code: "speculative" | "self-anchored" | "fallback-rung" | "low-confidence";
  text: string;
}

export interface PortfolioHolding {
  id: string;
  cardId?: string | null;   // legacy vendor/cardId — may diverge from hobbyiqCardId on old holdings (e.g. cardNumber prefix stripped). Prefer hobbyiqCardId for downstream queries.
  hobbyiqCardId?: string | null;   // canonical hiq: slug — always the source of truth for pricing/comps lookups when present.
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
  isEstimate?: boolean | null;
  /** D20. The rung that produced the holding's price surface, in the
   *  closed vocabulary (lib/rung.ts mirrors fmvRung.ts). Optional: the
   *  flat wire does not carry it today; read through `holdingProvenance()`
   *  which prefers the envelope's `method.ladderRung` /
   *  `provenance.pricingSourceMeta.method`. */
  fmvRung?: string | null;
  /** CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03). The caveats
   *  this holding's price must be read with — the SAME set the live
   *  canonical-fmv response carries for it, stamped at write time by the
   *  writer that decided the price.
   *
   *  Drew's ruling (2026-09-01): a self-comp PUBLISHES **and is LABELED**.
   *  Before this the label reached the card page and the sell draft and
   *  stopped, so a row showed a self-anchored $251 — the tier's only sale
   *  being the owner's own purchase — as an ordinary market read.
   *
   *  Absent / empty → no caveats, or a price surface predating the field. */
  pricingLabels?: PricingLabel[];
  /** The self-anchored ratio: `own` of the pool's `total` sales behind this
   *  price are the owner's. `own === total` is fully self-anchored. */
  selfAnchored?: { own: number; total: number } | null;
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
  certNumber?: string | null;
  // eBay link — populated after a successful publish. Used by the live-
  // listings surface on /app/ebay to render active listings + wire the
  // End/Revise actions per holding.
  ebayOfferId?: string | null;
  ebayListingId?: string | null;
  ebayListingPublishedAt?: string | null;
  lastUpdated?: string | null;
  // CF-STOREFRONT-OPT-IN (Drew, 2026-07-27 rev 2): explicit per-card
  // opt-in for the public /u/<username> storefront. Absent/false →
  // hidden; true → shown (subject to tier cap). Owner picks from
  // /app/storefront or the portfolio detail button.
  showOnStorefront?: boolean | null;
  // Legacy field kept for backward compat during reads. Do not gate
  // new UI on this — the storefront filter reads only showOnStorefront.
  hideFromStorefront?: boolean | null;
  // CF-IDENTITY-VERIFIED (Drew, 2026-07-27): true iff the owner has
  // explicitly picked a catalog candidate via the Confirm gate in the
  // Edit modal. Portfolio row shows a chip; follow-up PR can gate
  // storefront publication on this.
  identityVerified?: boolean | null;
  identityVerifiedAt?: string | null;
  identityVerifiedBy?: {
    source: string;
    candidateId: string;
    verifiedAt: string;
  } | null;
  /** CF-NEVER-AGAIN (Drew, 2026-09-02). Set by the nightly pricing invariant
   *  auditor when it could not reconcile this holding's persisted value with
   *  an independent re-derivation of the same pool. The row still shows the
   *  value — this only adds a subtle "under review" badge beside it. Cleared
   *  automatically on the next run that reconciles. */
  auditFlag?: {
    /** "<INVARIANT>: <kind>", e.g. "BASIS-IDENTITY: cross-product". */
    reason: string;
    at: string;
    invariant: string;
  } | null;
  /** CF-SURFACE-THE-PARKED-MATCH (2026-08-23). The catalog match the
   *  importer already found but did not pin, present ONLY when the holding
   *  has no identity of its own. 20 of 23 unidentified holdings carry one —
   *  the work of finding them was already done and thrown away at the glass.
   *  Confidence travels with it so a 0.72 can be presented differently from
   *  a 0.94 rather than implying the machine is certain. */
  proposedIdentity?: {
    slug: string;
    confidence?: number | null;
    matchedBy?: string | null;
  } | null;
  /** Why the holding is parked, in a sentence — written by the no-identity-
   *  no-price guard at the store door. */
  reviewReason?: string | null;
  needsReview?: boolean | null;
  /** CF-PRICING-ENVELOPE (Drew, 2026-07-31). Canonical pricing surface.
   *  Optional during the migration window — new endpoints emit it, older
   *  endpoints may still return only the legacy flat fields above.
   *  `holdingDisplayValue()` and any new UI should prefer `pricing.*`
   *  and fall back to the flats when null. See backend
   *  responseAssembly.ts for the source contract. */
  pricing?: PricingEnvelope | null;
  /** The sell-window timing call, derived server-side from the holding's own
   *  comp-pool trend against the player index. A TIMING signal, never a
   *  valuation — it says when the market may be ahead of this card, and the
   *  price it quotes is still the canonical FMV computed elsewhere.
   *
   *  Optional by design: this field arrives with the sell-window backend
   *  (open PR at time of writing), and until that deploys /api/portfolio
   *  answers 200 with the field simply absent. Consumers MUST treat absence
   *  as "capability not live" and render nothing, rather than as "no signal"
   *  — the two look identical on the wire but mean different things to a
   *  seller. The Pro Seller workspace does exactly that. */
  sellSignal?: {
    signal: "none" | "watch" | "sell-window" | "hold";
    horizon: "none" | "days-7-14" | "days-14-30";
    signalClass: "price" | "attention";
    /** One sentence with the numbers quoted. Show it verbatim — it is the
     *  basis, and paraphrasing it would drop the evidence. */
    basis: string;
    reason?: string | null;
    measures?: {
      playerIndexPct?: number | null;
      ownPoolPct?: number | null;
      divergencePct?: number | null;
      ownPoolSales?: number | null;
      trendAgeDays?: number | null;
      confidence?: number | null;
    } | null;
  } | null;
}

// CF-PRICING-ENVELOPE (2026-07-31). Envelope-first valuation status
// with legacy-flat fallback. Returns the canonical status the UI reads
// to decide badge treatment ("estimated" chip, "pending" chip, etc.).
// Envelope headline.valueSource maps: "observed"→"observed",
// "estimated"→"estimated", "cost-proxy"/"unpriced" → legacy fallback
// or null when neither is populated.
export function valuationStatusOf(
  h: PortfolioHolding,
): "observed" | "estimated" | "pending" | null {
  const src = h.pricing?.headline?.valueSource;
  if (src === "observed") return "observed";
  if (src === "estimated") return "estimated";
  // Envelope produced no real price → fall through to legacy.
  return h.valuationStatus ?? null;
}

// Envelope-preferred per-unit FMV. Same fallback ladder used by every
// UI site that wants "the observed FMV, or the estimate, or nothing".
// Returns null when the envelope declined AND legacy flats are null —
// the UI should render "—" or a pending state.
export function fmvPerUnitOf(h: PortfolioHolding): number | null {
  return (
    h.pricing?.observed?.fairMarketValue
    ?? h.pricing?.estimate?.value
    ?? h.fairMarketValue
    ?? h.estimatedValue
    ?? null
  );
}

// Prefer envelope headline → legacy fmv → legacy estimate → null.
// NEVER fall back to cost-proxy for a display value; that's what caused
// the "$1539 value" bug where a PSA 10 estimated at $1531 was rendered
// as its $1539 cost basis.
//
// CF-PRICING-ENVELOPE (2026-07-31): envelope prefers unified headline
// (observed → estimated → cost-proxy → unpriced). The cost-proxy tier is
// SKIPPED here to preserve the "never invent value" invariant — this
// helper returns null when the only signal is cost basis, and the UI
// renders "$—" or the pending badge instead.
export function holdingDisplayValue(h: PortfolioHolding): number | null {
  const qty = Math.max(1, h.quantity ?? 1);
  const envelope = h.pricing?.headline;
  if (envelope) {
    if (
      envelope.value != null
      && envelope.valueSource !== "cost-proxy"
      && envelope.valueSource !== "unpriced"
    ) {
      return envelope.value * (envelope.quantity ?? qty);
    }
    // Envelope present but declined to price — do not fall through to
    // legacy fields; the envelope is authoritative when populated.
    return null;
  }
  // Legacy fallback for endpoints not yet emitting the envelope.
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
  // CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): these values are always the last
  // persisted ones — this endpoint has never computed a price. Now that a
  // reprice can be running while this is served, the payload says so rather
  // than letting the UI present possibly-superseded numbers as current.
  valuation?: {
    /**
     * A background reprice is working on this user's holdings right now —
     * as seen by the worker that answered. CF-PORTFOLIO-FRESH-ON-OPEN
     * (2026-09-02): with 2 serving instances this can read false while a run
     * is alive on the other one, so the UI must not use it as the only
     * "is it refreshing" signal — it ORs it with its own dispatch state.
     */
    repricing: boolean;
    /** lastUpdated of the stalest holding, ISO-8601; null if none recorded. */
    oldestValuationAt: string | null;
    oldestValuationAgeMs: number | null;
    /** lastUpdated of the FRESHEST holding — the "as of" the UI shows. */
    newestValuationAt?: string | null;
    /** Durable cross-instance marker of the last dispatched reprice. */
    lastRepriceDispatchAt?: string | null;
  };
}

export async function fetchPortfolio(): Promise<PortfolioResponse> {
  return await request<PortfolioResponse>("/api/portfolio/");
}

// ─── Portfolio Breakdown ───────────────────────────────────────────
//
// CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). Allocation vs the HobbyIQ target
// mix, PortfolioIQ Score, risk, concentration, quality tiers, recommendations.
//
// The analysis is computed SERVER-SIDE (portfolioAnalytics.service.ts) rather
// than here on purpose: iOS renders the same screen, and a second copy of the
// scoring logic in TypeScript would drift from the Swift one. The web app's job
// is to render what it is handed.

export type PortfolioCategory =
  | "establishedGreatness" | "trueScarcity" | "eliteProspects" | "speculation";

export interface BreakdownAllocation {
  category: PortfolioCategory;
  label: string;
  blurb: string;
  currentShare: number;
  targetShare: number;
  value: number;
  cardCount: number;
  status: "onTarget" | "slightlyUnderweight" | "underweight" | "slightlyOverweight" | "overweight";
  driftPoints: number;
}

export interface BreakdownRiskMetric {
  name: string;
  score: number;
  polarity: "riskIsBad" | "strengthIsGood";
  level: "low" | "moderate" | "high";
  label: string;
  detail: string;
  isConcerning: boolean;
}

export interface BreakdownConcentration {
  dimension: string;
  displayName: string;
  label: string;
  share: number;
  value: number;
  cardCount: number;
  isWarning: boolean;
  guidance: string;
}

export interface BreakdownQualityBucket {
  tier: "cornerstone" | "strongHold" | "market" | "speculative";
  label: string;
  blurb: string;
  cardCount: number;
  value: number;
  valueShare: number;
}

export interface BreakdownRecommendation {
  kind: "allocation" | "concentration" | "quality" | "scarcity" | "consolidation" | "strength";
  title: string;
  detail: string;
  priority: number;
}

export interface BreakdownUpgrade {
  cardCount: number;
  combinedValue: number;
  lowValue: number;
  highValue: number;
  insight: string;
}

export interface PortfolioBreakdownResponse {
  userId: string;
  analyzedAt: string;
  totalValue: number;
  totalCost: number;
  totalProfitLoss: number;
  roi: number;
  cardCount: number;
  score: { value: number; tier: string; components: Array<{ name: string; score: number; weight: number }> };
  allocations: BreakdownAllocation[];
  risk: BreakdownRiskMetric[];
  concentrations: BreakdownConcentration[];
  qualityBuckets: BreakdownQualityBucket[];
  recommendations: BreakdownRecommendation[];
  upgradeOpportunities: BreakdownUpgrade[];
  /** Share of value whose print run could not be read. Rendered as a caveat so
   *  a thin-data portfolio does not read as a confident verdict. */
  unknownScarcityValueShare: number;
}

export async function fetchPortfolioBreakdown(): Promise<PortfolioBreakdownResponse> {
  return await request<PortfolioBreakdownResponse>("/api/portfolioiq/breakdown");
}

// ─── eBay sold sync ────────────────────────────────────────────────
//
// CF-EBAY-SOLD-SYNC-ON-DEMAND (Drew, 2026-08-17). pollEbayOrdersForUser has
// worked since the poll-based migration, but only the 1h scheduled job ever
// called it — so a user who just sold something waited up to an hour with no
// way to tell whether anything was happening. This is the same function the
// job calls, scoped to the caller, and idempotent (dedupes on order line items
// and advances a cursor), so pressing the button twice is safe.

export interface EbaySoldSyncResult {
  status: "ok" | "no-token" | "refresh-token-expired" | "fetch-failed";
  ordersFetched: number;
  lineItemsProcessed: number;
  matched: number;
  deduped: number;
  noMatchingHolding: number;
  markFailures: number;
  syncedAt: string;
}

export async function syncEbaySold(): Promise<EbaySoldSyncResult> {
  return await request<EbaySoldSyncResult>("/api/portfolioiq/ebay/sync-sold", { method: "POST" });
}

// ─── Custom allocation tiers ───────────────────────────────────────
//
// CF-CUSTOM-TIERS (Drew, 2026-08-17). A tier is a name, a target share, and
// rules deciding which holdings land in it. First match wins, in order, so the
// list is a priority statement the user controls — which is the only model that
// stays predictable once buckets overlap, and they always do.

export interface TierRule {
  printRunMax?: number;
  printRunMin?: number;
  yearMax?: number;
  yearMin?: number;
  graded?: boolean;
  isAuto?: boolean;
  productContains?: string;
  nameContains?: string;
  valueMin?: number;
  valueMax?: number;
}

export interface CustomTier {
  id: string;
  name: string;
  targetShare: number;
  rules: TierRule[];
  blurb?: string;
}

export async function fetchPortfolioTiers(): Promise<{ tiers: CustomTier[]; isCustom: boolean }> {
  return await request<{ tiers: CustomTier[]; isCustom: boolean }>("/api/portfolioiq/breakdown/tiers");
}

/** Pass an empty array to clear back to the HobbyIQ defaults. */
export async function savePortfolioTiers(tiers: CustomTier[]): Promise<{ tiers: CustomTier[]; isCustom: boolean }> {
  return await request<{ tiers: CustomTier[]; isCustom: boolean }>("/api/portfolioiq/breakdown/tiers", {
    method: "PUT",
    body: JSON.stringify({ tiers }),
  });
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

// CF-DAILY-PUBLISH: pre-computed twice-daily editorial snapshot. Server
// publishes at 5AM ET + 5PM ET; every read is a Cosmos point-read (fast
// + no auth required). Web pages hit this first and fall back to the
// live top-movers endpoint if the snapshot isn't available yet.
export interface MarketSnapshotResponse {
  success: boolean;
  snapshot: {
    id: "market";
    publishedAt: string;
    publishedSlot: "morning" | "evening";
    window: { selected: "7d"; pct30dLabel: string };
    topGainers: MarketMover[];
    topLosers: MarketMover[];
    poolSize: number;
    notableSales: NotableSale[];
  };
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshotResponse> {
  return await request<MarketSnapshotResponse>("/api/daily/market-snapshot", { auth: false });
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

// CF-CATALOG-FIRST product structure (Drew, 2026-08-04). Shared shape
// with iOS (see ProductOverviewModels.swift) — keep field names 1:1.
// Backed by the canonical card_catalog container.
export interface ProductParallel {
  section: string;
  name: string;
  printRun: number | null;
}
export interface ProductSubset {
  name: string;
  cardPrefix: string | null;
  parallelCount: number;
}
export interface ProductRelic {
  name: string;
  cardPrefix: string | null;
}
export interface ProductStructure {
  productKey: string;
  productName: string;
  sourcePage: string;
  year: number;
  sport: string;
  brand: string;
  setKey: string;
  parentSetKey: string | null;
  setName: string;
  parallels: ProductParallel[];
  inserts: ProductSubset[];
  autos: ProductSubset[];
  gameUsed: ProductRelic[];
  gimmicks: ProductRelic[];
  parallelCount: number;
  insertCount: number;
  autoCount: number;
  gameUsedCount: number;
  gimmickCount: number;
  fetchedAt: string;
  lastImportedAt: string;
}
export interface ProductListItem {
  productKey: string;
  productName: string;
  year: number;
  brand: string;
  setKey: string;
  parentSetKey: string | null;
  setName: string;
  parallelCount: number;
  insertCount: number;
  autoCount: number;
  gameUsedCount: number;
  gimmickCount: number;
}
export async function getProductStructure(productKey: string): Promise<ProductStructure> {
  const r = await request<{ success: boolean; product: ProductStructure }>(
    `/api/catalog/product-structure/${encodeURIComponent(productKey)}`,
  );
  return r.product;
}
export async function getProductStructureByYearSetKey(year: number, setKey: string): Promise<ProductStructure> {
  const r = await request<{ success: boolean; product: ProductStructure }>(
    `/api/catalog/product-structure?year=${year}&setKey=${encodeURIComponent(setKey)}`,
  );
  return r.product;
}
export async function listProductStructures(year: number, brand?: string): Promise<ProductListItem[]> {
  const qs = new URLSearchParams({ year: String(year) });
  if (brand) qs.set("brand", brand);
  const r = await request<{ success: boolean; count: number; products: ProductListItem[] }>(
    `/api/catalog/product-structure/list?${qs.toString()}`,
  );
  return r.products;
}

// CF-IDENTITY-VERIFIED (Drew, 2026-07-27). Preview FMV for a specific
// cardId at a specific grade — used by the Edit modal's Confirm gate so
// the user sees "PSA 10: $12,000 (24 comps)" next to a picker candidate
// before committing. Returns just the fields the preview UI needs;
// backend payload is much richer but we don't parse the whole thing.
export interface FmvPreviewResponse {
  success?: boolean;
  fmv?: number | null;
  currency?: string;
  compsCount?: number | null;
  gradeCompany?: string;
  gradeValue?: number;
  cardTitle?: string;
  cardImageUrl?: string | null;
}
export async function previewFmvForCard(input: {
  cardId: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  parallelName?: string | null;
}): Promise<FmvPreviewResponse> {
  return await request("/api/compiq/price-by-id", {
    method: "POST",
    body: JSON.stringify({
      cardId: input.cardId,
      ...(input.gradeCompany ? { gradeCompany: input.gradeCompany } : {}),
      ...(input.gradeValue != null ? { gradeValue: input.gradeValue } : {}),
      ...(input.parallelName ? { parallelName: input.parallelName } : {}),
    }),
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
  /** D16 (toPriceByIdResponse): every tier of the one-path curve rides
   *  here with its rung and whether it was observed or estimated. */
  rungLabel?: string | null;
  valueSource?: "observed" | "estimated" | "unavailable" | null;
  sampleCount?: number | null;
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
  /** D16: the rung (was canonical-fmv's METHOD). `no-recent-comps` when
   *  the engine declined — iOS's no-data check. */
  source?: string;
  /** D16/D17 (additive): the rung in the closed vocabulary, whether the
   *  headline is observed or estimated, and why there is none. */
  rungLabel?: string | null;
  valueSource?: "observed" | "estimated" | "unavailable" | null;
  fmvReason?: string | null;
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
  // CF-CARD-IDENTITY-FRONTEND (Drew, 2026-08-11). Backend enriches
  // hiq: slug responses with cardIdentity so the frontend can render
  // a proper title ("2018 Topps Update Shohei Ohtani #US285") instead
  // of falling back to the literal string "Card detail". Was missing
  // from the type interface, so the frontend never read it.
  cardIdentity?: {
    card_id?: string;
    player?: string | null;
    year?: number | null;
    set?: string | null;
    number?: string | null;
    parallel?: string | null;
    isAuto?: boolean;
    imageUrl?: string | null;
    sport?: string | null;
  };
  provenance?: { summary?: string };
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

// CF-QUERY-PRICE-LOOKUP (Drew, 2026-08-02). Used by the search page's
// catalog-fallback click-through — when a candidate has no vendor
// cardId, we POST the constructed query text to /api/compiq/price
// which runs the AI-matcher fallback and returns an identity block
// with the resolved card_id (if any). We only need cardIdentity for
// the redirect, so the rest of PriceByIdResponse is ignored here.
export interface PriceByQueryResponse {
  success: boolean;
  cardIdentity?: {
    card_id?: string | null;
    player?: string | null;
    year?: number | null;
    set?: string | null;
    number?: string | null;
    variant?: string | null;
  } | null;
}
export async function fetchPriceByQuery(query: string): Promise<PriceByQueryResponse> {
  return await request<PriceByQueryResponse>("/api/compiq/price", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

// Strip the "cardsight:" prefix from a search candidate id to get the
// UUID needed by price-by-id. Returns null for non-cardsight candidates.
export function candidateIdToCardsightId(candidateId: string): string | null {
  if (candidateId.startsWith("cardsight:")) return candidateId.slice("cardsight:".length);
  // CF-CATALOG-CANDIDATE-ROUTE (Drew, 2026-08-06). Also route `catalog:`
  // prefixed candidates directly to the card page using the embedded
  // hobbyiqCardId slug. The recent-sales endpoint already handles the
  // `hiq:...` slug shape (CF-RECENT-SALES-HIQ-SLUG), and the card page
  // just forwards its route param down to that endpoint. Before this
  // fix, `catalog:` clicks fell through to the free-text lookup which
  // showed the "sales history but no catalog detail" dead-end.
  if (candidateId.startsWith("catalog:")) return candidateId.slice("catalog:".length);
  return null;
}

// ─── Account / settings ────────────────────────────────────────────

// GET /api/entitlements/me returns the resolved plan + features/caps.
// Full shape is broad; we type only what the settings page reads.
export interface EntitlementsMeResponse {
  success: boolean;
  plan: "free" | "collector" | "investor" | "pro_seller" | string;
  entitlementOverride?: "free" | "collector" | "investor" | "pro_seller" | null;
  /**
   * The granted feature keys.
   *
   * CF-PRO-SELLER-WORKSPACE (2026-09-02). The backend sends an ARRAY —
   * `resolveEntitlementsFor()` returns `Array.from(features).sort()`, so the
   * wire shape is `["predictions", "watchlist", ...]`. This was typed as
   * `Record<string, boolean>` and nothing had read it yet, so the mistake
   * was invisible: an `if (features.someKey)` against an array is
   * `undefined`, which reads as "not entitled" and would have locked out
   * every paying user. Both shapes are declared because the type is the
   * contract and the array is what actually arrives; read it through
   * `hasFeature()` rather than indexing it directly.
   */
  features?: string[] | Record<string, boolean>;
  caps?: Record<string, unknown>;
}

/**
 * Is `feature` granted, whichever shape the endpoint used? Presentation only —
 * the server re-checks with requireEntitlement on every gated route, so a
 * wrong answer here can hide a feature but can never unlock one.
 */
export function hasFeature(
  features: EntitlementsMeResponse["features"],
  feature: string,
): boolean {
  if (Array.isArray(features)) return features.includes(feature);
  if (features && typeof features === "object") return features[feature] === true;
  return false;
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

// CF-RESERVED-USERNAMES: debounced availability probe used by the
// settings + signup flows to render live green/red feedback before the
// user submits. Runs the same validation gates as the change endpoint
// (regex → reserved list → uniqueness) so a green response is a
// commit-safe green.
export async function checkUsernameAvailable(username: string): Promise<{ available: boolean; reason?: string }> {
  return await request<{ available: boolean; reason?: string }>(
    `/api/auth/username-available?username=${encodeURIComponent(username)}`,
    { auth: false },
  );
}

// CF-EMAIL-VERIFICATION (Drew, 2026-07-27). Kick off a verification
// email for the currently signed-in account. Server picks the address
// from the user record — we don't send it. Returns `sent: false,
// devLogged: true` when the backend has no ACS connection configured
// (local dev); UI should show a "verification link in server log"
// hint in that case.
export async function sendEmailVerification(): Promise<{
  success: boolean;
  sent: boolean;
  devLogged: boolean;
  expiresAt?: string;
  error?: string;
}> {
  return await request("/api/auth/send-verification", { method: "POST" });
}

// CF-EMAIL-VERIFICATION. Called from the /verify-email page to redeem
// the token from the query string. Public — no session header needed.
export async function verifyEmailToken(token: string): Promise<{
  success: boolean;
  user?: AuthUser;
  error?: string;
}> {
  return await request(
    `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    { auth: false },
  );
}

// CF-CHANGE-PASSWORD (Drew, 2026-07-27). Session-gated. Server verifies
// currentPassword before writing the new hash. Never Apple-OAuth-safe:
// backend surfaces "sign-in method doesn't support password change" for
// those accounts and this helper propagates it.
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  return await request("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
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
  certNumber?: string | null;
  photos?: string[];
  quantity: number;
  purchasePrice?: number;
  purchaseDate?: string;
  purchaseSource?: string;
  notes?: string;
  cardsightCardId?: string;
  cardsightGradeId?: string;
  // CF-STOREFRONT-OPT-IN (Drew, 2026-07-27 rev 2): allow PATCH to toggle
  // showOnStorefront without dragging every other identity field along.
  // Backend spread-merges partial patches so `{showOnStorefront: true}`
  // is a valid update.
  showOnStorefront?: boolean;
  // Legacy — kept for backward compat during reads; new writes should
  // use showOnStorefront instead.
  hideFromStorefront?: boolean;
  // CF-IDENTITY-VERIFIED (Drew, 2026-07-27): sent when the user
  // confirms a picker candidate. Reads/writes atomically via the same
  // PATCH endpoint.
  identityVerified?: boolean;
  identityVerifiedAt?: string;
  identityVerifiedBy?: {
    source: string;
    candidateId: string;
    verifiedAt: string;
  };
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
  /** CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK (2026-09-01). Absent means observed —
   *  the endpoint returns the observed trail unless ?includeEstimated=true. */
  valuationStatus?: "observed" | "estimated";
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

// Two-step photo upload matching the iOS wire contract:
//   1. POST /api/uploads/card-photo → returns { uploadUrl, blobUrl }
//   2. PUT bytes directly to uploadUrl (Azure Blob SAS)
// The caller then appends `blobUrl` to the holding's photos[] via a
// PATCH. Returns the blobUrl for that append step.
export async function uploadHoldingPhoto(file: File): Promise<string> {
  const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
  const sas = await request<{
    success: boolean;
    uploadUrl: string;
    blobUrl: string;
    contentType?: string;
  }>("/api/uploads/card-photo", {
    method: "POST",
    body: JSON.stringify({
      clientId: `web-${Date.now()}`,
      fileExtension: ext,
    }),
  });
  if (!sas.uploadUrl || !sas.blobUrl) {
    throw new Error("Upload URL not issued");
  }
  const put = await fetch(sas.uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": sas.contentType ?? file.type ?? "application/octet-stream",
    },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Blob upload failed (${put.status})`);
  }
  return sas.blobUrl;
}

// D20 (2026-08-30): `identifyCardFromBlob()` and the CardIdentify* types
// (CF-CARD-IDENTIFY web parity, 2026-08-05) are gone. They posted to
// /api/portfolio/identify, a route the backend has never had — the scan
// page uploaded, then 404'd. /app/identify now says photo identification
// is not available; the call comes back with a real handler, not before.

// POST /holdings/:id/regrade — atomic grade conversion. Rolls
// `gradingCost` into totalCostBasis, sets grade + optional cert#, and
// emits a `regrade` price-history point in ONE commit. Preferred over
// PATCH when the user is doing the "raw → slabbed" flow because it
// keeps P&L honest by adding the grading fee to their all-in cost.
export interface RegradeInput {
  gradeCompany: string;
  gradeValue: number;
  certNumber?: string | null;
  gradingCost?: number;
}
export async function regradeHolding(id: string, body: RegradeInput): Promise<{ success: boolean; holding?: PortfolioHolding; message?: string }> {
  const raw = await request<{ message?: string; id?: string; updatedHolding?: PortfolioHolding; holding?: PortfolioHolding }>(
    `/api/portfolio/holdings/${encodeURIComponent(id)}/regrade`,
    { method: "POST", body: JSON.stringify(body) },
  );
  const holding = raw.updatedHolding ?? raw.holding;
  return {
    success: typeof raw.id === "string" || holding != null,
    holding,
    message: raw.message,
  };
}

// ─── Stripe subscriptions ────────────────────────────────────────

export async function createStripeCheckoutSession(plan: "collector" | "investor" | "pro_seller"): Promise<{ success: boolean; url?: string; error?: string }> {
  return await request<{ success: boolean; url?: string; error?: string }>(
    "/api/stripe/checkout",
    { method: "POST", body: JSON.stringify({ plan }) },
  );
}

export async function createStripePortalSession(): Promise<{ success: boolean; url?: string; error?: string }> {
  return await request<{ success: boolean; url?: string; error?: string }>(
    "/api/stripe/portal",
    { method: "POST", body: JSON.stringify({}) },
  );
}

// ─── Public seller storefront ─────────────────────────────────────

export interface StorefrontCard {
  holdingId: string;
  cardTitle: string;
  playerName: string | null;
  imageUrl: string | null;
  grade: string | null;
  fmv: number | null;
  parallel: string | null;
  year: number | null;
}

export interface PublicSellerResponse {
  success: boolean;
  seller: {
    userId: string;
    username: string;
    joinedAt: string;
  };
  portfolio: {
    cardCount: number;
    sports: Array<{ sport: string; count: number }>;
  };
  cards: StorefrontCard[];
  // CF-STOREFRONT-TIER (Drew, 2026-07-27): per-tier storefront cap +
  // effective plan. Investor: 50 cards. Pro Seller: 200 (safety cap).
  tier?: "investor" | "pro_seller";
  cap?: number;
}

export async function fetchPublicSeller(username: string): Promise<PublicSellerResponse> {
  return await request<PublicSellerResponse>(
    `/api/public/seller/${encodeURIComponent(username)}`,
    { auth: false },
  );
}

// ─── CF-MESSAGING (Drew, 2026-07-27) ────────────────────────────────────

export type MessageKind = "chat" | "offer" | "accepted" | "sold";

export interface HoldingRef {
  holdingId: string;
  sellerUserId: string;
  cardTitle: string;
  imageUrl?: string | null;
  askingPriceCents?: number | null;
}

export interface Message {
  id: string;
  threadId: string;
  fromUserId: string;
  toUserId: string;
  text: string;
  createdAt: string;
  readAt?: string | null;
  kind: MessageKind;
  priceCents?: number | null;
  holdingRef?: HoldingRef | null;
}

export interface ThreadSummary {
  threadId: string;
  otherUserId: string;
  // CF-MESSAGING-USERNAMES (Drew, 2026-07-27): server-enriched.
  // Absent/null → renderer falls back to a shortened userId.
  otherUsername?: string | null;
  lastMessage: {
    text: string;
    kind: MessageKind;
    fromMe: boolean;
    createdAt: string;
    priceCents?: number | null;
  };
  unreadCount: number;
}

export interface UserDisplay {
  userId: string;
  username: string | null;
}

export async function fetchThreads(): Promise<{ success: boolean; threads: ThreadSummary[] }> {
  return await request("/api/messages/threads");
}

export async function fetchThread(otherUserId: string): Promise<{
  success: boolean;
  messages: Message[];
  other: UserDisplay;
}> {
  return await request(`/api/messages/threads/${encodeURIComponent(otherUserId)}`);
}

export async function fetchUserDisplay(userId: string): Promise<{ success: boolean; user: UserDisplay }> {
  return await request(`/api/messages/user/${encodeURIComponent(userId)}`);
}

export async function sendMessage(input: {
  toUserId: string;
  text: string;
  kind?: MessageKind;
  priceCents?: number | null;
  holdingRef?: HoldingRef | null;
}): Promise<{ success: boolean; message?: Message; error?: string }> {
  return await request("/api/messages/", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function markSold(
  messageId: string,
  threadId: string,
): Promise<{ success: boolean; message?: Message; error?: string }> {
  return await request(
    `/api/messages/${encodeURIComponent(messageId)}/mark-sold?threadId=${encodeURIComponent(threadId)}`,
    { method: "POST" },
  );
}

export async function fetchUnreadCount(): Promise<{ success: boolean; unread: number }> {
  return await request("/api/messages/unread-count");
}

// ─── CF-ONBOARDING (Drew, 2026-07-27) ───────────────────────────────────

export interface OnboardingStep {
  id: "verify" | "link-ebay" | "first-card" | "first-alert" | "storefront";
  label: string;
  description: string;
  done: boolean;
  href: string;
  cta?: string;
}

export interface OnboardingResponse {
  success: boolean;
  steps: OnboardingStep[];
  doneCount: number;
  total: number;
  percentComplete: number;
  dismissed: boolean;
}

export async function fetchOnboarding(): Promise<OnboardingResponse> {
  return await request("/api/onboarding/");
}

export async function dismissOnboarding(): Promise<{ success: boolean }> {
  return await request("/api/onboarding/dismiss", { method: "POST" });
}

export async function reopenOnboarding(): Promise<{ success: boolean }> {
  return await request("/api/onboarding/reopen", { method: "POST" });
}

// ─── CF-FIRST-RUN (Drew, 2026-09-02) ────────────────────────────────────
//
// The guided funnel's state. `progress` is null for an account that has
// never started — lib/firstRun.ts's normalizeProgress() turns that into
// the empty record, so exactly one module decides what "fresh" means.
// `holdingCount` is derived server-side from the portfolio, which is what
// lets the funnel stand down for a user who filled their collection on
// iOS and has never opened the web app before.

export interface FirstRunStateResponse {
  success: boolean;
  progress: unknown | null;
  holdingCount: number;
}

export async function fetchFirstRun(): Promise<FirstRunStateResponse> {
  return await request<FirstRunStateResponse>("/api/onboarding/first-run");
}

export async function saveFirstRun(
  progress: unknown,
): Promise<{ success: boolean; progress?: unknown }> {
  return await request("/api/onboarding/first-run", {
    method: "POST",
    body: JSON.stringify({ progress }),
  });
}

export async function setPublicShareEnabled(enabled: boolean): Promise<{ success: boolean; publicShareEnabled: boolean }> {
  return await request<{ success: boolean; publicShareEnabled: boolean }>(
    "/api/auth/public-share",
    { method: "POST", body: JSON.stringify({ enabled }) },
  );
}

// ─── Portfolio CSV / xlsx import ──────────────────────────────────

export type ImportLane = "update" | "new";
export type ImportBucket = "clean" | "collision" | "ambiguous" | "unresolved" | "identity-edited";
export type CommitAction = "commit" | "skip" | "add-as-copy" | "update-cost";

export interface NormalizedHoldingPayload {
  id?: string;
  cardId?: string | null;
  playerName?: string;
  cardYear?: number;
  product?: string;
  cardTitle?: string;
  cardNumber?: string;
  parallel?: string;
  serialNumber?: string;
  isAuto?: boolean;
  gradeCompany?: string;
  gradeValue?: number;
  certNumber?: string;
  quantity?: number;
  purchasePrice?: number;
  totalCostBasis?: number;
  purchaseDate?: string;
  purchaseSource?: string;
  notes?: string;
}

export interface ImportRowEnvelope {
  rowNumber: number;
  lane: ImportLane;
  bucket: ImportBucket;
  cardId: string | null;
  existingHoldingId?: string;
  payload: NormalizedHoldingPayload;
  parseFlags: Array<{ column: string; reason: string }>;
  message: string;
}

export interface ImportPreviewResponse {
  ok: boolean;
  summary?: {
    totalRows: number;
    parsedRows: number;
    byBucket: Record<ImportBucket, number>;
    defaultCommitCount: number;
    capacityProjection?: {
      currentCount: number;
      projectedTotal: number;
      cap: number | null;
      wouldExceed: boolean;
    };
  };
  envelopes?: ImportRowEnvelope[];
  unmappedHeaders?: string[];
  proposedMapping?: Record<string, string | null>;
  // Async path — for large files
  async?: true;
  jobId?: string;
  totalRows?: number;
}

// Preview a portfolio import. Encode the file as base64 in the request
// body — backend supports both csv (plain text OR base64) and xlsx
// (base64 only). Returns either envelopes for the sync path or a jobId
// for the async large-file path (>40 rows).
export async function previewImport(file: File, format: "csv" | "xlsx"): Promise<ImportPreviewResponse> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked base64 to avoid stack limits on big files.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(binary);
  return await request<ImportPreviewResponse>("/api/portfolio/import/preview", {
    method: "POST",
    body: JSON.stringify({ file: b64, format }),
  });
}

export interface ImportCommitResponse {
  ok: boolean;
  idempotencyToken?: string;
  outcomes?: Array<{
    rowNumber: number;
    action: CommitAction;
    outcome: "added" | "updated" | "skipped" | "failed";
    holdingId?: string;
    reason?: string;
  }>;
  totals?: { added: number; updated: number; skipped: number; failed: number };
  capacityExceeded?: { currentCount: number; cap: number; wouldBeTotal: number };
}

export async function commitImport(
  idempotencyToken: string,
  envelopes: ImportRowEnvelope[],
  actions: Record<number, CommitAction>,
): Promise<ImportCommitResponse> {
  return await request<ImportCommitResponse>("/api/portfolio/import/commit", {
    method: "POST",
    body: JSON.stringify({ idempotencyToken, envelopes, actions }),
  });
}

// ─── Trade targets (buy-side discovery) ──────────────────────────

export interface TradeTarget {
  cardId: string;
  playerName: string;
  cardTitle: string;
  imageUrl: string | null;
  askPrice: number;
  engineValue: number;
  discountPct: number;
  discountAbsolute: number;
  confidence: "high" | "medium" | "low";
  reason: string;
  listingUrl: string;
  seller: { username: string; feedbackScore: number | null };
}

export interface TradeTargetsResponse {
  computedAt: string;
  source: "watchlist" | "inventory";
  cardsScanned: number;
  listingsSeen: number;
  targets: TradeTarget[];
}

export async function fetchTradeTargets(source: "watchlist" | "inventory" = "watchlist"): Promise<TradeTargetsResponse> {
  return await request<TradeTargetsResponse>(`/api/portfolio/trade-targets?source=${source}`);
}

// ─── Observed grade curve for a card ─────────────────────────────

export interface ObservedGradeEntry {
  grade: string;
  grader: string;
  sampleCount: number;
  weightedMedianPrice: number | null;
  plainMedianPrice: number | null;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  newestSaleDate: string | null;
  oldestSaleDate: string | null;
  confidenceScore: number;
  value: number | null;
  valueSource: "observed" | "estimated" | "unavailable";
  /** CF-RUNG-LABEL / D16: the rung that produced `value` for this tier
   *  (closed vocabulary, lib/rung.ts). null when unavailable; absent on
   *  legacy curves for vendor ids the catalog cannot name. */
  rungLabel?: string | null;
  estimatedMultiplier: number | null;
  estimatedFrom: "reference-price" | "raw-multiplier" | "sibling-card" | "empirical-ratio" | "empirical-ratio-tier" | null;
  trendAdjustedValue: number | null;
  trendAdjustmentPct: number | null;
  predictedPriceAt30d: number | null;
  predictedPricePct: number | null;
  predictedPriceRangeLow: number | null;
  predictedPriceRangeHigh: number | null;
  predictedHorizonDays: number;
  daysSinceNewestSale: number | null;
  newestSalePrice: number | null;
  salesHistory: Array<{ price: number; date: string | null; saleType: string | null }>;
  referencePrice: number | null;
  referenceDivergencePct: number | null;
  referenceAnomaly: boolean;
}

export interface ObservedGradeCurveResponse {
  success: boolean;
  cardId: string;
  entries: ObservedGradeEntry[];
  totalSampleCount: number;
  computedAt: string;
  ratePerWeek?: number | null;
  signalSource?: string | null;
  /** D16 (toObservedGradeCurveResponse, additive): the headline rung for
   *  the requested identity, its source, why it is null when it is, and
   *  the catalog identity the curve was served under. */
  rungLabel?: string | null;
  valueSource?: "observed" | "estimated" | "unavailable" | null;
  fmvReason?: string | null;
  identity?: Record<string, unknown> | null;
}

export async function fetchObservedGradeCurve(cardId: string): Promise<ObservedGradeCurveResponse> {
  return await request<ObservedGradeCurveResponse>(
    `/api/compiq/observed-grade-curve/${encodeURIComponent(cardId)}`,
  );
}

// ─── Recent sold comps for a card ─────────────────────────────────

export interface RecentCompSale {
  id?: string | null;      // needed for flag button
  cardId?: string | null;  // partition key for flag POST
  source: string;
  price: number;
  soldAt: string;
  title: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  cardYear: number | null;
  cardNumber: string | null;
  imageUrl?: string | null;
  sellerHandle?: string | null;
  listingUrl?: string | null;
  // CF-CONFIDENCE-EXPLAIN (Drew, 2026-08-01)
  confidenceScore?: number | null;
  confidenceBand?: string | null;
  confidenceExplain?: string | null;
  // CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). True when this sale is
  // the VIEWER'S own imported purchase. The row is shown either way -- an
  // own purchase is a real sale -- and this drives the label, not a filter.
  isOwn?: boolean | null;
  /** The wording for that label, served by the backend so the phrase lives
   *  in one place. "your purchase". */
  ownLabel?: string | null;
}

// CF-USER-FLAG-CLIENT (Drew, 2026-08-01). Fires POST /api/user/flag-comp
// so end users can mark a comp row as "this looks wrong". After 3
// distinct users flag the same row, it auto-quarantines.
export async function flagComp(input: {
  rowId: string;
  cardId: string;
  reasonNote?: string;
  category?: string;
}): Promise<{ success: boolean; flagCount: number; autoQuarantined: boolean }> {
  const sessionId = typeof window !== "undefined" ? window.localStorage.getItem("hobbyiq_session_id") : null;
  const res = await fetch(`${API_BASE}/api/user/flag-comp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
    },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "flag failed");
  return body;
}

export interface RecentCompsResponse {
  count: number;
  sales: RecentCompSale[];
}

export async function fetchRecentComps(opts: {
  cardId: string;
  parallel?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  /** When true, backend returns ALL grades (Raw + every PSA/BGS/SGC/CGC).
   *  Otherwise the backend defaults to Raw when no explicit grade set. */
  allGrades?: boolean;
  days?: number;
  limit?: number;
}): Promise<RecentCompsResponse> {
  const q = new URLSearchParams();
  if (opts.parallel !== undefined && opts.parallel !== null) q.set("parallel", opts.parallel);
  if (opts.allGrades) {
    q.set("tier", "all");
  } else {
    if (opts.gradeCompany) q.set("gradeCompany", opts.gradeCompany);
    if (opts.gradeValue != null) q.set("gradeValue", String(opts.gradeValue));
  }
  if (opts.days != null) q.set("days", String(opts.days));
  if (opts.limit != null) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return await request<RecentCompsResponse>(
    `/api/compiq/cards/${encodeURIComponent(opts.cardId)}/recent-sales${qs ? `?${qs}` : ""}`,
  );
}

// ─── Sold ledger ───────────────────────────────────────────────────

export interface LedgerEntry {
  id: string;
  userId: string;
  holdingId: string;
  playerName: string;
  cardTitle: string;
  quantitySold: number;
  unitSalePrice: number;
  grossProceeds: number;
  fees: number;
  tax: number;
  shipping: number;
  netProceeds: number;
  costBasisSold: number;
  realizedProfitLoss: number;
  realizedProfitLossPct: number;
  soldAt: string;
  notes?: string;
  source?: "manual" | "ebay";
  ebayOrderId?: string;
  needsReconciliation?: boolean;
  gradingCost?: number | null;
  suppliesCost?: number | null;
  actualShippingCost?: number | null;
  dismissedAt?: string;
}

export interface LedgerResponse {
  userId: string;
  count: number;
  totals: {
    realizedProfitLoss: number;
    grossProceeds: number;
    netProceeds: number;
    costBasisSold: number;
  };
  entries: LedgerEntry[];
}

export async function fetchLedger(): Promise<LedgerResponse> {
  return await request<LedgerResponse>("/api/portfolio/ledger");
}

export async function updateLedgerEntry(
  id: string,
  patch: Partial<Pick<LedgerEntry, "gradingCost" | "suppliesCost" | "notes"> & { dismissedAt?: string | null; dismissedReason?: string | null }>,
): Promise<LedgerEntry> {
  return await request<LedgerEntry>(`/api/portfolio/ledger/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ─── Financials (Pro Seller) ──────────────────────────────────────
// URL slug + backend routes still use "/erp" for backward compat with
// bookmarks + iOS deep links. User-facing labels say "Financials".

export interface ErpTopMover {
  holdingId: string;
  title: string;
  playerName: string;
  costBasis: number;
  snapshotValue: number;
  unrealizedGainLoss: number;
  unrealizedPct: number;
}

export interface ErpSummaryResponse {
  success: boolean;
  asOf: string;
  totals: {
    costBasis: number;
    snapshotValue: number;
    unrealizedGainLoss: number;
    unrealizedPct: number;
    holdingCount: number;
    freshCount: number;
    staleCount: number;
    missingCount: number;
    estimatedCount: number;
    pendingCount: number;
  };
  fullPosition: {
    realizedYtd: number;
    unrealized: number;
    total: number;
    realizedYtdNote: string;
  };
  change30d: {
    absolute: number;
    percent: number | null;
    asOfDate: string;
    rangeWeak: boolean;
  } | null;
  topGainers: ErpTopMover[];
  topLosers: ErpTopMover[];
  valueTrend30d: Array<{ date: string; displayableTotal: number }>;
}

// Backend responds 402/403 when the caller doesn't have the
// erpReconciliation entitlement (free-tier / Collector-tier users).
// The error handler in `request()` throws with the status code so the
// caller can render an upsell instead of a generic failure.
export async function fetchErpSummary(): Promise<ErpSummaryResponse> {
  return await request<ErpSummaryResponse>("/api/portfolio/erp/summary");
}

// CF-CEO-DASHBOARD (Drew, 2026-08-16: "a true dashboard for a CEO to see
// profitability, drill down by year, months, purchases and all that").
//
// The backend has carried a full P&L since CF-ERP — gross proceeds, fees,
// shipping, COGS, realized P&L, operating expenses and true net, groupable
// seven ways. Nothing on the web ever called it; /erp/summary only returns a
// portfolio snapshot, which is position, not profitability.
export type PnlGroupBy =
  | "month" | "player" | "set" | "grade" | "source" | "salesChannel" | "paymentMethod";

export interface PnlTotals {
  grossProceeds: number;
  feesTotal: number;
  shipping: number;
  netProceeds: number;
  costBasisSold: number;
  realizedProfitLoss: number;
  entryCount: number;
  // CF-PNL-SHOW-GRADING (Drew, 2026-08-16). Deducted inside netProceeds but
  // never reported, so the walk did not add up. Optional so an older backend
  // response still parses.
  gradingCost?: number;
  suppliesCost?: number;
}

export interface PnlGroup {
  key: string;
  label: string;
  totals: PnlTotals;
}

export interface ErpPnlResponse {
  success: boolean;
  window: { from: string | null; to: string | null };
  groupBy: PnlGroupBy;
  totals: PnlTotals;
  groups: PnlGroup[];
  excluded: {
    unreconciledCount: number;
    unreconciledOldestSoldAt: string | null;
    unreconciledNewestSoldAt: string | null;
  };
  cogs?: Record<string, number> | null;
  operatingExpenses?: number;
  trueNet?: number;
}

export async function fetchErpPnl(opts: {
  from?: string;
  to?: string;
  groupBy?: PnlGroupBy;
  includeExpenses?: boolean;
} = {}): Promise<ErpPnlResponse> {
  const qs = new URLSearchParams();
  if (opts.from) qs.set("from", opts.from);
  if (opts.to) qs.set("to", opts.to);
  qs.set("groupBy", opts.groupBy ?? "month");
  // Always ask for expenses: a profitability view that ignores operating cost
  // is not profitability. The backend defaults this OFF only to preserve the
  // older iOS response shape.
  if (opts.includeExpenses !== false) qs.set("includeExpenses", "1");
  return await request<ErpPnlResponse>(`/api/portfolio/erp/pnl?${qs.toString()}`);
}

export type ExpenseCategory =
  | "store_subscription"
  | "show_booth"
  | "show_admission"
  | "mileage"
  | "supplies"
  | "shipping_supplies"
  | "grading_fees"
  | "software"
  | "hobbyiq_subscription"
  | "travel"
  | "meals"
  | "other";

export const EXPENSE_CATEGORIES: ReadonlyArray<{ value: ExpenseCategory; label: string }> = [
  { value: "supplies", label: "Supplies" },
  { value: "shipping_supplies", label: "Shipping supplies" },
  { value: "grading_fees", label: "Grading fees" },
  { value: "store_subscription", label: "Store subscription" },
  { value: "hobbyiq_subscription", label: "HobbyIQ subscription" },
  { value: "software", label: "Software" },
  { value: "show_booth", label: "Show booth" },
  { value: "show_admission", label: "Show admission" },
  { value: "mileage", label: "Mileage" },
  { value: "travel", label: "Travel" },
  { value: "meals", label: "Meals" },
  { value: "other", label: "Other" },
];

export interface ExpenseEntry {
  id: string;
  userId: string;
  category: ExpenseCategory;
  categoryNote?: string;
  amount: number;
  date: string;
  note?: string;
  receiptRef?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateExpenseInput {
  category: ExpenseCategory;
  amount: number;
  date: string;
  categoryNote?: string;
  note?: string;
  receiptRef?: string;
}

export async function fetchExpenses(opts?: { from?: string; to?: string; category?: ExpenseCategory }): Promise<ExpenseEntry[]> {
  const q = new URLSearchParams();
  if (opts?.from) q.set("from", opts.from);
  if (opts?.to) q.set("to", opts.to);
  if (opts?.category) q.set("category", opts.category);
  const qs = q.toString();
  const res = await request<{ success: boolean; entries: ExpenseEntry[] }>(
    `/api/portfolio/erp/expenses${qs ? `?${qs}` : ""}`,
  );
  return res.entries;
}

export async function createExpense(body: CreateExpenseInput): Promise<ExpenseEntry> {
  const res = await request<{ success: boolean; expense: ExpenseEntry }>(
    "/api/portfolio/erp/expenses",
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.expense;
}

export async function deleteExpense(id: string): Promise<void> {
  await request(`/api/portfolio/erp/expenses/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ─── Grade-worthy analysis ────────────────────────────────────────

export type GradeWorthyRecommendation =
  | "grade_now"
  | "grade_worthy_but_wait"
  | "not_worth"
  | "insufficient_data";

export interface GradeWorthyTier {
  graderTier: string;
  gradedMedianPrice: number;
  gradedSampleSize: number;
  gradingCostAssumed: number;
  expectedGain: number;
  expectedRoi: number;
  recommendation: GradeWorthyRecommendation;
  reason: string;
}

export interface GradeWorthyAnalysis {
  rawPrice: number;
  bestTier: GradeWorthyTier | null;
  allTiers: GradeWorthyTier[];
  overallRecommendation: GradeWorthyRecommendation;
  reason: string;
}

export interface GradeAnalysisResponse {
  holdingId: string;
  player: string | null;
  year: number | null;
  cardNumber: string | null;
  set: string | null;
  variant: string | null;
  analysis: GradeWorthyAnalysis;
  failureRate?: { rate: number; nGraded: number; caveat: string } | null;
  diagnostics?: unknown;
}

export async function fetchGradeAnalysis(holdingId: string): Promise<GradeAnalysisResponse> {
  return await request<GradeAnalysisResponse>(
    `/api/portfolio/holdings/${encodeURIComponent(holdingId)}/grade-analysis`,
  );
}

// ─── Grade arbitrage (CF-GRADE-ARB, 2026-09-02) ───────────────────
//
// Conditional value of a RAW holding at each graded tier, from the
// card's OWN empirical grade curve, minus a disclosed grading-cost
// assumption. Refuses (available:false) when there is no empirical
// basis — the UI must render `refusalReason`, never a guess.

export type GradeArbRefusal = "not-raw" | "no-raw-basis" | "no-graded-basis";

export interface GradeArbTier {
  tier: string;
  grader: string;
  gradedValue: number;
  netGain: number;
  netGainPct: number | null;
  sampleCount: number;
  rungLabel: string | null;
  /** Always "observed": the surface refuses any tier that is not real
   *  sales of this card at this tier, with at least 3 of them. */
  valueSource: "observed";
  confidence: number;
  basis: string;
}

export interface GradeArbResult {
  available: boolean;
  refusal: GradeArbRefusal | null;
  refusalReason: string | null;
  rawValue: number | null;
  gradingCostUsd: number;
  tiers: GradeArbTier[];
  bestTier: GradeArbTier | null;
  /** The condition caveat. Always present — render it with any number. */
  disclosure: string;
}

export interface GradeArbResponse {
  holdingId: string;
  player: string | null;
  year: number | null;
  cardNumber: string | null;
  set: string | null;
  variant: string | null;
  gradeArb: GradeArbResult;
}

export async function fetchGradeArb(holdingId: string): Promise<GradeArbResponse> {
  return await request<GradeArbResponse>(
    `/api/portfolio/holdings/${encodeURIComponent(holdingId)}/grade-arb`,
  );
}

export interface PurchaseEntry {
  id: string;
  userId: string;
  purchaseDate: string;
  source: "manual" | "ebay";
  subtotal: number;
  tax: number;
  shipping: number;
  otherFees: number;
  totalCost: number;
  holdingIds: string[];
  vendor?: string;
  invoiceRef?: string;
  notes?: string;
  ebayOrderId?: string;
}

export interface PurchasesListResponse {
  success: boolean;
  window: { from: string | null; to: string | null };
  source: "manual" | "ebay" | null;
  purchases: PurchaseEntry[];
  totals: {
    count: number;
    subtotal: number;
    tax: number;
    shipping: number;
    otherFees: number;
    totalCost: number;
  };
}

export async function fetchPurchases(opts?: { from?: string; to?: string; source?: "manual" | "ebay" }): Promise<PurchasesListResponse> {
  const q = new URLSearchParams();
  if (opts?.from) q.set("from", opts.from);
  if (opts?.to) q.set("to", opts.to);
  if (opts?.source) q.set("source", opts.source);
  const qs = q.toString();
  return await request<PurchasesListResponse>(`/api/portfolio/erp/purchases${qs ? `?${qs}` : ""}`);
}

export interface CreatePurchaseInput {
  purchaseDate: string;
  source?: "manual" | "ebay";
  subtotal?: number;
  tax?: number;
  shipping?: number;
  otherFees?: number;
  vendor?: string;
  invoiceRef?: string;
  notes?: string;
  holdingIds?: string[];
}

export interface EbayImportSummary {
  daysWindow: number;
  fetched: number;
  imported: number;
  replayHits: number;
  skipped: number;
  errors: number;
  totalCost: number;
  ebayTotalReported: number | null;
  entries: PurchaseEntry[];
  holdingsCreated: number;
  holdingsNeedingReview: number;
  holdingsSkipped: number;
  holdingsBrowseEnriched: number;
}

export async function importEbayPurchases(days: number): Promise<{ success: boolean } & EbayImportSummary> {
  return await request<{ success: boolean } & EbayImportSummary>(
    "/api/portfolio/erp/purchases/import/ebay",
    { method: "POST", body: JSON.stringify({ days }) },
  );
}

// ─── Review queue (CF-EBAY-REVIEW-QUEUE) ──────────────────────────

export interface PendingReviewHolding {
  id: string;
  cardTitle?: string | null;
  notes?: string | null;
  playerName?: string | null;
  cardYear?: number | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | string | null;
  isAuto?: boolean | null;
  parseConfidence?: number | null;
  purchasePrice?: number | null;
  totalCostBasis?: number | null;
  purchaseDate?: string | null;
  suggestedCardId?: string | null;
  suggestion?: {
    cardId?: string | null;
    displayTitle?: string | null;
    confidence?: number | null;
    source?: string | null;
  } | null;
}

export async function fetchPendingReviewHoldings(): Promise<{
  success: boolean;
  holdings: PendingReviewHolding[];
}> {
  return await request("/api/portfolio/holdings/pending-review");
}

// CF-BACKFILL-HOLDINGS-WEB (Drew, 2026-08-03). Re-runs
// autoCreateHoldingForPurchase against every orphan purchase (no
// linked holding). Idempotent. Used to recover after an ingest
// parser fix ships — no eBay refetch, just re-parse locally.
export async function backfillPurchaseHoldings(): Promise<{
  success: boolean;
  processed?: number;
  holdingsCreated?: number;
  holdingsNeedingReview?: number;
  holdingsBrowseEnriched?: number;
  skipped?: number;
}> {
  return await request(
    "/api/portfolio/erp/purchases/backfill-holdings",
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function generatePendingReviewSuggestions(force = false): Promise<{
  success: boolean;
  suggested?: number;
  skipped?: number;
  errors?: number;
}> {
  return await request(
    "/api/portfolio/holdings/generate-suggestions",
    { method: "POST", body: JSON.stringify({ force }) },
  );
}

export async function confirmPendingReviewHolding(
  holdingId: string,
  edits: Partial<{
    playerName: string | null;
    cardYear: number | null;
    setName: string | null;
    parallel: string | null;
    cardNumber: string | null;
    gradeCompany: string | null;
    gradeValue: number | null;
    isAuto: boolean | null;
    team: string | null;
    sport: string | null;
    cardId: string | null;
  }> = {},
): Promise<{
  success: boolean;
  status: string;
  holding?: PendingReviewHolding;
}> {
  return await request(
    `/api/portfolio/erp/holdings/${encodeURIComponent(holdingId)}/confirm`,
    { method: "POST", body: JSON.stringify(edits) },
  );
}

// CF-APPROVE-MULTIPLES (Drew, 2026-08-31). Approve many pending-review
// holdings in one request. The response is always per-item: a row someone
// already approved in another tab comes back "not-pending", which is a fact
// about that row rather than a failure of the batch.
export interface BatchConfirmItemResult {
  holdingId: string;
  status: "confirmed" | "not-found" | "not-pending" | "error";
  correctionCount?: number;
  reason?: string;
}

/** Server-side cap per batch (BATCH_CONFIRM_MAX). The UI chunks to match. */
export const BATCH_CONFIRM_MAX = 50;

export async function confirmPendingReviewHoldingsBatch(
  holdingIds: string[],
  edits: Record<string, Record<string, unknown>> = {},
): Promise<{
  success: boolean;
  requested: number;
  confirmed: number;
  failed: number;
  results: BatchConfirmItemResult[];
}> {
  return await request(
    "/api/portfolio/erp/holdings/confirm-batch",
    { method: "POST", body: JSON.stringify({ holdingIds, edits }) },
  );
}

// CF-SEARCH-AND-PICK (Drew, 2026-08-23: "if it is not verified — i want the
// SEARCH function to find the card to match it... that search then gets
// selected and edits the card to the catalog match").
export interface CatalogSearchHit {
  slug: string;
  /** The server's one display format for the card. Computed per request from
   *  the row's fields, never stored — so it cannot go stale when a name, a
   *  parallel or a set is corrected. */
  displayName?: string | null;
  cardNumber: string | null;
  playerName: string | null;
  sport: string | null;
  year: number | null;
  setKey: string | null;
  setName: string | null;
  parallel: string | null;
  isAuto: boolean;
  printRun: number | null;
  imageUrl: string | null;
  /** The row's own catalog `source` string ("beckett-checklist-2026-08-01",
   *  "sold-comps-stub-2026-08-12", "cardhedge", …). */
  source?: string | null;
  /** D33: what this row is allowed to decide, classified server-side from
   *  `source` so web and iOS cannot drift on the answer. "checklist" earns the
   *  ✓ badge — it is the same predicate that stamps a holding VERIFIED. */
  authority?: "checklist" | "vendor" | "derived" | "unknown" | null;
  score: number;
  salesSummary: {
    count: number;
    median30d: number | null;
    median90d: number | null;
    medianAll: number | null;
    lastSaleAt: string | null;
    trendDirection: "up" | "down" | "flat";
  } | null;
}

/** `context` is what we already know about the card being identified. The
 *  server boosts hits that agree with it so the right card opens at the top;
 *  it never filters, because every one of those fields came from a title parse
 *  that has already proved unreliable. Ranking lives server-side so iOS and
 *  web cannot drift apart on what "best" means. */
export async function searchCatalog(input: {
  query: string;
  limit?: number;
  context?: {
    cardNumber?: string | null;
    year?: number | null;
    setName?: string | null;
    playerName?: string | null;
    isAuto?: boolean | null;
  } | null;
}): Promise<{
  success: boolean;
  hits: CatalogSearchHit[];
  provisional?: boolean;
  timedOut?: boolean;
}> {
  return await request("/api/catalog/search", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createPurchase(body: CreatePurchaseInput): Promise<PurchaseEntry> {
  const res = await request<{ success: boolean; purchase: PurchaseEntry }>(
    "/api/portfolio/erp/purchases",
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.purchase;
}

// ─── Unreconciled queue ───────────────────────────────────────────

export type CostsStatus = "needs_action" | "saved_pending_fees";

export interface UnreconciledEntry extends LedgerEntry {
  missingFields: string[];
  costsStatus: CostsStatus;
}

export interface UnreconciledListResponse {
  success: boolean;
  entries: UnreconciledEntry[];
  counts: { unreconciledTotal: number; dismissedHidden: number };
}

export async function fetchUnreconciled(): Promise<UnreconciledListResponse> {
  return await request<UnreconciledListResponse>("/api/portfolio/erp/unreconciled");
}

// Save user-provided costs (gradingCost + suppliesCost) on an eBay
// ledger entry. Backend flips the axis-2 marker and, if fees are also
// filled in, finalizes the entry and removes it from the queue.
export async function saveUnreconciledCosts(
  id: string,
  body: { gradingCost?: number | null; suppliesCost?: number | null },
): Promise<{ success: boolean; entry: UnreconciledEntry }> {
  return await request<{ success: boolean; entry: UnreconciledEntry }>(
    `/api/portfolio/erp/unreconciled/${encodeURIComponent(id)}/save-costs`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export type TaxFilingRail = "ebay" | "paypal" | "venmo";
export const TAX_FILING_RAILS: ReadonlyArray<{ value: TaxFilingRail; label: string }> = [
  { value: "ebay", label: "eBay Managed Payments" },
  { value: "paypal", label: "PayPal" },
  { value: "venmo", label: "Venmo" },
];

export interface RailReconciliation {
  rail: TaxFilingRail;
  reported1099K: number | null;
  ledgerGross: number;
  delta: number | null;
  deltaPct: number | null;
  ledgerEntryCount: number;
  unreconciledExcluded: number;
  note?: string;
}

export interface TaxFilingReport {
  success: boolean;
  taxYear: number;
  rails: RailReconciliation[];
  totals: {
    reported1099K: number | null;
    ledgerGross: number;
    delta: number | null;
  };
  updatedAt: string | null;
}

export async function fetchTaxFiling(year: number): Promise<TaxFilingReport> {
  return await request<TaxFilingReport>(`/api/portfolio/erp/tax/filings/${year}`);
}

export async function upsertTaxFiling(
  year: number,
  rails: Partial<Record<TaxFilingRail, { reportedGross1099K: number; note?: string }>>,
): Promise<TaxFilingReport> {
  return await request<TaxFilingReport>(`/api/portfolio/erp/tax/filings/${year}`, {
    method: "PUT",
    body: JSON.stringify({ rails }),
  });
}

// Accounting export — returns a CSV or JSON download the user can save
// for QuickBooks / Xero import. We surface as a same-tab redirect
// (browser handles the download) so the session cookie carries through.
export function accountingExportUrl(opts?: { from?: string; to?: string; format?: "csv" | "json" }): string {
  const q = new URLSearchParams();
  if (opts?.from) q.set("from", opts.from);
  if (opts?.to) q.set("to", opts.to);
  if (opts?.format) q.set("format", opts.format);
  const qs = q.toString();
  return `${API_BASE}/api/portfolio/erp/accounting-export${qs ? `?${qs}` : ""}`;
}

// POST /holdings/:id/refresh — reruns autoPriceHolding on the server so
// the estimatedValue picks up any pricing-engine changes (e.g. a
// calibration refresh, or a new comp landing in sold_comps). Rate-limited
// server-side per user's plan tier — surfaces as a 429 the caller must
// handle. Response shape mirrors updateHolding.
// POST /portfolio/reprice/batch — bulk refresh every stale holding on the
// user's doc. Rate-limited server-side (60s user throttle by default);
// caller sees the result summary directly. Collector+ tier only —
// backend returns 402 for free-tier callers, surfaced as an entitlement
// error the caller can render as an upsell nudge.
export interface BatchRepriceResult {
  requested: number;
  repriced: number;
  skipped: number;
  reason?: string;
  throttled?: boolean;
  freshSkipped?: number;
  examined?: number;
  updates: Array<{
    id: string;
    status: "repriced" | "skipped" | "error" | "fresh";
    reason?: string;
  }>;
}

// CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): the dispatch acknowledgement.
// The server no longer computes before answering, so there is no result
// summary to return here — only the fact that a run started.
export interface RepriceDispatch {
  accepted: boolean;
  status: "running" | "throttled";
  alreadyRunning?: boolean;
  throttled?: boolean;
  retryAfterMs?: number;
  /**
   * Handle for the dispatched run. Pass it to getRepriceStatus() so a poll
   * that load-balances onto the other serving instance can be told
   * "unknown-here" instead of the ambiguous "idle".
   */
  jobId?: string | null;
  startedAt?: string | null;
  /** Always true on dispatch: on-screen values are the last persisted ones. */
  stale?: boolean;
  /**
   * CF-PORTFOLIO-FRESH-ON-OPEN (2026-09-02): on a `throttled` answer, WHEN
   * the values on screen were last refreshed. A skip that says only "no"
   * looks identical to a broken refresh; this lets the UI say "as of 10:42"
   * instead of going quiet.
   */
  freshAsOf?: string | null;
  freshAgeMs?: number | null;
}

export async function refreshAllHoldings(): Promise<RepriceDispatch> {
  // The server used to reprice up to PORTFOLIO_REPRICE_HTTP_MAX_HOLDINGS (50)
  // holdings synchronously before responding — one measured request issued
  // 5,657 Cosmos calls / 68.3s of dependency time and never produced a
  // completed request row, because this client aborted first. That is why
  // this call had been widened to a 180s timeout.
  //
  // It now returns 202 as soon as the run is dispatched, so the default
  // request() timeout is correct again. Read the new values back through
  // fetchPortfolio() — that endpoint serves stored values in ~77ms — and
  // use getRepriceStatus() to know when the run has landed.
  return await request<RepriceDispatch>("/api/portfolio/reprice/batch", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// GET /portfolio/reprice/status — progress of the dispatched run. Returns
// the run's state, never a price; refreshed values come from the portfolio
// read.
//
// CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31, judged blocker): the backend runs
// on 2 instances and the job map is per-process, so a poll can land on the
// worker that did NOT dispatch. Branch on `settled` — NOT on "status is not
// running". `idle` and `unknown-here` both mean "this worker can't see your
// run", which is a reason to keep polling, never a completion.
export interface RepriceStatus {
  status: "idle" | "unknown-here" | "running" | "done" | "error";
  running: boolean;
  /** True only when a worker actually observed the run reach done/error. */
  settled?: boolean;
  jobId?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  result?: BatchRepriceResult | null;
  error?: string | null;
}

export async function getRepriceStatus(jobId?: string | null): Promise<RepriceStatus> {
  const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
  return await request<RepriceStatus>(`/api/portfolio/reprice/status${qs}`);
}

// GET /portfolio/export?format=csv|xlsx — server returns the file as an
// attachment. Sits outside request() because we need the raw blob body
// + Content-Disposition filename, not JSON. Session header still on
// every request via getStoredSessionId().
export async function exportPortfolio(format: "csv" | "xlsx" = "xlsx"): Promise<void> {
  const sid = getStoredSessionId();
  const res = await fetch(`${API_BASE}/api/portfolio/export?format=${format}`, {
    method: "GET",
    headers: sid ? { "x-session-id": sid } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  // Extract filename from Content-Disposition if server sent one.
  const cd = res.headers.get("Content-Disposition") ?? "";
  const fnMatch = cd.match(/filename="([^"]+)"/);
  const filename = fnMatch?.[1] ?? `hobbyiq-portfolio.${format}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CF-VALUATION-REPORT (Drew, 2026-09-02): GET /portfolio/valuation-report
// — the printable valuation document. Opens in a new tab so the user can
// read it and hit Print / Save as PDF; the backend has no PDF renderer, so
// the browser's print pipeline IS the PDF path (see
// backend/src/services/portfolioiq/valuationReport.service.ts).
//
// It goes through fetch + a blob URL rather than a plain link because the
// route needs the session header, which an <a href> cannot carry. The
// object URL is revoked on a timer rather than immediately: revoking it
// synchronously races the new tab's load and yields a blank page.
export async function openValuationReport(): Promise<void> {
  const sid = getStoredSessionId();
  const res = await fetch(`${API_BASE}/api/portfolio/valuation-report`, {
    method: "GET",
    headers: sid ? { "x-session-id": sid } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Could not generate the report (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "noopener");
  if (!win) {
    // Popup blocked — fall back to downloading the file so the click is
    // never silently swallowed.
    const a = document.createElement("a");
    a.href = url;
    a.download = "hobbyiq-valuation-report.html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** CF-ACCEPT-THE-PARKED-MATCH (2026-08-23). One click from "we think this is
 *  X" to a pinned identity. The route is state-agnostic on purpose — a
 *  holding does not have to be sitting in the eBay review queue for its owner
 *  to be allowed to say which card it is. On success the server pins the
 *  slug, marks the holding verified, clears needsReview, and kicks a reprice,
 *  so the caller should re-read the holding rather than patching state
 *  locally.
 *
 *  409 slug-not-in-catalog is a real answer, not a failure: accepting a card
 *  the catalog has never seen would price it from an empty pool. */
export async function acceptHoldingIdentity(
  id: string,
  cardId: string,
): Promise<{ success: boolean; holding?: PortfolioHolding; correctionCount?: number; error?: string; detail?: string }> {
  return await request(
    `/api/portfolio/erp/holdings/${encodeURIComponent(id)}/accept-identity`,
    { method: "POST", body: JSON.stringify({ cardId }) },
  );
}

export async function refreshHolding(id: string): Promise<{ success: boolean; holding?: PortfolioHolding; message?: string }> {
  const raw = await request<{ message?: string; id?: string; holding?: PortfolioHolding; entry?: { holding?: PortfolioHolding } }>(
    `/api/portfolio/holdings/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
  );
  const holding = raw.holding ?? raw.entry?.holding;
  return {
    success: typeof raw.id === "string" || raw.message === "Holding refreshed" || holding != null,
    holding,
    message: raw.message,
  };
}

// CF-WEB-SELL-PAYLOAD-FIX (Drew, 2026-08-10). Backend
// portfolioStore.sellHolding requires quantity + soldAt (ISO). Web
// was sending {salePrice, saleDate} which returned 400. Expanded to
// carry the full expense-reconciliation payload shape iOS supports
// (fees / tax / shipping / grading / supplies / channel / payment /
// location / notes) so P&L per sale reconciles correctly.
export type SellSalesChannel =
  | "ebay" | "whatnot" | "comc" | "myslabs" | "goldin" | "pwcc"
  | "instagram" | "facebook" | "card_show" | "in_person" | "other";
export type SellPaymentMethod =
  | "ebay_managed" | "paypal" | "venmo" | "zelle" | "cash" | "check"
  | "cashapp" | "trade" | "other";
export interface SellHoldingDetail {
  salePrice: number;
  saleDate?: string;              // YYYY-MM-DD from <input type="date">
  quantity?: number;              // default 1
  fees?: number;
  tax?: number;
  shipping?: number;
  gradingCost?: number;
  suppliesCost?: number;
  salesChannel?: SellSalesChannel;
  channelNote?: string;
  paymentMethod?: SellPaymentMethod;
  paymentNote?: string;
  saleLocation?: { venue?: string; city?: string; state?: string };
  notes?: string;
}
export async function sellHolding(
  id: string,
  detailOrPrice: SellHoldingDetail | number,
  legacyDate?: string,
): Promise<{ success: boolean }> {
  // Back-compat: legacy call sellHolding(id, price, "YYYY-MM-DD") still works.
  const d: SellHoldingDetail = typeof detailOrPrice === "number"
    ? { salePrice: detailOrPrice, saleDate: legacyDate }
    : detailOrPrice;

  const soldAt = d.saleDate
    ? new Date(`${d.saleDate}T12:00:00Z`).toISOString()
    : new Date().toISOString();

  // Only include fields when set — backend validators error on nulls in some
  // paths (e.g. salesChannel="other" requires channelNote).
  const body: Record<string, unknown> = {
    quantity: d.quantity ?? 1,
    salePrice: d.salePrice,
    fees: d.fees ?? 0,
    tax: d.tax ?? 0,
    shipping: d.shipping ?? 0,
    soldAt,
    source: "manual",
  };
  if (d.gradingCost != null && d.gradingCost > 0) body.gradingCost = d.gradingCost;
  if (d.suppliesCost != null && d.suppliesCost > 0) body.suppliesCost = d.suppliesCost;
  if (d.salesChannel) body.salesChannel = d.salesChannel;
  if (d.channelNote?.trim()) body.channelNote = d.channelNote.trim();
  if (d.paymentMethod) body.paymentMethod = d.paymentMethod;
  if (d.paymentNote?.trim()) body.paymentNote = d.paymentNote.trim();
  if (d.saleLocation) {
    const loc: Record<string, string> = {};
    if (d.saleLocation.venue?.trim()) loc.venue = d.saleLocation.venue.trim();
    if (d.saleLocation.city?.trim()) loc.city = d.saleLocation.city.trim();
    if (d.saleLocation.state?.trim()) loc.state = d.saleLocation.state.trim().toUpperCase().slice(0, 2);
    if (Object.keys(loc).length) body.saleLocation = loc;
  }
  if (d.notes?.trim()) body.notes = d.notes.trim();

  return await request(`/api/portfolio/holdings/${encodeURIComponent(id)}/sell`, {
    method: "POST",
    body: JSON.stringify(body),
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

// ─── Weekly digest (CF-WEEKLY-DIGEST, Drew 2026-09-02) ────────────
//
// The persisted Sunday digest. Every section is OPTIONAL on the wire:
// a section the digest did not have is ABSENT, not empty — `sections`
// names what is there, and the page walks that list. Mirrors the
// backend's WeeklyDigest exactly.

export type DigestValueBasis = "observed" | "estimated" | "under-review" | "unpriced";
export type DigestSectionName = "movers" | "reestimated" | "signals" | "audit" | "market";

export interface DigestMover {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  movePct: number;
  value: number | null;
  valueBasis: DigestValueBasis;
  moveUsd: number | null;
  fromValue: number | null;
  fromAt: string | null;
  toAt: string | null;
  observationCount: number;
  costBasis: number | null;
  vsCostPct: number | null;
  basisNote: string;
  speculative: boolean;
  /** CF-A-MOVER-NEEDS-CORROBORATION (2026-09-03). True iff both ends of
   *  the move were exact-pool reads — a real sale of this card at each
   *  end. Only corroborated rows appear under a movers heading. */
  corroborated: boolean;
  anchorRung: string | null;
  latestRung: string | null;
}

export interface DigestSignalRow {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  kind: "sell" | "watch";
  value: number | null;
  unrealizedGainUsd: number | null;
  urgencyScore: number;
  basisNote: string;
}

export interface DigestAuditItem {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  invariant: string;
  reason: string;
  raisedAt: string;
  value: number | null;
  basisNote: string;
}

export interface DigestMarketRow {
  sport: string;
  changePct: number | null;
  latestLevel: number;
  basisNote: string;
}

export interface WeeklyDigest {
  schemaVersion: number;
  userId: string;
  weekId: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  headline: string;
  summary: {
    holdings: number;
    pricedHoldings: number;
    speculativeHoldings: number;
    portfolioValue: number | null;
    portfolioValueBasis: string;
  };
  sections: DigestSectionName[];
  movers?: { gainers: DigestMover[]; decliners: DigestMover[] };
  /** Value changes we could not corroborate with sales at both ends —
   *  repricings, rendered under their own heading and never as movers. */
  reestimated?: { items: DigestMover[]; total: number };
  signals?: { sell: DigestSignalRow[]; watch: DigestSignalRow[] };
  audit?: { items: DigestAuditItem[]; total: number };
  market?: { rows: DigestMarketRow[] };
  footnotes: string[];
}

export interface WeeklyDigestResponse {
  /** null when no digest has been built for this user yet. */
  digest: WeeklyDigest | null;
  message?: string;
  deliveredAt?: string | null;
  deliveryChannel?: string | null;
  computedAt?: string;
}

export interface WeeklyDigestIndexResponse {
  count: number;
  weeks: Array<{
    weekId: string;
    weekStart: string;
    weekEnd: string;
    headline: string;
    sections: DigestSectionName[];
    deliveredAt: string | null;
  }>;
}

export async function fetchWeeklyDigest(weekId?: string): Promise<WeeklyDigestResponse> {
  const q = weekId ? `?week=${encodeURIComponent(weekId)}` : "";
  return await request<WeeklyDigestResponse>(`/api/portfolio/insights/weekly-digest${q}`);
}

export async function fetchWeeklyDigestIndex(): Promise<WeeklyDigestIndexResponse> {
  return await request<WeeklyDigestIndexResponse>("/api/portfolio/insights/weekly-digests");
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
  // CF-EBAY-RECONNECT-SURFACE (found by #1721). The backend has returned
  // these since D26 (backend ebayAuth.service.ts `getConnectionStatus`) and
  // no client read them. `connected` stays TRUE when eBay has already
  // refused the refresh token — a record still exists — so `connected`
  // alone cannot tell a working connection from a dead one. Read `status`.
  // See lib/ebayConnection.ts for the three-state collapse.
  /** "ok" or "reconnect-required". Absent on an older response. */
  status?: "ok" | "reconnect-required";
  /** Why re-authorisation is needed. Null when the connection is healthy. */
  reconnectReason?: string | null;
  /** ISO timestamp the connection was marked dead. Null when healthy. */
  reconnectRequiredAt?: string | null;
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
    /** CF-EBAY-SELL-LOOP: the "how this price was set" HTML the backend
     *  will append at publish. "" when the price is not HobbyIQ's. Shown
     *  read-only — publish re-derives it server-side, so editing it here
     *  would have no effect on what a buyer sees. */
    basisBlock?: string;
    /** One-line helper text under the price field. */
    priceSummary?: string;
  };
  /** CF-EBAY-SELL-LOOP (Drew, 2026-09-02). Where the listing price came
   *  from. The price is the engine's canonical projection with its rung
   *  label — never a stored snapshot and never a number the client
   *  computed. `labels` are disclosures that MUST be shown to the seller. */
  pricing?: EbayDraftPricing;
  /** The sell-window signal for this holding, when its trend supports one.
   *  Context for the seller's timing — it never moved the price. */
  sellSignal?: EbaySellSignal | null;
  validation: {
    requiredMissing: string[];
    warnings: string[];
    readyToPublish: boolean;
  };
}

export interface EbayDraftLabel {
  code: "speculative" | "self-anchored" | "fallback-rung" | "low-confidence";
  text: string;
}

export interface EbayDraftPricing {
  status: "engine" | "engine-declined" | "no-identity" | "engine-error";
  priceCents: number | null;
  /** The rung from the closed fmvRung vocabulary. */
  rungLabel: string | null;
  /** True iff the number came from the exact (identity, grade) pool. */
  exactPool: boolean;
  confidence: number | null;
  basis: string | null;
  compCount: number;
  range: { n: number; min: number; median: number; max: number } | null;
  computedAt: string | null;
  labels: EbayDraftLabel[];
  declineReason: string | null;
}

export interface EbaySellSignal {
  signal: "none" | "watch" | "sell-window" | "hold";
  horizon: "none" | "days-7-14" | "days-14-30";
  signalClass: "price" | "attention";
  basis: string;
  reason: string | null;
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

export interface EbayOfferStatus {
  success: boolean;
  offerId: string;
  status: string;
  listingId?: string;
  listingUrl?: string;
  price?: number;
  quantity?: number;
  categoryId?: string;
  marketplaceId?: string;
}

export async function fetchEbayOfferStatus(offerId: string): Promise<EbayOfferStatus> {
  return await request<EbayOfferStatus>(`/api/ebay/listings/${encodeURIComponent(offerId)}/status`);
}

export async function endEbayListing(offerId: string): Promise<{ success: boolean; error?: string }> {
  return await request<{ success: boolean; error?: string }>(
    `/api/ebay/listings/${encodeURIComponent(offerId)}/end`,
    { method: "POST" },
  );
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

// PUT /listings/:offerId/revise — updates a LIVE listing. Backend takes
// the flat `HoldingListingInput` shape (unlike publish which also
// accepts the nested prepared payload), so we flatten here. Any field
// left out of the prepared shape is either derivable or optional.
export async function reviseEbayListing(
  offerId: string,
  payload: EbayListingPrepared,
): Promise<EbayPublishResult> {
  const flat = flattenPreparedForRevise(payload);
  return await request<EbayPublishResult>(
    `/api/ebay/listings/${encodeURIComponent(offerId)}/revise`,
    { method: "PUT", body: JSON.stringify(flat) },
  );
}

function flattenPreparedForRevise(p: EbayListingPrepared): Record<string, unknown> {
  return {
    holdingId: p.holdingId,
    playerName: p.identity.playerName ?? "",
    cardTitle: p.listing.titleSuggested,
    cardYear: p.identity.cardYear ?? 0,
    brand: p.identity.setName?.split(" ")[0] ?? "",   // best-effort — backend fills the gaps
    setName: p.identity.setName ?? "",
    product: p.identity.setName ?? "",
    sport: (p.identity.sport ?? undefined) as string | undefined,
    cardNumber: p.identity.cardNumber ?? undefined,
    parallel: p.identity.parallel ?? undefined,
    isAuto: p.identity.isAuto,
    isPatch: false,
    isRookie: p.identity.isRookie,
    team: p.identity.team ?? undefined,
    grade: p.condition.grade ?? undefined,
    gradingCompany: p.condition.gradingCompany ?? undefined,
    certNumber: p.condition.certNumber ?? undefined,
    conditionNotes: p.condition.conditionNotes ?? undefined,
    conditionEstimate: p.condition.conditionEstimate ?? undefined,
    quantity: p.listing.quantity,
    listingPrice: p.listing.priceCents / 100,
    bestOfferEnabled: p.listing.bestOfferEnabled,
    bestOfferMinPrice: p.listing.bestOfferMinPriceCents != null
      ? p.listing.bestOfferMinPriceCents / 100
      : undefined,
    imageFrontUrl: p.photos[0],
    imageBackUrl: p.photos[1],
    photos: p.photos,
    description: p.listing.description,
  };
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

export interface AlertPreset {
  presetId: string;
  name: string;
  category: "portfolio_sell_signal" | "watchlist_move" | "grade_opportunity" | "market_dip";
  description: string;
  whyItMatters: string;
  scope: { type: string };
  combinator: "AND" | "OR";
  conditions: Array<Record<string, unknown>>;
  cooldownMin: number;
}

export interface AdvancedAlertRule {
  id: string;
  userId: string;
  name: string;
  scope: { type: string };
  combinator: "AND" | "OR";
  conditions: Array<Record<string, unknown>>;
  cooldownMin: number;
  active: boolean;
  createdAt: string;
  lastFiredAt?: string | null;
  presetId?: string | null;
}

export async function fetchAlertPresets(): Promise<{ success: boolean; presets: AlertPreset[] }> {
  return await request("/api/alerts/advanced/presets");
}

export async function activateAlertPreset(
  presetId: string,
  opts: { priceTarget?: number; customName?: string } = {},
): Promise<{ success: boolean; rule?: AdvancedAlertRule; error?: string }> {
  return await request(`/api/alerts/advanced/presets/${encodeURIComponent(presetId)}/activate`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export async function fetchAdvancedAlerts(): Promise<{ success: boolean; rules: AdvancedAlertRule[] }> {
  return await request("/api/alerts/advanced/");
}

export async function deleteAdvancedAlert(ruleId: string): Promise<{ success: boolean }> {
  return await request(`/api/alerts/advanced/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
  });
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

// CF-PLAYER-GRADE-TIERS (Drew, 2026-08-02). Player-level momentum
// sliced by grade tier — data from /api/players/:name (distinct from
// /api/playeriq/:name). Complementary macro view: "Trout PSA 10 up
// 8%, PSA 9 flat, Raw down 3%" across ALL his cards.
export interface PlayerGradeTier {
  tier: string;
  currentSampleCount: number;
  currentMedian: number;
  priorSampleCount: number;
  priorMedian: number | null;
  deltaPct: number | null;
  direction: "up" | "down" | "flat";
}
export interface PlayerDetail {
  player: string;
  sport: string;
  windowDays: number;
  computedAt: string;
  summary: unknown;
  gradeTiers?: PlayerGradeTier[];
  topCards?: unknown;
  byYear?: unknown;
}
export async function fetchPlayerDetail(name: string, days = 30): Promise<PlayerDetail> {
  return await request<PlayerDetail>(`/api/players/${encodeURIComponent(name)}?days=${days}`);
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

// ─── Market indexes ────────────────────────────────────────────────
// CF-MARKET-INDEXES (Drew, 2026-09-02). One call returns every sport's
// series + latest values, so the tile strip renders without a fan-out.

export interface IndexSeriesPoint {
  date: string;
  level: number;
  /** Members with a fresh (non-carried) value on this date. */
  freshMembers?: number;
  /** Share of basket weight actually valued (0..1). */
  usedWeight?: number;
  /** Level carried from a prior day, not computed for this one. */
  stale?: boolean;
  withheldReason?: string;
}

export interface SportIndexSeries {
  sport: string;
  series: IndexSeriesPoint[];
  latestLevel: number | null;
  changePct: number | null;
  windowDays: number;
  basketSize: number | null;
  asOf: string | null;
  /** Members with a fresh value on the newest point. The tile says
   *  "n of N fresh" whenever this is below the full basket, so a level
   *  computed from a thin basket cannot pass for a full one (H-12). */
  freshMembers?: number | null;
  usedWeight?: number | null;
  /** The newest point is carried because the basket went thin. */
  stale?: boolean;
  withheldReason?: string | null;
}

export interface MarketIndexesResponse {
  success: boolean;
  computedAt: string;
  windowDays: number;
  indexes: SportIndexSeries[];
}

export async function fetchMarketIndexes(days = 180): Promise<MarketIndexesResponse> {
  return await request<MarketIndexesResponse>(`/api/compiq/market-indexes?days=${days}`);
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
  cardsWithSlug: number;               // unique canonical cards in card_catalog
  productsIndexed?: number;            // distinct product structures — added 2026-08-05
  categories: number;
  sportsCovered: string[];
  // CF-NO-VENDOR-LEAK (Drew, 2026-08-05). Vendor-name array removed — only
  // the aggregate count crosses the network. If the backend hasn't rolled
  // yet the field will be missing, hence optional.
  dataSourceCount?: number;
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

// ─── BuyerIQ (card-show buying checklist) ──────────────────────────
// Mirrors iOS BuyerIQ. Backend: backend/src/routes/buyeriq.routes.ts

export type BuyerIqPriority = "high" | "medium" | "low";
export type BuyerIqStatus = "wanted" | "acquired" | "passed";

export interface BuyerIqList {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  showDate: string | null;
  showLocation: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BuyerIqTarget {
  id: string;
  userId: string;
  listId: string;
  hobbyiqCardId: string | null;
  playerName: string;
  cardYear: number | null;
  cardNumber: string | null;
  setName: string | null;
  parallel: string | null;
  isAuto: boolean | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  imageUrl: string | null;
  maxPrice: number | null;
  priority: BuyerIqPriority;
  notes: string | null;
  status: BuyerIqStatus;
  acquiredAt: string | null;
  acquiredPrice: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuyerIqListUpsert {
  name?: string;
  description?: string | null;
  showDate?: string | null;
  showLocation?: string | null;
  archived?: boolean;
}

export interface BuyerIqTargetUpsert {
  listId?: string;
  hobbyiqCardId?: string | null;
  playerName?: string;
  cardYear?: number | null;
  cardNumber?: string | null;
  setName?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  imageUrl?: string | null;
  maxPrice?: number | null;
  priority?: BuyerIqPriority;
  notes?: string | null;
  status?: BuyerIqStatus;
  acquiredAt?: string | null;
  acquiredPrice?: number | null;
}

export async function fetchBuyerIqLists(): Promise<{ success: boolean; lists: BuyerIqList[] }> {
  return await request("/api/buyeriq/lists");
}

export async function createBuyerIqList(body: BuyerIqListUpsert): Promise<{ success: boolean; list: BuyerIqList }> {
  return await request("/api/buyeriq/lists", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateBuyerIqList(listId: string, body: BuyerIqListUpsert): Promise<{ success: boolean; list: BuyerIqList }> {
  return await request(`/api/buyeriq/lists/${encodeURIComponent(listId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteBuyerIqList(listId: string): Promise<{ success: boolean }> {
  return await request(`/api/buyeriq/lists/${encodeURIComponent(listId)}`, {
    method: "DELETE",
  });
}

export async function fetchBuyerIqTargets(listId?: string): Promise<{ success: boolean; targets: BuyerIqTarget[] }> {
  const qs = listId ? `?listId=${encodeURIComponent(listId)}` : "";
  return await request(`/api/buyeriq/targets${qs}`);
}

export async function createBuyerIqTarget(body: BuyerIqTargetUpsert): Promise<{ success: boolean; target: BuyerIqTarget }> {
  return await request("/api/buyeriq/targets", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateBuyerIqTarget(targetId: string, body: BuyerIqTargetUpsert): Promise<{ success: boolean; target: BuyerIqTarget }> {
  return await request(`/api/buyeriq/targets/${encodeURIComponent(targetId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteBuyerIqTarget(targetId: string): Promise<{ success: boolean }> {
  return await request(`/api/buyeriq/targets/${encodeURIComponent(targetId)}`, {
    method: "DELETE",
  });
}

// ─── CF-USER-PRICE-ALERTS (Drew, 2026-09-02) ────────────────────────────────
// Per-holding "tell me when this card moves N%" rules. One rule per holding;
// PUT is an upsert keyed by holdingId, matching the backend's storage rule.

export type HoldingMoveDirection = "up" | "down" | "any";

export interface HoldingMoveRule {
  ruleId: string;
  userId: string;
  holdingId: string;
  thresholdPct: number;
  direction: HoldingMoveDirection;
  windowHours: number;
  isActive: boolean;
  createdAt: string;
  lastFiredValue: number | null;
  lastFiredAt: string | null;
  triggerCount: number;
}

export async function fetchHoldingMoveRule(
  holdingId: string,
): Promise<{ success: boolean; rule: HoldingMoveRule | null; dailyCap: number }> {
  return await request(`/api/alerts/holding-moves/${encodeURIComponent(holdingId)}`);
}

export async function saveHoldingMoveRule(
  holdingId: string,
  body: {
    thresholdPct: number;
    direction: HoldingMoveDirection;
    windowHours: number;
    isActive?: boolean;
  },
): Promise<{ success: boolean; rule: HoldingMoveRule }> {
  return await request(`/api/alerts/holding-moves/${encodeURIComponent(holdingId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteHoldingMoveRule(holdingId: string): Promise<{ success: boolean }> {
  return await request(`/api/alerts/holding-moves/${encodeURIComponent(holdingId)}`, {
    method: "DELETE",
  });
}

// ─── BuyerIQ deal scanner ─────────────────────────────────────────────
// Backend: GET /api/buyeriq/deals (buyeriq.routes.ts → dealFeed.service).
// Live asks compared against each card's canonical projected next sale.

/** Why a target did not produce a deal. */
export type BuyerIqDealRefusal =
  | "no-basis"
  | "speculative-confidence"
  | "below-threshold"
  | "no-listing-price";

/** Why a LISTING was not comparable to the target (CF-BUYERIQ-GRADE-
 *  AWARE-MATCH, 2026-09-03). Identity includes grade tier: a raw ask is
 *  not a discount on a PSA 10, and a listing whose grade we cannot read
 *  is not scored at all rather than assumed into either tier. */
export type BuyerIqGradeMismatchReason =
  | "grade-unknown"
  | "listing-raw-target-graded"
  | "listing-graded-target-raw"
  | "grade-company-mismatch"
  | "grade-value-mismatch";

/** The evidence behind a flagged deal — what the discount is measured
 *  against, and how much that projection is trusted. */
export interface BuyerIqDealBasis {
  projection: number;
  rung: string | null;
  exactPool: boolean;
  confidence: number;
  discountPct: number;
  requiredDiscountPct: number;
}

export interface BuyerIqDealListing {
  listingId: string;
  title: string;
  price: number;
  currency: string;
  itemWebUrl: string;
  imageUrl: string | null;
  sellerHandle: string | null;
  endsAt: string | null;
}

export interface BuyerIqDeal {
  targetId: string;
  listId: string;
  playerName: string;
  cardYear: number | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  listing: BuyerIqDealListing;
  /** The grade tier read off the listing title and verified equal to
   *  the target tier before scoring ("PSA 10", "Raw"). */
  matchedTier: string;
  basis: BuyerIqDealBasis;
  discountPctDisplay: number;
  requiredDiscountPctDisplay: number;
  savingsVsProjection: number;
}

export interface BuyerIqSkippedTarget {
  targetId: string;
  playerName: string;
  reason: BuyerIqDealRefusal | BuyerIqGradeMismatchReason | "no-listings" | "no-player-name";
  basis: BuyerIqDealBasis | null;
  /** Listings that matched the card but not the TIER, by reason. Lets
   *  the page say "2 listed, both raw" instead of "nothing listed". */
  gradeRejections?: Partial<Record<BuyerIqGradeMismatchReason, number>>;
}

export interface BuyerIqDealFeed {
  success: boolean;
  deals: BuyerIqDeal[];
  /** False when the vendor-call budget ran out mid-scan. The feed is
   *  then a PARTIAL view — do not present it as the whole market. */
  complete: boolean;
  stoppedReason: "vendor-call-budget-exhausted" | null;
  targetsUnexamined: number;
  targetsScanned: number;
  targetsEligible: number;
  skipped: BuyerIqSkippedTarget[];
  budget: { remaining: number; spent: number; cacheHits: number; limit: number };
  baseDiscountPct: number;
  scannedAt: string;
}

export async function fetchBuyerIqDeals(opts?: {
  listId?: string;
  /** Base discount at full confidence, as a fraction (0.20 = 20% under). */
  threshold?: number;
}): Promise<BuyerIqDealFeed> {
  const qs = new URLSearchParams();
  if (opts?.listId) qs.set("listId", opts.listId);
  if (typeof opts?.threshold === "number") qs.set("threshold", String(opts.threshold));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return await request(`/api/buyeriq/deals${suffix}`);
}

// ─── Pro Seller workspace (CF-PRO-SELLER-WORKSPACE, 2026-09-02) ─────
//
// One page composes six independent seller surfaces. Several of them are
// still in open PRs on the day this ships, so the page is written to merge
// in ANY order relative to them: each section asks its own endpoint, and an
// endpoint the deployed backend does not have yet answers 404. A 404 is not
// a failure here — it means "not built yet", and the section hides.
//
// The three outcomes a section can land on, and why they are different:
//
//   404 / 501  → the backing PR has not merged (or has not deployed). The
//                section renders NOTHING. No error, no empty state, no
//                "coming soon" — the page simply has one fewer section.
//   402 / 403  → the API exists and the caller has not paid for it. That is
//                the ENTITLEMENT gate, enforced server-side by
//                requireEntitlement("erpReconciliation") and friends; the
//                page renders the upsell, never data.
//   anything   → a real failure. The section says so, in its own box, and
//   else         the rest of the page still renders.
//
// Keeping 404 and 402 apart is the whole point. Collapsing them would make a
// free-tier user think the feature does not exist (losing the upsell), and
// make a paying user think they had not paid (a support ticket).

/** What a feature-detected section resolved to. */
export type SectionOutcome<T> =
  | { state: "ready"; data: T }
  /** Backing API absent from this deployment — render nothing at all. */
  | { state: "absent" }
  /** API present, caller not entitled. `requiredTier` comes from the 402 body. */
  | { state: "locked"; requiredTier?: string | null }
  | { state: "error"; message: string };

/**
 * Statuses that mean "this deployment does not serve that route".
 *
 * 404 is the honest one — Express has no handler, so the app's 404 fires.
 * 501 is included because a route may land ahead of its implementation
 * behind a not-implemented guard. 405 is NOT here: a wrong method on a real
 * route is our bug, and should surface as an error rather than vanish.
 */
const ABSENT_STATUSES = new Set([404, 501]);

/** Statuses the entitlement middleware answers with. `requireEntitlement`
 *  returns 402; some older gated routes answer 403. Both mean "pay for it",
 *  and both are handled identically everywhere else in this app (see
 *  /app/erp, /app/daily, /app/insights). */
const LOCKED_STATUSES = new Set([402, 403]);

/**
 * Run one section's fetch and classify the result. Never throws: a section
 * failing is a section-shaped hole, never a blank page.
 */
export async function resolveSection<T>(
  load: () => Promise<T>,
): Promise<SectionOutcome<T>> {
  try {
    return { state: "ready", data: await load() };
  } catch (err) {
    const e = err as ApiError & { requiredTier?: string | null };
    const status = e?.status;
    if (status != null && ABSENT_STATUSES.has(status)) return { state: "absent" };
    if (status != null && LOCKED_STATUSES.has(status)) {
      return { state: "locked", requiredTier: e.requiredTier ?? null };
    }
    return { state: "error", message: e?.message ?? "Failed to load" };
  }
}

// Grade arbitrage — the portfolio-wide grade-worthy scan. Already served by
// GET /api/portfolio/grade-worthy-alerts; typed here for the first time.
// Each candidate reuses the GradeWorthyAnalysis shape the per-holding
// grade-analysis endpoint already returns, so the two surfaces cannot drift.
export interface GradeArbCandidate {
  holdingId: string;
  cardTitle: string;
  player: string;
  year: number | null;
  set: string;
  variant: string;
  number: string;
  analysis: GradeWorthyAnalysis;
}

export interface GradeArbResponse {
  scannedHoldings: number;
  gradeWorthyCount: number;
  candidates: GradeArbCandidate[];
}

export async function fetchGradeArbOpportunities(): Promise<GradeArbResponse> {
  // Slow by construction: the route fans out over every raw holding at
  // concurrency 6, each hitting Cosmos. The default 30s timeout aborts a
  // real answer on a large portfolio, so this one gets the longer budget
  // rather than reporting a timeout the server did not have.
  return await request<GradeArbResponse>("/api/portfolio/grade-worthy-alerts", {
    timeoutMs: 90_000,
  });
}
