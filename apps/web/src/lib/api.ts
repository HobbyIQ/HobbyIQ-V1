// HobbyIQ web — backend fetch helper. Talks to the same Node/TS API
// that serves iOS. Session model is `x-session-id` header on every
// authenticated call; token is minted by /api/auth/login and stored
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

// ─── Auth ──────────────────────────────────────────────────────────

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const res = await request<{ success: true; sessionId: string; user: AuthUser }>(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
      auth: false,
    },
  );
  setStoredSessionId(res.sessionId);
  return res.user;
}

export async function signUp(email: string, password: string): Promise<AuthUser> {
  const res = await request<{ success: true; sessionId: string; user: AuthUser }>(
    "/api/auth/register",
    {
      method: "POST",
      body: JSON.stringify({ email, password }),
      auth: false,
    },
  );
  setStoredSessionId(res.sessionId);
  return res.user;
}

export async function fetchSessionUser(): Promise<AuthUser | null> {
  const sid = getStoredSessionId();
  if (!sid) return null;
  try {
    const res = await request<{ user: AuthUser }>("/api/auth/session");
    return res.user;
  } catch {
    clearStoredSessionId();
    return null;
  }
}

export function signOut(): void {
  clearStoredSessionId();
}
