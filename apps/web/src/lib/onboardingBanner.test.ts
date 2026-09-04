// CF-DAILYIQ-BANNER-ONLY-WHEN-EMPTY (Drew, 2026-09-04).
//
// THE BUG: the Today page showed "Value your first card — Get started" to a
// user with 43 holdings. Not a rendering slip — the gate genuinely answered
// true. `shouldRunFirstRun` stands down on `holdingCount > 0` ONLY when the
// progress record also says the `first-value` step was completed, and a user
// who never opened the funnel has an empty `completedSteps`. So every user
// who built a portfolio without walking the funnel got told to start one.
//
// THE FIX is a second, stricter gate for the BANNER, leaving the funnel's own
// gate alone — /app/start still shows the value moment to someone who added a
// card outside the funnel, which firstRun.test.ts pins deliberately. The
// banner just stops nagging a portfolio that plainly is not empty.
//
// MUTATION CHECK (the reason this file is worth its bytes): reverting
// `shouldShowFirstRunBanner` to plain `shouldRunFirstRun` turns the first two
// tests below RED. A test that cannot fail on the broken build is not
// evidence — the standard docs/harness/README.md sets for the harnesses.

import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_STEP_IDS,
  chooseLane,
  completeStep,
  emptyProgress,
  shouldRunFirstRun,
  shouldShowFirstRunBanner,
  skipFunnel,
} from "./firstRun";

describe("the onboarding banner shows ONLY when the portfolio is empty", () => {
  it("does not nag a 43-holding portfolio that never ran the funnel", () => {
    // THE EXACT REPORTED CASE. The funnel's own gate says true here — that is
    // correct for /app/start and wrong for a banner — so this assertion is
    // the one that fails if the banner ever goes back to the shared gate.
    const p = emptyProgress();
    expect(shouldRunFirstRun(p, { holdingCount: 43 })).toBe(true);
    expect(shouldShowFirstRunBanner(p, { holdingCount: 43 })).toBe(false);
  });

  it("does not nag a portfolio with a single holding", () => {
    // The boundary: one card is not empty.
    expect(shouldShowFirstRunBanner(emptyProgress(), { holdingCount: 1 })).toBe(false);
  });

  it("still shows on a genuinely empty portfolio", () => {
    // The banner's whole purpose. If this goes red the fix has overreached
    // and the funnel is unreachable from the Today page.
    expect(shouldShowFirstRunBanner(emptyProgress(), { holdingCount: 0 })).toBe(true);
  });

  it("shows mid-funnel on an empty portfolio, so a resume is offered", () => {
    const mid = chooseLane(emptyProgress(), "search");
    expect(shouldShowFirstRunBanner(mid, { holdingCount: 0 })).toBe(true);
  });

  it("stays hidden for a skipped funnel even on an empty portfolio", () => {
    // Skip is a real, persisted answer — not a dismissal that comes back.
    expect(shouldShowFirstRunBanner(skipFunnel(emptyProgress()), { holdingCount: 0 })).toBe(false);
  });

  it("stays hidden for a completed funnel", () => {
    // All three steps: completing the LAST one is what flips status to
    // "completed" (the machine has one definition of done). Completing only
    // `lane` + `first-value` leaves it active with a step still to run — a
    // resume, not a finished funnel.
    let done = chooseLane(emptyProgress(), "import");
    for (const id of FIRST_RUN_STEP_IDS) done = completeStep(done, id);
    expect(done.status).toBe("completed");
    expect(shouldShowFirstRunBanner(done, { holdingCount: 0 })).toBe(false);
  });

  it("leaves the FUNNEL's own gate untouched", () => {
    // /app/start's behaviour must not have changed: an account with cards but
    // no value moment still gets the funnel when it navigates there. Only the
    // unsolicited banner stood down.
    expect(shouldRunFirstRun(emptyProgress(), { holdingCount: 3 })).toBe(true);
    const seen = completeStep(chooseLane(emptyProgress(), "import"), "first-value");
    expect(shouldRunFirstRun(seen, { holdingCount: 412 })).toBe(false);
  });
});
