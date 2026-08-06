/**
 * CF-WAITLIST (Drew, 2026-08-06). Email templates for the waitlist flow.
 *
 * Two mails per signup:
 *   - Confirmation to the signup email (from drew@hobby-iq.com)
 *   - Notification to drew@hobby-iq.com so we see signups in real time.
 *
 * A third template (launchAnnouncementContent) fires from a manual
 * broadcast script when launch happens.
 */

export function confirmationEmailContent(opts: { email: string }): {
  subject: string; plainText: string; html: string;
} {
  const subject = "You're on the HobbyIQ waitlist";
  const plainText =
    `Thanks for signing up.\n\n` +
    `You're on the list — we'll email you the moment HobbyIQ opens for\n` +
    `general access. No spam, just the launch notice.\n\n` +
    `HobbyIQ is a card-portfolio and pricing platform: real transactions\n` +
    `power every FMV rung, and every price ships with a confidence badge\n` +
    `so you can tell how much to trust it.\n\n` +
    `— Drew\n` +
    `Just The Boys and Cards, LLC\n`;
  const html =
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#111;line-height:1.55;padding:24px;max-width:520px;margin:auto">` +
    `<h2 style="margin:0 0 12px 0">You're on the HobbyIQ waitlist</h2>` +
    `<p>Thanks for signing up.</p>` +
    `<p>You're on the list — we'll email you the moment HobbyIQ opens for general access. No spam, just the launch notice.</p>` +
    `<p style="color:#444">HobbyIQ is a card-portfolio and pricing platform: real transactions power every FMV rung, and every price ships with a confidence badge so you can tell how much to trust it.</p>` +
    `<p style="color:#888;font-size:12px;margin-top:32px">— Drew · Just The Boys and Cards, LLC</p>` +
    `</body></html>`;
  return { subject, plainText, html };
}

export function ownerNotificationContent(opts: {
  email: string; source: string; referer: string | null; total: number;
}): { subject: string; plainText: string; html: string } {
  const subject = `Waitlist signup: ${opts.email} (#${opts.total})`;
  const plainText =
    `New waitlist signup.\n\n` +
    `Email:    ${opts.email}\n` +
    `Source:   ${opts.source}\n` +
    `Referer:  ${opts.referer ?? "—"}\n` +
    `Total:    ${opts.total}\n`;
  const html =
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#111;line-height:1.55;padding:24px;max-width:520px;margin:auto">` +
    `<h2 style="margin:0 0 12px 0">New waitlist signup</h2>` +
    `<table style="border-collapse:collapse;font-size:14px"><tbody>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#666">Email</td><td style="padding:4px 0"><strong>${escapeHtml(opts.email)}</strong></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#666">Source</td><td style="padding:4px 0">${escapeHtml(opts.source)}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#666">Referer</td><td style="padding:4px 0">${escapeHtml(opts.referer ?? "—")}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#666">Total</td><td style="padding:4px 0"><strong>${opts.total}</strong></td></tr>` +
    `</tbody></table>` +
    `</body></html>`;
  return { subject, plainText, html };
}

export function launchAnnouncementContent(opts: {
  loginUrl: string;
}): { subject: string; plainText: string; html: string } {
  const subject = "HobbyIQ is live — your account is ready";
  const plainText =
    `HobbyIQ is officially live.\n\n` +
    `Everything we promised on the waitlist is in production:\n` +
    `  - Real-transaction FMV across every card, grade, and parallel\n` +
    `  - Portfolio tracking with sell/hold/list signals\n` +
    `  - Grade ladder + confidence badges on every price\n\n` +
    `Get started:\n${opts.loginUrl}\n\n` +
    `— Drew\n`;
  const html =
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,sans-serif;color:#111;line-height:1.55;padding:24px;max-width:520px;margin:auto">` +
    `<h2 style="margin:0 0 12px 0">HobbyIQ is live</h2>` +
    `<p>Everything we promised on the waitlist is in production:</p>` +
    `<ul style="padding-left:20px;color:#333">` +
    `<li>Real-transaction FMV across every card, grade, and parallel</li>` +
    `<li>Portfolio tracking with sell/hold/list signals</li>` +
    `<li>Grade ladder + confidence badges on every price</li>` +
    `</ul>` +
    `<p style="margin:24px 0"><a href="${opts.loginUrl}" style="background:#1EA75A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Get started</a></p>` +
    `<p style="color:#888;font-size:12px;margin-top:32px">— Drew · Just The Boys and Cards, LLC</p>` +
    `</body></html>`;
  return { subject, plainText, html };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
