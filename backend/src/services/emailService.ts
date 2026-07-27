// CF-EMAIL-VERIFICATION (Drew, 2026-07-27).
//
// Thin abstraction over Azure Communication Services Email. The auth
// verification flow is the only caller today; future PRs (welcome mail,
// alert digests, subscription receipts) plug into the same sendEmail()
// contract.
//
// Configuration: three env vars on HobbyIQ3.
//   ACS_EMAIL_CONNECTION_STRING  — Azure Communication Services connection
//                                  string (from an ACS resource in the
//                                  same sub). Copy from the ACS blade →
//                                  Keys → Primary connection string.
//   EMAIL_FROM_ADDRESS           — Sender address, must be a verified
//                                  domain on that ACS resource. E.g.
//                                  DoNotReply@notifications.hobby-iq.com
//                                  (or DoNotReply@<acs-managed-domain>
//                                  during setup before the custom
//                                  domain is verified).
//   EMAIL_FROM_NAME              — Display name shown before the address.
//                                  Defaults to "HobbyIQ".
//
// Fail-open behavior in local dev: if the connection string is unset,
// we log the message body to stdout instead of throwing so the auth
// flow works end-to-end without provisioning ACS just to test locally.
// Production sets the env var, so a real deploy that CAN'T reach ACS
// still throws (correctly — it's a config bug).

import { EmailClient, type EmailMessage } from "@azure/communication-email";

let _client: EmailClient | null = null;
function getClient(): EmailClient | null {
  if (_client) return _client;
  const connStr = process.env.ACS_EMAIL_CONNECTION_STRING;
  if (!connStr) return null;
  _client = new EmailClient(connStr);
  return _client;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  plainText: string;
  html: string;
}

export interface SendEmailResult {
  delivered: boolean;
  messageId?: string;
  // When ACS isn't configured (local dev), we return delivered=false and
  // devLogged=true so the route handler can surface a friendly "email
  // service not configured" message rather than a 500.
  devLogged?: boolean;
  error?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const client = getClient();
  const fromAddress = process.env.EMAIL_FROM_ADDRESS ?? "";
  const fromName = process.env.EMAIL_FROM_NAME ?? "HobbyIQ";

  if (!client || !fromAddress) {
    // Local dev fallback. Never echo secrets — only the message subject +
    // recipient, both of which the caller passed in.
    console.log(
      `[email][dev-fallback] would send to=${input.to} subject=${JSON.stringify(input.subject)} (ACS unconfigured)`,
    );
    return { delivered: false, devLogged: true };
  }

  const message: EmailMessage = {
    senderAddress: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
    content: {
      subject: input.subject,
      plainText: input.plainText,
      html: input.html,
    },
    recipients: {
      to: [{ address: input.to }],
    },
  };

  try {
    const poller = await client.beginSend(message);
    const result = await poller.pollUntilDone();
    return {
      delivered: result.status === "Succeeded",
      messageId: result.id,
      error: result.status !== "Succeeded" ? result.status : undefined,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Never surface the raw ACS error verbatim to the client — it can
    // leak connection-string fragments in edge cases. Log full detail
    // server-side and return a compact message.
    console.error("[email] ACS send failed:", msg);
    return { delivered: false, error: "email-provider-failed" };
  }
}

// ─── Verification-email templates ────────────────────────────────────────────

export function verificationEmailContent(opts: {
  verifyUrl: string;
  toEmail: string;
  displayName?: string | null;
}): { subject: string; plainText: string; html: string } {
  const who = opts.displayName?.trim() || opts.toEmail;
  const subject = "Verify your HobbyIQ email";
  const plainText =
    `Hi ${who},\n\n` +
    `Confirm your email address for HobbyIQ by opening this link:\n` +
    `${opts.verifyUrl}\n\n` +
    `The link is good for 24 hours. If you didn't request this, you can ignore this email.\n\n` +
    `— HobbyIQ`;
  const html =
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#111;line-height:1.5;padding:24px;max-width:520px;margin:auto">` +
    `<h2 style="margin:0 0 12px 0">Verify your email</h2>` +
    `<p>Hi ${who},</p>` +
    `<p>Confirm your email address for HobbyIQ so we can send you alerts and subscription receipts.</p>` +
    `<p style="margin:24px 0"><a href="${opts.verifyUrl}" style="background:#1EA75A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Verify email</a></p>` +
    `<p style="color:#555;font-size:13px">Or paste this link into your browser:<br><span style="word-break:break-all">${opts.verifyUrl}</span></p>` +
    `<p style="color:#555;font-size:13px">The link is good for 24 hours. If you didn't request this, you can ignore this email.</p>` +
    `<p style="color:#888;font-size:12px;margin-top:32px">— HobbyIQ</p>` +
    `</body></html>`;
  return { subject, plainText, html };
}
