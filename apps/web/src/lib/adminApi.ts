// CF-ADMIN-API (Drew, 2026-07-28). Client for the admin-gated backend
// surfaces (verify queue + data-quality report). ADMIN_API_TOKEN lives
// in App Service application settings; the web UI collects it once
// and stashes in localStorage (session-scoped — user can rotate at
// any time from the UI).
//
// Kept separate from lib/api.ts because the auth model differs:
// user endpoints use `x-session-id`; admin endpoints use
// `Authorization: Bearer <ADMIN_API_TOKEN>`.

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

const ADMIN_TOKEN_KEY = "hobbyiq_admin_token";

export function getStoredAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setStoredAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearStoredAdminToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ADMIN_TOKEN_KEY);
}

// CF-ADMIN-REQ-TIMEOUT (Drew, 2026-08-02). 15s hard timeout on every
// admin API call. Prior behavior: a hung endpoint (like /cleanliness/
// anomalies during heavy backfill load) left the dashboard's
// Promise.all in Loading state forever because .catch(() => null)
// only handles rejections, not hangs. AbortSignal.timeout makes the
// fetch reject at 15s so the dashboard falls back to whatever data
// did resolve.
const ADMIN_REQ_TIMEOUT_MS = 15_000;

async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredAdminToken();
  if (!token) throw new Error("Admin token not set");
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(ADMIN_REQ_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.reason ?? res.statusText);
  }
  return body as T;
}

// ─── Data quality ─────────────────────────────────────────────────

export interface DataQualityReport {
  totalRows: number;
  cutoffDays: number;
  buckets: {
    verified: number;
    catalogMatched: number;
    autoParsed: number;
    uncertain: number;
    flagged: number;
    pendingVerify: number;
  };
  trustScore: number;
  trustPercentageDisplay: string;
  bySource: Record<string, { total: number; uncertain: number; flagged: number; uncertainPct: number }>;
  topFlagReasons: Array<{ reason: string; count: number }>;
  computedAt: string;
}

export async function fetchDataQualityReport(cutoffDays = 180): Promise<DataQualityReport> {
  const { report } = await adminRequest<{ success: boolean; report: DataQualityReport }>(
    `/api/data-quality/report?cutoffDays=${cutoffDays}`,
  );
  return report;
}

// ─── Verify queue ─────────────────────────────────────────────────

export type VerifyReason =
  | "price-outlier"
  | "parser-low-confidence"
  | "slug-conflict"
  | "cross-source-mismatch"
  | "sample-audit"
  | "manual"
  | "divergence-alert"
  | "catalog-gap"
  | "parallel-price-mismatch"
  | "image-mismatch";

export interface VerifyQueueItem {
  id: string;
  reason: VerifyReason;
  status: "pending" | "approved" | "rejected" | "fixed";
  observedAt: string;
  input: {
    cardId: string;
    playerName: string;
    cardYear?: number | null;
    setName?: string | null;
    parallel?: string | null;
    cardNumber?: string | null;
    isAuto?: boolean;
    gradeCompany?: string | null;
    gradeValue?: number | null;
    price: number;
    soldAt: string;
    source: string;
    title?: string | null;
    imageUrl?: string | null;
    url?: string | null;
  };
  signal?: {
    rollingMedian?: number;
    ratio?: number;
    note?: string;
  };
}

export async function fetchVerifyQueue(reason?: VerifyReason, limit = 50): Promise<{
  items: VerifyQueueItem[];
  continuation?: string;
}> {
  const params = new URLSearchParams();
  if (reason) params.set("reason", reason);
  params.set("limit", String(limit));
  return adminRequest(`/api/verify/queue?${params.toString()}`);
}

export async function fetchVerifyQueueCount(reason?: VerifyReason): Promise<number> {
  const params = new URLSearchParams();
  if (reason) params.set("reason", reason);
  const { count } = await adminRequest<{ success: boolean; count: number }>(
    `/api/verify/queue/count?${params.toString()}`,
  );
  return count;
}

export async function resolveVerifyItem(
  reason: VerifyReason,
  id: string,
  action: "approve" | "reject" | "fix",
  correction?: {
    parallel?: string | null;
    cardNumber?: string | null;
    isAuto?: boolean;
    gradeCompany?: string | null;
    gradeValue?: number | null;
    price?: number;
    soldAt?: string;
    reasonNote?: string;
  },
  adminUserId = "admin-web",
): Promise<void> {
  await adminRequest(`/api/verify/queue/${reason}/${id}`, {
    method: "POST",
    body: JSON.stringify({ action, correction, adminUserId }),
  });
}

