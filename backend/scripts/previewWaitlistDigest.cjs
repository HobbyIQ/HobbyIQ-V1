// CF-DIGEST-PREVIEW (Drew, 2026-08-08). Renders the digest HTML for
// review by extracting the same template logic. Outputs the HTML to
// stdout so we can pipe it to send-via-Outlook without needing ACS.

const { CosmosClient } = require("@azure/cosmos");

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const hours = Number(process.env.HOURS || 48);
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  const c = new CosmosClient(conn);
  const wl = c.database("hobbyiq").container("waitlist");
  const q = await wl.items.query({
    query: "SELECT c.email, c.source, c.referer, c.createdAt FROM c WHERE c.createdAt >= @cutoff ORDER BY c.createdAt DESC",
    parameters: [{ name: "@cutoff", value: cutoff }],
  }, { maxItemCount: 500 }).fetchAll();
  const rows = q.resources ?? [];
  const totalQ = await wl.items.query({ query: "SELECT VALUE COUNT(1) FROM c" }, { maxItemCount: 1 }).fetchAll();
  const total = Number(totalQ.resources[0] ?? 0);

  const dateStr = new Date().toISOString().slice(0, 10);
  const windowStr = `last ${hours}h`;

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

  const html = `<body style="margin:0;padding:0;background:#06101D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#C4CDD9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#06101D;padding:40px 20px">
  <tr><td align="center">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#101B2D;border:1px solid #2A3344;border-radius:12px;overflow:hidden">
      <tr>
        <td style="background:linear-gradient(135deg,#2A6A9E,#2C8F66);padding:28px 32px;color:#FFFFFF">
          <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;font-weight:600">Waitlist Digest</div>
          <div style="font-size:28px;font-weight:700;margin-top:6px;letter-spacing:-0.5px">HobbyIQ</div>
          <div style="font-size:13px;opacity:0.85;margin-top:4px">${dateStr} · ${windowStr}</div>
        </td>
      </tr>
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
</body>`;

  // Write to a temp file for the send step
  const fs = require("fs");
  const path = require("path");
  const outPath = path.resolve(process.env.TEMP || "/tmp", "digest-preview.html");
  fs.writeFileSync(outPath, html);
  console.log(`Preview HTML written to: ${outPath}`);
  console.log(`Signups: ${rows.length}, Total: ${total}`);
  // Print sample rows so we know what's in the preview
  rows.slice(0, 5).forEach(r => console.log(`  · ${r.email} (${r.source})`));
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
