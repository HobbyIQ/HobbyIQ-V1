#!/usr/bin/env -S npx tsx
/**
 * CF-WAITLIST (Drew, 2026-08-06). Launch broadcast script.
 *
 * Pages through every unnotified waitlist entry, sends the launch email,
 * marks the row notifiedAt. Idempotent — re-running skips rows already
 * marked.
 *
 * Env:
 *   BROADCAST_APPLY    true = actually send; default dry-run
 *   BROADCAST_URL      link to include in email; default https://hobby-iq.com/register
 *   BROADCAST_LIMIT    stop after N rows (safety cap); default 0 (unbounded)
 *   COSMOS_CONNECTION_STRING + ACS_EMAIL_CONNECTION_STRING + EMAIL_FROM_ADDRESS
 */

import { sendEmail } from "../src/services/emailService.js";
import { iterateUnnotified, markNotified } from "../src/services/waitlist/waitlistStore.service.js";
import { launchAnnouncementContent } from "../src/services/waitlist/waitlistEmails.js";

const APPLY = process.env.BROADCAST_APPLY === "true";
const LIMIT = Number(process.env.BROADCAST_LIMIT ?? 0);
const LOGIN_URL = process.env.BROADCAST_URL ?? "https://hobby-iq.com/register";

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — waitlist launch broadcast`);
  console.log(`  loginUrl: ${LOGIN_URL}`);
  let sent = 0, failed = 0, scanned = 0;

  for await (const entry of iterateUnnotified()) {
    scanned++;
    if (LIMIT > 0 && scanned > LIMIT) { console.log(`  reached LIMIT=${LIMIT}, stopping`); break; }
    console.log(`  → ${entry.email}${APPLY ? "" : " (dry-run)"}`);
    if (!APPLY) continue;
    const { subject, plainText, html } = launchAnnouncementContent({ loginUrl: LOGIN_URL });
    try {
      const result = await sendEmail({ to: entry.email, subject, plainText, html });
      if (result.delivered || result.devLogged) {
        await markNotified(entry.email);
        sent++;
      } else {
        failed++;
        console.error(`    ! send failed: ${result.error}`);
      }
    } catch (err) {
      failed++;
      console.error(`    ! send threw: ${(err as Error).message}`);
    }
  }

  console.log(`\n▸ Summary`);
  console.log(`  scanned: ${scanned}`);
  console.log(`  sent:    ${sent}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  failed:  ${failed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
