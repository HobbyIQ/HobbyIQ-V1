// CF-WAITLIST-DAILY-DIGEST (Drew, 2026-08-08). Emails a summary of
// waitlist signups from the last N hours (default 24). Runs nightly
// via .github/workflows/waitlist-daily-digest.yml. Uses ACS Email
// (same provider that sends confirmations + owner notifications).
//
// Env:
//   COSMOS_CONNECTION_STRING       required
//   ACS_EMAIL_CONNECTION_STRING    required (or falls back to devLogged)
//   EMAIL_FROM_ADDRESS             required
//   WAITLIST_DIGEST_TO             recipient (default dvabulas@outlook.com)
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
  const to = process.env.WAITLIST_DIGEST_TO || "dvabulas@outlook.com";
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

  const rowsHtml = rows.map(r => `
    <tr>
      <td>${escHtml((r.createdAt || "").slice(0, 19).replace("T", " "))}</td>
      <td><a href="mailto:${escHtml(r.email)}">${escHtml(r.email)}</a></td>
      <td>${escHtml(r.source || "")}</td>
      <td>${escHtml((r.referer || "").slice(0, 60))}</td>
    </tr>
  `).join("");

  const html = `
    <p>Daily HobbyIQ waitlist digest — ${dateStr}</p>
    <p><strong>${rows.length}</strong> new signup${rows.length === 1 ? "" : "s"} in the ${windowStr}. Total waitlist: <strong>${total}</strong>.</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:12px">
      <thead>
        <tr><th>createdAt (UTC)</th><th>email</th><th>source</th><th>referer</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p style="color:#888;font-size:11px">Sent by waitlist-daily-digest workflow. Recipient controllable via WAITLIST_DIGEST_TO env var on HobbyIQ3.</p>
  `;
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
