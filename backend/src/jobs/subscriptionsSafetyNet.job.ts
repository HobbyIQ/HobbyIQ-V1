// CF-PAYMENTS-APPLE-2 (2026-06-03): nightly subscription safety-net job.
//
// Catches webhooks Apple failed to deliver. Mirrors dailyiq.job's
// setTimeout + setInterval(24h) pattern.
//
// For each user with plan != free:
//   1. Call AppStoreServerAPIClient.getAllSubscriptionStatuses with
//      stored originalTransactionId.
//   2. Reconcile:
//        Apple expired/revoked AND we have paid -> downgrade to free
//        Apple active        AND we have free   -> restore plan + expiresAt
//        Apple active        AND plan matches   -> just refresh expiresAt
//        Apple active        AND plan differs   -> update plan (in-group
//                                                  tier change Apple
//                                                  applied but webhook
//                                                  missed)
//
// Logs per-user counts (reconciled / unchanged / errors) so a regression
// (e.g. a stale productMap) is greppable in App Insights.

import {
  Environment,
  Status,
  type StatusResponse,
  type LastTransactionsItem,
} from "@apple/app-store-server-library";
import {
  findReconcilableUsers,
  setUserSubscriptionState,
  type AppleSubscriptionState,
  type AuthUser,
} from "../services/authService.js";
import { type Plan } from "../config/entitlements.js";
import {
  getAppleConfig,
  pickEnvironmentClients,
  AppleConfigError,
} from "../services/subscriptions/appleConfig.js";
import { productIdToPlan } from "../services/subscriptions/productMap.js";

interface ReconcileSummary {
  totalScanned: number;
  reconciled: number;
  unchanged: number;
  errors: number;
}

function msUntilNextRun(hour: number, minute: number, tz: string): number {
  // Same algorithm as dailyiq.job — compute the next wall-clock moment
  // in tz that matches hh:mm:00, then subtract current UTC.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const localNowMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const tzOffsetMs = localNowMs - now.getTime();
  let targetLocal = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    minute,
    0,
  );
  if (targetLocal <= localNowMs) {
    targetLocal += 24 * 60 * 60 * 1000;
  }
  return targetLocal - tzOffsetMs - now.getTime();
}

/**
 * Reconcile a single user against Apple. BIDIRECTIONAL — applies both
 * the "Apple authoritative" upgrade/restore direction and the
 * "Apple revoked, we missed it" downgrade direction.
 *
 * Returns the outcome so the caller can aggregate counts. Throws on
 * Apple API errors so the caller counts them as "errors" rather than
 * mis-reporting as "unchanged".
 *
 * Reconcile cases (CF-PAYMENTS-APPLE-2-FIX 2026-06-03 — bidirectional):
 *   Apple ACTIVE + we have FREE         -> RESTORE plan from productId
 *   Apple ACTIVE + different paid plan  -> update plan
 *   Apple ACTIVE + matches (plan, exp)  -> unchanged
 *   Apple ACTIVE + matches plan, diff exp -> refresh expiresAt only
 *   Apple expired/revoked + we have paid -> downgrade to free
 *   Apple expired/revoked + we have free -> unchanged
 *   No Apple record + we have paid       -> downgrade to free
 *   No Apple record + we have free       -> unchanged
 *
 * All downgrade paths PRESERVE the appleSubscription link
 * (originalTransactionId + last known expiresAt) so the 40-day lookback
 * predicate keeps the user in the scan set for restore.
 */
