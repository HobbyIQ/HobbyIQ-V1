"use client";

// CF-FIRST-RUN (Drew, 2026-09-02). The guided first-run funnel.
//
// signup → a VALUED portfolio in minutes. Three steps:
//
//   1. lane        pick how your first card arrives — link eBay, import a
//                  file, or search one card. Each hands off to a flow that
//                  already ships; this page routes, it does not reimplement.
//   2. first-value the payoff: the card, its canonical value, the
//                  provenance chip, one line of how we price.
//   3. next-step   market indexes + what to do next, honestly gated.
//
// WHAT LIVES WHERE. The rules are in lib/firstRun.ts (pure, pinned) and
// the value render is lib/firstValue.ts (pure, pinned). This file is the
// shell: fetch, render, persist, emit. When a behaviour here looks like a
// decision, it belongs in one of those two modules instead.
//
// RESUMABLE + SKIPPABLE + NEVER BLOCKING. Progress round-trips through
// the user doc (/api/onboarding/first-run), so a refresh, a new device or
// finishing a lane in another tab all resume on the right step. `Skip`
// is terminal and persisted. A returning user who already reached their
// first value is bounced to /app before this page paints anything.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FirstValueCard } from "@/components/FirstValueCard";
import { MarketIndexes } from "@/components/MarketIndexes";
import {
  fetchEntitlements,
  fetchFirstRun,
  fetchPortfolio,
  hasFeature,
  saveFirstRun,
  type PortfolioHolding,
} from "@/lib/api";
import {
  FIRST_RUN_STEP_IDS,
  chooseLane,
  completeStep,
  currentStep,
  emptyProgress,
  lanesFor,
  nextActionsFor,
  normalizeProgress,
  shouldRunFirstRun,
  skipFunnel,
  stepIndex,
  tierLabelFor,
  type FirstRunContext,
  type FirstRunProgress,
  type FirstRunStepId,
  type LaneId,
  type NextAction,
} from "@/lib/firstRun";
import { trackFunnelStep } from "@/lib/funnelTelemetry";

export default function FirstRunPage() {
  const router = useRouter();

  const [progress, setProgress] = useState<FirstRunProgress | null>(null);
  const [ctx, setCtx] = useState<FirstRunContext | null>(null);
  const [holding, setHolding] = useState<PortfolioHolding | null>(null);
  const [loading, setLoading] = useState(true);
  const [pollingLane, setPollingLane] = useState(false);

  // ─── Load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Three reads, resolved independently. An entitlement probe that
      // fails must not stop the funnel: `entitlementsKnown: false` makes
      // the machine hide gated lanes and show honest upsells, which is a
      // working funnel — a thrown error would be a locked-out new user.
      const [state, ents] = await Promise.all([
        fetchFirstRun().catch(() => null),
        fetchEntitlements().then(
          (r) => ({ ok: true as const, features: r.features }),
          () => ({ ok: false as const, features: undefined }),
        ),
      ]);
      if (cancelled) return;

      const p = normalizeProgress(state?.progress ?? null);
      const holdingCount = state?.holdingCount ?? 0;
      const context: FirstRunContext = {
        features: ents.features,
        holdingCount,
        entitlementsKnown: ents.ok,
      };

      // Rule 1: never block a returning user. This runs before any funnel
      // chrome paints, so a completed / skipped account sees the app, not
      // a flash of onboarding.
      if (!shouldRunFirstRun(p, { holdingCount })) {
        router.replace("/app");
        return;
      }

      setProgress(p);
      setCtx(context);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  // ─── Persist ──────────────────────────────────────────────────────────
  // Every transition writes through. The local state updates first so the
  // UI never waits on a round trip, and a failed write is swallowed: the
  // worst case is a resumed session landing one step earlier, which is a
  // far better outcome than an error dialog between a new user and their
  // first price.
  const commit = useCallback((next: FirstRunProgress) => {
    setProgress(next);
    void saveFirstRun(next).catch(() => {});
  }, []);

  const step: FirstRunStepId | null = progress ? currentStep(progress) : null;

  // ─── Telemetry: one `view` per step, per visit ────────────────────────
  // A ref, not state — re-emitting on every re-render would inflate the
  // top of the funnel and make the drop-off rate meaningless.
  const viewed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!progress || !step) return;
    if (viewed.current.has(step)) return;
    viewed.current.add(step);
    // A step the user lands on with progress already behind them is a
    // RESUME, not a fresh view — the distinction is the whole point of
    // measuring: people who come back are not people who dropped.
    const resumed = progress.completedSteps.length > 0 && viewed.current.size === 1;
    trackFunnelStep({
      step,
      action: resumed ? "resume" : "view",
      lane: progress.lane,
      detail: { stepIndex: stepIndex(progress) },
    });
  }, [step, progress]);

  // ─── Poll for the first holding while a lane is in flight ─────────────
  // The lanes hand off to real flows in this same tab or another one. When
  // the user comes back, the holding may already exist — so once a lane is
  // chosen and we are on the value step with nothing to show, ask the
  // portfolio periodically rather than making them refresh.
  useEffect(() => {
    if (step !== "first-value" || holding) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const look = async () => {
      setPollingLane(true);
      const res = await fetchPortfolio().catch(() => null);
      if (cancelled) return;
      const first = res?.items?.[0] ?? null;
      if (first) {
        setHolding(first);
        setPollingLane(false);
        return;
      }
      timer = setTimeout(look, 5000);
    };

    void look();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [step, holding]);

  // ─── Actions ──────────────────────────────────────────────────────────

  function onPickLane(lane: LaneId, href: string) {
    if (!progress) return;
    trackFunnelStep({ step: "lane", action: "advance", lane, detail: { href } });
    commit(chooseLane(progress, lane));
    // Hand off to the shipped flow. The funnel resumes on return because
    // progress is server-side, not in this component's state.
    router.push(href);
  }

  function onSkip(from: FirstRunStepId) {
    if (!progress) return;
    trackFunnelStep({ step: from, action: "skip", lane: progress.lane });
    commit(skipFunnel(progress));
    router.push("/app");
  }

  function onAdvance(from: FirstRunStepId) {
    if (!progress) return;
    const next = completeStep(progress, from);
    trackFunnelStep({
      step: from,
      action: next.status === "completed" ? "complete" : "advance",
      lane: progress.lane,
    });
    commit(next);
    if (next.status === "completed") router.push("/app");
  }

  // ─── Render ───────────────────────────────────────────────────────────

  if (loading || !progress || !ctx) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="text-sm" style={{ color: "var(--hiq-muted-text)" }}>
          Setting things up…
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <StepRail progress={progress} />

      {step === "lane" && (
        <LaneStep ctx={ctx} onPick={onPickLane} onSkip={() => onSkip("lane")} />
      )}

      {step === "first-value" && (
        <ValueStep
          holding={holding}
          polling={pollingLane}
          laneHref={laneHrefFor(progress.lane)}
          onContinue={() => onAdvance("first-value")}
          onSkip={() => onSkip("first-value")}
        />
      )}

      {step === "next-step" && (
        <NextStep
          ctx={ctx}
          onDone={() => onAdvance("next-step")}
        />
      )}
    </div>
  );
}

