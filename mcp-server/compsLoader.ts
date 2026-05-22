// Backend-backed comp loader for the MCP server.
//
// Phase 1 CH removal (refs c285c33 + WS2 ship at 9124e54): replaces the
// prior blob-read pattern (compiq-signals/{player-slug}/cardhedge.json,
// written nightly by fn-cardhedge-comps) with a call to backend's
// /api/compiq/price endpoint. Backend's /price now routes its comps
// through findCompsRouted → resolveCardId → Cardsight getPricing under
// CARDSIGHT_MODE=exclusive.
//
// MCP server is on the admin path only (called by fn-backtest-runner).
// Latency budget tolerates Cardsight's first-call p50 ~9–10s; subsequent
// calls hit backend's 15-min Redis cache + cardsight.client's 6h cache.
//
// Function signature preserved (callers in server.ts:223 and
// backtest.ts:239 unchanged). playerSlug export removed — cardhedge.ts
// has its own local copy and no other module imported the one from here.

import type { CardComp } from "./pricing.js";

const BACKEND_URL =
  process.env.HOBBYIQ_BACKEND_URL ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";
const FETCH_TIMEOUT_MS = 30_000; // Cardsight first-call p50 ~9-10s; headroom.

interface BackendPriceResponse {
  success?: boolean;
  recentComps?: Array<{
    price?: number;
    title?: string;
    soldDate?: string | null;
    grade?: string;
  }>;
}

export async function fetchPlayerComps(
  playerName: string,
  preferredGrade?: string,
): Promise<CardComp[]> {
  if (!playerName?.trim()) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND_URL}/api/compiq/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: playerName }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(
        `[compsLoader] backend /price returned ${res.status} for "${playerName}"`,
      );
      return [];
    }

    const body = (await res.json()) as BackendPriceResponse;
    if (!body.recentComps?.length) return [];

    return body.recentComps
      .filter((c) => Number.isFinite(Number(c.price)) && Number(c.price) > 0)
      .map<CardComp>((c) => ({
        price: Number(c.price),
        date: c.soldDate ?? "",
        grade: c.grade ?? preferredGrade ?? "Raw",
        source: "cardsight",
        title: c.title,
      }));
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[compsLoader] backend /price failed for "${playerName}": ${msg}`,
    );
    return [];
  }
}
