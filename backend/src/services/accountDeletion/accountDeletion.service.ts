// CF-ACCOUNT-DELETION (2026-06-04): orchestrator for `DELETE /api/account`.
//
// Apple Guideline 5.1.1(v) requires apps with account creation to offer
// in-app deletion. This service implements the backend purge across every
// container keyed by userId, anonymizes the two retain-with-PII-removed
// stores, and leaves the two no-PII stores untouched.
//
// Order of operations matters: the user-doc delete is LAST because that
// invalidates the session (getUserBySession returns null once the doc is
// gone). Other purges happen first so the in-flight request stays valid.
//
// Idempotent: a second call with the same session returns 401 because
// requireSession can no longer resolve the user. The iOS client clears
// its local session on the first 200 and never re-calls.
//
// Per-step errors are caught + logged + recorded in `failures[]`. The
// purge continues so a single container hiccup doesn't strand the user
// mid-deletion. The result summary reports per-container counts AND
// the failures array so the caller can verify what landed.
//
// SUBSYSTEM-TAGGED ERROR LOGGING (CF-PUSH-A+B+C STEP 0, 2026-06-04):
// every purge-step failure emits a structured error line prefixed
// with the relevant Group-B umbrella tag, e.g.
//   [cosmos][accountDeletion] purge step 'compiq_alerts' failed: ...
//   [ebay][accountDeletion] purge step 'ebay_connections_token' failed: ...
//   [apple][accountDeletion] purge step 'anonymize_subscription_events' failed: ...
// So Group B's per-subsystem error-spike alert picks up a partial-
// deletion failure without needing a dedicated `account_deletion`
// alert. Photo-blob failures tag as `[accountDeletion]` only — blob
// storage isn't a Group B subsystem, but the failure still lands in
// `failures[]` and the response.
//
// OPS RETRY-BY-USERID PATH:
// Every purge helper is idempotent and keyed by the same userId. If
// `result.failures` is non-empty, operators can replay just the failed
// steps:
//   - The user doc is the LAST step; if it landed (users_doc_deleted=
//     true), the session is dead and requireSession-gated routes won't
//     work. Operators invoke the underlying repo helpers directly
//     (e.g. deleteAllAlertsForUser(userId)) by the userId from the
//     route response.
//   - Every helper tolerates "nothing to delete" — replaying a
//     successful step is a no-op (returns 0/false).
//   - The original userId is the join key; it's stable + recoverable
//     from the route response body even after the user doc is gone.

import {
  deleteUserDoc,
  type AuthUser,
} from "../authService.js";
import {
  deletePortfolioDocForUser,
  type PortfolioDocDeletionSummary,
} from "../portfolioiq/portfolioStore.service.js";
import { deleteAllExpensesForUser } from "../../repositories/portfolioExpenses.repository.js";
import { deleteAllTaxFilingsForUser } from "../../repositories/taxFilings.repository.js";
import { deleteAllWatchlistEntriesForUser } from "../dailyiq/watchlistStore.service.js";
import { deleteAllAlertsForUser } from "../../repositories/priceAlerts.repository.js";
import { deleteAllRulesForUser } from "../../repositories/advancedAlertRules.repository.js";
import { deletePreferenceForUser } from "../../repositories/alertPreferences.repository.js";
import { deleteTokenRecord } from "../ebay/ebayTokenStore.service.js";
import { deleteAllTokensForUser } from "../../repositories/deviceToken.repository.js";
import { deleteAllBlobsForUser } from "../photoStorage/photoStorage.service.js";
import { anonymizePredictionLogForUser } from "../compiq/predictionCorpus.service.js";
import { anonymizeSubscriptionEventsForUser } from "../subscriptions/subscriptionEventStore.service.js";

export interface AccountDeletionPurgeCounts {
  // PII / user-keyed containers — fully purged
  portfolio_doc: PortfolioDocDeletionSummary;
  portfolio_expenses: number;
  tax_filings: number;
  dailyiq_watchlist: number;
  compiq_alerts: number;
  compiq_advanced_alert_rules: number;
  alert_preferences_doc_deleted: boolean;
  ebay_connections_token_deleted: boolean;
  device_tokens: number;
  photo_blobs: number;
  users_doc_deleted: boolean;
}

export interface AccountDeletionAnonymizedCounts {
  prediction_log_rows_anonymized: number;
  subscription_events_rows_anonymized: number;
}

export interface AccountDeletionResult {
  success: true;
  userId: string;
  deletedAt: string;
  // CF-PUSH-A+B+C STEP 0: per-step failure list. Empty on a clean
  // purge; populated with the step names that threw + were caught by
  // safePurge. Group B alerts fire on the `[<subsystem>]` line that
  // accompanies each push; this array exists so the route response
  // also surfaces the same information to the caller for retry.
  failures: string[];
  purged: AccountDeletionPurgeCounts;
  anonymized: AccountDeletionAnonymizedCounts;
  retained_no_pii: {
    prediction_outcomes: "no userId field on the row schema; not affected";
    webhook_events: "no userId field on the row schema; not affected";
  };
  appleSubscription:
    | {
        wasLinked: true;
        originalTransactionId: string;
        billingActionRequired: true;
        message: string;
        cancellationInstructionsUrl: string;
      }
    | { wasLinked: false };
}

const APPLE_CANCEL_MESSAGE =
  "Your subscription is billed by Apple. To stop being charged, you must also cancel in iOS Settings → Apple ID → Subscriptions → HobbyIQ. Deleting your HobbyIQ account does not cancel the Apple billing.";

const APPLE_CANCEL_URL =
  "https://hobbyiq.com/help/apple-subscription-cancel";

