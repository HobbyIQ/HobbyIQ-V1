#!/usr/bin/env -S node --experimental-strip-types
/**
 * CF-EMAIL-VERIFICATION follow-on (Drew, 2026-07-27).
 *
 * One-off invite email for accounts Drew provisions on behalf of someone
 * else (owner-comped Pro Seller invites, in the current use case).
 *
 * What it does:
 *   1. Looks the user up by email (must exist — this script does NOT
 *      register anyone; use scripts/seedOwnerAccount.ts for that first).
 *   2. Issues a fresh email-verification token via the shared authService
 *      helper — same flow used by /api/auth/send-verification, so the
 *      landing page + expiry semantics all match.
 *   3. Sends a branded welcome/invite email via the shared emailService.
 *
 * What it does NOT do:
 *   - Never echoes the temporary password to stdout, chat, or the email
 *     body. The password ships out-of-band (Drew hands it over in DM /
 *     in person). The email tells the recipient "your login is <email>,
 *     ask Drew for your temporary password, then verify your email".
 *   - Never touches Cosmos entitlement flags. If you want the recipient
 *     to land on a paid tier, run scripts/seedOwnerAccount.ts FIRST so
 *     the override is in place before the invite email lands.
 *
 * Required env:
 *   COSMOS_CONNECTION_STRING (or endpoint+key)  — talks to hobbyiq/users
 *   AUTH_SESSION_SECRET                          — authService boots
 *   ACS_EMAIL_CONNECTION_STRING                  — email delivery
 *   EMAIL_FROM_ADDRESS                           — verified sender
 *   WEB_ORIGIN (optional)                        — for the verify link;
 *                                                  defaults to hobby-iq.com
 *
 * Usage:
 *   node --experimental-strip-types backend/scripts/sendUserInvite.ts <email>
 *   # or, to preview the email without sending (useful before ACS is live):
 *   DRY_RUN=1 node --experimental-strip-types backend/scripts/sendUserInvite.ts <email>
 */

import {
  findUserByEmail,
  issueEmailVerification,
} from "../src/services/authService.js";
import {
  sendEmail,
  verificationEmailContent,
} from "../src/services/emailService.js";

async function main(): Promise<void> {
  const email = (process.argv[2] ?? "").trim();
  if (!email) {
    console.error("Usage: sendUserInvite.ts <email>");
    process.exit(2);
  }

  const user = await findUserByEmail(email);
  if (!user) {
    console.error(
      `[invite] no user on file with email=${redactEmail(email)}. ` +
        `Register the account first via seedOwnerAccount.ts (or /api/auth/register).`,
    );
    process.exit(1);
  }

  const issued = await issueEmailVerification(user.userId);
  if (!issued) {
    console.error(`[invite] failed to issue verification token for userId=${user.userId}`);
    process.exit(1);
  }

  const webOrigin = (process.env.WEB_ORIGIN ?? "https://hobby-iq.com").replace(/\/+$/, "");
  const verifyUrl = `${webOrigin}/verify-email?token=${encodeURIComponent(issued.token)}`;

  const displayName = user.username ?? deriveNameFromEmail(email);
  const content = buildInviteContent({
    verifyUrl,
    toEmail: email,
    displayName,
    loginUrl: `${webOrigin}/login`,
  });

  if (process.env.DRY_RUN === "1") {
    // Dry-run: print recipient + subject + verifyUrl so Drew can eyeball
    // the copy before firing. Never prints the token itself in isolation
    // (the URL contains it, but only in the dry-run context by design).
    console.log(`[invite][dry-run] to: ${email}`);
    console.log(`[invite][dry-run] subject: ${content.subject}`);
    console.log(`[invite][dry-run] verify link: ${verifyUrl}`);
    console.log(`[invite][dry-run] link expires: ${issued.expiresAt}`);
    return;
  }

  const result = await sendEmail({
    to: email,
    subject: content.subject,
    plainText: content.plainText,
    html: content.html,
  });

  if (result.devLogged) {
    console.log(
      `[invite] ACS not configured; the send was logged instead. ` +
        `Provision ACS_EMAIL_CONNECTION_STRING + EMAIL_FROM_ADDRESS on HobbyIQ3 and rerun.`,
    );
  } else if (result.delivered) {
    console.log(`[invite] sent to ${redactEmail(email)}${result.messageId ? ` (id=${result.messageId})` : ""}`);
    console.log(`[invite] verification link expires ${issued.expiresAt}`);
  } else {
    console.error(`[invite] send failed: ${result.error ?? "unknown"}`);
    process.exit(1);
  }
}

