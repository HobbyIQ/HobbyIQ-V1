"use client";

// CF-ONBOARDING (Drew, 2026-07-27). Compact banner on the Today page
// for new users. Renders nothing when the checklist is complete OR
// dismissed OR still loading — so the banner never flickers in on a
// paint before we know the state.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchFirstRun, fetchOnboarding, type OnboardingResponse } from "@/lib/api";
import {
  FIRST_RUN_STEP_IDS,
  normalizeProgress,
  shouldShowFirstRunBanner,
  type FirstRunProgress,
} from "@/lib/firstRun";

export function OnboardingBanner() {
  const [data, setData] = useState<OnboardingResponse | null>(null);
  const [firstRun, setFirstRun] = useState<
    { progress: FirstRunProgress; holdingCount: number } | null
  >(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchOnboarding().catch(() => null),
      // CF-FIRST-RUN (Drew, 2026-09-02): the guided funnel takes
      // precedence over the long-tail checklist when it is still
      // unfinished — resuming the funnel is the higher-value action, and
      // showing both banners would be two nags for the same thing.
      fetchFirstRun().catch(() => null),
    ])
      .then(([onboarding, fr]) => {
        if (cancelled) return;
        if (onboarding) setData(onboarding);
        if (fr) {
          setFirstRun({
            progress: normalizeProgress(fr.progress),
            holdingCount: fr.holdingCount ?? 0,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;

  // CF-DAILYIQ-BANNER-ONLY-WHEN-EMPTY (Drew, 2026-09-04). An unfinished
  // funnel gets a resume banner instead of the checklist — but ONLY on an
  // empty portfolio. `shouldShowFirstRunBanner` is the banner's gate, which
  // adds "and the portfolio is empty" on top of the funnel's own
  // `shouldRunFirstRun`; see the comment on it for why the two differ.
  //
  // The bug this fixes: a user with 43 holdings who never ran the funnel has
  // an empty `completedSteps`, so the funnel gate answered true and the
  // Today page told them to "Value your first card". The funnel is still
  // reachable at /app/start; it just no longer interrupts a portfolio that
  // plainly is not empty.
  if (
    firstRun
    && shouldShowFirstRunBanner(firstRun.progress, { holdingCount: firstRun.holdingCount })
  ) {
    return <ResumeFirstRunBanner progress={firstRun.progress} />;
  }

  if (!data) return null;
  if (data.dismissed) return null;
  if (data.percentComplete >= 100) return null;
  // Same rule for the long-tail checklist. It is a setup nag too, and an
  // established portfolio has moved past setup — whatever the checklist
  // record still says is unticked.
  if (firstRun && firstRun.holdingCount > 0) return null;

  const nextStep = data.steps.find((s) => !s.done);

  return (
    <section className="hiq-card p-5 mb-6 flex items-center gap-4 flex-wrap">
      <div className="flex-1 min-w-[240px]">
        <div className="text-sm font-semibold mb-1">
          Get set up · {data.doneCount}/{data.total} done
        </div>
        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "var(--color-border)" }}>
          <div
            className="h-full transition-all"
            style={{
              width: `${data.percentComplete}%`,
              background: "var(--hiq-hobby-green)",
            }}
          />
        </div>
        {nextStep && (
          <div
            className="text-xs mt-2"
            style={{ color: "var(--hiq-muted-text)" }}
          >
            Next: {nextStep.label}
          </div>
        )}
      </div>
      <Link href="/app/welcome" className="hiq-btn-primary text-sm px-4">
        {nextStep ? nextStep.cta ?? "Continue" : "Continue"}
      </Link>
    </section>
  );
}

/** CF-FIRST-RUN: the resume affordance. A user who started the guided
 *  funnel and wandered off gets one line back into it, on the step they
 *  stopped at — the whole point of persisting progress server-side. */
function ResumeFirstRunBanner({ progress }: { progress: FirstRunProgress }) {
  const total = FIRST_RUN_STEP_IDS.length;
  const done = progress.completedSteps.length;
  const started = done > 0;

  return (
    <section className="hiq-card p-5 mb-6 flex items-center gap-4 flex-wrap">
      <div className="flex-1 min-w-[240px]">
        <div className="text-sm font-semibold mb-1">
          {started
            ? `Finish setting up · ${done}/${total} done`
            : "Value your first card"}
        </div>
        <div
          className="w-full h-2 rounded-full overflow-hidden"
          style={{ background: "var(--color-border)" }}
        >
          <div
            className="h-full transition-all"
            style={{
              width: `${Math.round((done / total) * 100)}%`,
              background: "var(--hiq-hobby-green)",
            }}
          />
        </div>
        <div className="text-xs mt-2" style={{ color: "var(--hiq-muted-text)" }}>
          {started
            ? "Pick up where you left off."
            : "One card is enough to see what HobbyIQ does."}
        </div>
      </div>
      <Link href="/app/start" className="hiq-btn-primary text-sm px-4">
        {started ? "Resume" : "Get started"}
      </Link>
    </section>
  );
}
