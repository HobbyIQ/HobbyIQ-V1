"use client";

// CF-ONBOARDING (Drew, 2026-07-27). Welcome + checklist page. Two ways
// people land here:
//   1. /verify-email?token=... success redirects them (?verified=1)
//   2. Manual visit from the Today banner or the sidebar (later)
//
// Steps are server-derived so refreshing after linking eBay in another
// tab reflects the new state immediately.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  dismissOnboarding,
  fetchOnboarding,
  fetchSessionUser,
  type AuthUser,
  type OnboardingResponse,
} from "@/lib/api";

function StepIcon({ done }: { done: boolean }) {
  if (done) {
    return (
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 font-bold"
        style={{
          background: "var(--hiq-hobby-green)",
          color: "#000",
        }}
      >
        ✓
      </div>
    );
  }
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
      style={{
        border: "2px solid var(--color-border)",
        color: "var(--hiq-muted-text)",
      }}
    />
  );
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="relative w-20 h-20 flex items-center justify-center flex-shrink-0">
      <svg width="80" height="80" viewBox="0 0 80 80">
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="6"
        />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="var(--hiq-hobby-green)"
          strokeWidth="6"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 40 40)"
        />
      </svg>
      <div className="absolute text-lg font-bold">{pct}%</div>
    </div>
  );
}

function WelcomeBody() {
  const router = useRouter();
  const params = useSearchParams();
  const justVerified = params?.get("verified") === "1";

  const [user, setUser] = useState<AuthUser | null>(null);
  const [data, setData] = useState<OnboardingResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await fetchSessionUser();
        if (cancelled) return;
        setUser(u);
        const res = await fetchOnboarding();
        if (cancelled) return;
        setData(res);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onDismiss() {
    await dismissOnboarding().catch(() => {});
    router.push("/app");
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading…</div>
      </div>
    );
  }

  if (!user) {
    router.replace("/login");
    return null;
  }

  const displayName = user.username ?? user.fullName ?? "collector";

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      {justVerified && (
        <div
          className="hiq-card p-4 flex items-center gap-3"
          style={{
            background: "color-mix(in oklab, var(--hiq-hobby-green) 12%, transparent)",
            borderColor: "color-mix(in oklab, var(--hiq-hobby-green) 40%, transparent)",
          }}
        >
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-bold"
            style={{
              background: "var(--hiq-hobby-green)",
              color: "#000",
            }}
          >
            ✓
          </div>
          <div className="text-sm">
            <div className="font-semibold">Email verified</div>
            <div style={{ color: "var(--hiq-muted-text)" }}>
              Thanks for confirming — you&apos;re all set.
            </div>
          </div>
        </div>
      )}

      <section className="hiq-card p-6">
        <div className="flex items-center gap-6 flex-wrap">
          {data && <ProgressRing pct={data.percentComplete} />}
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-bold">Welcome, {displayName}</h1>
            <p
              className="text-sm mt-1"
              style={{ color: "var(--hiq-muted-text)" }}
            >
              {data
                ? `${data.doneCount} of ${data.total} steps complete — a few minutes gets you
                  the full HobbyIQ signal.`
                : "Setting up your account."}
            </p>
          </div>
        </div>
      </section>

      {/* CF-WEB-GUIDE (2026-08-22). The checklist below is five account
          CHORES. Finishing all of them teaches a user nothing about what the
          app does — what BuyerIQ is for, what the confidence number means, or
          why our FMV is a projected next sale rather than a median. That last
          one is the whole differentiator and it lived only on the public
          marketing site. Put the way in ABOVE the chores, because a user who
          understands the product finishes setup for a reason. */}
      <section
        className="hiq-card p-5 flex items-center justify-between gap-4 flex-wrap"
        style={{
          borderColor: "color-mix(in oklab, var(--color-accent) 40%, transparent)",
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="font-semibold">New to HobbyIQ? Start here.</div>
          <p className="text-sm mt-1" style={{ color: "var(--hiq-muted-text)" }}>
            Five minutes on what the numbers mean and what each page is for — including
            why our FMV is the projected next sale, not a median.
          </p>
        </div>
        <Link href="/app/guide" className="hiq-btn-primary text-sm px-4 flex-shrink-0">
          How HobbyIQ works
        </Link>
      </section>

      {data && (
        <section className="hiq-card p-0 divide-y divide-[color:var(--color-border)]">
          {data.steps.map((step) => (
            <div
              key={step.id}
              className="flex items-start gap-4 p-5"
              style={{ opacity: step.done ? 0.65 : 1 }}
            >
              <StepIcon done={step.done} />
              <div className="min-w-0 flex-1">
                <div
                  className={`font-semibold ${step.done ? "line-through" : ""}`}
                >
                  {step.label}
                </div>
                <p
                  className="text-sm mt-1"
                  style={{ color: "var(--hiq-muted-text)" }}
                >
                  {step.description}
                </p>
              </div>
              <div className="flex-shrink-0">
                {step.done ? (
                  <span
                    className="text-xs font-semibold uppercase tracking-wide"
                    style={{ color: "var(--hiq-hobby-green)" }}
                  >
                    Done
                  </span>
                ) : (
                  <Link
                    href={step.href}
                    className="hiq-btn-primary text-sm px-3 py-2"
                  >
                    {step.cta ?? step.label}
                  </Link>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/app" className="hiq-btn-primary text-sm">
            Go to your dashboard
          </Link>
          <Link href="/app/guide" className="hiq-btn-secondary text-sm">
            How HobbyIQ works
          </Link>
        </div>
        <button
          onClick={onDismiss}
          className="text-sm hover:underline"
          style={{ color: "var(--hiq-muted-text)" }}
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <Suspense fallback={null}>
      <WelcomeBody />
    </Suspense>
  );
}
