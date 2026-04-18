// API client for DailyIQ
import type { DailyIQBrief } from "../types/dailyiq";

export async function fetchDailyIQBrief(): Promise<DailyIQBrief> {
  const res = await fetch("/api/dailyiq/brief");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
