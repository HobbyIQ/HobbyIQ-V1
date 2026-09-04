// CF-WEB-NO-NESTED-ANCHOR (Drew, 2026-09-04) — the structural invariant.
//
// The bug this pins: the portfolio row was an outer <Link>, and the
// MISSING-identity state rendered a "Fix identity →" <Link> among the chips
// INSIDE it. An <a> descended from an <a> is invalid HTML — the parser hoists
// the inner one out, and a tap aimed at the fixer landed on the ROW instead
// (measured in Chromium at 390px and 1280px; apps/web/docs/harness/).
//
// This is a STRUCTURAL assertion, not a console-watching one, and that is
// deliberate: the browser splits the anchors the same way server-side and
// client-side, so React logs no hydration warning either before or after.
// A test that waited for a warning would wait forever and pass on the bug.
//
// It asserts on the RENDERED MARKUP rather than on the source, because the
// nesting is a property of the output tree: an <a> can reach another <a>
// through any number of intermediate components, and only the markup knows.
// `react-dom/server` renders it with no DOM and no jsdom dependency.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RowStretchedLink, RowEscapeHatch } from "./HoldingRowLink";

const ROW_HREF = "/app/portfolio/h_abc123";
const FIX_HREF = "/app/portfolio/h_abc123";

/**
 * The MISSING-identity row, in the SAME composition apps/web/src/app/app/
 * portfolio/page.tsx renders: a positioned `.hiq-card` container holding the
 * row's stretched link, the card's content, and — because the holding has no
 * value and is not estimated or pending — the MISSING pill plus the fixer.
 *
 * `nestFixer` reproduces the ORIGINAL, buggy shape: the fixer rendered as a
 * DESCENDANT of the row's anchor. It exists so the assertions below can be
 * shown to fail on the broken tree — a structural test that cannot go red is
 * not pinning anything.
 */
