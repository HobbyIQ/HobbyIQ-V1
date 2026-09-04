import Link from "next/link";
import type { ReactNode } from "react";

// CF-WEB-NO-NESTED-ANCHOR (Drew, 2026-09-04). Found while shipping #1714.
//
// The portfolio list wrapped every holding card in a `<Link>` to the detail
// page, and the MISSING-identity state rendered a SECOND `<Link>` ("Fix
// identity →") among the chips INSIDE that card. An `<a>` inside an `<a>` is
// invalid HTML: the browser's parser hoists the inner one out of the outer,
// so which element a tap lands on is a parser detail rather than a decision
// we made. Measured in Chromium at 390px and 1280px against the pre-fix
// build, a tap at the centre of "Fix identity →" resolved to the ROW's link
// — the reported symptom, reproduced (apps/web/docs/harness/).
//
// Worth knowing for anyone re-verifying: the console is CLEAN before and
// after. The parser splits the anchors identically server-side and
// client-side, so React sees no mismatch and logs no hydration warning. The
// nesting is invalid and it changes behaviour, but it is silent — which is
// why the test asserts structure instead of watching the console.
//
// The fix is structural and needs no CSS: the row container is a plain
// `<div>` (`.hiq-card` is already `position: relative`), and the row's
// navigation is ONE absolutely-positioned "stretched" anchor covering it.
// Anything that must stay independently clickable — the fixer — renders as a
// SIBLING in normal flow with `relative z-10`, stacking above the overlay.
// Nothing is nested, both anchors keep real `href`s, and both stay in the tab
// order and reachable by keyboard.
//
// Why an overlay rather than "make the whole card a button that pushes a
// route": the row must remain a real link — middle-click, cmd-click, "copy
// link address" and crawlers all depend on the `href` being on an anchor.

/**
 * The row's single navigational element: an anchor stretched over the whole
 * card. The parent MUST be positioned (`.hiq-card` is). Children of the row
 * that need their own clicks must stack above it — see `RowEscapeHatch`.
 */
export function RowStretchedLink({
  href,
  label,
}: {
  href: string;
  /** Accessible name for the row, since the anchor has no visible text. */
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ outlineColor: "var(--color-accent)" }}
      data-testid="row-link"
    />
  );
}

/**
 * A control inside a stretched-link row that must NOT navigate to the row's
 * destination. Stacks above the overlay and stops the click from bubbling.
 *
 * Touch target: the visible text is 10px, so the 44px floor comes from
 * `min-h-11` (2.75rem) plus padding rather than from the glyphs — the same
 * on mobile and desktop, since this renders inside the one shared
 * `statusChips` fragment both layouts use.
 */
export function RowEscapeHatch({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="relative z-10 inline-flex items-center min-h-11 px-2 -mx-2 text-[10px] font-semibold underline"
      style={{ color: "var(--color-accent)" }}
      onClick={(e) => e.stopPropagation()}
      data-testid="fix-identity-link"
    >
      {children}
    </Link>
  );
}
