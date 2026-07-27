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

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import {
  readOnboardingDismissed,
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

export default router;