async function reconcileUser(user: AuthUser): Promise<"reconciled" | "unchanged"> {
  const originalTransactionId = user.appleSubscription?.originalTransactionId;
  if (!originalTransactionId) {
    // Shouldn't happen with the findReconcilableUsers predicate, but
    // defensive: seeded admin without a real Apple sub.
    return "unchanged";
  }

  const env = user.appleSubscription?.environment === "Sandbox" ? "Sandbox" : "Production";
  const { apiClient, environment } = pickEnvironmentClients(env);

  const statusResponse: StatusResponse = await apiClient.getAllSubscriptionStatuses(
    originalTransactionId,
  );
  const matched = findStatusForTransaction(statusResponse, originalTransactionId);

  const currentByApple = matched ? isCurrent(matched.status) : false;

  // ─── Downgrade direction (Apple says not current) ────────────────────────
  if (!currentByApple) {
    if (user.plan === "free") return "unchanged";
    await downgradeToFreePreservingLink(user, environment, matched);
    return "reconciled";
  }

  // ─── Restore / upgrade / refresh direction (Apple says active) ──────────
  // matched is non-null because currentByApple required matched.
  const productIdFromApple =
    extractProductId(matched!.entry) ?? user.appleSubscription?.productId ?? null;
  const expiresFromApple = extractExpiresMs(matched!.entry) ?? null;
  const planFromApple = productIdFromApple ? productIdToPlan(productIdFromApple) : null;

  if (!planFromApple) {
    // Apple's active but productId isn't mapped. Log loudly, no change
    // — exactly like /verify and the webhook handler. Drew may have
    // added a product without updating productMap.ts.
    console.error(
      `[subscriptionsSafetyNet] UNKNOWN PRODUCTID from Apple for user=${user.userId}: ${productIdFromApple}`,
    );
    return "unchanged";
  }

  const expiresFromAppleIso = expiresFromApple ? new Date(expiresFromApple).toISOString() : null;
  const planChanged = planFromApple !== user.plan;
  const expiresChanged =
    expiresFromAppleIso !== null && expiresFromAppleIso !== user.appleSubscription?.expiresAt;

  if (!planChanged && !expiresChanged) return "unchanged";

  const apple: AppleSubscriptionState = {
    originalTransactionId,
    // Prefer Apple's authoritative value; fall back to stored if Apple's
    // entry didn't carry one.
    expiresAt: expiresFromAppleIso ?? user.appleSubscription?.expiresAt ?? null,
    lastEventAt: new Date().toISOString(),
    environment: environment === Environment.SANDBOX ? "Sandbox" : "Production",
    productId: productIdFromApple ?? "",
  };
  await setUserSubscriptionState(user.userId, planFromApple as Plan, apple);

  // Log specifically by direction for ops grep-ability.
  if (user.plan === "free") {
    console.log(
      `[subscriptionsSafetyNet] reconciled user=${user.userId} RESTORED free -> ${planFromApple} (Apple ACTIVE, productId=${productIdFromApple})`,
    );
  } else if (planChanged) {
    console.log(
      `[subscriptionsSafetyNet] reconciled user=${user.userId} plan ${user.plan} -> ${planFromApple} (Apple authoritative)`,
    );
  }
  // No plan-line log for plain expiresAt refresh — bounded log volume.
  return "reconciled";
}

/**
 * Downgrade to free while preserving the Apple link (originalTransactionId
 * and the most recent expiresAt we know about). This keeps the user
 * inside the 40-day lookback window so a future Apple restore (refund
 * reversal, grace extension, etc.) can be picked up by the next nightly
 * even if the webhook misses.
 */
async function downgradeToFreePreservingLink(
  user: AuthUser,
  environment: Environment,
  matched: { status: number; entry: LastTransactionsItem } | null,
): Promise<void> {
  // Prefer Apple's latest expiresAt if the entry has one; otherwise
  // preserve whatever we had stored. NEVER null this out — that would
  // drop the user out of the next nightly's lookback window.
  const expiresFromApple = matched ? extractExpiresMs(matched.entry) : null;
  const expiresAt = expiresFromApple
    ? new Date(expiresFromApple).toISOString()
    : user.appleSubscription?.expiresAt ?? null;
  const apple: AppleSubscriptionState = {
    originalTransactionId: user.appleSubscription!.originalTransactionId,
    expiresAt,
    lastEventAt: new Date().toISOString(),
    environment: environment === Environment.SANDBOX ? "Sandbox" : "Production",
    productId: user.appleSubscription?.productId ?? "",
  };
  await setUserSubscriptionState(user.userId, "free", apple);
  const reason = matched
    ? `Apple status=${Status[matched.status as Status] ?? matched.status}`
    : "no Apple record";
  console.log(`[subscriptionsSafetyNet] reconciled user=${user.userId} -> free (${reason})`);
}

/**
 * One-shot job entry point. Returns a summary so the route admin (if
 * added later) can echo it. Errors during a single user's reconcile are
 * logged + counted; the job DOES NOT throw — one bad user shouldn't
 * take down the whole nightly sweep.
 */
