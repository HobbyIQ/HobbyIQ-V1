// CF-SELLER-INTELLIGENCE-SELL-WINDOW (Drew, 2026-09-02).
//
// The timing call, said in one small chip beside the holding — built on the
// same bones as ProvenanceChip (D20) so the portfolio row reads as one
// system: --hiq-* tokens through color-mix (correct in both themes with no
// second palette to maintain), 10px medium, the detail in the tooltip.
//
// THREE RULES THIS COMPONENT KEEPS:
//
// 1. A QUIET SIGNAL RENDERS NOTHING. `none` returns null. A chip on every
//    holding is not intelligence, it is decoration — and it would train the
//    eye to skip the one row that matters. The reason is still on the wire
//    for anyone who asks the API.
//
// 2. THE HORIZON IS PART OF THE CLAIM, never a tooltip afterthought. A
//    timing call without its horizon is a hunch. It is rendered inline.
//
// 3. THE BASIS SENTENCE IS SHOWN VERBATIM in the tooltip, numbers and all.
//    The server wrote a sentence that quotes its own evidence; paraphrasing
//    it here would drop exactly the part a seller can check.

type SellSignalValue = "none" | "watch" | "sell-window" | "hold";
type SellHorizon = "none" | "days-7-14" | "days-14-30";

export interface SellSignalShape {
  signal: SellSignalValue;
  horizon: SellHorizon;
  signalClass?: "price" | "attention";
  basis: string;
  reason?: string | null;
  measures?: {
    playerIndexPct?: number | null;
    ownPoolPct?: number | null;
    divergencePct?: number | null;
    ownPoolSales?: number | null;
    trendAgeDays?: number | null;
    confidence?: number | null;
  } | null;
}

/** Warning, not positive: a sell window is a CAVEAT on holding — it is
 *  time-sensitive and it expires. Green would read as "this card is good". */
const COLOR: Record<Exclude<SellSignalValue, "none">, string> = {
  "sell-window": "var(--hiq-warning)",
  watch: "var(--hiq-electric-blue)",
  hold: "var(--hiq-hobby-green)",
};

const MARK: Record<Exclude<SellSignalValue, "none">, string> = {
  "sell-window": "◷",
  watch: "◐",
  hold: "●",
};

const LABEL: Record<Exclude<SellSignalValue, "none">, string> = {
  "sell-window": "sell window",
  watch: "watch",
  hold: "hold",
};

/** The horizon in words. Never invented — it comes off the wire. */
const HORIZON_WORDS: Record<SellHorizon, string> = {
  "days-7-14": "7-14d",
  "days-14-30": "14-30d",
  none: "",
};

export function SellSignalChip({
  sellSignal,
  className,
}: {
  sellSignal?: SellSignalShape | null;
  className?: string;
}) {
  // Rule 1: no call, no chip. Also covers the not-yet-rolled-out case where
  // an older endpoint omits the field entirely.
  if (!sellSignal || sellSignal.signal === "none") return null;

  const signal = sellSignal.signal;
  const color = COLOR[signal];
  const horizon = HORIZON_WORDS[sellSignal.horizon] ?? "";

  // Rule 3: the server's sentence, verbatim, plus the measures behind it.
  const m = sellSignal.measures ?? null;
  const numbers = [
    m?.playerIndexPct != null ? `player index ${m.playerIndexPct > 0 ? "+" : ""}${m.playerIndexPct}%` : null,
    m?.ownPoolPct != null ? `own pool ${m.ownPoolPct > 0 ? "+" : ""}${m.ownPoolPct}%` : null,
    m?.ownPoolSales != null ? `${m.ownPoolSales} sales` : null,
  ].filter(Boolean).join(" · ");

  const title = [
    sellSignal.basis,
    numbers ? `— ${numbers}` : null,
    sellSignal.horizon !== "none" ? `horizon: ${HORIZON_WORDS[sellSignal.horizon]}` : null,
  ].filter(Boolean).join("\n");

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${className ?? ""}`}
      style={{
        background: `color-mix(in oklab, ${color} 15%, transparent)`,
        color,
      }}
      title={title}
      data-sell-signal={signal}
      data-sell-horizon={sellSignal.horizon}
    >
      <span aria-hidden="true">{MARK[signal]}</span>
      {/* Rule 2: the horizon rides inline with the label, not in the tooltip. */}
      <span>
        {LABEL[signal]}
        {horizon ? ` · ${horizon}` : ""}
      </span>
    </span>
  );
}
