"use client";

// CF-PRO-SELLER-WORKSPACE (Drew, 2026-09-02). The chrome every section on
// the Pro Seller workspace shares: heading, loading skeleton, the states a
// feature-detected section can land on, and the small state-encoded chips
// the tables use.
//
// Pulled out of the page rather than repeated six times because the whole
// value of the page is that the sections read the SAME WAY. A seller scans
// it; six hand-rolled variations of "no rows yet" would each have to be
// read separately, which is the opposite of scannable.

import Link from "next/link";
import type { ReactNode } from "react";
import type { SectionOutcome } from "@/lib/api";

// ─── Severity vocabulary ───────────────────────────────────────────────
//
// A closed set, mapped once to the design tokens. Sections pick a severity
// for a row; they never pick a color. That is what keeps "urgent" the same
// red in the sell-window table and the reconciliation row, and it is why a
// theme change lands everywhere at once.

export type Severity = "urgent" | "opportunity" | "neutral" | "info";

const SEVERITY_COLOR: Record<Severity, string> = {
  urgent: "var(--color-danger)",
  opportunity: "var(--color-success)",
  neutral: "var(--color-muted)",
  info: "var(--color-accent)",
};

/**
 * A small state-encoded label. Carries its meaning in the word FIRST and the
 * color second — color alone is not a label, and a red/green-only encoding
 * is unreadable to a good fraction of sellers.
 */
export function Chip({
  label,
  severity = "info",
  title,
}: {
  label: string;
  severity?: Severity;
  title?: string;
}) {
  const color = SEVERITY_COLOR[severity];
  return (
    <span
      className="inline-block text-[11px] font-medium px-2 py-0.5 rounded whitespace-nowrap"
      title={title}
      style={{
        color,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${color} 32%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

/** Money/count cell styling. `tabular-nums` so columns line up digit-for-digit
 *  down a scanned column — the single most useful thing a numeric table does. */
export function Num({
  children,
  severity,
  className = "",
}: {
  children: ReactNode;
  severity?: Severity;
  className?: string;
}) {
  return (
    <span
      className={`tabular-nums ${className}`}
      style={severity ? { color: SEVERITY_COLOR[severity] } : undefined}
    >
      {children}
    </span>
  );
}

// ─── Skeleton ──────────────────────────────────────────────────────────

/** Per-section loading placeholder. Sized to the content that replaces it so
 *  the page does not jump as the six requests land at six different times —
 *  they are independent, and they WILL land out of order. */
export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-9 rounded animate-pulse"
          style={{
            background: "color-mix(in oklab, var(--color-muted) 12%, transparent)",
          }}
        />
      ))}
    </div>
  );
}

// ─── Section shell ─────────────────────────────────────────────────────

export interface SectionProps<T> {
  title: string;
  /** One line under the heading: what this section answers. */
  blurb: string;
  outcome: SectionOutcome<T> | null;
  /** Optional deep-link to the full surface for this section. */
  href?: string;
  hrefLabel?: string;
  skeletonRows?: number;
  /** Rendered when the fetch succeeded. Returning null yields the empty state. */
  children: (data: T) => ReactNode;
  /** What "nothing to show" means HERE — an empty deal feed and an empty
   *  sell-window list are different kinds of good news, so each says its own. */
  emptyNote: string;
}

/**
 * Renders one section, or nothing at all.
 *
 * The `absent` branch returns null — no heading, no box, no gap. A section
 * whose backing PR has not merged should be invisible, not a promise. This
 * is the pin: absent API → section hidden cleanly, no error.
 */
export function Section<T>({
  title,
  blurb,
  outcome,
  href,
  hrefLabel = "Open",
  skeletonRows = 3,
  children,
  emptyNote,
}: SectionProps<T>) {
  // Not yet resolved → skeleton. Resolved to absent → render nothing.
  if (outcome?.state === "absent") return null;

  return (
    <section className="hiq-card p-5">
      <div className="flex items-baseline justify-between gap-3 mb-1 flex-wrap">
        <h2 className="font-bold text-lg">{title}</h2>
        {href && outcome?.state === "ready" && (
          <Link
            href={href}
            className="text-xs font-medium"
            style={{ color: "var(--color-accent)" }}
          >
            {hrefLabel} →
          </Link>
        )}
      </div>
      <p className="text-sm text-[color:var(--color-muted)] mb-4 leading-relaxed">
        {blurb}
      </p>

      {outcome == null && <SectionSkeleton rows={skeletonRows} />}

      {outcome?.state === "locked" && <SectionLocked requiredTier={outcome.requiredTier} />}

      {outcome?.state === "error" && (
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {outcome.message}
        </p>
      )}

      {outcome?.state === "ready" && renderBody(children(outcome.data), emptyNote)}
    </section>
  );
}

/**
 * Distinguishes "the renderer produced no rows" from "it produced rows",
 * without every section writing the same length check against a differently
 * named array. Each section's `children` returns null when it has nothing to
 * show, and gets its own empty sentence back.
 *
 * The result is inspected DIRECTLY rather than passed through a child
 * component's `children` prop: React normalizes children on the way in, so
 * an emptiness test on the far side of that boundary is not reliable.
 */
function renderBody(body: ReactNode, emptyNote: string): ReactNode {
  const empty =
    body == null
    || body === false
    || (Array.isArray(body) && body.length === 0);
  if (empty) {
    return <p className="text-sm text-[color:var(--color-muted)]">{emptyNote}</p>;
  }
  return body;
}

/**
 * The per-section entitlement state. The page-level gate already caught the
 * common case (a free-tier user never gets this far), so this fires for the
 * narrower one: a paying tier that owns SOME of these features but not this
 * one. It names the tier the server asked for rather than assuming.
 */
export function SectionLocked({ requiredTier }: { requiredTier?: string | null }) {
  return (
    <div
      className="rounded-lg p-4 text-sm"
      style={{
        background: "color-mix(in oklab, var(--color-accent) 8%, transparent)",
        border: "1px solid color-mix(in oklab, var(--color-accent) 28%, transparent)",
      }}
    >
      <span className="text-[color:var(--color-muted)]">
        Included with {tierLabel(requiredTier)}.{" "}
      </span>
      <Link href="/pricing" style={{ color: "var(--color-accent)" }} className="font-medium">
        See plans →
      </Link>
    </div>
  );
}

/** Plan keys as the entitlements matrix spells them → what a person calls them. */
export function tierLabel(plan: string | null | undefined): string {
  switch (plan) {
    case "pro_seller":
      return "Pro Seller";
    case "investor":
      return "Investor";
    case "collector":
      return "Collector";
    case "free":
      return "the free plan";
    default:
      // The matrix grew a tier this build has not been taught. Say something
      // true and non-specific rather than mislabelling it.
      return "a paid plan";
  }
}
