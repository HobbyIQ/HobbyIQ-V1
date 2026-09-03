// CF-FIRST-RUN (Drew, 2026-09-02). The funnel's doctrine, pinned.
//
// These are the rules the machine exists to keep, not a coverage
// exercise: skip is terminal, resume lands where you left off, a
// returning user is never blocked, a lane that would 402 is never
// offered, and a gated action is shown honestly rather than hidden or
// silently unlocked.
import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_STEP_IDS,
  chooseLane,
  completeStep,
  currentStep,
  emptyProgress,
  lanesFor,
  nextActionsFor,
  normalizeProgress,
  reopenFunnel,
  shouldRunFirstRun,
  skipFunnel,
  stepIndex,
  tierLabelFor,
  type FirstRunContext,
  type FirstRunProgress,
} from "./firstRun";

const freeCtx: FirstRunContext = {
  features: [],
  holdingCount: 0,
  entitlementsKnown: true,
};
const investorCtx: FirstRunContext = {
  features: ["predictions", "watchlist", "advancedAlerts", "ebayIntegration", "marketTrendIndexes"],
  holdingCount: 0,
  entitlementsKnown: true,
};
const proCtx: FirstRunContext = {
  features: [...(investorCtx.features as string[]), "erpReconciliation"],
  holdingCount: 0,
  entitlementsKnown: true,
};

describe("the step machine", () => {
  it("starts on the first step", () => {
    expect(currentStep(emptyProgress())).toBe("lane");
    expect(stepIndex(emptyProgress())).toBe(0);
  });

  it("advances to the next unfinished step", () => {
    const p = completeStep(emptyProgress(), "lane");
    expect(currentStep(p)).toBe("first-value");
    expect(stepIndex(p)).toBe(1);
  });

  it("is idempotent — completing a step twice does not double-count", () => {
    const once = completeStep(emptyProgress(), "lane");
    const twice = completeStep(once, "lane");
    expect(twice.completedSteps).toEqual(["lane"]);
    expect(currentStep(twice)).toBe("first-value");
  });

  it("completes the funnel when the last step is done", () => {
    let p = emptyProgress();
    for (const id of FIRST_RUN_STEP_IDS) p = completeStep(p, id);
    expect(p.status).toBe("completed");
    expect(currentStep(p)).toBeNull();
    expect(stepIndex(p)).toBe(FIRST_RUN_STEP_IDS.length);
  });

  it("stamps startedAt once and keeps it across steps", () => {
    const first = completeStep(emptyProgress(), "lane");
    const second = completeStep(first, "first-value");
    expect(first.startedAt).not.toBeNull();
    expect(second.startedAt).toBe(first.startedAt);
  });

  it("picking a lane records it AND completes the lane step", () => {
    const p = chooseLane(emptyProgress(), "import");
    expect(p.lane).toBe("import");
    expect(currentStep(p)).toBe("first-value");
  });
});

describe("skip and resume", () => {
  it("skip is terminal and persisted, not a dismissal", () => {
    const p = skipFunnel(emptyProgress());
    expect(p.status).toBe("skipped");
    expect(shouldRunFirstRun(p, { holdingCount: 0 })).toBe(false);
  });

  it("skip keeps progress so a re-open resumes rather than restarts", () => {
    const mid = chooseLane(emptyProgress(), "search");
    const skipped = skipFunnel(mid);
    const reopened = reopenFunnel(skipped);
    expect(reopened.status).toBe("active");
    expect(reopened.lane).toBe("search");
    // Resumes on the step it stopped on — not back at the lane picker.
    expect(currentStep(reopened)).toBe("first-value");
    expect(shouldRunFirstRun(reopened, { holdingCount: 0 })).toBe(true);
  });

  it("a completed funnel does not run again", () => {
    let p = emptyProgress();
    for (const id of FIRST_RUN_STEP_IDS) p = completeStep(p, id);
    expect(shouldRunFirstRun(p, { holdingCount: 0 })).toBe(false);
  });
});

describe("it never blocks a returning user", () => {
  it("stands down for an account that already reached its first value", () => {
    const p = completeStep(chooseLane(emptyProgress(), "import"), "first-value");
    expect(shouldRunFirstRun(p, { holdingCount: 412 })).toBe(false);
  });

  it("still shows the value moment to someone who added a card outside the funnel", () => {
    // Holdings exist but the value moment was never rendered — that render
    // IS the product, so the funnel still has something to do.
    expect(shouldRunFirstRun(emptyProgress(), { holdingCount: 3 })).toBe(true);
  });

  it("runs for a genuinely fresh account", () => {
    expect(shouldRunFirstRun(emptyProgress(), { holdingCount: 0 })).toBe(true);
  });
});

