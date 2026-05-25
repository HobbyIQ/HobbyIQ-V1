// SignalPayload — shape returned by the Azure Function aggregator
// (compiq-functions/fn-signal-aggregator). Read by Layer 1 of TrendIQ.
//
// PROVENANCE: ported 2026-05-25 from mcp-server/pricing.ts:82-128.
// FOLLOWUP: if a third consumer ever appears (e.g. iOS calling
// directly, or a worker process), extract into a shared workspace
// package. For now port-with-provenance keeps the two services
// loosely coupled; they may diverge as backend and mcp-server
// evolve different prediction surfaces.

export interface SignalPayload {
  player?: string;
  final_multiplier: number;
  predicted_direction?: "rising" | "falling" | "stable";
  signal_flags?: string[];
  components?: {
    ebay?: number;
    reddit?: number;
    trends?: number;
    odds?: number;
    stats?: number;
    news?: number;
    youtube?: number;
  };
  component_signals?: Record<string, string>;
  bin_signal?: string | null;
  bin_drop_pct?: number | null;
  sell_through_rate?: number | null;
  str_signal?: string | null;
  show_phase?: string | null;
  show_name?: string | null;
  days_to_show?: number | null;
  show_multiplier?: number | null;
  release_phase?: string | null;
  release_name?: string | null;
  days_to_release?: number | null;
  release_multiplier?: number | null;
  playoff_signal?: string | null;
  playoff_window?: string | null;
  playoff_multiplier?: number | null;
  career_arc_signal?: string[] | null;
  career_arc_multiplier?: number | null;
  updated_at?: string;
}

/**
 * Neutral fallback. Used by the aggregator itself when no real signal
 * is available for a tracked player, AND by fetchPlayerSignals as a
 * defensive return when callers need a non-null SignalPayload. TrendIQ
 * Layer 1 treats payloads tagged with "signal_unavailable" as "no real
 * signal" and drops Layer 1 from the composite — see fetchPlayerSignals.
 */
export const NEUTRAL_SIGNAL: SignalPayload = {
  final_multiplier: 1.0,
  predicted_direction: "stable",
  signal_flags: ["signal_unavailable"],
  components: {},
};