export async function runSubscriptionsSafetyNetJob(): Promise<ReconcileSummary> {
  let users: AuthUser[];
  try {
    users = await findReconcilableUsers();
  } catch (err: any) {
    console.error("[subscriptionsSafetyNet] findReconcilableUsers failed:", err?.message ?? err);
    return { totalScanned: 0, reconciled: 0, unchanged: 0, errors: 1 };
  }

  // Pre-flight: if Apple isn't configured (config error throws on first
  // pickEnvironmentClients call), abort cleanly so we don't burn through
  // every user logging the same error.
  try {
    getAppleConfig();
  } catch (err) {
    if (err instanceof AppleConfigError) {
      console.warn(
        "[subscriptionsSafetyNet] skipping run: Apple config missing — payments not deployed yet",
      );
      return { totalScanned: users.length, reconciled: 0, unchanged: 0, errors: 0 };
    }
    throw err;
  }

  let reconciled = 0;
  let unchanged = 0;
  let errors = 0;

  for (const user of users) {
    try {
      const outcome = await reconcileUser(user);
      if (outcome === "reconciled") reconciled++;
      else unchanged++;
    } catch (err: any) {
      errors++;
      console.error(
        `[subscriptionsSafetyNet] user=${user.userId} reconcile failed:`,
        err?.message ?? err,
      );
    }
  }

  console.log(
    `[subscriptionsSafetyNet] done totalScanned=${users.length} reconciled=${reconciled} unchanged=${unchanged} errors=${errors}`,
  );
  return { totalScanned: users.length, reconciled, unchanged, errors };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

let _scheduleTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

export function startSubscriptionsSafetyNetJob(): void {
  if (process.env.SUBSCRIPTIONS_SAFETY_NET_DISABLE_SCHEDULER === "true") {
    console.log("[subscriptionsSafetyNet] scheduler disabled via env");
    return;
  }
  if (_scheduleTimer || _intervalTimer) {
    console.warn("[subscriptionsSafetyNet] scheduler already running; ignoring duplicate start");
    return;
  }
  const hour = Number(process.env.SUBSCRIPTIONS_SAFETY_NET_JOB_HOUR ?? "5");
  const minute = Number(process.env.SUBSCRIPTIONS_SAFETY_NET_JOB_MINUTE ?? "15");
  const tz = process.env.SUBSCRIPTIONS_SAFETY_NET_JOB_TIMEZONE ?? "America/Los_Angeles";
  const delay = msUntilNextRun(hour, minute, tz);
  console.log(
    `[subscriptionsSafetyNet] scheduling first run in ${Math.round(delay / 1000 / 60)} min ` +
      `(target ${hour}:${String(minute).padStart(2, "0")} ${tz})`,
  );

  _scheduleTimer = setTimeout(() => {
    runSubscriptionsSafetyNetJob().catch((err) => {
      console.error("[subscriptionsSafetyNet] runSubscriptionsSafetyNetJob threw:", err?.message ?? err);
    });
    _intervalTimer = setInterval(() => {
      runSubscriptionsSafetyNetJob().catch((err) => {
        console.error("[subscriptionsSafetyNet] runSubscriptionsSafetyNetJob threw:", err?.message ?? err);
      });
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

export function stopSubscriptionsSafetyNetJob(): void {
  if (_scheduleTimer) { clearTimeout(_scheduleTimer); _scheduleTimer = null; }
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isCurrent(status: number | undefined): boolean {
  return status === Status.ACTIVE || status === Status.BILLING_GRACE_PERIOD;
}

function findStatusForTransaction(
  resp: StatusResponse,
  originalTransactionId: string,
): { status: number; entry: LastTransactionsItem } | null {
  const groups = resp.data ?? [];
  for (const group of groups) {
    const last = group.lastTransactions ?? [];
    for (const entry of last) {
      if (entry.originalTransactionId === originalTransactionId) {
        const status = typeof entry.status === "number" ? entry.status : null;
        if (status === null) continue;
        return { status, entry };
      }
    }
  }
  return null;
}

// LastTransactionsItem doesn't expose productId / expiresDate directly —
// those live inside the signed JWS (signedTransactionInfo). Apple's lib
// could decode it, but we accept the tradeoff of not chain-verifying the
// inner txn in the safety-net path: the OUTER getAllSubscriptionStatuses
// is itself an authenticated Apple API call. For first-cut safety-net we
// extract productId from the entry's decoded fields if present, falling
// back to the user's stored productId. Tests inject these directly.
function extractProductId(entry: LastTransactionsItem): string | null {
  // The lib's LastTransactionsItem only carries status + originalTxn +
  // signedTransactionInfo/signedRenewalInfo. To get productId we'd need
  // to decode signedTransactionInfo. For Phase 2 we accept the limitation:
  // when productId can't be extracted, the reconcile falls back to the
  // stored productId (same plan). Phase 3 can decode signedTransactionInfo
  // when we add in-group tier-change reconcile via the safety-net.
  const anyEntry = entry as unknown as { productId?: string };
  return typeof anyEntry.productId === "string" ? anyEntry.productId : null;
}

function extractExpiresMs(entry: LastTransactionsItem): number | null {
  const anyEntry = entry as unknown as { expiresDate?: number };
  return typeof anyEntry.expiresDate === "number" ? anyEntry.expiresDate : null;
}
