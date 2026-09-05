// CF-PORTFOLIO-DAY-CHANGE (Drew, 2026-09-04) — "show the day change in $ and
// % with colour."
//
// Three renderings have to stay distinguishable, and the failure that would
// ship silently is collapsing the first two:
//
//   1. a MEASURED MOVE prints $ and % in the success/danger token — not a
//      hard-coded green, the same variables the P&L beside it uses;
//   2. a MEASURED FLAT DAY prints "$0", muted. Suppressing it (falsy check on
//      the number) would hide a real answer;
//   3. NO PREVIOUS CLOSE prints an em dash. Printing "$0" here would claim a
//      measurement we do not have — the same lie as (2) in reverse.
//
// Plus: partial coverage is SAID, not hidden. A move computed over 12 of 43
// holdings understates the portfolio, and a bar that shows it bare is
// presenting a partial measurement as a whole one.
//
// Same technique as VerifiedCheck.test.tsx: render to static markup with
// `react-dom/server` — no DOM, no jsdom. The component fetches on mount, so
// the DayChange fragment is exercised through the exported `PortfolioBar`
// only via its own props-free path; instead this pins the fragment the bar
// composes by rendering the bar's own module-level helper through a small
// harness that mirrors what the bar passes it. Where a fixture cannot prove
// composition, the page's SOURCE is pinned (test at the bottom).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PortfolioBarDayChange } from "./PortfolioBar";
import type { BarStats } from "@/lib/dailyIqActions";

function stats(over: Partial<BarStats> = {}): BarStats {
  return {
    totalValue: 12500,
    dayChange: null,
    dayChangePct: null,
    dayChangeCoverage: null,
    costBasis: 9000,
    unrealisedPL: 3500,
    unrealisedPLPct: 38.9,
    cardCount: 43,
    verifiedCount: 38,
    attentionCount: 0,
    // CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05). Drew's real split at the time
    // of writing: 33 of 43 priced, 10 withheld.
    pricedCount: 33,
    withheldCount: 10,
    ...over,
  };
}

describe("the bar's day change", () => {
  it("prints a gain in $ and % using the SUCCESS token", () => {
    const html = renderToStaticMarkup(
      <PortfolioBarDayChange
        stats={stats({
          dayChange: 500,
          dayChangePct: 4.17,
          dayChangeCoverage: { holdingsWithPrior: 43, holdingsTotal: 43 },
        })}
      />,
    );
    expect(html).toContain("$500");
    expect(html).toContain("+4.2%");
    expect(html).toContain("today");
    // The design-system token, not a literal green.
    expect(html).toContain("--color-success");
    expect(html).not.toContain("--color-danger");
  });

  it("prints a loss using the DANGER token, sign preserved", () => {
    const html = renderToStaticMarkup(
      <PortfolioBarDayChange
        stats={stats({
          dayChange: -320,
          dayChangePct: -2.5,
          dayChangeCoverage: { holdingsWithPrior: 43, holdingsTotal: 43 },
        })}
      />,
    );
    expect(html).toContain("-$320");
    expect(html).toContain("-2.5%");
    expect(html).toContain("--color-danger");
    expect(html).not.toContain("--color-success");
  });

  it("a MEASURED FLAT day prints $0 — it is an answer, not an absence", () => {
    const html = renderToStaticMarkup(
      <PortfolioBarDayChange
        stats={stats({
          dayChange: 0,
          dayChangePct: 0,
          dayChangeCoverage: { holdingsWithPrior: 43, holdingsTotal: 43 },
        })}
      />,
    );
    expect(html).toContain("$0");
    expect(html).toContain("0.0%");
    // MUTATION GUARD: a falsy check on the number would render the em-dash
    // branch here. It must not.
    expect(html).not.toContain("—");
    expect(html).toContain("--color-muted");
  });

  it("NO previous close prints an em dash, never $0", () => {
    const html = renderToStaticMarkup(<PortfolioBarDayChange stats={stats()} />);
    expect(html).toContain("—");
    expect(html).toContain("today");
    // The lie this whole feature is built to avoid.
    expect(html).not.toContain("$0");
    expect(html).not.toContain("0.0%");
  });

  it("partial coverage is SAID, in muted text, with the real counts", () => {
    const html = renderToStaticMarkup(
      <PortfolioBarDayChange
        stats={stats({
          dayChange: 40,
          dayChangePct: 0.9,
          dayChangeCoverage: { holdingsWithPrior: 12, holdingsTotal: 43 },
        })}
      />,
    );
    expect(html).toContain("12 of 43 with prior");
    expect(html).toContain("portfolio-bar-day-coverage");
  });

  it("FULL coverage says nothing — the note is a caveat, not a label", () => {
    const html = renderToStaticMarkup(
      <PortfolioBarDayChange
        stats={stats({
          dayChange: 40,
          dayChangePct: 0.9,
          dayChangeCoverage: { holdingsWithPrior: 43, holdingsTotal: 43 },
        })}
      />,
    );
    expect(html).not.toContain("with prior");
    expect(html).not.toContain("portfolio-bar-day-coverage");
  });

  it("carries the testid the layout harness measures overlap on", () => {
    const html = renderToStaticMarkup(
      <PortfolioBarDayChange stats={stats({ dayChange: 40, dayChangePct: 0.9 })} />,
    );
    expect(html).toContain('data-testid="portfolio-bar-day"');
  });
});

describe("the bar composes the day change", () => {
  // A fixture proves the fragment renders; only the source proves the BAR
  // still puts it on the page. Without this, deleting <DayChange/> from the
  // headline band would leave every test above green.
  const src = readFileSync(path.join(__dirname, "PortfolioBar.tsx"), "utf8");

  it("renders <DayChange/> in the headline band, beside the total", () => {
    expect(src).toContain("<DayChange stats={stats} />");
    // Before the P&L: today's move is the first question the bar answers.
    expect(src.indexOf("<DayChange stats={stats} />")).toBeLessThan(
      src.indexOf("<PnL stats={stats} />"),
    );
  });

  it("no longer claims the wire carries no previous close", () => {
    // The old bar documented the day line as permanently absent. A comment
    // that still says so would be a lie sitting next to working code.
    expect(src).not.toContain("/api/portfolio carries no previous");
  });
});