// ─── Variant labeler ──────────────────────────────────────────────

export interface CanonicalLabel {
  parallel: string;
  isRefractor: boolean;
  printRun: number | null;
  setSlug: string;
  labeledBy: string;
  labeledAt: string;
}

export interface VariantView {
  cardCatalogId: string;
  chCardId: string;
  chVariant: string;
  set: string;
  imageUrl: string | null;
  matchedSoldCompsCount: number;
  currentLabel: CanonicalLabel | null;
}

export interface VariantsResponse {
  cardNumber: string;
  cardYear: number | null;
  player: string;
  variants: VariantView[];
  unmatchedSoldCompsCount: number;
}

export async function fetchLabelerVariants(cardNumber: string, cardYear: number | null): Promise<VariantsResponse> {
  const params = new URLSearchParams({ cardNumber });
  if (cardYear != null) params.set("cardYear", String(cardYear));
  const r = await adminRequest<{ success: boolean } & VariantsResponse>(
    `/api/labeler/variants?${params.toString()}`,
  );
  return r;
}

export interface SaveLabelInput {
  cardCatalogId: string;
  cardNumber: string;
  cardYear: number;
  set: string;
  chVariant: string;
  canonicalParallel: string;
  isRefractor: boolean;
  printRun: number | null;
  labeledBy: string;
  applyToSoldComps?: boolean;
  sport?: string;
}

