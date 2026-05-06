// Shared API service layer for HobbyIQ frontend
import type { CompIQRequest, CompIQResponse } from "../types/compiq";
import type { PlayerIQRequest, PlayerIQResponse } from "../types/playeriq";
import { apiFetch as apiClientFetch } from "./client";

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  return apiClientFetch<T>(path, { ...options, auth: true });
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