function redactEmail(e: string): string {
  const [local, domain] = e.split("@");
  if (!local || !domain) return "<hidden>";
  const shown = local.length <= 2 ? local[0] : `${local[0]}…${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}

function deriveNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (!local) return "there";
  // Trim common separators, capitalize the first token.
  const first = local.split(/[._\-+0-9]/)[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * Extends the verification-email template with an "you've been invited"
 * intro so the recipient understands why they're getting the mail. Falls
 * back to the plain verification template's subject/link — same landing
 * page, same token behavior.
 */
function buildInviteContent(opts: {
  verifyUrl: string;
  toEmail: string;
  displayName: string;
  loginUrl: string;
}): { subject: string; plainText: string; html: string } {
  const base = verificationEmailContent({
    verifyUrl: opts.verifyUrl,
    toEmail: opts.toEmail,
    displayName: opts.displayName,
  });
  const subject = "You're invited to HobbyIQ";
  const plainText =
    `Hi ${opts.displayName},\n\n` +
    `Drew set up a HobbyIQ account for you.\n\n` +
    `Your login: ${opts.toEmail}\n` +
    `Password: reach out to Drew — he'll share it in DM.\n\n` +
    `Two quick steps once you sign in:\n` +
    `1) Verify your email so we can send you alerts and receipts:\n` +
    `   ${opts.verifyUrl}\n` +
    `2) Sign in at ${opts.loginUrl}\n\n` +
    `The verification link is good for 24 hours. If you didn't expect this,` +
    ` you can ignore this email.\n\n` +
    `— HobbyIQ`;
  const html =
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#111;line-height:1.5;padding:24px;max-width:560px;margin:auto">` +
    `<h2 style="margin:0 0 12px 0">You're invited to HobbyIQ</h2>` +
    `<p>Hi ${opts.displayName},</p>` +
    `<p>Drew set up a HobbyIQ account for you — welcome.</p>` +
    `<div style="background:#F5F7FA;border-radius:10px;padding:16px 18px;margin:20px 0">` +
    `<div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Your login</div>` +
    `<div style="font-weight:600">${opts.toEmail}</div>` +
    `<div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 4px">Password</div>` +
    `<div>Reach out to Drew — he'll share it in DM.</div>` +
    `</div>` +
    `<p>Once you have the password, verify your email so you get alerts, receipts, and password-reset links:</p>` +
    `<p style="margin:20px 0"><a href="${opts.verifyUrl}" style="background:#1EA75A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Verify email</a></p>` +
    `<p><a href="${opts.loginUrl}" style="color:#1EA75A">Sign in at hobby-iq.com</a></p>` +
    `<p style="color:#555;font-size:13px">Or paste this link into your browser:<br><span style="word-break:break-all">${opts.verifyUrl}</span></p>` +
    `<p style="color:#555;font-size:13px">The link is good for 24 hours. If you didn't expect this, you can ignore this email.</p>` +
    `<p style="color:#888;font-size:12px;margin-top:32px">— HobbyIQ</p>` +
    `</body></html>`;
  // base is unused here but kept as an import boundary — the fallback
  // template lives one file over so future edits stay in one place.
  void base;
  return { subject, plainText, html };
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[invite] fatal: ${msg}`);
  process.exit(1);
});
