// CF-FIRST-RUN (Drew, 2026-09-02). The onboarding funnel's step machine.
//
// THE GOAL: a new collector goes from signup to a VALUED portfolio in
// minutes. Not "a tour of the app" — one holding, priced, with the
// provenance shown, in as few decisions as we can get away with.
//
// This module is the machine only: which step is current, what a skip
// does, what completes a step, and how that state round-trips through
// the user doc. It is PURE — no DOM, no fetch, no React — because the
// rules below are doctrine and doctrine gets pinned by something that
// exits 0/1 (the convention vitest.config.mts sets for src/lib).
//
// FOUR RULES THIS MACHINE KEEPS:
//
// 1. IT NEVER BLOCKS A RETURNING USER. `shouldRunFirstRun` is the only
//    gate, and it answers false the moment the funnel is completed or
//    skipped, or the account already reached its first value. A
//    collector who imported 400 cards on iOS and then opens the web app
//    is not new, whatever their progress record says.
//
// 2. SKIP IS A REAL, PERSISTED ANSWER — not a dismissal that comes back
//    tomorrow. `skipFunnel` writes a terminal status. The funnel is
//    re-openable on purpose (settings, or the Today banner), but it
//    re-opens because the user asked, never because we forgot.
//
// 3. RESUME LANDS ON THE FIRST UNFINISHED STEP, and the steps behind it
//    stay done. Progress is per-user server state (the user doc, via the
//    same readUser/writeUser lane onboardingDismissed already uses) so
//    it survives a new device and a cleared browser. No new container.
//
// 4. A STEP THE USER CANNOT USE IS NOT SHOWN. Feature-detection removes
//    a lane whose destination would 402 — EXCEPT where the upsell IS the
//    content (`gated: "upsell"`), which the strip uses to say honestly
//    what a paid tier would add. Hiding is presentation; the server
//    re-checks every gated route regardless, so this can hide a surface
//    but can never unlock one.

// ─── The steps ──────────────────────────────────────────────────────────

/** The funnel's steps, in order. `lane` is the one branching step: the
 *  user picks HOW their first card arrives, and the three lanes all land
 *  on the same place — one holding that exists. */
export const FIRST_RUN_STEP_IDS = ["lane", "first-value", "next-step"] as const;
export type FirstRunStepId = (typeof FIRST_RUN_STEP_IDS)[number];

/** The three ways a first card arrives. Each maps to a flow that already
 *  ships — the funnel routes into them, it does not reimplement them. */
export const LANE_IDS = ["ebay", "import", "search"] as const;
export type LaneId = (typeof LANE_IDS)[number];

export interface Lane {
  id: LaneId;
  label: string;
  /** One line, second person, that says what happens — not what it is. */
  blurb: string;
  /** The shipped flow this lane hands off to. */
  href: string;
  cta: string;
  /** The entitlement key the lane's destination needs, or null when the
   *  lane is open to every tier. `ebayIntegration` is investor+, so a
   *  free user is not sent down a lane that ends in a 402. */
  requiresFeature: string | null;
  /** Roughly how long the lane takes, shown so the choice is informed. */
  effort: string;
}

export const LANES: readonly Lane[] = [
  {
    id: "ebay",
    label: "Link eBay",
    blurb:
      "Your eBay purchases become holdings, with what you paid already filled in.",
    href: "/app/ebay",
    cta: "Connect eBay",
    requiresFeature: "ebayIntegration",
    effort: "about a minute",
  },
  {
    id: "import",
    label: "Import a file",
    blurb:
      "Upload a CSV or spreadsheet — we match each row to a card and show you before anything is saved.",
    href: "/app/portfolio/import",
    cta: "Upload a file",
    requiresFeature: null,
    effort: "a few minutes",
  },
  {
    id: "search",
    label: "Add one card",
    blurb:
      "Search a player, pick the exact card, and see what it is worth right now.",
    href: "/app/portfolio/add",
    cta: "Search a card",
    requiresFeature: null,
    effort: "under a minute",
  },
] as const;

// ─── Persisted progress ─────────────────────────────────────────────────

export type FirstRunStatus = "active" | "skipped" | "completed";

/** Exactly what is stored on the user doc under `firstRun`. Small and
 *  flat on purpose: it is written on every step transition, so a fat
 *  record would mean a fat write on a hot path. */
