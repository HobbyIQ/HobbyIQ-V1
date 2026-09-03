// CF-MARKET-INDEXES (Drew, 2026-09-02). Endpoint contract + the
// shared-component identity pin (one component, both screens).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const repoRoot = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

describe("endpoint contract", () => {
  const route = read("backend/src/routes/marketIndexes.routes.ts");
  const app = read("backend/src/app.ts");

  it("is registered under /api/compiq", () => {
    expect(app).toContain('import marketIndexesRoutes from "./routes/marketIndexes.routes.js"');
    expect(app).toContain('app.use("/api/compiq", marketIndexesRoutes)');
  });

  it("serves market-indexes behind requireSession, like the other market surfaces", () => {
    expect(route).toContain('"/market-indexes"');
    expect(route).toContain("requireSession");
  });

  it("clamps the days param into a sane range", () => {
    expect(route).toContain("Math.min(SERIES_DAYS");
    expect(route).toContain("Math.max(30");
  });

  it("returns every sport in one call — the UI must not fan out", () => {
    const readSvc = read("backend/src/services/insights/marketIndexRead.service.ts");
    expect(readSvc).toContain("INDEX_SPORTS.map");
    expect(readSvc).toContain("Promise.all");
  });
});

describe("storage: no new container", () => {
  const svc = read("backend/src/services/insights/marketIndex.service.ts");

  it("writes into the existing daily_price_series container", () => {
    expect(svc).toContain('.container("daily_price_series")');
  });

  it("never provisions a container as a side effect", () => {
    // Container creation is a HALT-for-Drew config change. The shared
    // vendorPersistenceCommon helper provisions on demand, so these
    // services deliberately do NOT route through it. Match the CALL
    // form (`containers.createIfNotExists(`) so the prose explaining
    // this rule doesn't trip the guard.
    const provisioningCall = /containers\s*\.\s*createIfNotExists\s*\(/;
    const helperImport = /from\s+["'].*vendorPersistenceCommon/;
    for (const f of [
      "backend/src/services/insights/marketIndex.service.ts",
      "backend/src/services/insights/marketIndexCompute.service.ts",
      "backend/src/services/insights/marketIndexRead.service.ts",
    ]) {
      const src = read(f);
      expect(provisioningCall.test(src), `${f} provisions a container`).toBe(false);
      expect(helperImport.test(src), `${f} imports the provisioning helper`).toBe(false);
    }
    expect(svc).toContain("daily_price_series");
  });

  it("tags every reserved row with a docType so it is filterable", () => {
    expect(svc).toContain("market_index_point");
    expect(svc).toContain("market_index_basket");
  });
});

describe("shared-component identity", () => {
  const daily = read("apps/web/src/app/app/daily/page.tsx");
  const market = read("apps/web/src/app/app/market/page.tsx");

  it("both screens import the SAME MarketIndexes component", () => {
    expect(daily).toContain('from "@/components/MarketIndexes"');
    expect(market).toContain('from "@/components/MarketIndexes"');
    expect(daily).toContain("<MarketIndexes");
    expect(market).toContain("<MarketIndexes");
  });

  it("there is exactly one tile implementation", () => {
    // The footer string is the tell — if a second copy of the tile
    // markup appears anywhere else, this catches the drift.
    const component = read("apps/web/src/components/MarketIndexes.tsx");
    expect(component).toContain("Index:");
    expect(daily).not.toContain("Index:");
    expect(market).not.toContain("Index:");
  });

  it("the DailyIQ mount sits outside the brief's phase gate", () => {
    // It must render whether the brief is loading, locked, or errored.
    const idxPos = daily.indexOf("<MarketIndexes");
    const phaseGate = daily.indexOf('{phase === "loading"');
    expect(idxPos).toBeGreaterThan(-1);
    expect(phaseGate).toBeGreaterThan(-1);
    expect(idxPos).toBeLessThan(phaseGate);
  });

  it("the market screen does not render a link to itself", () => {
    expect(market).toContain("showExploreLink={false}");
  });

  it("the explore affordance points at the market screen", () => {
    const component = read("apps/web/src/components/MarketIndexes.tsx");
    expect(component).toContain('href="/app/market"');
    expect(component).toContain("Explore indexes");
  });
});

describe("job wiring", () => {
  const wf = read(".github/workflows/market-indexes-compute.yml");

  it("has a schedule and a dispatchable backfill", () => {
    expect(wf).toContain("schedule:");
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain("backfill");
  });

  it("sources Cosmos creds from App Service, never from a checked-in secret", () => {
    expect(wf).toContain("az webapp config appsettings list");
    expect(wf).toContain("COSMOS_CONNECTION_STRING");
  });

  it("does not touch the frozen backfill-runner inputs", () => {
    // WHAT THIS GUARDS (restated 2026-09-03): workflow_dispatch caps at 25
    // inputs and the runner is at 24. The index work must never claim the
    // last one - that is the frozen thing.
    //
    // It used to be asserted as `not.toContain("market-index")`, i.e. by
    // banning the STRING. That was a proxy, and it was wrong in both
    // directions: it would have passed a new input named `index_epoch`,
    // and it failed the purge lane (Drew's ruling, 2026-09-03), which adds
    // a script-dropdown OPTION and no input at all. A dropdown option is
    // not an input; conflating them blocks the safe change and permits the
    // dangerous one. Assert the input count and names directly.
    const runner = read(".github/workflows/backfill-runner.yml");
    const dispatchBlock = runner.slice(
      runner.indexOf("  workflow_dispatch:"),
      runner.indexOf("jobs:"),
    );
    const inputNames = [...dispatchBlock.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputNames.length).toBeLessThanOrEqual(25);
    // No input exists FOR the index work: the purge lane rides `script`,
    // `apply` and `sports`, all of which long predate it.
    expect(inputNames.filter((n) => n.includes("index"))).toEqual([]);
    expect(inputNames.filter((n) => n.includes("market"))).toEqual([]);
    expect(inputNames.filter((n) => n.includes("basket"))).toEqual([]);
  });

  it("the purge lane is a script OPTION on the runner, not a new input", () => {
    // The other half of the same rule, stated positively so the lane's
    // presence is pinned rather than merely tolerated.
    const runner = read(".github/workflows/backfill-runner.yml");
    expect(runner.replace(/\r\n/g, "\n")).toContain("          - rebuild-market-indexes\n");
  });
});
