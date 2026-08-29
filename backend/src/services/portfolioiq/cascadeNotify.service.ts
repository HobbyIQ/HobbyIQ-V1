// CF-CASCADE-APNS-PUSH (Drew, 2026-07-17). Fan-out worker: given a
// set of freshly-fired cascade events, find the users who OWN the
// affected player AND have opted in to cascade push, then dispatch
// an APNs notification per user.
//
// Reuses `sendCascadeAlertNotification` in notification.service — this
// module owns policy (severity gate, owner lookup, best-effort semantics),
// NOT the APNs wire itself.
//
// Severity gate:
//   insider  → FIRE (biggest signal, graded market moving alone)
//   emerging → FIRE (cascade forming, graded ≥ 1.3× raw)
//   confirmed → SKIP (both raw & graded up — too noisy, late-stage)
//
// Best-effort: individual send failures are logged and the batch
// continues. Aggregate counts returned so the caller can log a summary.

import { sendCascadeAlertNotification } from "../notification.service.js";
import { listUsersOwningPlayerWithCascadeOptIn } from "./portfolioStore.service.js";
import type { CascadeEvent } from "../../types/cascadeAlert.types.js";

/** Severities that route to push. `confirmed` is deliberately excluded. */
const PUSHABLE_SEVERITIES: ReadonlySet<CascadeEvent["severity"]> = new Set([
  "insider",
  "emerging",
]);

export interface CascadeNotifyResult {
  sent: number;
  failed: number;
  /**
   * D13 (2026-08-29): opted-in owners found across the pushable events —
   * the population a push was owed to. `sent` alone cannot distinguish
   * "nobody to notify" from "provider missing, every send no-op'd".
   */
  optedInUsers: number;
}

/**
 * D13 (2026-08-29) — alert gates prove delivery. The nightly cascade
 * detect ran for six weeks with `pushSent: 0` and exit 0: the workflow
 * never passed the APNs env, so the provider was null and every send
 * silently no-op'd. This is the ONE decision the script makes about its
 * own exit code, kept pure so a test can pin the truth table:
 *
 *   newEvents > 0 AND optedInUsers > 0 AND provider missing → 1 (red)
 *   anything else                                            → 0
 *
 * A zero with nothing to send, or with a configured provider, is a
 * legitimate zero. A zero because the sender does not exist is not.
 */
export function cascadePushExitCode(input: {
  newEvents: number;
  optedInUsers: number;
  providerConfigured: boolean;
}): 0 | 1 {
  if (input.newEvents > 0 && input.optedInUsers > 0 && !input.providerConfigured) {
    return 1;
  }
  return 0;
}

/**
 * For each event whose severity is pushable, find opted-in owners and
 * dispatch a push. Returns aggregate counts. Never throws — individual
 * failures are swallowed after logging.
 *
 * `events` is expected to be the NEW events (deduped by the caller
 * against what's already stored), so this function will happily fire on
 * every event it receives.
 */
export async function sendCascadeAlertsForNewEvents(
  events: CascadeEvent[],
): Promise<CascadeNotifyResult> {
  let sent = 0;
  let failed = 0;
  let optedInUsers = 0;

  for (const ev of events) {
    if (!PUSHABLE_SEVERITIES.has(ev.severity)) {
      continue;
    }

    let owners: Array<{ userId: string; apnsDeviceToken: string | null }> = [];
    try {
      owners = await listUsersOwningPlayerWithCascadeOptIn(ev.player);
    } catch (err: any) {
      console.error(
        `[cascadeNotify] owner lookup failed player=${ev.player}: ${err?.message ?? err}`,
      );
      continue;
    }

    if (owners.length === 0) continue;
    optedInUsers += owners.length;

    for (const owner of owners) {
      try {
        const result = await sendCascadeAlertNotification(owner.userId, {
          player: ev.player,
          playerSlug: ev.playerSlug,
          severity: ev.severity,
          momentumRatio: ev.detectionInput.momentumRatio,
          reason: ev.reason,
        });
        sent += result.sent;
        failed += result.failed;
      } catch (err: any) {
        // Best-effort: swallow so a single-user failure doesn't abort
        // the batch and leave later owners un-notified.
        failed += 1;
        console.error(
          `[cascadeNotify] send failed user=${owner.userId} player=${ev.player}: ${err?.message ?? err}`,
        );
      }
    }
  }

  return { sent, failed, optedInUsers };
}

/** Exported for direct test coverage of the severity policy. */
export const _PUSHABLE_SEVERITIES = PUSHABLE_SEVERITIES;
