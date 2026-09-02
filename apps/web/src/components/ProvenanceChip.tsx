// D20 — the web says what the engine says (2026-08-30).
//
// One small chip, rendered beside every price the web shows: the rung in
// human words and whether it is an OBSERVED read of this card's own pool
// or an ESTIMATE from somewhere else. The raw label and the pipeline that
// wrote the number ride in the tooltip so nothing the wire said is lost.

import { describeStaleness, type RungDescription, type RungKind } from "@/lib/rung";

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
  daysSinceNewestComp,
  className,
}: {
  rung: RungDescription;
  /** `pricingSource` / route name for the tooltip — never shown inline. */
  source?: string | null;
  /** Age of the newest direct comp behind this number (price-by-id's
   *  `daysSinceNewestComp`). When it is past the stale line, a second
   *  chip says the price is projected to today's market rather than
   *  read off cold prints. Omitted / null → no second chip. */
  daysSinceNewestComp?: number | null;
  className?: string;
}) {
  const color = COLOR[rung.kind];
  const stale = describeStaleness(daysSinceNewestComp);
  const title = [
    `rung: ${rung.label ?? "(none)"}`,
    source ? `source: ${source}` : null,
    stale ? `newest comp: ${stale.daysSinceNewestComp}d old` : null,
  ].filter(Boolean).join(" · ");
  // An estimate's words already begin with "estimate"; the others get the
  // head word so "observed" and "unknown" are said, not implied by colour.
  const words = rung.kind === "estimate" ? rung.text : `${HEAD[rung.kind]} · ${rung.text}`;
  const chip = (
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
  if (!stale) return chip;
  // The speculation chip. Warning-coloured because it is a caveat on the
  // number, not a second provenance claim — and it never replaces the
  // rung chip, which still says which pool the number came from.
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chip}
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight"
        style={{
          background: "color-mix(in oklab, var(--hiq-warning) 15%, transparent)",
          color: "var(--hiq-warning)",
        }}
        title={stale.long}
        data-stale-comp-days={stale.daysSinceNewestComp}
      >
        <span aria-hidden="true">◷</span>
        <span>{stale.short}</span>
      </span>
    </span>
  );
}
