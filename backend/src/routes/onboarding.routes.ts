// CF-ONBOARDING (Drew, 2026-07-27). Server-derived new-user checklist.
//
// The endpoint doesn't add a new schema — it derives progress at query
// time from the systems each step touches:
//   verify          → user.emailVerification.verifiedAt
//   link-ebay       → readTokenRecord(userId) !== null
//   first-card      → portfolio.holdings has ≥ 1 entry
//   first-alert     → alertsService returns ≥ 1 alert
//   storefront      → user.publicShareEnabled === true (Pro Seller only)
//
// This means the checklist self-heals: a user who bounces off the flow
// and completes a step through the normal UI later shows up as done on
// their next visit.
//
// The only new field on the user record is `onboardingDismissed?: bool`
// so the "hide the banner" state persists across sessions.

// ─── CF-FIRST-RUN (Drew, 2026-09-02) ────────────────────────────────────
//
// The guided first-run funnel adds three routes to this same router,
// because it is the same subject and the checklist above is its
// long-tail sibling: the funnel gets a new collector to ONE valued card,
// the checklist nags about the rest forever.
//
//   GET  /api/onboarding/first-run          progress + the derived facts
//   POST /api/onboarding/first-run          persist a progress record
//   POST /api/onboarding/telemetry          one funnel step event
//
// Progress persists on the USER DOC (authService's firstRun field), via
// the same readUser/writeUser lane onboardingDismissed already uses. No
// new container, no new partition key, nothing to provision.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import {
  getUserBySession,
  readFirstRunProgress,
  readOnboardingDismissed,
  setFirstRunProgress,
  setOnboardingDismissed,
} from "../services/authService.js";
import { readTokenRecord } from "../services/ebay/ebayTokenStore.service.js";
import { readUserDoc } from "../services/portfolioiq/portfolioStore.service.js";
import { listAlertsForUser } from "../repositories/priceAlerts.repository.js";
import { effectivePlanFor } from "../config/entitlements.js";

const router = Router();

interface Step {
  id: "verify" | "link-ebay" | "first-card" | "first-alert" | "storefront";
  label: string;
  description: string;
  done: boolean;
  href: string;
  // Optional CTA-copy override — defaults to the label if absent.
  cta?: string;
}

router.get("/", requireSession, async (req: Request, res: Response) => {
  const user = req.user!;
  const userId = user.userId;

  // Fetch every derived signal in parallel. Any single failure just
  // marks that step "not done" — the checklist never blocks on a
  // subsystem being unavailable.
  const [ebayToken, portfolio, alerts, dismissed] = await Promise.all([
    readTokenRecord(userId).catch(() => null),
    readUserDoc(userId).catch(() => null),
    listAlertsForUser(userId).catch(() => []),
    readOnboardingDismissed(userId).catch(() => false),
  ]);

  const holdingCount = portfolio?.holdings
    ? Object.keys(portfolio.holdings).length
    : 0;
  const alertCount = Array.isArray(alerts) ? alerts.length : 0;

  const effectivePlan = effectivePlanFor({
    plan: user.plan,
    entitlementOverride: user.entitlementOverride,
  });

  const steps: Step[] = [
    {
      id: "verify",
      label: "Verify your email",
      description:
        "Confirm your address so we can send you alerts, receipts, and password-reset links.",
      done: Boolean(user.emailVerified),
      href: "/app/settings",
      cta: "Send verification email",
    },
    {
      id: "link-ebay",
      label: "Link your eBay account",
      description:
        "Auto-import your sales so cost basis and P&L stay accurate without manual entry.",
      done: Boolean(ebayToken),
      href: "/app/ebay",
      cta: "Connect eBay",
    },
    {
      id: "first-card",
      label: "Add your first card",
      description:
        "Start your portfolio — search a player, scan a cert, or import a Card Ladder CSV.",
      done: holdingCount > 0,
      href: "/app/portfolio/add",
      cta: "Add a card",
    },
    {
      id: "first-alert",
      label: "Set your first price alert",
      description:
        "Get notified the moment FMV crosses a threshold you set — sell high, buy low.",
      done: alertCount > 0,
      href: "/app/alerts",
      cta: "Create an alert",
    },
  ];

  // Storefront step surfaces only for Pro Seller. Steps stay identical
  // for other tiers so upgrading later reveals the last step without
  // making it look like a step disappeared for existing users.
  if (effectivePlan === "pro_seller") {
    steps.push({
      id: "storefront",
      label: "Enable your public storefront",
      description:
        "Flip the toggle at /app/settings to publish your inventory to hobby-iq.com/u/<yourname>.",
      done: Boolean(user.publicShareEnabled),
      href: "/app/settings",
      cta: "Open settings",
    });
  }

  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;
  const percentComplete = total === 0 ? 100 : Math.round((doneCount / total) * 100);

  return res.json({
    success: true,
    steps,
    doneCount,
    total,
    percentComplete,
    dismissed,
  });
});

router.post("/dismiss", requireSession, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await setOnboardingDismissed(userId, true);
  return res.json({ success: true });
});

router.post("/reopen", requireSession, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await setOnboardingDismissed(userId, false);
  return res.json({ success: true });
});

// ─── CF-FIRST-RUN: the guided funnel ────────────────────────────────────

const FIRST_RUN_STEP_IDS = ["lane", "first-value", "next-step"] as const;
const LANE_IDS = ["ebay", "import", "search"] as const;

type StoredFirstRun = NonNullable<
  Awaited<ReturnType<typeof readFirstRunProgress>>
>;

