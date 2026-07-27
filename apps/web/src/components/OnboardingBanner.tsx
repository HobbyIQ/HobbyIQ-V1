"use client";

// CF-ONBOARDING (Drew, 2026-07-27). Compact banner on the Today page
// for new users. Renders nothing when the checklist is complete OR
// dismissed OR still loading — so the banner never flickers in on a
// paint before we know the state.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchOnboarding, type OnboardingResponse } from "@/lib/api";

export function OnboardingBanner() {
  const [data, setData] = useState<OnboardingResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchOnboarding()
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch(() => {
        // Silent — banner just doesn't render if the endpoint errors.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;
  if (!data) return null;
  if (data.dismissed) return null;
  if (data.percentComplete >= 100) return null;

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
