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
//
// PHASE-4B-SLICE-1 (2026-06-01): every code path emits a structured
// `[compiq.signal_fetch_observed]` console.log so we can definitively
// answer "is the backend ACTUALLY calling fn-serve-signals?" without
// depending on trackHttpDependency (which is auto-instrumentation gap
// CF-APPINSIGHTS-FETCH-INSTRUMENTATION sensitive) or on the fn-compiq
// App Insights workspace (which is a DIFFERENT sink — eastus-8 key
// f7eebd2c-... vs hobbyiq-insights centralus-2 key 02dca1c0-...).
// console.log goes through HobbyIQ3's stdout pipeline → hobbyiq-insights
// `traces` table, the same workspace we're already querying. One log
// line per call, ASCII-only, grep-key: [compiq.signal_fetch_observed].

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

/**
 * PHASE-4B-SLICE-1: structured observability outcome for every fetch path.
 * Stable string union — query App Insights for `outcome=<value>` exact
 * matches. Multiplier reported for non-neutral classification (the
 * load-bearing question: is the signal moving the prediction?).
 */
export type SignalFetchOutcome =
  | "not_configured"        // SIGNAL_URL unset — env gap
  | "no_player"             // empty playerName — caller skipped the path
  | "ok_neutral"            // aggregator returned final_multiplier === 1.0
  | "ok_non_neutral"        // aggregator returned final_multiplier !== 1.0
  | "aggregator_unavailable" // signal_flags includes "signal_unavailable"
  | "non_ok_status"         // HTTP non-2xx
  | "timeout"               // AbortSignal.timeout fired
  | "fetch_error";          // any other fetch/JSON error

function emitObservedLog(args: {
  outcome: SignalFetchOutcome;
  player: string | null;
  durationMs: number;
  status: number | null;
  multiplier: number | null;
}): void {
  try {
    // Player truncated to 32 chars to bound the log line; full name lives
    // in playerName field elsewhere in the prediction emit path.
    const playerTrimmed = args.player
      ? args.player.slice(0, 32)
      : "";
    const multStr =
      args.multiplier === null ? "null" : args.multiplier.toFixed(3);
    const statusStr = args.status === null ? "null" : String(args.status);
    console.log(
      `[compiq.signal_fetch_observed] outcome=${args.outcome} ` +
        `multiplier=${multStr} ` +
        `duration_ms=${args.durationMs} ` +
        `status=${statusStr} ` +
        `player="${playerTrimmed}"`,
    );
  } catch {
    // Observability must never throw.
  }
}

export async function fetchPlayerSignals(
  playerName: string,
): Promise<FetchPlayerSignalsResult> {
  // PHASE-4B-SLICE-1: zero-cost outcomes (no fetch attempted) still emit
  // the structured log so we can count not_configured vs no_player vs
  // genuine-fetch-attempted in App Insights.
  if (!SIGNAL_URL) {
    emitObservedLog({
      outcome: "not_configured",
      player: playerName || null,
      durationMs: 0,
      status: null,
      multiplier: null,
    });
    return { payload: null, sourceUrl: null };
  }
  if (!playerName) {
    emitObservedLog({
      outcome: "no_player",
      player: null,
      durationMs: 0,
      status: null,
      multiplier: null,
    });
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
    if (!resp.ok) {
      emitObservedLog({
        outcome: "non_ok_status",
        player: playerName,
        durationMs: Date.now() - start,
        status: resp.status,
        multiplier: null,
      });
      return { payload: null, sourceUrl: sanitizedUrl };
    }

    const data = (await resp.json()) as Partial<SignalPayload>;
    const flags = data.signal_flags ?? [];
    if (flags.includes("signal_unavailable")) {
      emitObservedLog({
        outcome: "aggregator_unavailable",
        player: playerName,
        durationMs: Date.now() - start,
        status: resp.status,
        multiplier: null,
      });
      return { payload: null, sourceUrl: sanitizedUrl };
    }

    const mult = clamp(Number(data.final_multiplier ?? 1.0), 0.7, 1.5);
    // The PROOF question: is the signal moving the prediction or sitting
    // at 1.0? Bucket on strict-equal 1.0 so we can count "non-neutral"
    // calls directly in App Insights without parsing a multiplier value.
    emitObservedLog({
      outcome: mult === 1.0 ? "ok_neutral" : "ok_non_neutral",
      player: playerName,
      durationMs: Date.now() - start,
      status: resp.status,
      multiplier: mult,
    });
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
    // AbortSignal.timeout throws a DOMException with name="TimeoutError"
    // (Node 18+). Anything else is a generic fetch/JSON failure.
    const isTimeout =
      (err as { name?: string } | null)?.name === "TimeoutError" ||
      (err as { name?: string } | null)?.name === "AbortError";
    emitObservedLog({
      outcome: isTimeout ? "timeout" : "fetch_error",
      player: playerName,
      durationMs: Date.now() - start,
      status: null,
      multiplier: null,
    });
    return { payload: null, sourceUrl: sanitizedUrl };
  }
}