/** Validate a client-supplied progress record before it is written.
 *
 *  The client owns the state machine (apps/web/src/lib/firstRun.ts) and
 *  this endpoint is its persistence, so the server's job is not to
 *  re-derive the transitions — it is to make sure nothing that lands in
 *  the user doc can break the next read. Unknown step ids and lanes are
 *  DROPPED rather than rejected: a client one version ahead should not
 *  get a 400 that strands the user mid-funnel.
 *
 *  Note what this deliberately does NOT do: it does not grant anything.
 *  Progress is a record of what a person clicked, never an entitlement,
 *  so a forged body buys nothing but a wrong progress bar on their own
 *  account. Every gated surface the funnel links to is re-checked by
 *  requireEntitlement on its own route. */
function sanitizeProgress(raw: unknown): StoredFirstRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const status =
    r.status === "skipped" || r.status === "completed" || r.status === "active"
      ? r.status
      : "active";

  const completedSteps: string[] = [];
  if (Array.isArray(r.completedSteps)) {
    for (const s of r.completedSteps) {
      if (
        typeof s === "string"
        && (FIRST_RUN_STEP_IDS as readonly string[]).includes(s)
        && !completedSteps.includes(s)
      ) {
        completedSteps.push(s);
      }
    }
  }

  const lane =
    typeof r.lane === "string" && (LANE_IDS as readonly string[]).includes(r.lane)
      ? r.lane
      : null;

  // Timestamps are echoed back as strings but capped in length so a
  // hostile body cannot grow the user doc. The server stamps its own
  // updatedAt regardless — the client clock is a hint, not the record.
  const iso = (v: unknown): string | null =>
    typeof v === "string" && v.length <= 40 ? v : null;

  return {
    status,
    completedSteps,
    lane,
    startedAt: iso(r.startedAt),
    updatedAt: new Date().toISOString(),
  };
}

/** GET the funnel state: the stored progress plus the two derived facts
 *  the client needs to decide whether to run at all. Both facts are read
 *  from the systems that own them (the same self-healing principle the
 *  checklist above uses) — a user who added a card on iOS shows a
 *  holdingCount here without the web ever having been told. */
router.get("/first-run", requireSession, async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const [progress, portfolio] = await Promise.all([
    readFirstRunProgress(userId).catch(() => undefined),
    readUserDoc(userId).catch(() => null),
  ]);

  const holdingCount = portfolio?.holdings
    ? Object.keys(portfolio.holdings).length
    : 0;

  return res.json({
    success: true,
    // null (not a fabricated empty record) means "never started" — the
    // client's normalizeProgress turns that into the empty record, so
    // there is one place that decides what a fresh user looks like.
    progress: progress ?? null,
    holdingCount,
  });
});

router.post("/first-run", requireSession, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const progress = sanitizeProgress(req.body?.progress);
  if (!progress) {
    return res.status(400).json({ success: false, error: "progress required" });
  }
  const ok = await setFirstRunProgress(userId, progress);
  if (!ok) return res.status(404).json({ success: false, error: "user not found" });
  return res.json({ success: true, progress });
});

/** The funnel's telemetry sink.
 *
 *  NO NEW VENDOR: this writes one structured JSON line to stdout, which
 *  the App Service agent lifts into App Insights — the identical pattern
 *  logSubRawInversionObserved uses in marketRead.service.ts. Query it
 *  there with `summarize by step, action`.
 *
 *  Deliberately NOT behind requireSession. The most valuable event in a
 *  signup funnel is the one from someone who left, and gating the sink on
 *  a valid session would systematically delete the drop-off we are trying
 *  to measure. The userId is attached when a session happens to be
 *  present and omitted otherwise; nothing here reads or writes user data,
 *  so an unauthenticated caller can add noise to a log and nothing else.
 *
 *  Every field is bounded and the whole thing is wrapped: telemetry must
 *  never be the reason a request fails. It answers 204 unconditionally. */
router.post("/telemetry", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown, max = 64): string | null =>
      typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

    const step = str(body.step, 32);
    const action = str(body.action, 32);

    // A row with no step or action cannot be counted, so it is not worth
    // a line in the log. Still a 204 — the client is not to retry.
    if (step && action) {
      // Detail is flattened to primitives and capped, so a malformed or
      // hostile payload cannot write an unbounded object into telemetry.
      const detail: Record<string, string | number | boolean> = {};
      const rawDetail = body.detail;
      if (rawDetail && typeof rawDetail === "object" && !Array.isArray(rawDetail)) {
        for (const [k, v] of Object.entries(rawDetail).slice(0, 8)) {
          if (typeof v === "number" || typeof v === "boolean") detail[k.slice(0, 32)] = v;
          else if (typeof v === "string") detail[k.slice(0, 32)] = v.slice(0, 64);
        }
      }

      // Resolve the session by hand rather than mounting requireSession:
      // the route must accept anonymous callers (above), so the lookup
      // has to be able to fail without becoming a 401. An invalid or
      // expired id is simply an event with no user attached.
      const sessionId = req.header("x-session-id");
      const user = sessionId
        ? await getUserBySession(sessionId).catch(() => null)
        : null;

      console.log(JSON.stringify({
        event: "onboarding_funnel_step",
        step,
        action,
        lane: str(body.lane, 16),
        detail: Object.keys(detail).length > 0 ? detail : null,
        // Present only when the caller had a live session. An anonymous
        // event is still a real event — see the note above.
        userId: user?.userId ?? null,
        clientTimestamp: str(body.clientTimestamp, 40),
        timestamp: new Date().toISOString(),
      }));
    }
  } catch {
    // Telemetry failures must never propagate.
  }
  return res.status(204).end();
});

export default router;
