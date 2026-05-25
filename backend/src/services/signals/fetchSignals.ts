// Player-momentum signal fetch — Layer 1 input for TrendIQ.
//
// Queries the Azure Function aggregator's serve-signals endpoint and
// returns the player's current aggregated multiplier + signal flags.
// Aggregator updates ~every 2 hours and is responsible for the 0.70..1.50
// clamp; we defensively re-clamp on read.
//
// PROVENANCE: ported 2026-05-25 from mcp-server/pricing.ts:223-271.
// FOLLOWUP: see signals.types.ts for the shared-workspace extraction
// criteria.
//
// Return contract:
//   - SignalPayload  → real aggregator data (use in TrendIQ Layer 1)
//   - null           → URL unconfigured, fetch failed, non-OK response,
//                      or aggregator returned the NEUTRAL_SIGNAL fallback
//                      (signal_flags includes "signal_unavailable").
//                      TrendIQ treats null as "Layer 1 absent" and drops
//                      it from the composite per the 8-row weight table.

import {
  type SignalPayload,
  NEUTRAL_SIGNAL,
} from "./signals.types.js";
import { trackHttpDependency } from "./telemetry.js";

const SIGNAL_URL = process.env.AZURE_SIGNAL_FUNCTION_URL ?? "";
const SIGNAL_KEY = process.env.AZURE_SIGNAL_FUNCTION_KEY ?? "";

// Tighter than mcp-server's 5s — backend's /api/compiq/price is on an
// interactive request path. Signal fetch in parallel with broaderTrend
// fetch; a 3s budget keeps the worst-case latency bounded.
const SIGNAL_FETCH_TIMEOUT_MS = 3_000;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export interface FetchPlayerSignalsResult {
  payload: SignalPayload | null;
  sourceUrl: string | null;
}

export async function fetchPlayerSignals(
  playerName: string,
): Promise<FetchPlayerSignalsResult> {
  if (!SIGNAL_URL || !playerName) {
    return { payload: null, sourceUrl: null };
  }

  const url = new URL(SIGNAL_URL);
  url.searchParams.set("player", playerName);
  if (SIGNAL_KEY) url.searchParams.set("code", SIGNAL_KEY);
  const fullUrl = url.toString();
  const sanitizedUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const start = Date.now();

  try {
    const resp = await fetch(fullUrl, {
      signal: AbortSignal.timeout(SIGNAL_FETCH_TIMEOUT_MS),
    });
    trackHttpDependency({
      name: "signal_service",
      url: fullUrl,
      startMs: start,
      resultCode: resp.status,
      success: resp.ok,
    });
    if (!resp.ok) return { payload: null, sourceUrl: sanitizedUrl };

    const data = (await resp.json()) as Partial<SignalPayload>;
    const flags = data.signal_flags ?? [];
    if (flags.includes("signal_unavailable")) {
      return { payload: null, sourceUrl: sanitizedUrl };
    }

    const mult = clamp(Number(data.final_multiplier ?? 1.0), 0.7, 1.5);
    return {
      payload: {
        ...NEUTRAL_SIGNAL,
        ...data,
        final_multiplier: mult,
        signal_flags: flags,
        components: data.components ?? {},
      },
      sourceUrl: sanitizedUrl,
    };
  } catch (err) {
    trackHttpDependency({
      name: "signal_service",
      url: fullUrl,
      startMs: start,
      resultCode: 0,
      success: false,
      error: err as Error,
    });
    return { payload: null, sourceUrl: sanitizedUrl };
  }
}
