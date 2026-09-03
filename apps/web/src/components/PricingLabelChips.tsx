// CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
//
// The caveats a price must be read with, rendered beside it. Drew's standing
// ruling (2026-09-01): a self-comp PUBLISHES **and is LABELED** — the number
// still shows, and the label says what is behind it.
//
// The sentences are NOT written here. They are served on the wire, composed
// by the backend's `labelsForResult` (ebaySellDraft.service.ts) and stamped
// onto the holding by the writer that decided the price, so the portfolio
// row, the card page, the sell draft and iOS all say the same thing in the
// same words. This component chooses a colour and a mark; it never edits the
// text, and it never invents a label the wire did not send.
//
// Kept separate from ProvenanceChip on purpose. The rung says WHICH POOL the
// number came from; these say WHAT IS WRONG WITH THAT POOL. Different facts,
// and neither replaces the other — the same reasoning that keeps the
// staleness chip its own chip.

import type { PricingLabel } from "@/lib/api";

type Code = PricingLabel["code"];

/** Severity, not category: `speculative` and `self-anchored` are the two
 *  that say the number may not reflect a real market at all, so they carry
 *  the warning colour. `fallback-rung` and `low-confidence` are softer —
 *  the number is real, it is just further from the exact card. */
const COLOR: Record<Code, string> = {
  speculative: "var(--hiq-warning)",
  "self-anchored": "var(--hiq-warning)",
  "fallback-rung": "var(--hiq-electric-blue)",
  "low-confidence": "var(--hiq-muted-text)",
};

const MARK: Record<Code, string> = {
  speculative: "◈",
  "self-anchored": "◉",
  "fallback-rung": "≈",
  "low-confidence": "◌",
};

/** The two or three words the chip shows inline. The full sentence — the
 *  wire's own `text` — rides in the tooltip and the accessible label, so
 *  nothing the backend said is lost to the abbreviation. */
const SHORT: Record<Code, string> = {
  speculative: "speculative",
  "self-anchored": "self-anchored",
  "fallback-rung": "estimated",
  "low-confidence": "low confidence",
};

/**
 * A single caveat chip.
 *
 * `selfAnchored` refines only the self-anchored chip's inline words: a fully
 * self-anchored price says so, a partial one shows its ratio ("1 of 2"). The
 * sentence in the tooltip is the wire's either way — this never restates it.
 */
export function PricingLabelChip({
  label,
  selfAnchored,
  className,
}: {
  label: PricingLabel;
  selfAnchored?: { own: number; total: number } | null;
  className?: string;
}) {
  const color = COLOR[label.code] ?? "var(--hiq-muted-text)";
  const mark = MARK[label.code] ?? "•";
  let words = SHORT[label.code] ?? label.code;
  if (label.code === "self-anchored" && selfAnchored) {
    words = selfAnchored.own >= selfAnchored.total
      ? "self-anchored"
      : `self-anchored ${selfAnchored.own} of ${selfAnchored.total}`;
  }
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${className ?? ""}`}
      style={{
        background: `color-mix(in oklab, ${color} 15%, transparent)`,
        color,
      }}
      // The backend's sentence, verbatim. This is the copy the sell draft
      // shows a buyer and the copy iOS shows in its chip.
      title={label.text}
      aria-label={label.text}
      data-pricing-label={label.code}
    >
      <span aria-hidden="true">{mark}</span>
      <span>{words}</span>
    </span>
  );
}

/**
 * Every caveat on a price, in the order the engine emitted them — strongest
 * claim about the number's softness first (speculative, then self-anchored,
 * then the generic fallback note, then confidence). The order is the
 * backend's; re-sorting here would put a different emphasis on the same
 * facts than the sell draft does.
 *
 * Renders nothing when there are no labels, which is the common case.
 */
export function PricingLabelChips({
  labels,
  selfAnchored,
  className,
}: {
  labels?: PricingLabel[] | null;
  selfAnchored?: { own: number; total: number } | null;
  className?: string;
}) {
  if (!labels || labels.length === 0) return null;
  return (
    <>
      {labels.map((l) => (
        <PricingLabelChip
          key={l.code}
          label={l}
          selfAnchored={selfAnchored}
          className={className}
        />
      ))}
    </>
  );
}
