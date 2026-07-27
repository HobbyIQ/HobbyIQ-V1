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
  plan?: "free" | "collector" | "investor" | "pro_seller" | string;
  expiresAt?: string | null;
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