describe("stored progress is read defensively", () => {
  it("turns absent / malformed records into a fresh start", () => {
    expect(normalizeProgress(null)).toEqual(emptyProgress());
    expect(normalizeProgress(undefined)).toEqual(emptyProgress());
    expect(normalizeProgress("nope")).toEqual(emptyProgress());
    expect(normalizeProgress(42)).toEqual(emptyProgress());
  });

  it("drops step ids it has no code for rather than counting them", () => {
    const p = normalizeProgress({
      status: "active",
      completedSteps: ["lane", "a-step-from-the-future", "first-value"],
    });
    expect(p.completedSteps).toEqual(["lane", "first-value"]);
    // The unknown id did NOT advance the user past a step they never saw.
    expect(currentStep(p)).toBe("next-step");
  });

  it("drops an unknown lane and an unknown status", () => {
    const p = normalizeProgress({ status: "banana", lane: "carrier-pigeon" });
    expect(p.status).toBe("active");
    expect(p.lane).toBeNull();
  });

  it("de-duplicates repeated step ids", () => {
    const p = normalizeProgress({ completedSteps: ["lane", "lane", "lane"] });
    expect(p.completedSteps).toEqual(["lane"]);
  });

  it("round-trips a real record", () => {
    const original: FirstRunProgress = chooseLane(emptyProgress(), "ebay");
    expect(normalizeProgress(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });
});

describe("feature-detected lanes", () => {
  it("hides the eBay lane from a tier that cannot use it", () => {
    const ids = lanesFor(freeCtx).map((l) => l.id);
    expect(ids).not.toContain("ebay");
    expect(ids).toEqual(["import", "search"]);
  });

  it("offers the eBay lane to a tier that has ebayIntegration", () => {
    expect(lanesFor(investorCtx).map((l) => l.id)).toContain("ebay");
  });

  it("always leaves a way forward — never an empty lane list", () => {
    for (const ctx of [freeCtx, investorCtx, proCtx, { ...freeCtx, entitlementsKnown: false }]) {
      expect(lanesFor(ctx).length).toBeGreaterThan(0);
    }
  });

  it("hides gated lanes when the entitlement probe failed — never assumes granted", () => {
    const unknown: FirstRunContext = { features: undefined, holdingCount: 0, entitlementsKnown: false };
    expect(lanesFor(unknown).map((l) => l.id)).not.toContain("ebay");
  });

  it("reads the map wire shape as well as the array", () => {
    const asMap: FirstRunContext = {
      features: { ebayIntegration: true },
      holdingCount: 0,
      entitlementsKnown: true,
    };
    expect(lanesFor(asMap).map((l) => l.id)).toContain("ebay");
    const falseMap: FirstRunContext = {
      features: { ebayIntegration: false },
      holdingCount: 0,
      entitlementsKnown: true,
    };
    expect(lanesFor(falseMap).map((l) => l.id)).not.toContain("ebay");
  });
});

describe("the next-step strip gates honestly", () => {
  it("shows every action to every tier — gated ones as upsells, never hidden", () => {
    for (const ctx of [freeCtx, investorCtx, proCtx]) {
      expect(nextActionsFor(ctx).map((a) => a.id)).toEqual([
        "import-more",
        "set-alert",
        "sell-signals",
      ]);
    }
  });

  it("marks alerts and sell signals as upsells for a free account, naming the tier", () => {
    const byId = Object.fromEntries(nextActionsFor(freeCtx).map((a) => [a.id, a]));
    expect(byId["import-more"].gated).toBe("open");
    expect(byId["set-alert"].gated).toBe("upsell");
    expect(byId["set-alert"].requiredTier).toBe("investor");
    expect(byId["sell-signals"].gated).toBe("upsell");
    expect(byId["sell-signals"].requiredTier).toBe("pro_seller");
  });

  it("opens what each tier actually has", () => {
    const inv = Object.fromEntries(nextActionsFor(investorCtx).map((a) => [a.id, a]));
    expect(inv["set-alert"].gated).toBe("open");
    // Investor does not get the Pro Seller workspace.
    expect(inv["sell-signals"].gated).toBe("upsell");

    const pro = Object.fromEntries(nextActionsFor(proCtx).map((a) => [a.id, a]));
    expect(pro["sell-signals"].gated).toBe("open");
  });

  it("no entitlement bypass: an unknown probe never opens a gated action", () => {
    const unknown: FirstRunContext = { features: undefined, holdingCount: 0, entitlementsKnown: false };
    const byId = Object.fromEntries(nextActionsFor(unknown).map((a) => [a.id, a]));
    expect(byId["set-alert"].gated).toBe("upsell");
    expect(byId["sell-signals"].gated).toBe("upsell");
    // The ungated one still works — a failed probe must not strand a user.
    expect(byId["import-more"].gated).toBe("open");
  });

  it("an open action never carries a required tier", () => {
    for (const a of nextActionsFor(proCtx)) {
      if (a.gated === "open") expect(a.requiredTier).toBeNull();
      else expect(a.requiredTier).not.toBeNull();
    }
  });
});

describe("tier labels", () => {
  it("says the plan name a human would recognise", () => {
    expect(tierLabelFor("pro_seller")).toBe("Pro Seller");
    expect(tierLabelFor("investor")).toBe("Investor");
  });

  it("never renders an empty upsell when the tier is unknown", () => {
    expect(tierLabelFor(null)).toBe("a paid plan");
    expect(tierLabelFor(undefined)).toBe("a paid plan");
  });
});
