// Shared API service layer for HobbyIQ frontend
import type { CompIQRequest, CompIQResponse } from "../types/compiq";
import type { PlayerIQRequest, PlayerIQResponse } from "../types/playeriq";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

function getApiUrl(path: string) {
  if (path.startsWith("http")) return path;
  if (API_BASE_URL) {
    return `${API_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : "/" + path}`;
  }
  return path;
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = getApiUrl(path);
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    throw new Error("Network error. Please check your connection.");
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function fetchCompIQ(query: CompIQRequest): Promise<CompIQResponse> {
  return apiFetch<CompIQResponse>("/api/compiq/live-estimate", {
    method: "POST",
    body: JSON.stringify(query),
  });
}

export async function fetchPlayerIQ(player: PlayerIQRequest): Promise<PlayerIQResponse> {
  return apiFetch<PlayerIQResponse>("/api/playeriq/evaluate", {
    method: "POST",
    body: JSON.stringify(player),
  });
}
