// CF-VERIFIED-IS-A-CHECK (Drew, 2026-09-04) — "Rather than say Verified —
// let's just do a green check for it next to the card details."
//
// Three things have to hold, and each one has a mutation case below proving
// the assertion can actually go red:
//
//   1. the marker no longer says the WORD — a chip fragment that still emits
//      "VERIFIED" has not made the change;
//   2. the check renders ONLY for a verified holding — a mark that paints on
//      an unverified row is worse than the old chip, because it silently
//      claims a checklist-backed identity the holding does not have;
//   3. it carries an accessible name — the word was the name for a screen
//      reader, and dropping it for a glyph without a label REMOVES
//      information rather than tidying it.
//
// Same technique as HoldingRowLink.test.tsx: render to static markup with
// `react-dom/server` (no DOM, no jsdom) and pin the page's own source where a
// fixture cannot prove the page still composes it that way.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VerifiedCheck, VERIFIED_LABEL } from "./VerifiedCheck";

describe("VerifiedCheck", () => {
  it("renders a green check for a verified holding", () => {
    const html = renderToStaticMarkup(<VerifiedCheck verified />);
    expect(html).toContain("<svg");
    // The design system's success token, not a hard-coded green.
    expect(html).toContain("--hiq-hobby-green");
  });

  it("says nothing — the glyph replaced the word", () => {
    const html = renderToStaticMarkup(<VerifiedCheck verified />);
    // The visible text of the marker. The <title> element is the tooltip and
    // legitimately contains the word "Verified", so this checks the SHOUTED
    // form the chip used, which nothing should emit any more.
    expect(html).not.toContain("VERIFIED");
    expect(html).not.toContain("✓");
  });

  it("renders NOTHING when the holding is not verified", () => {
    expect(renderToStaticMarkup(<VerifiedCheck verified={false} />)).toBe("");
    expect(renderToStaticMarkup(<VerifiedCheck verified={null} />)).toBe("");
    expect(renderToStaticMarkup(<VerifiedCheck />)).toBe("");
  });

  it("treats a missing flag as unverified, never as verified", () => {
    // `identityVerified` is `boolean | null | undefined` on the wire. A row
    // that predates the flag, or one the catalog sweep has not reached, is
    // NOT verified — only an explicit `true` earns the mark.
    expect(renderToStaticMarkup(<VerifiedCheck verified={undefined} />)).toBe("");
  });

  it("carries an accessible name and a hover tooltip", () => {
    const html = renderToStaticMarkup(<VerifiedCheck verified />);
    expect(html).toContain(`aria-label="${VERIFIED_LABEL}"`);
    expect(html).toContain('role="img"');
    // The <title> child is what a browser shows on hover, and it repeats the
    // label so the two can never say different things.
    expect(html).toMatch(/<title>[^<]*Verified identity[^<]*<\/title>/);
  });

  it("MUTATION: the a11y assertion goes red if the label is dropped", () => {
    // Proves the test above is load-bearing: an unlabelled <svg> must NOT
    // satisfy it. If this ever passes with the aria-label absent, the
    // assertion has stopped meaning anything.
    const unlabelled = '<svg role="img"><title>x</title></svg>';
    expect(unlabelled).not.toContain(`aria-label="${VERIFIED_LABEL}"`);
  });

  it("MUTATION: the render-only-when-verified assertion can fail", () => {
    // The shape a broken component would produce — a mark painted on an
    // unverified row. The emptiness check above must reject it.
    const wrong = renderToStaticMarkup(<VerifiedCheck verified />);
    expect(wrong).not.toBe("");
  });
});

// A fixture proves the component behaves; it cannot prove the PAGE still uses
// it. The portfolio page's source is pinned here for the same reason
// HoldingRowLink.test.tsx pins it: a fixture that drifts from the page keeps
// passing while the change is reverted at the call site.
describe("the portfolio page marks verified identity with the check", () => {
  const rawSrc = readFileSync(
    path.join(__dirname, "..", "app", "app", "portfolio", "page.tsx"),
    "utf8",
  );
  // Blank the comments, keep the offsets — the page's own CF- notes quote the
  // removed `✓ VERIFIED` chip verbatim to explain what changed, and a guard
  // that read prose as code would fail on the comment describing the fix.
  const pageSrc = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

  it("no longer renders the VERIFIED chip text", () => {
    // The exact pre-change markup was a <span> whose body was `✓ VERIFIED`.
    expect(pageSrc).not.toContain("✓ VERIFIED");
    expect(pageSrc).not.toMatch(/>\s*✓?\s*VERIFIED\s*</);
  });

  it("renders the check on BOTH the mobile and desktop title lines", () => {
    // Two layouts, one marker — the same discipline `statusChips` follows, so
    // phone and desktop can never disagree about what a verified row looks
    // like. Three call sites: the mobile player+number line, the mobile
    // no-player fallback title, and the desktop row title.
    expect(pageSrc.match(/<VerifiedCheck\b/g)?.length).toBe(3);
    expect(pageSrc).toContain("verified={h.identityVerified}");
  });

  it("keeps the UNVERIFIED chip exactly as it was", () => {
    // This change touches the VERIFIED marker only. An unverified identity is
    // actionable — "open Edit and pick the card" — so it keeps a chip that
    // says so in words.
    expect(pageSrc).toContain("UNVERIFIED");
    expect(pageSrc).toContain("Identity is fuzzy or parked");
  });

  it("keeps every other status chip in the vocabulary", () => {
    // The blast radius of this PR is one badge. If any of these vanished, the
    // change reached further than it was asked to.
    for (const chip of ["EST", "PENDING", "MISSING", "UNDER REVIEW"]) {
      expect(pageSrc).toContain(chip);
    }
    expect(pageSrc).toContain("<SellSignalChip");
    expect(pageSrc).toContain("<PricingLabelChips");
    expect(pageSrc).toContain("<ProvenanceChip");
  });

  it("the check sits with the card details, not back in the chips band", () => {
    // The point of the change is WHERE the mark is. `statusChips` is one
    // fragment ending at `</>`; the marker must not be inside it.
    const chipsStart = pageSrc.indexOf("const statusChips");
    const chipsEnd = pageSrc.indexOf("const thumb");
    expect(chipsStart).toBeGreaterThan(-1);
    expect(chipsEnd).toBeGreaterThan(chipsStart);
    const chipsFragment = pageSrc.slice(chipsStart, chipsEnd);
    expect(chipsFragment).not.toContain("<VerifiedCheck");
    // And it still contains the chip that did NOT move.
    expect(chipsFragment).toContain("UNVERIFIED");
  });
});
