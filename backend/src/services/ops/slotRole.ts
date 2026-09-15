/**
 * CF-A-STAGING-SLOT-MUST-NOT-ACT-LIKE-PRODUCTION (Fable, 2026-09-15).
 *
 * WHY THIS EXISTS. R56 approves a staging deployment slot for HobbyIQ3 so that
 * no cold process ever takes user traffic: deploy to the slot, warm it, smoke
 * it, then swap it into production. The swap is the easy half. The dangerous
 * half is that an App Service slot runs THE SAME IMAGE WITH THE SAME SETTINGS,
 * so unless something stops it, a warming slot is a second complete production
 * backend — with the production Cosmos connection string, the production eBay
 * credentials and the production APNs key — running every in-process scheduler
 * a minute or two before it takes over from the instance already running them.
 *
 * Twelve schedulers start at boot in server.ts today:
 *
 *   startDailyJobs                     startEbayOrderPollJob
 *   startPortfolioRepriceJob           startEbayFinancesEnrichmentJob
 *   startPriceAlertEvaluatorJob        startWeeklyEbayPurchaseSyncJob
 *   startStagingDrainer                startSubscriptionsSafetyNetJob
 *   startAdvancedAlertsEvaluatorJob    startMatchedCohortJob
 *   startBuyerIqDealScannerJob         startCacheHitRateEmit
 *
 * Double-running them is not a tidiness problem. The concrete hazards, each
 * from a job that already exists:
 *
 *   - priceAlertEvaluator and advancedAlertsEvaluator send PUSH
 *     NOTIFICATIONS. A user would get every alert twice, from two processes
 *     that cannot see each other's sends.
 *   - portfolioReprice WRITES holding values. Two repricers racing the same
 *     holdings is how a value gets written from a half-migrated pool.
 *   - ebayOrderPoll ADVANCES A CURSOR and records sales. Two pollers share one
 *     cursor: one advances past orders the other has not processed, and those
 *     orders are then never seen again.
 *   - stagingDrainer promotes rows out of comps_staging. Two drainers promote
 *     the same row twice.
 *
 * Some of those jobs have their own kill switches already, but they are
 * per-job, inconsistently named (`_DISABLE` vs `_ENABLED`), and default to ON.
 * Relying on remembering to set eleven of them correctly on a slot is exactly
 * the kind of configuration that is right the day it is written and wrong six
 * months later. One gate, default-safe, is the whole point.
 *
 * THE GATE. `HIQ_SLOT_ROLE=staging` turns off every in-process job and every
 * outbound side effect, while leaving the HTTP surface up so `/api/health` and
 * `/api/health/warm` still answer — which is what the deploy needs in order to
 * warm and smoke the slot before swapping it.
 *
 * IT MUST BE SLOT-STICKY. In App Service a "sticky" (slot setting) stays with
 * the SLOT across a swap, rather than travelling with the code. That is the
 * property that makes this safe: after the swap, the newly-promoted instance
 * is production and reads no `HIQ_SLOT_ROLE`, so it starts its jobs normally;
 * the old production instance lands in the staging slot, picks up
 * `HIQ_SLOT_ROLE=staging`, and goes quiet. Marked non-sticky it would swap
 * along with the code and silence production — which is the failure this
 * comment exists to prevent. See docs/runbooks/staging-slot-swap.md.
 *
 * DEFAULT IS PRODUCTION. An unset variable means production, so nothing
 * changes for the app as it runs today and no existing deployment has to be
 * touched for this code to be safe to merge.
 */

export type SlotRole = "production" | "staging";

/**
 * This process's role. `staging` ONLY when `HIQ_SLOT_ROLE` says so explicitly;
 * anything else — unset, empty, a typo — is production.
 *
 * Read at call time rather than cached at module load, so a test can set the
 * variable and observe the effect without re-importing the module graph.
 */
export function slotRole(): SlotRole {
  return String(process.env.HIQ_SLOT_ROLE ?? "").trim().toLowerCase() === "staging"
    ? "staging"
    : "production";
}

/** True on a staging slot. The single predicate every gate should ask. */
export function isStagingSlot(): boolean {
  return slotRole() === "staging";
}

/**
 * May this process run in-process schedulers, write user data, or send
 * anything outbound?
 *
 * Named for what it PERMITS rather than what it disables, so a call site reads
 * as a positive condition and a new job added later has to opt in by asking.
 */
export function mayRunBackgroundJobs(): boolean {
  return !isStagingSlot();
}

/**
 * Guard a named background job. Returns true when it may start; logs and
 * returns false on a staging slot, so the skip is visible in the slot's own
 * log stream rather than being a silent absence — "why did nothing run?" is a
 * question the log should answer.
 */
export function allowBackgroundJob(jobName: string): boolean {
  if (mayRunBackgroundJobs()) return true;
  console.warn(JSON.stringify({
    event: "background_job_skipped_on_staging_slot",
    source: "slotRole",
    job: jobName,
    role: slotRole(),
    detail: "in-process jobs and outbound side effects are disabled on a staging slot; it serves /api/health and /api/health/warm only",
  }));
  return false;
}
