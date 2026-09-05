// CF-DAILYIQ-LAYOUT (Drew, 2026-09-04). The ORDER of the Today page, pinned.
//
// Drew asked for one specific arrangement — "Portfolio Today should be a wide
// bar at the top ... then market indexes, and maybe something around actions
// below it" — and an ordering is exactly the kind of decision that a later
// edit reshuffles without anyone noticing, because every individual piece
// still renders and the page still looks fine.
//
// This reads the page SOURCE rather than rendering it. The page is a client
// component whose three children each fetch on mount; rendering it in the
// node-only lane would test the mocking, not the layout. The mount ORDER,
// though, is a textual fact about the file, and comparing source positions is
// a real assertion about the shipped artifact — the same reasoning
// marketIndexMount.test.ts already uses on this page.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pageSrc = readFileSync(
  fileURLToPath(new URL("../app/app/page.tsx", import.meta.url)),
  "utf8",
);

/** Position of a JSX mount in the source, or -1. Matches the opening tag so
 *  an import line cannot be mistaken for a mount. */
function mountAt(tag: string): number {
  return pageSrc.indexOf(`<${tag}`);
}

describe("the Today page mounts bar -> indexes -> actions", () => {
  it("mounts all three", () => {
    expect(mountAt("PortfolioBar")).toBeGreaterThan(-1);
    expect(mountAt("MarketIndexes")).toBeGreaterThan(-1);
    expect(mountAt("TodaysActions")).toBeGreaterThan(-1);
  });

  it("puts the portfolio bar above the market indexes", () => {
    expect(mountAt("PortfolioBar")).toBeLessThan(mountAt("MarketIndexes"));
  });

  it("puts the market indexes above the actions section", () => {
    expect(mountAt("MarketIndexes")).toBeLessThan(mountAt("TodaysActions"));
  });

  it("keeps the eBay reconnect banner first, outside every gate", () => {
    // It was mounted first for a reason (#1721) and the reshuffle must not
    // have pushed it below a surface that can 402 away.
    expect(mountAt("EbayReconnectBanner")).toBeLessThan(mountAt("PortfolioBar"));
  });

  it("no longer mounts the three-card grid this replaced", () => {
    // The portfolio card became the bar; the market + brief cards merged into
    // the actions section's third column. Leaving one mounted would show the
    // same numbers twice on one screen.
    expect(mountAt("PortfolioTodayCard")).toBe(-1);
    expect(mountAt("MarketTodayCard")).toBe(-1);
    expect(mountAt("DailyIQCard")).toBe(-1);
  });

  it("points the bar's attention chip at the actions section", () => {
    // The chip is a link to an anchor; if the id and the href drift the chip
    // silently scrolls nowhere.
    expect(pageSrc).toContain("ACTIONS_SECTION_ID");
    expect(pageSrc).toMatch(/attentionHref=\{`#\$\{ACTIONS_SECTION_ID\}`\}/);
  });
});
