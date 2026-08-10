// CF-WAITLIST-DAILY-DIGEST (Drew, 2026-08-08). Emails a summary of
// waitlist signups from the last N hours (default 24). Runs nightly
// via .github/workflows/waitlist-daily-digest.yml. Uses ACS Email
// (same provider that sends confirmations + owner notifications).
//
// Env:
//   COSMOS_CONNECTION_STRING       required
//   ACS_EMAIL_CONNECTION_STRING    required (or falls back to devLogged)
//   EMAIL_FROM_ADDRESS             required
//   WAITLIST_DIGEST_TO             recipient (default drew@hobby-iq.com)
//   WAITLIST_DIGEST_HOURS          window (default 24)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

async function loadSendEmail() {
  const p = path.resolve(__dirname, "..", "dist", "services", "emailService.js");
  if (!fs.existsSync(p)) throw new Error(`emailService not built at ${p} — run npm run build first`);
  return require(p).sendEmail;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const hours = Math.max(1, Number(process.env.WAITLIST_DIGEST_HOURS || 24));
  const to = process.env.WAITLIST_DIGEST_TO || "drew@hobby-iq.com";
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();

  const c = new CosmosClient(conn);
  const wl = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("waitlist");

  const q = await wl.items.query({
    query: "SELECT c.email, c.source, c.referer, c.createdAt FROM c WHERE c.createdAt >= @cutoff ORDER BY c.createdAt DESC",
    parameters: [{ name: "@cutoff", value: cutoff }],
  }, { maxItemCount: 500 }).fetchAll();

  const rows = q.resources ?? [];
  const totalQ = await wl.items.query({
    query: "SELECT VALUE COUNT(1) FROM c",
  }, { maxItemCount: 1 }).fetchAll();
  const total = Number(totalQ.resources[0] ?? 0);

  const dateStr = new Date().toISOString().slice(0, 10);
  const windowStr = `last ${hours}h`;

  console.log(`[waitlist-digest] ${rows.length} new signups in ${windowStr}, ${total} total`);
  if (rows.length === 0) {
    console.log(`[waitlist-digest] no new signups — skipping email per skip-on-empty rule`);
    return;
  }

  // CF-WAITLIST-DIGEST-TEMPLATE (Drew, 2026-08-08). Match HobbyIQ web
  // palette from reference_hobbyiq_design_system.md: dark app bg
  // #06101D, card surface #101B2D, electric blue accent #1E90FF,
  // hero-stroke blue→green gradient. Email-client-safe: table layout,
  // inline styles, no external assets, no @media queries (Outlook
  // strips them silently).
  const rowsHtml = rows.map(r => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:13px;font-family:'SF Mono',Monaco,Consolas,monospace">
        ${escHtml((r.createdAt || "").slice(0, 19).replace("T", " "))}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #2A3344;font-size:14px">
        <a href="mailto:${escHtml(r.email)}" style="color:#3DA9FF;text-decoration:none;font-weight:500">${escHtml(r.email)}</a>
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:13px">
        ${escHtml(r.source || "—")}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:12px;font-family:'SF Mono',Monaco,Consolas,monospace">
        ${escHtml((r.referer || "—").slice(0, 55))}
      </td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HobbyIQ waitlist digest — ${dateStr}</title>
</head>
<body style="margin:0;padding:0;background:#06101D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#C4CDD9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#06101D;padding:40px 20px">
  <tr><td align="center">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#101B2D;border:1px solid #2A3344;border-radius:12px;overflow:hidden">
      <!-- Hero header with signature blue→green gradient -->
      <tr>
        <td style="background:linear-gradient(135deg,#2A6A9E,#2C8F66);padding:28px 32px;color:#FFFFFF">
          <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;font-weight:600">Waitlist Digest</div>
          <div style="font-size:28px;font-weight:700;margin-top:6px;letter-spacing:-0.5px">HobbyIQ</div>
          <div style="font-size:13px;opacity:0.85;margin-top:4px">${dateStr} · ${windowStr}</div>
        </td>
      </tr>
      <!-- Stats row -->
      <tr>
        <td style="padding:32px 32px 0 32px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right:16px;vertical-align:top">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600">New signups</div>
                <div style="font-size:44px;font-weight:700;color:#7CFF72;margin-top:6px;letter-spacing:-1px;line-height:1">${rows.length}</div>
              </td>
              <td style="padding-left:16px;border-left:1px solid #2A3344;vertical-align:top">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600">Total waitlist</div>
                <div style="font-size:44px;font-weight:700;color:#FFFFFF;margin-top:6px;letter-spacing:-1px;line-height:1">${total.toLocaleString("en-US")}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <!-- Signups table -->
      <tr>
        <td style="padding:28px 32px 32px 32px">
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600;margin-bottom:14px">Signups in ${windowStr}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#0B1424;border:1px solid #2A3344;border-radius:8px;overflow:hidden">
            <thead>
              <tr>
                <th style="padding:12px 16px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Time (UTC)</th>
                <th style="padding:12px 16px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Email</th>
                <th style="padding:12px 16px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Source</th>
                <th style="padding:12px 16px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Referer</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </td>
      </tr>
      <!-- Footer -->
      <tr>
        <td style="padding:20px 32px 24px 32px;border-top:1px solid #2A3344;background:#0B1424">
          <div style="font-size:11px;color:#C4CDD9;opacity:0.55;line-height:1.5">
            Sent by <span style="color:#3DA9FF">waitlist-daily-digest</span> · fires 6 AM EDT daily · skips silently on 0 signups<br>
            Recipient controllable via <code style="color:#3DA9FF">WAITLIST_DIGEST_TO</code> on HobbyIQ3
          </div>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
  const plainText = [
    `Daily HobbyIQ waitlist digest — ${dateStr}`,
    ``,
    `${rows.length} new signups in the ${windowStr}. Total waitlist: ${total}.`,
    ``,
    ...rows.map(r => `  ${(r.createdAt || "").slice(0, 19).replace("T", " ")}  ${r.email}  (${r.source || ""})`),
  ].join("\n");

  const sendEmail = await loadSendEmail();
  const result = await sendEmail({
    to,
    subject: `HobbyIQ waitlist — ${rows.length} new signup${rows.length === 1 ? "" : "s"} today (${dateStr})`,
    plainText,
    html,
  });
  console.log(`[waitlist-digest] send result: delivered=${result.delivered} devLogged=${result.devLogged ?? false} error=${result.error ?? ""}`);
  if (!result.delivered) process.exit(1);
}

main().catch((e) => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