export async function saveLabelerLabel(input: SaveLabelInput): Promise<{
  cardCatalogUpdated: boolean;
  soldCompsRewritten: number;
  newSlugSample: string;
}> {
  return adminRequest(`/api/labeler/label`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface AiSuggestInput {
  chVariant: string;
  set: string;
  cardNumber: string;
  cardYear: number;
  playerName: string;
  imageUrl: string | null;
  currentGuess?: string;
}

export interface AiSuggestOutput {
  parallel: string;
  printRun: number | null;
  isRefractor: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  usedImage: boolean;
}

export async function aiSuggestLabel(input: AiSuggestInput): Promise<AiSuggestOutput> {
  const r = await adminRequest<{ success: boolean; suggestion: AiSuggestOutput }>(
    `/api/labeler/ai-suggest`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return r.suggestion;
}

export interface LabelerQueueCandidate {
  cardNumber: string;
  cardYear: number | null;
  playerName: string;
  portfolioHits: number;
  unlabeledVariants: number;
  totalVariants: number;
  soldCompsCount: number;
  priority: number;
}

export async function fetchLabelerQueue(limit = 25): Promise<LabelerQueueCandidate[]> {
  const r = await adminRequest<{ success: boolean; items: LabelerQueueCandidate[] }>(
    `/api/labeler/queue?limit=${limit}`,
  );
  return r.items;
}

// ─── Cleanliness dashboard ────────────────────────────────────────

export interface CleanlinessReport {
  totalRows: number;
  bySource: Record<string, number>;
  slug: {
    withValid: number;
    missingOrInvalid: number;
    validPct: number;
  };
  identity: {
    withCardNumber: number;
    withPlayerName: number;
    withCardYear: number;
    missingAny: number;
  };
  flags: {
    priceOutliers: number;
    cardsightUnverified: number;
    catalogCanonicalized: number;
    stage2TitleParsed: number;
    priceOutlierBelowFloor: number;
    priceOutlierAboveCeiling: number;
  };
  cleanliness: { score: number; label: string };
  computedAt: string;
}

export async function fetchCleanlinessReport(): Promise<CleanlinessReport> {
  const r = await adminRequest<{ success: boolean; report: CleanlinessReport }>(
    `/api/cleanliness/report`,
  );
  return r.report;
}

export async function refreshCleanlinessReport(): Promise<CleanlinessReport> {
  const r = await adminRequest<{ success: boolean; report: CleanlinessReport }>(
    `/api/cleanliness/refresh`,
    { method: "POST" },
  );
  return r.report;
}

// ─── Quarantine browser ───────────────────────────────────────────

export type QuarantineFilter = "any" | "price-outlier" | "cardsight-unverified" | "user-flagged" | "bad-actor";

export interface QuarantineRow {
  id: string;
  cardId: string;
  playerName: string | null;
  cardYear: number | null;
  cardNumber: string | null;
  parallel: string | null;
  price: number;
  source: string;
  soldAt: string | null;
  title: string | null;
  imageUrl: string | null;
  hobbyiqCardId: string | null;
  flags: {
    priceOutlier: boolean;
    priceOutlierBand?: string | null;
    priceOutlierPoolMedian?: number | null;
    cardsightUnverified: boolean;
    userFlagQuarantine: boolean;
    userFlagCount: number;
    badActorSeller: boolean;
  };
  flagCount: number;
}

export async function fetchQuarantine(filter: QuarantineFilter = "any", limit = 50): Promise<{
  items: QuarantineRow[];
  totalReturned: number;
  hasMore: boolean;
  filter: string;
}> {
  const params = new URLSearchParams({ filter, limit: String(limit) });
  const r = await adminRequest<{ success: boolean; items: QuarantineRow[]; totalReturned: number; hasMore: boolean; filter: string }>(
    `/api/quarantine/list?${params.toString()}`,
  );
  return r;
}

export async function clearQuarantineRow(cardId: string, rowId: string): Promise<void> {
  await adminRequest(`/api/quarantine/${encodeURIComponent(cardId)}/${encodeURIComponent(rowId)}/clear`, { method: "POST" });
}

export async function forceQuarantineRow(cardId: string, rowId: string, reason: string): Promise<void> {
  await adminRequest(`/api/quarantine/${encodeURIComponent(cardId)}/${encodeURIComponent(rowId)}/quarantine`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

// ─── Catalog review queue (Drew 2026-08-08) ───────────────────────

export interface CatalogReviewItem {
  type: "user-seeded" | "vendor-unmatched";
  slug: string;
  cardYear: number | null;
  sport: string | null;
  setName: string | null;
  setKey: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  playerName: string | null;
  source: string;
  confidence: number | null;
  sampleTitles: string[];
  stagedCompCount: number;
  observedAt: string | null;
}

export async function fetchCatalogReviewQueue(
  type: "user-seeded" | "vendor-unmatched" | "all" = "all",
  limit = 50,
): Promise<{
  items: CatalogReviewItem[];
  counts: { userSeeded: number; vendorUnmatched: number; total: number };
}> {
  const params = new URLSearchParams({ type, limit: String(limit) });
  const r = await adminRequest<{
    success: boolean;
    items: CatalogReviewItem[];
    counts: { userSeeded: number; vendorUnmatched: number; total: number };
  }>(`/api/admin/catalog-review/queue?${params.toString()}`);
  return { items: r.items, counts: r.counts };
}

export async function approveCatalogReview(
  slug: string,
  type: "user-seeded" | "vendor-unmatched",
  note?: string,
): Promise<{ ok: boolean; staged?: number; error?: string }> {
  return await adminRequest(`/api/admin/catalog-review/approve`, {
    method: "POST",
    body: JSON.stringify({ slug, type, note }),
  });
}

export async function rejectCatalogReview(
  slug: string,
  type: "user-seeded" | "vendor-unmatched",
): Promise<{ ok: boolean; staged?: number; error?: string }> {
  return await adminRequest(`/api/admin/catalog-review/reject`, {
    method: "POST",
    body: JSON.stringify({ slug, type }),
  });
}

export async function bulkCatalogReview(
  action: "approve" | "reject",
  items: Array<{ slug: string; type: "user-seeded" | "vendor-unmatched" }>,
): Promise<{
  succeeded: number;
  failed: number;
  total: number;
  results: Array<{ slug: string; ok: boolean; staged?: number; error?: string }>;
}> {
  const r = await adminRequest<{
    success: boolean;
    succeeded: number;
    failed: number;
    total: number;
    results: Array<{ slug: string; ok: boolean; staged?: number; error?: string }>;
  }>(`/api/admin/catalog-review/bulk`, {
    method: "POST",
    body: JSON.stringify({ action, items }),
  });
  return { succeeded: r.succeeded, failed: r.failed, total: r.total, results: r.results };
}

export interface ChecklistDiffResult {
  parsed: number;
  inCatalog: Array<{ cardNumber: string; player: string; matchedSlug: string }>;
  missingFromCatalog: Array<{ cardNumber: string; player: string }>;
  extraInCatalog: Array<{ cardNumber: string; playerName: string | null; slug: string; verificationStatus?: string | null }>;
  setKey: string;
  year: number;
}

export async function fetchChecklistDiff(
  checklistText: string,
  year: number,
  setName: string,
  sport?: string,
): Promise<ChecklistDiffResult> {
  const r = await adminRequest<{ success: boolean } & ChecklistDiffResult>(
    `/api/admin/catalog-review/checklist-diff`,
    {
      method: "POST",
      body: JSON.stringify({ checklistText, year, setName, sport }),
    },
  );
  return {
    parsed: r.parsed,
    inCatalog: r.inCatalog,
    missingFromCatalog: r.missingFromCatalog,
    extraInCatalog: r.extraInCatalog,
    setKey: r.setKey,
    year: r.year,
  };
}

// ─── Learning summary ─────────────────────────────────────────────

export interface LearningSummary {
  totalEvents: number;
  byType: Record<string, number>;
  byActor: Record<string, number>;
  last7Days: number;
  last30Days: number;
}

export async function fetchLearningSummary(): Promise<LearningSummary> {
  const r = await adminRequest<{ success: boolean; summary: LearningSummary }>(
    `/api/cleanliness/learning`,
  );
  return r.summary;
}

export interface LearnedWeights {
  computedAt: string;
  trainingEventCount: number;
  weights: Record<string, number>;
  signalStats: Record<string, { positive: number; negative: number; correlation: number }>;
  version: number;
}

export async function fetchLearnedWeights(): Promise<LearnedWeights | null> {
  const r = await adminRequest<{ success: boolean; weights: LearnedWeights | null }>(
    `/api/cleanliness/current-weights`,
  );
  return r.weights;
}

export async function trainConfidenceWeights(days = 30): Promise<{ learned: LearnedWeights | null; message?: string }> {
  const r = await adminRequest<{ success: boolean; learned?: LearnedWeights; message?: string }>(
    `/api/cleanliness/train-weights?days=${days}`,
    { method: "POST" },
  );
  return { learned: r.learned ?? null, message: r.message };
}

export interface SlugAuditRow {
  slug: string;
  sampleCount: number;
  median: number;
  min: number;
  max: number;
  contaminationPct: number;
  flaggedCount: number;
  bySource: Record<string, number>;
  lastActivityAt: string | null;
}

export interface SlugAuditReport {
  totalSlugs: number;
  topByVolume: SlugAuditRow[];
  topByContamination: SlugAuditRow[];
  computedAt: string;
  minSampleFilter: number;
}

export async function fetchSlugAudit(force = false): Promise<SlugAuditReport> {
  const params = force ? "?force=true" : "";
  const r = await adminRequest<{ success: boolean; report: SlugAuditReport }>(
    `/api/cleanliness/slug-audit${params}`,
  );
  return r.report;
}

export interface FmvAccuracySummary {
  totalEvents: number;
  last7Days: number;
  last30Days: number;
  medianDeltaPct: number;
  meanDeltaPct: number;
  within5PctRate: number;
  within10PctRate: number;
  within20PctRate: number;
  within50PctRate: number;
  worstSlugs: Array<{ slug: string; sampleCount: number; medianDeltaPct: number }>;
  bestSlugs: Array<{ slug: string; sampleCount: number; medianDeltaPct: number }>;
  computedAt: string;
}

export async function fetchFmvAccuracy(): Promise<FmvAccuracySummary> {
  const r = await adminRequest<{ success: boolean; summary: FmvAccuracySummary }>(
    `/api/cleanliness/fmv-accuracy`,
  );
  return r.summary;
}

export interface AnomalyRow {
  slug: string;
  baselineMedian: number;
  currentMedian: number;
  driftPct: number;
  driftDirection: "up" | "down";
  baselineSample: number;
  currentSample: number;
  sampleGrowthPct: number;
  suspiciousness: "high" | "medium" | "low";
}

export interface AnomalyReport {
  baselineDate: string;
  slugsWithBaseline: number;
  slugsChanged: number;
  anomalies: AnomalyRow[];
  computedAt: string;
}

export async function fetchAnomalies(): Promise<AnomalyReport> {
  const r = await adminRequest<{ success: boolean; report: AnomalyReport }>(
    `/api/cleanliness/anomalies`,
  );
  return r.report;
}
