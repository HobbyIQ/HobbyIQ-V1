export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const SESSION_STORAGE_KEY = "hobbyiq_session_id";

export interface AuthUser {
  userId: string;
  email: string;
  plan: "free" | "pro" | "all-star";
  createdAt: string;
}

interface AuthResult {
  success: boolean;
  user?: AuthUser;
  sessionId?: string;
  error?: string;
}

interface ApiFetchOptions extends RequestInit {
  auth?: boolean;
}

function getApiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  if (!API_BASE_URL) {
    return path;
  }

  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getStoredSessionId(): string {
  return localStorage.getItem(SESSION_STORAGE_KEY) || "";
}

export function setStoredSessionId(sessionId: string): void {
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { auth = false, headers, ...rest } = options;
  const sessionId = getStoredSessionId();

  const mergedHeaders: Record<string, string> = {
    ...(headers as Record<string, string> | undefined),
  };

  if (!(rest.body instanceof FormData) && !mergedHeaders["Content-Type"]) {
    mergedHeaders["Content-Type"] = "application/json";
  }

  if (auth && sessionId) {
    mergedHeaders["x-session-id"] = sessionId;
  }

  const response = await fetch(getApiUrl(path), {
    ...rest,
    headers: mergedHeaders,
  });

  let payload: any;
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    payload = await response.text();
  }

  if (!response.ok) {
    if (auth && response.status === 401) {
      clearStoredSessionId();
    }
    const message =
      (payload && typeof payload === "object" && (payload.error || payload.message)) ||
      `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  return payload as T;
}

export async function signIn(username: string, password: string): Promise<{ user: AuthUser; sessionId: string }> {
  const response = await apiFetch<AuthResult>("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

  if (!response.success || !response.user || !response.sessionId) {
    throw new Error(response.error || "Unable to sign in");
  }

  setStoredSessionId(response.sessionId);
  return { user: response.user, sessionId: response.sessionId };
}

export async function signOut(): Promise<void> {
  const sessionId = getStoredSessionId();
  if (sessionId) {
    try {
      await apiFetch<AuthResult>("/api/auth/signout", {
        method: "POST",
        auth: true,
      });
    } catch {
      // Local sign-out should proceed even if network sign-out fails.
    }
  }
  clearStoredSessionId();
}

export async function fetchSessionUser(): Promise<AuthUser> {
  const response = await apiFetch<{ success: boolean; user?: AuthUser; error?: string }>("/api/auth/session", {
    method: "GET",
    auth: true,
  });

  if (!response.success || !response.user) {
    throw new Error(response.error || "Invalid session");
  }

  return response.user;
}