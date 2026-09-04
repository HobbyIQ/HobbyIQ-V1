// CF-MARKET-INDEXES (Drew, 2026-09-04). The strip shipped in #1644 and was
// live on iOS, but on web it looked missing for weeks. Nothing was broken:
// it was mounted on /app/daily, and the nav item labelled "DailyIQ" points
// at /app — a DIFFERENT page, with no nav entry pointing at /app/daily at
// all. The only route there was a small "Open full brief →" link inside
// DailyIQCard.
//
// There is no DOM in this vitest lane (vitest.config.mts is
// `environment: "node"`), so these read the page sources. That is enough
// to pin the thing that actually went wrong — WHICH page mounts it, and
// that the mount is not nested inside a gate — which a render test would
// not have caught either, since the page renders fine; it just renders
// the wrong page's worth of content.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_NAV } from "./navigation";

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

const HOME = "app/app/page.tsx";
const BRIEF = "app/app/daily/page.tsx";

/** Strips block + line comments so a mention in prose is not a mount. */
function code(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("PIN: the nav's DailyIQ item and the page that mounts the strip agree", () => {
  it("the item labelled DailyIQ points at /app", () => {
    const item = APP_NAV.find((n) => n.label === "DailyIQ");
    expect(item).toBeDefined();
    expect(item!.href).toBe("/app");
  });

  it("/app — the page users call DailyIQ — mounts the strip", () => {
    const s = code(src(HOME));
    expect(s).toContain('from "@/components/MarketIndexes"');
    expect(s).toMatch(/<MarketIndexes\b/);
  });

  it("/app/daily — the full brief — still mounts it too", () => {
    const s = code(src(BRIEF));
    expect(s).toContain('from "@/components/MarketIndexes"');
    expect(s).toMatch(/<MarketIndexes\b/);
  });
});

describe("PIN: the mount is outside the gated region on both pages", () => {
  // The brief page gates on `phase`: "locked" (402), "error", "empty".
  // The strip must not sit inside any of those branches, or a free-tier
  // user — the exact case iOS renders the strip for, outside the locked
  // overlay — would see no tiles.
  it("the brief page mounts the strip before the first phase branch", () => {
    const s = code(src(BRIEF));
    const mount = s.indexOf("<MarketIndexes");
    const firstPhaseGate = s.indexOf('phase === "');
    expect(mount).toBeGreaterThan(-1);
    expect(firstPhaseGate).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(firstPhaseGate);
  });

  it("the brief page's strip is not nested in a phase/locked conditional", () => {
    const s = code(src(BRIEF));
    const line = s.split("\n").find((l) => l.includes("<MarketIndexes"))!;
    expect(line).not.toMatch(/phase|locked|entitle|gate/i);
  });

  it("the home page's strip is not behind an entitlement conditional", () => {
    const s = code(src(HOME));
    const line = s.split("\n").find((l) => l.includes("<MarketIndexes"))!;
    expect(line).not.toMatch(/phase|locked|entitle|gate|granted|\?/i);
  });

  it("the home page renders the strip above the card grid", () => {
    const s = code(src(HOME));
    expect(s.indexOf("<MarketIndexes")).toBeLessThan(s.indexOf("<PortfolioTodayCard"));
  });
});
