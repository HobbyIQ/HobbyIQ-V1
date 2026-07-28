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