/**
 * Purge + anonymize for a single user. The caller (route layer) is
 * responsible for `requireSession` gating + the confirmation-token
 * body check. This function trusts the userId.
 *
 * Returns the full summary used by the route response. Throws ONLY on
 * a programming error — per-container failures are logged and counted
 * as zero so a transient Cosmos hiccup doesn't strand the user mid-purge.
 */
export async function deleteAccountForUser(user: AuthUser): Promise<AccountDeletionResult> {
  const userId = user.userId;
  const deletedAt = new Date().toISOString();
  const failures: string[] = [];

  // CF-PUSH-A+B+C STEP 0: per-step error capture. On throw, emit a
  // structured ERROR line tagged with the Group-B umbrella subsystem
  // AND `[accountDeletion]`, push the step name to `failures`, and
  // return `fallback` so the orchestrator doesn't strand on one
  // container hiccup. The tag is what the Group-B per-subsystem
  // error-spike alert query matches.
  const safePurge = async <T>(
    step: string,
    subsystemTag: string,
    fallback: T,
    fn: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (err: any) {
      console.error(
        `${subsystemTag}[accountDeletion] purge step '${step}' failed:`,
        err?.message ?? err,
      );
      failures.push(step);
      return fallback;
    }
  };

  // Step 1: anonymize the retain-with-PII-removed stores FIRST. These are
  // additive operations that don't block subsequent deletes; doing them
  // up front means even a mid-purge failure leaves no PII behind.
  const prediction_log_rows_anonymized = await safePurge(
    "anonymize_prediction_log",
    "[cosmos]",
    0,
    () => anonymizePredictionLogForUser(userId),
  );
  const subscription_events_rows_anonymized = await safePurge(
    "anonymize_subscription_events",
    "[cosmos][apple]",
    0,
    () => anonymizeSubscriptionEventsForUser(userId),
  );

  // Step 2: purge per-user containers in dependency-safe order. eBay token
  // first (revoke surface), then alert subsystems, preferences, watchlist,
  // tax filings, expenses, portfolio doc, photos. user doc LAST.

  // ebay_connections: deleteTokenRecord is the existing teardown helper —
  // same path that's already used at /auth/ebay/disconnect. Best-effort
  // (no live revocation against eBay's OAuth introspect endpoint today;
  // that's a separate follow-up).
  const ebay_connections_token_deleted = await safePurge(
    "ebay_connections_token",
    "[ebay]",
    false,
    async () => { await deleteTokenRecord(userId); return true; },
  );

  const device_tokens = await safePurge(
    "device_tokens",
    "[cosmos]",
    0,
    () => deleteAllTokensForUser(userId),
  );
  const compiq_alerts = await safePurge(
    "compiq_alerts",
    "[cosmos]",
    0,
    () => deleteAllAlertsForUser(userId),
  );
  const compiq_advanced_alert_rules = await safePurge(
    "compiq_advanced_alert_rules",
    "[cosmos]",
    0,
    () => deleteAllRulesForUser(userId),
  );
  const alert_preferences_doc_deleted = await safePurge(
    "alert_preferences",
    "[cosmos]",
    false,
    () => deletePreferenceForUser(userId),
  );
  const dailyiq_watchlist = await safePurge(
    "dailyiq_watchlist",
    "[cosmos]",
    0,
    () => deleteAllWatchlistEntriesForUser(userId),
  );
  const tax_filings = await safePurge(
    "tax_filings",
    "[cosmos]",
    0,
    () => deleteAllTaxFilingsForUser(userId),
  );
  const portfolio_expenses = await safePurge(
    "portfolio_expenses",
    "[cosmos]",
    0,
    () => deleteAllExpensesForUser(userId),
  );
  const portfolio_doc = await safePurge(
    "portfolio_doc",
    "[cosmos]",
    { existed: false, holdingCount: 0, ledgerCount: 0, tradeCount: 0, expensesEmbeddedCount: 0 },
    () => deletePortfolioDocForUser(userId),
  );
  // Photo blobs live in Azure Blob Storage — not a Group-B subsystem
  // (no [<subsystem>] alert today). The failure still surfaces via
  // `failures[]` and the route response, and `[accountDeletion]` keeps
  // the line greppable.
  const photo_blobs = await safePurge(
    "photo_blobs",
    "",
    0,
    () => deleteAllBlobsForUser(userId),
  );

  // Apple subscription handling — capture link state BEFORE deleting the
  // user doc, so the response can echo the originalTransactionId. We do
  // NOT call Apple — only the iOS-Settings user-side cancel can stop
  // billing. Backend just purges the link.
  const apple = user.appleSubscription;
  const appleSubscription: AccountDeletionResult["appleSubscription"] = apple
    ? {
        wasLinked: true,
        originalTransactionId: apple.originalTransactionId,
        billingActionRequired: true,
        message: APPLE_CANCEL_MESSAGE,
        cancellationInstructionsUrl: APPLE_CANCEL_URL,
      }
    : { wasLinked: false };

  // Step 3: user doc LAST. This invalidates the session.
  const users_doc_deleted = await safePurge(
    "users_doc",
    "[cosmos]",
    false,
    () => deleteUserDoc(userId),
  );

  return {
    success: true,
    userId,
    deletedAt,
    failures,
    purged: {
      portfolio_doc,
      portfolio_expenses,
      tax_filings,
      dailyiq_watchlist,
      compiq_alerts,
      compiq_advanced_alert_rules,
      alert_preferences_doc_deleted,
      ebay_connections_token_deleted,
      device_tokens,
      photo_blobs,
      users_doc_deleted,
    },
    anonymized: {
      prediction_log_rows_anonymized,
      subscription_events_rows_anonymized,
    },
    retained_no_pii: {
      prediction_outcomes: "no userId field on the row schema; not affected",
      webhook_events: "no userId field on the row schema; not affected",
    },
    appleSubscription,
  };
}