export interface FirstRunProgress {
  status: FirstRunStatus;
  /** Steps the user has finished, in no particular order. */
  completedSteps: FirstRunStepId[];
  /** The lane they picked, once they have picked one. */
  lane: LaneId | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export function emptyProgress(): FirstRunProgress {
  return {
    status: "active",
    completedSteps: [],
    lane: null,
    startedAt: null,
    updatedAt: null,
  };
}

/** Read a stored record defensively. Anything malformed — a legacy row, a
 *  hand-edited doc, a field from a future version — degrades to the empty
 *  record rather than throwing on a page every new user sees. Unknown
 *  step ids and lane ids are DROPPED, not preserved: a step id we have no
 *  code for cannot be rendered, and keeping it would let it count toward
 *  completion and skip a step the user never saw. */
export function normalizeProgress(raw: unknown): FirstRunProgress {
  const out = emptyProgress();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  if (r.status === "skipped" || r.status === "completed" || r.status === "active") {
    out.status = r.status;
  }
  if (Array.isArray(r.completedSteps)) {
    const seen = new Set<FirstRunStepId>();
    for (const s of r.completedSteps) {
      if (typeof s === "string" && (FIRST_RUN_STEP_IDS as readonly string[]).includes(s)) {
        seen.add(s as FirstRunStepId);
      }
    }
    out.completedSteps = Array.from(seen);
  }
  if (typeof r.lane === "string" && (LANE_IDS as readonly string[]).includes(r.lane)) {
    out.lane = r.lane as LaneId;
  }
  out.startedAt = typeof r.startedAt === "string" ? r.startedAt : null;
  out.updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : null;
  return out;
}

// ─── Feature detection ──────────────────────────────────────────────────

/** What the caller knows about the account when it asks the machine
 *  anything. Every field is something the app already fetches — no new
 *  endpoint is implied by this shape. */
export interface FirstRunContext {
  /** Granted feature keys, in either wire shape (see EntitlementsMeResponse
   *  in api.ts — the backend sends an array, the type also allows a map). */
  features: string[] | Record<string, boolean> | undefined;
  /** How many holdings the account has. A funnel whose whole purpose is
   *  the first holding has nothing to say to an account that has one. */
  holdingCount: number;
  /** False when the entitlement probe failed. The machine then assumes
   *  NOTHING is granted: a gated lane is hidden and a gated action shows
   *  its upsell. The failure mode is an honest "here is what Investor
   *  adds", never a falsely unlocked surface. */
  entitlementsKnown: boolean;
}

function granted(ctx: FirstRunContext, feature: string): boolean {
  if (!ctx.entitlementsKnown) return false;
  const f = ctx.features;
  if (Array.isArray(f)) return f.includes(feature);
  if (f && typeof f === "object") return f[feature] === true;
  return false;
}

/** The lanes to offer this account. A lane whose destination the account
 *  cannot reach is dropped rather than shown-and-locked: unlike the
 *  strip's upsells, a LANE is a required choice, and offering a choice
 *  that 402s is a dead end at the exact moment we promised a fast one.
 *
 *  `import` and `search` are open to every tier, so this can never
 *  return empty — the funnel always has at least one way forward. */
export function lanesFor(ctx: FirstRunContext): Lane[] {
  return LANES.filter((l) => l.requiresFeature == null || granted(ctx, l.requiresFeature));
}

// ─── The "what next" strip ──────────────────────────────────────────────

export interface NextAction {
  id: "import-more" | "set-alert" | "sell-signals";
  label: string;
  blurb: string;
  href: string;
  /** "open" — the account can do this now.
   *  "upsell" — it cannot, and the card says so plainly, naming the tier.
   *  A gated action is never silently dropped from the strip: the honest
   *  version of a paywall is telling people what is behind it. */
  gated: "open" | "upsell";
  /** The tier that unlocks it, when gated. */
  requiredTier: string | null;
  requiresFeature: string | null;
}

const TIER_LABEL: Record<string, string> = {
  free: "Free",
  collector: "Collector",
  investor: "Investor",
  pro_seller: "Pro Seller",
};

export function tierLabelFor(tier: string | null | undefined): string {
  if (!tier) return "a paid plan";
  return TIER_LABEL[tier] ?? tier;
}

/** Minimum tier granting each feature the strip references. Mirrors
 *  backend/src/config/entitlements.ts, which is the one authority — this
 *  map only decides which WORD the upsell says. */
const REQUIRED_TIER: Record<string, string> = {
  advancedAlerts: "investor",
  ebayIntegration: "investor",
  marketTrendIndexes: "investor",
  erpReconciliation: "pro_seller",
};

/** The three things worth doing once a first card is priced. Each is
 *  feature-detected: granted → "open", not granted → "upsell" naming the
 *  tier. Nothing here bypasses an entitlement; every href lands on a
 *  route the server gates independently. */
export function nextActionsFor(ctx: FirstRunContext): NextAction[] {
  const actions: Omit<NextAction, "gated" | "requiredTier">[] = [
    {
      id: "import-more",
      label: "Add the rest of your collection",
      blurb:
        "One card is a price. A collection is a portfolio — import a file and value all of it at once.",
      href: "/app/portfolio/import",
      requiresFeature: null,
    },
    {
      id: "set-alert",
      label: "Set a price alert",
      blurb:
        "We watch the comps and tell you the moment a card crosses a number you pick.",
      href: "/app/alerts",
      requiresFeature: "advancedAlerts",
    },
    {
      id: "sell-signals",
      label: "See your sell signals",
      blurb:
        "When a card of yours enters a sell window — with the sales that say so.",
      href: "/app/seller",
      requiresFeature: "erpReconciliation",
    },
  ];

  return actions.map((a) => {
    if (a.requiresFeature == null) {
      return { ...a, gated: "open" as const, requiredTier: null };
    }
    const ok = granted(ctx, a.requiresFeature);
    return {
      ...a,
      gated: ok ? ("open" as const) : ("upsell" as const),
      requiredTier: ok ? null : (REQUIRED_TIER[a.requiresFeature] ?? null),
    };
  });
}

// ─── The machine ────────────────────────────────────────────────────────

/** Should the funnel run at all?
 *
 *  Rule 1 lives here. Order matters: the terminal statuses answer first,
 *  then the fact on the ground. An account that already has a holding AND
 *  has been shown its value has nothing left to gain from the funnel —
 *  that is the difference between "new user" and "user whose record we
 *  happen not to have written yet".
 *
 *  Note it does NOT bail on holdingCount alone. A user who added a card
 *  through the normal UI and never saw the value moment still gets the
 *  value moment; the funnel's whole product is that render. */
export function shouldRunFirstRun(
  progress: FirstRunProgress,
  ctx: Pick<FirstRunContext, "holdingCount">,
): boolean {
  if (progress.status === "skipped" || progress.status === "completed") return false;
  if (ctx.holdingCount > 0 && progress.completedSteps.includes("first-value")) return false;
  return true;
}

/** CF-DAILYIQ-BANNER-ONLY-WHEN-EMPTY (Drew, 2026-09-04: the "Value your first
 *  card — Get started" banner was rendering on a 43-holding portfolio).
 *
 *  The BANNER's gate, which is deliberately stricter than `shouldRunFirstRun`.
 *  The two answer different questions and must not be collapsed into one:
 *
 *    shouldRunFirstRun — "may the /app/start funnel run?" A user who added
 *      cards outside the funnel has still never seen the value moment, and
 *      that render IS the product, so the funnel stays available to them.
 *      The test above ("still shows the value moment to someone who added a
 *      card outside the funnel") pins that on purpose, and this change does
 *      not touch it — /app/start behaves exactly as before.
 *
 *    shouldShowFirstRunBanner — "should the Today page NAG about it?" No. A
 *      portfolio with holdings in it is not empty, and an owner looking at 43
 *      cards being told to value their first one is the app failing to read
 *      the screen it is on. The funnel is still reachable (the route, and
 *      settings); it just stops interrupting.
 *
 *  So: the banner requires the funnel to be runnable AND the portfolio to be
 *  genuinely empty. `holdingCount` is the fact on the ground and it is what
 *  decides — not a progress record that may simply never have been written. */
export function shouldShowFirstRunBanner(
  progress: FirstRunProgress,
  ctx: Pick<FirstRunContext, "holdingCount">,
): boolean {
  if (ctx.holdingCount > 0) return false;
  return shouldRunFirstRun(progress, ctx);
}

/** The step to render now: the first one not yet complete. Returns null
 *  when every step is done, which is the caller's cue to complete. */
export function currentStep(progress: FirstRunProgress): FirstRunStepId | null {
  for (const id of FIRST_RUN_STEP_IDS) {
    if (!progress.completedSteps.includes(id)) return id;
  }
  return null;
}

/** Zero-based index of the current step, for a progress indicator.
 *  Returns the step count when the funnel is finished. */
export function stepIndex(progress: FirstRunProgress): number {
  const cur = currentStep(progress);
  if (cur == null) return FIRST_RUN_STEP_IDS.length;
  return FIRST_RUN_STEP_IDS.indexOf(cur);
}

const now = () => new Date().toISOString();

/** Mark a step done and advance. Idempotent: completing a step twice is
 *  the same record, so a double-submit or a replayed request cannot
 *  corrupt progress or double-count the funnel.
 *
 *  Completing the LAST step completes the funnel — the machine has one
 *  definition of done rather than trusting each caller to notice. */
export function completeStep(
  progress: FirstRunProgress,
  step: FirstRunStepId,
): FirstRunProgress {
  const completed = progress.completedSteps.includes(step)
    ? progress.completedSteps
    : [...progress.completedSteps, step];
  const next: FirstRunProgress = {
    ...progress,
    completedSteps: completed,
    startedAt: progress.startedAt ?? now(),
    updatedAt: now(),
  };
  if (FIRST_RUN_STEP_IDS.every((id) => completed.includes(id))) {
    next.status = "completed";
  }
  return next;
}

/** Record the lane choice. Picking a lane completes the `lane` step —
 *  the choice IS the step, so there is no second "continue" to click. */
export function chooseLane(progress: FirstRunProgress, lane: LaneId): FirstRunProgress {
  return completeStep({ ...progress, lane }, "lane");
}

/** Skip the whole funnel. Terminal and persisted (rule 2). Progress made
 *  so far is KEPT, not cleared: if the user re-opens the funnel from
 *  settings, they resume where they were rather than starting over. */
export function skipFunnel(progress: FirstRunProgress): FirstRunProgress {
  return { ...progress, status: "skipped", updatedAt: now() };
}

/** Re-open a skipped or completed funnel, at the step it stopped on. */
export function reopenFunnel(progress: FirstRunProgress): FirstRunProgress {
  return { ...progress, status: "active", updatedAt: now() };
}
