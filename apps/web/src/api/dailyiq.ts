// API client for DailyIQ
import type { DailyIQBrief } from "../types/dailyiq";
import { apiFetch } from "./client";

export async function fetchDailyIQBrief(): Promise<DailyIQBrief> {
  return apiFetch<DailyIQBrief>("/api/dailyiq/brief", { auth: true });
}
