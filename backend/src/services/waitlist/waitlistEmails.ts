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

// CF-WAITLIST-EMAIL-BRAND (Drew, 2026-08-08). Confirmation reskinned
// to the HobbyIQ web palette (dark #06101D bg, card #101B2D, electric-
// blue #1E90FF accents, hobby-green #7CFF72 signal, hero-stroke
// blue→green gradient in the header). Same email-client-safe
// constraints as the daily digest: table layout, inline styles,
// no external assets. Warmer than the daily digest — this is what
// a real person receives on signup, so it's founder-signed and
// invites a reply.
export function confirmationEmailContent(opts: { email: string }): {
  subject: string; plainText: string; html: string;
} {
  const subject = "You're on the HobbyIQ waitlist";
  const plainText =
    `You're on the list.\n\n` +
    `Drew here from HobbyIQ — thanks for signing up.\n\n` +
    `HobbyIQ is the pricing standard for sports cards: one number for every\n` +
    `card, every grade, every parallel. Grounded in our own comp pool of\n` +
    `real transactions — not vendor guesses or a median of eBay listings.\n` +
    `Every price ships with a confidence badge so you can tell how much to\n` +
    `trust it.\n\n` +
    `  • Empirical FMV — every rung is a real sale\n` +
    `  • Actionable intel — sell-now radar, grade-worthy alerts\n` +
    `  • Full grade ladder — PSA 1-10, BGS, SGC, CGC\n\n` +
    `When we open access we'll email you personally — no marketing blast,\n` +
    `no drip funnel.\n\n` +
    `If you want to be a design-partner-style early tester (feedback\n` +
    `shapes the roadmap, free access for the life of the beta), just hit\n` +
    `reply and I'll add you to that queue.\n\n` +
    `— Drew Vabulas\n` +
    `Founder, HobbyIQ\n`;
  const html = `<body style="margin:0;padding:0;background:#06101D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#C4CDD9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#06101D;padding:40px 20px">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#101B2D;border:1px solid #2A3344;border-radius:12px;overflow:hidden">
      <!-- Hero header: gradient + logo + tagline -->
      <tr>
        <td style="background:linear-gradient(135deg,#14345E,#0B1424);padding:40px 40px 36px 40px;text-align:center">
          <img src="https://hobby-iq.com/hobbyiq-logo.png" alt="HobbyIQ" width="200" style="display:block;margin:0 auto 16px auto;max-width:200px;height:auto;border:0;outline:none">
          <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#FFFFFF;opacity:0.85;font-weight:600;margin-top:8px">HobbyIQ Waitlist</div>
          <div style="font-size:36px;font-weight:700;margin-top:12px;letter-spacing:-1px;line-height:1.1;color:#FFFFFF">You're on the list</div>
        </td>
      </tr>
      <!-- Body copy -->
      <tr>
        <td style="padding:36px 40px 8px 40px">
          <p style="margin:0 0 20px 0;font-size:16px;line-height:1.6;color:#E8ECF3">Drew here from HobbyIQ &mdash; thanks for signing up.</p>
          <p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:#C4CDD9">
            HobbyIQ is the pricing standard for sports cards: one number for every card, every grade, every parallel. Grounded in our own comp pool of real transactions &mdash; not vendor guesses or a median of eBay listings. Every price ships with a confidence badge so you can tell how much to trust it.
          </p>
        </td>
      </tr>
      <!-- Website-style feature triptych: Empirical FMV / Actionable intel / Full grade ladder -->
      <tr>
        <td style="padding:16px 40px 20px 40px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:8px 0">
            <tr>
              <td width="33%" style="background:#0B1424;border:1px solid #2A3344;border-radius:10px;padding:18px 14px;text-align:center;vertical-align:top">
                <div style="font-size:14px;font-weight:700;color:#FFFFFF;letter-spacing:-0.2px;margin-bottom:6px">Empirical FMV</div>
                <div style="font-size:12px;line-height:1.5;color:#C4CDD9">Every rung is a real sale. Observed medians when we have them.</div>
              </td>
              <td width="33%" style="background:#0B1424;border:1px solid #2A3344;border-radius:10px;padding:18px 14px;text-align:center;vertical-align:top">
                <div style="font-size:14px;font-weight:700;color:#FFFFFF;letter-spacing:-0.2px;margin-bottom:6px">Actionable intel</div>
                <div style="font-size:12px;line-height:1.5;color:#C4CDD9">Sell-now radar. Grade-worthy alerts. Timed windows, not vibes.</div>
              </td>
              <td width="33%" style="background:#0B1424;border:1px solid #2A3344;border-radius:10px;padding:18px 14px;text-align:center;vertical-align:top">
                <div style="font-size:14px;font-weight:700;color:#FFFFFF;letter-spacing:-0.2px;margin-bottom:6px">Full grade ladder</div>
                <div style="font-size:12px;line-height:1.5;color:#C4CDD9">PSA 1-10, BGS, SGC, CGC. Vintage low-grade included.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <!-- No-drip-funnel promise -->
      <tr>
        <td style="padding:12px 40px 20px 40px">
          <p style="margin:0;font-size:15px;line-height:1.7;color:#C4CDD9">
            When we open access we'll email you personally &mdash; no marketing blast, no drip funnel.
          </p>
        </td>
      </tr>
      <!-- Design partner CTA card -->
      <tr>
        <td style="padding:8px 40px 32px 40px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0B1424;border:1px solid #2A3344;border-radius:10px">
            <tr>
              <td style="padding:22px 24px">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#3DA9FF;font-weight:600;margin-bottom:8px">Want in earlier?</div>
                <div style="font-size:14px;line-height:1.6;color:#C4CDD9">
                  Reply to this email to become a <strong style="color:#FFFFFF">design-partner early tester</strong> &mdash; your feedback shapes the roadmap, and you get free access for the life of the beta.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <!-- Footer / signature (text only, no LLC) -->
      <tr>
        <td style="padding:22px 40px 26px 40px;border-top:1px solid #2A3344;background:#0B1424">
          <div style="font-size:15px;color:#E8ECF3;line-height:1.5;font-weight:600">Drew Vabulas</div>
          <div style="color:#C4CDD9;font-size:13px;line-height:1.5">Founder, HobbyIQ</div>
        </td>
      </tr>
    </table>
    <div style="max-width:600px;margin:16px auto 0 auto;text-align:center;font-size:11px;color:#5A6577;line-height:1.5">
      You're receiving this because you signed up at <a href="https://hobby-iq.com" style="color:#3DA9FF;text-decoration:none">hobby-iq.com</a>.
    </div>
  </td></tr>
</table>
</body>`;
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
    `<p style="color:#888;font-size:12px;margin-top:32px">— Drew · HobbyIQ, LLC</p>` +
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