function MissingIdentityRow({ nestFixer = false }: { nestFixer?: boolean }) {
  const fixer = (
    <RowEscapeHatch href={FIX_HREF}>{"Fix identity →"}</RowEscapeHatch>
  );
  return (
    <div className="hiq-card p-4 flex flex-col gap-3">
      {nestFixer ? (
        // The pre-fix tree: the row anchor WRAPS the content, so the fixer is
        // inside it. Rendered only by the mutation case.
        <a href={ROW_HREF} className="block">
          <div className="font-semibold">Ken Griffey Jr. #1</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px]">MISSING</span>
            {fixer}
          </div>
        </a>
      ) : (
        <>
          <RowStretchedLink href={ROW_HREF} label="Open Ken Griffey Jr. #1" />
          <div className="font-semibold">Ken Griffey Jr. #1</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px]">MISSING</span>
            {fixer}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Every anchor in `html` that has another anchor somewhere beneath it.
 *
 * Counts depth over the raw markup instead of parsing a tree: <a> cannot
 * self-close in HTML, so each `<a` opens exactly one level and each `</a>`
 * closes one. Any `<a` seen while depth > 0 is a nested anchor. This is the
 * same rule the browser's parser breaks on, applied to the same bytes.
 */
function nestedAnchorCount(html: string): number {
  let depth = 0;
  let nested = 0;
  for (const tag of html.match(/<\/?a[\s>]/g) ?? []) {
    if (tag.startsWith("</")) {
      depth = Math.max(0, depth - 1);
    } else {
      if (depth > 0) nested += 1;
      depth += 1;
    }
  }
  return nested;
}

describe("nestedAnchorCount (the detector itself)", () => {
  it("sees a nested anchor and ignores sibling ones", () => {
    expect(nestedAnchorCount("<a href='/x'><a href='/y'>z</a></a>")).toBe(1);
    expect(nestedAnchorCount("<a href='/x'>x</a><a href='/y'>y</a>")).toBe(0);
    expect(nestedAnchorCount("<div><a href='/x'><span>x</span></a></div>")).toBe(0);
    // An <article>/<aside> must not be read as an anchor.
    expect(nestedAnchorCount("<article><a href='/x'>x</a></article>")).toBe(0);
  });
});

describe("MISSING-identity row", () => {
  it("renders no <a> inside another <a>", () => {
    const html = renderToStaticMarkup(<MissingIdentityRow />);
    expect(nestedAnchorCount(html)).toBe(0);
  });

  it("MUTATION: re-nesting the fixer inside the row anchor goes red", () => {
    // If this ever reports 0, the assertion above has stopped meaning
    // anything and the detector is broken — not the component.
    const html = renderToStaticMarkup(<MissingIdentityRow nestFixer />);
    expect(nestedAnchorCount(html)).toBeGreaterThan(0);
  });

  it("keeps BOTH targets reachable — the row href and the fixer href", () => {
    const html = renderToStaticMarkup(<MissingIdentityRow />);
    const hrefs = (html.match(/href="([^"]*)"/g) ?? []).map((h) =>
      h.slice(6, -1),
    );
    expect(hrefs).toContain(ROW_HREF);
    expect(hrefs).toContain(FIX_HREF);
    // Exactly two anchors: the stretched row link and the fixer. A third
    // would mean something else in the row started navigating.
    expect(html.match(/<a[\s>]/g)?.length).toBe(2);
  });

  it("the fixer is a real anchor, not a click handler on a span", () => {
    // Keyboard reachability is the point: a <span onClick> is invisible to
    // Tab and to a screen reader's links list.
    const html = renderToStaticMarkup(<RowEscapeHatch href={FIX_HREF}>go</RowEscapeHatch>);
    expect(html).toMatch(/^<a [^>]*href="\/app\/portfolio\/h_abc123"/);
  });

  it("the fixer clears the 44px touch floor and stacks above the row link", () => {
    const html = renderToStaticMarkup(<RowEscapeHatch href={FIX_HREF}>go</RowEscapeHatch>);
    // min-h-11 is 2.75rem = 44px. The visible text is 10px, so without this
    // the tap target is the glyph box.
    expect(html).toContain("min-h-11");
    // The stretched link covers the whole card; the fixer must paint over it
    // or the tap lands on the row again — the exact symptom being fixed.
    expect(html).toContain("z-10");
    // One class list for both breakpoints: `statusChips` is shared by the
    // mobile and desktop layouts, so there is no md: variant to disagree.
    expect(html).not.toMatch(/\bmd:/);
  });

  it("the row link covers the card and sits below the fixer", () => {
    const html = renderToStaticMarkup(
      <RowStretchedLink href={ROW_HREF} label="Open card" />,
    );
    expect(html).toContain("absolute inset-0");
    expect(html).toContain("z-0");
    // No visible text, so it needs an accessible name of its own.
    expect(html).toContain('aria-label="Open card"');
  });
});

// The composition above is a FIXTURE — it can only prove the components
// compose safely, not that the portfolio page still composes them that way.
// A fixture that drifts from the page would keep passing while the bug came
// back, so the page's own source is pinned here too. Same technique as
// rung.test.ts, which reads the backend's rung union from source to keep two
// sides from disagreeing silently.
describe("the portfolio page composes the row without nesting anchors", () => {
  const rawSrc = readFileSync(
    path.join(__dirname, "..", "app", "app", "portfolio", "page.tsx"),
    "utf8",
  );
  // Comments are stripped first. This file's own CF-WEB-NO-NESTED-ANCHOR
  // notes quote the buggy `<Link>...<HoldingRow>` shape verbatim to explain
  // what was removed, and a guard that reads prose as code would fail on the
  // very comment describing the fix. Blank the comments, keep the offsets.
  const pageSrc = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

  it("the list maps holdings into a container, not a wrapping <Link>", () => {
    // The exact pre-fix line was:
    //   <Link key={h.id} href={...} className="block"><HoldingRow h={h} /></Link>
    // Any anchor that WRAPS <HoldingRow> puts the whole row — fixer included
    // — inside it again.
    expect(pageSrc).not.toMatch(/<Link[^>]*>\s*<HoldingRow/);
    expect(pageSrc).not.toMatch(/<a[\s>][^>]*>\s*<HoldingRow/);
  });

  it("the row's navigation is the stretched link, not a bare anchor", () => {
    expect(pageSrc).toContain("<RowStretchedLink");
    // Two layout cards — mobile and desktop — each carrying the overlay.
    expect(pageSrc.match(/\{rowLink\}/g)?.length).toBe(2);
  });

  it("the MISSING fixer goes through the escape hatch, not a raw <Link>", () => {
    expect(pageSrc).toContain("<RowEscapeHatch");
    // The fixer's label must be rendered BY the escape hatch. Scoped to the
    // element that directly encloses the text — `[^<]*` cannot cross into
    // another tag, so an unrelated <Link> elsewhere in the file is not a
    // match the way a lazy `[^]*?` would have made it one.
    const fixerLabel = /(?:Fix|Confirm) identity →/;
    expect(pageSrc).toMatch(fixerLabel);
    expect(pageSrc).not.toMatch(/<Link[^>]*>[^<]*(?:Fix|Confirm) identity/);
    // The label lives inside the escape hatch's element, with only the
    // ternary between the opening tag and the text.
    expect(pageSrc).toMatch(/<RowEscapeHatch[^>]*>[\s\S]{0,120}?(?:Fix|Confirm) identity/);
  });
});