function laneHrefFor(lane: LaneId | null): string {
  if (lane === "ebay") return "/app/ebay";
  if (lane === "import") return "/app/portfolio/import";
  return "/app/portfolio/add";
}

// ─── The progress rail ──────────────────────────────────────────────────

const STEP_LABEL: Record<FirstRunStepId, string> = {
  lane: "Add a card",
  "first-value": "See its value",
  "next-step": "What next",
};

function StepRail({ progress }: { progress: FirstRunProgress }) {
  const idx = stepIndex(progress);
  return (
    <nav aria-label="Setup progress" className="flex items-center gap-2 flex-wrap">
      {FIRST_RUN_STEP_IDS.map((id, i) => {
        const done = progress.completedSteps.includes(id);
        const current = i === idx;
        return (
          <div key={id} className="flex items-center gap-2">
            <span
              className="flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium"
              style={{
                background: current
                  ? "color-mix(in oklab, var(--hiq-electric-blue) 18%, transparent)"
                  : "transparent",
                color: done
                  ? "var(--hiq-hobby-green)"
                  : current
                    ? "var(--hiq-electric-blue)"
                    : "var(--hiq-muted-text)",
              }}
              aria-current={current ? "step" : undefined}
            >
              <span aria-hidden="true">{done ? "✓" : i + 1}</span>
              <span>{STEP_LABEL[id]}</span>
            </span>
            {i < FIRST_RUN_STEP_IDS.length - 1 && (
              <span aria-hidden="true" style={{ color: "var(--hiq-muted-text)" }}>
                ·
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ─── Step 1: pick your lane ─────────────────────────────────────────────

function LaneStep({
  ctx,
  onPick,
  onSkip,
}: {
  ctx: FirstRunContext;
  onPick: (lane: LaneId, href: string) => void;
  onSkip: () => void;
}) {
  // Feature-detected: a lane whose destination this account cannot reach
  // is not offered at all (lib/firstRun.ts explains why lanes hide and
  // next-actions upsell). `import` and `search` are open to every tier,
  // so this list is never empty.
  const lanes = lanesFor(ctx);

  return (
    <>
      <header>
        <h1 className="text-2xl sm:text-3xl font-bold">Let&apos;s value your first card</h1>
        <p
          className="text-sm mt-2 leading-relaxed max-w-prose"
          style={{ color: "var(--hiq-muted-text)" }}
        >
          Pick whichever is easiest — you can do the others later. One card is
          enough to see what HobbyIQ does.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {lanes.map((lane) => (
          <button
            key={lane.id}
            type="button"
            onClick={() => onPick(lane.id, lane.href)}
            className="hiq-card p-5 text-left transition-transform active:scale-[0.99]"
            style={{ cursor: "pointer" }}
          >
            <div className="font-semibold">{lane.label}</div>
            <p
              className="text-sm mt-1.5 leading-relaxed"
              style={{ color: "var(--hiq-muted-text)" }}
            >
              {lane.blurb}
            </p>
            <div
              className="text-xs mt-3 font-medium"
              style={{ color: "var(--hiq-electric-blue)" }}
            >
              {lane.cta} · {lane.effort}
            </div>
          </button>
        ))}
      </div>

      <SkipRow onSkip={onSkip} />
    </>
  );
}

// ─── Step 2: the value moment ───────────────────────────────────────────

function ValueStep({
  holding,
  polling,
  laneHref,
  onContinue,
  onSkip,
}: {
  holding: PortfolioHolding | null;
  polling: boolean;
  laneHref: string;
  onContinue: () => void;
  onSkip: () => void;
}) {
  if (!holding) {
    // The lane is still in flight — the user has not finished the eBay
    // link / the import / the search yet. We wait rather than declaring
    // failure, and give them the way back into the flow they picked.
    return (
      <>
        <header>
          <h1 className="text-2xl sm:text-3xl font-bold">Waiting on your first card</h1>
          <p
            className="text-sm mt-2 leading-relaxed max-w-prose"
            style={{ color: "var(--hiq-muted-text)" }}
          >
            {polling
              ? "As soon as a card lands in your portfolio, we will price it and show you the number here."
              : "Finish adding a card and come back — this page picks up where you left off."}
          </p>
        </header>
        <div className="flex flex-wrap gap-3">
          <Link href={laneHref} className="hiq-btn-primary text-sm">
            Back to adding a card
          </Link>
        </div>
        <SkipRow onSkip={onSkip} />
      </>
    );
  }

  return (
    <>
      <FirstValueCard holding={holding} />
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={onContinue} className="hiq-btn-primary text-sm">
          What to do next
        </button>
      </div>
      <SkipRow onSkip={onSkip} />
    </>
  );
}

// ─── Step 3: the strip ──────────────────────────────────────────────────

function NextStep({ ctx, onDone }: { ctx: FirstRunContext; onDone: () => void }) {
  const actions = nextActionsFor(ctx);
  // The indexes tile strip is itself a gated surface (marketTrendIndexes
  // is investor+). Feature-detected here so a free account gets the
  // upsell line instead of a strip of empty tiles — the component would
  // otherwise render its own failure state, which reads as breakage
  // rather than as a plan boundary.
  const indexesGranted = ctx.entitlementsKnown
    && hasFeature(ctx.features, "marketTrendIndexes");

  return (
    <>
      <header>
        <h1 className="text-2xl sm:text-3xl font-bold">You&apos;re set up</h1>
        <p
          className="text-sm mt-2 leading-relaxed max-w-prose"
          style={{ color: "var(--hiq-muted-text)" }}
        >
          Here is what the market is doing, and the three things worth doing next.
        </p>
      </header>

      {indexesGranted ? (
        <MarketIndexes showHeading showExploreLink={false} />
      ) : (
        <section className="hiq-card p-5">
          <div className="text-sm font-semibold">Market indexes</div>
          <p
            className="text-sm mt-1.5 leading-relaxed"
            style={{ color: "var(--hiq-muted-text)" }}
          >
            Per-sport index trends over 180 days come with{" "}
            {tierLabelFor("investor")}. Your own cards are priced on every plan —
            the indexes add the market they sit in.
          </p>
          <Link href="/pricing" className="hiq-btn-secondary text-sm mt-4 inline-block">
            See plans
          </Link>
        </section>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {actions.map((a) => (
          <NextActionCard key={a.id} action={a} />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={onDone} className="hiq-btn-primary text-sm">
          Go to my portfolio
        </button>
      </div>
    </>
  );
}

function NextActionCard({ action }: { action: NextAction }) {
  const locked = action.gated === "upsell";
  // A gated action is SHOWN, and says plainly what unlocks it. Hiding it
  // would make the product look smaller than it is; a fake-open button
  // that 402s on click would be worse. The href goes to pricing, so the
  // click does what the card promised.
  const href = locked ? "/pricing" : action.href;

  return (
    <Link href={href} className="hiq-card p-5 block">
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold">{action.label}</div>
        {locked && (
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight flex-shrink-0"
            style={{
              background: "color-mix(in oklab, var(--hiq-electric-blue) 15%, transparent)",
              color: "var(--hiq-electric-blue)",
            }}
          >
            {tierLabelFor(action.requiredTier)}
          </span>
        )}
      </div>
      <p
        className="text-sm mt-1.5 leading-relaxed"
        style={{ color: "var(--hiq-muted-text)" }}
      >
        {action.blurb}
      </p>
      {locked && (
        <div className="text-xs mt-3" style={{ color: "var(--hiq-muted-text)" }}>
          Included with {tierLabelFor(action.requiredTier)}.
        </div>
      )}
    </Link>
  );
}

// ─── Skip ───────────────────────────────────────────────────────────────

function SkipRow({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={onSkip}
        className="text-sm hover:underline"
        style={{ color: "var(--hiq-muted-text)" }}
      >
        Skip setup — I&apos;ll explore on my own
      </button>
    </div>
  );
}
