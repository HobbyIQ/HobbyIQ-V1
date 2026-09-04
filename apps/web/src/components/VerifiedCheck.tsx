/**
 * CF-VERIFIED-IS-A-CHECK (Drew, 2026-09-04: "Rather than say Verified — let's
 * just do a green check for it next to the card details.").
 *
 * The verified marker used to be a text pill — `✓ VERIFIED` — sitting in the
 * `statusChips` band with every other badge. Two things were wrong with that:
 *
 *   1. The word competed with the chips that carry ACTUAL news. EST, UNDER
 *      REVIEW, MISSING and the sell-window call all say something the owner
 *      may need to act on. "VERIFIED" is the resting state of a healthy row —
 *      on a clean portfolio it was the loudest thing on every card, repeated
 *      down the page, saying nothing actionable.
 *   2. It sat away from the identity it qualifies. Verified is a claim about
 *      the CARD — this holding is a checklist-backed catalog card — so it
 *      belongs on the title line, not in a band of pricing badges.
 *
 * So the word goes and the glyph moves to the title. This is deliberately NOT
 * a chip: no pill background, no padding box, nothing that reads as another
 * badge. It is a mark on the title line, the way a verified tick sits beside
 * a name.
 *
 * WHAT IT IS NOT: this component renders nothing for the unverified case. The
 * UNVERIFIED chip stays exactly where it was, in `statusChips`, in its own
 * words — an unverified identity IS actionable ("open Edit and pick the
 * card"), so it keeps a chip that says so. Only the verified marker changed.
 *
 * Accessibility: the glyph is the whole marker, so it carries the name. The
 * SVG is `role="img"` with an `aria-label`, and a <title> element gives the
 * same words as a native hover tooltip — no tooltip library, and the label is
 * not left to a `title` attribute alone (which screen readers treat
 * inconsistently). `focusable="false"` keeps it out of the tab order in IE/
 * Edge legacy rendering; it is decoration WITH a name, not a control.
 *
 * Why an inline SVG and not an icon component: the repo has no icon library,
 * and the two existing glyphs in this page (the thumbnail placeholder, the
 * sell-signal arrow) are inline SVGs too. Adding a dependency for one check
 * would be the larger change.
 */

/** The accessible name AND the hover text. One string, so they cannot drift. */
export const VERIFIED_LABEL = "Verified identity";

/** The longer explanation, shown on hover under the label. */
export const VERIFIED_TITLE =
  "Verified identity — this holding is a checklist-backed catalog card, so pricing reads that card's exact pool.";

/**
 * The green check that marks a verified holding identity.
 *
 * Renders `null` unless `verified` is strictly true. `identityVerified` is
 * `boolean | null | undefined` on the wire: a holding that predates the flag,
 * or one the sweep has not reached, is NOT verified, and an absent flag must
 * never paint the mark. Only an explicit `true` earns it.
 */
export function VerifiedCheck({ verified }: { verified?: boolean | null }) {
  if (verified !== true) return null;
  return (
    <svg
      // `inline-block align-[-0.125em]` sits the glyph on the text baseline
      // beside the card number rather than on the line box's top edge.
      // `flex-shrink-0` keeps it from being squeezed to a sliver when the
      // title wraps at 390px — it is 14px or it is absent.
      className="inline-block align-[-0.125em] flex-shrink-0 ml-1"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-label={VERIFIED_LABEL}
      focusable="false"
      // The design system's success colour, the same token the old pill used.
      style={{ color: "var(--hiq-hobby-green)" }}
      data-verified-check="true"
    >
      <title>{VERIFIED_TITLE}</title>
      {/* Filled circle + check, one path, so the mark reads at 14px where a
          stroked outline would go muddy. */}
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.7 7.7-5.4 5.4a1 1 0 0 1-1.4 0l-2.6-2.6a1 1 0 1 1 1.4-1.4l1.9 1.9 4.7-4.7a1 1 0 1 1 1.4 1.4z" />
    </svg>
  );
}
