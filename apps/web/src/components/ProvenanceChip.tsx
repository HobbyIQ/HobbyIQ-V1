// D20 — the web says what the engine says (2026-08-30).
//
// One small chip, rendered beside every price the web shows: the rung in
// human words and whether it is an OBSERVED read of this card's own pool
// or an ESTIMATE from somewhere else. The raw label and the pipeline that
// wrote the number ride in the tooltip so nothing the wire said is lost.

import type { RungDescription, RungKind } from "@/lib/rung";

const MARK: Record<RungKind, string> = {
  observed: "●",
  estimate: "≈",
  unpriced: "—",
  unknown: "?",
};

const COLOR: Record<RungKind, string> = {
  observed: "var(--hiq-hobby-green)",
  estimate: "var(--hiq-electric-blue)",
  unpriced: "var(--hiq-muted-text)",
  unknown: "var(--hiq-warning)",
};

const HEAD: Record<RungKind, string> = {
  observed: "observed",
  estimate: "estimate",
  unpriced: "unpriced",
  unknown: "unknown",
};

export function ProvenanceChip({
  rung,
  source,
  className,
}: {
  rung: RungDescription;
  /** `pricingSource` / route name for the tooltip — never shown inline. */
  source?: string | null;
  className?: string;
}) {
  const color = COLOR[rung.kind];
  const title = [
    `rung: ${rung.label ?? "(none)"}`,
    source ? `source: ${source}` : null,
  ].filter(Boolean).join(" · ");
  // An estimate's words already begin with "estimate"; the others get the
  // head word so "observed" and "unknown" are said, not implied by colour.
  const words = rung.kind === "estimate" ? rung.text : `${HEAD[rung.kind]} · ${rung.text}`;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${className ?? ""}`}
      style={{
        background: `color-mix(in oklab, ${color} 15%, transparent)`,
        color,
      }}
      title={title}
      data-rung={rung.label ?? ""}
      data-rung-kind={rung.kind}
    >
      <span aria-hidden="true">{MARK[rung.kind]}</span>
      <span>{words}</span>
    </span>
  );
}
