// CF-CATALOG-GAP-DIGEST (Drew, 2026-08-08). Emails Drew a daily
// ranked list of the top-N catalog gap buckets — sets that appear
// most frequently in the sold_comps unmatched pool but have no
// card_catalog coverage. Each morning's report = the day's
// batch-fill hit-list.
//
// Runs nightly via .github/workflows/catalog-gap-digest.yml.
// Sends via ACS (same provider as waitlist digest + confirmations).
// Skips silently on empty pool (never spam an "all clean" email).
//
// Env:
//   COSMOS_CONNECTION_STRING       required
//   ACS_EMAIL_CONNECTION_STRING    required
//   EMAIL_FROM_ADDRESS             required
//   GAP_DIGEST_TO                  recipient (default drew@hobby-iq.com)
//   GAP_DIGEST_TOP_N               top-N buckets (default 20)
//   GAP_DIGEST_SAMPLE_LIMIT        pool scan cap (default 15000)
//   GAP_DIGEST_MIN_ROWS            bucket min-observation gate (default 3)

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

async function fetchGapBuckets(conn) {
  const TOP_N = Number(process.env.GAP_DIGEST_TOP_N || 20);
  const MIN_ROWS = Number(process.env.GAP_DIGEST_MIN_ROWS || 3);
  const LIMIT = Number(process.env.GAP_DIGEST_SAMPLE_LIMIT || 15000);
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");
  // Same query shape as analyzeCatalogGaps.cjs, kept inline here so the
  // digest ships without a shared-lib refactor.
  const { resources: rows } = await sc.items.query({
    query: `SELECT TOP ${LIMIT} c.cardYear, c.setName, c.sport, c.playerName, c.title
            FROM c
            WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = "")
            ORDER BY c._ts DESC`,
  }, { maxItemCount: LIMIT }).fetchNext();
  const buckets = new Map();
  let noKey = 0;
  for (const r of rows) {
    const year = r.cardYear ?? null;
    const set = (r.setName ?? "").trim() || null;
    const sport = (r.sport ?? "").trim().toLowerCase() || null;
    if (!year && !set) { noKey++; continue; }
    const key = `${year ?? "?"}\t${set ?? "?"}\t${sport ?? "?"}`;
    if (!buckets.has(key)) buckets.set(key, { year, set, sport, count: 0, samples: [] });
    const b = buckets.get(key);
    b.count++;
    if (b.samples.length < 2 && r.title) b.samples.push(String(r.title).slice(0, 90));
  }
  const ranked = [...buckets.values()]
    .filter(b => b.count >= MIN_ROWS)
    .sort((a, b) => b.count - a.count);
  // CF-HOBBYIQ-CATALOG-GAP (Drew, 2026-08-10). Roll gaps up by sport and
  // by year so the report shows structural coverage at a glance, not
  // just the top-N leaf buckets.
  const bySport = new Map();
  const byYear = new Map();
  for (const b of ranked) {
    const s = b.sport ?? "?";
    const y = b.year ?? "?";
    const sportAgg = bySport.get(s) ?? { sport: s, count: 0, buckets: 0 };
    sportAgg.count += b.count;
    sportAgg.buckets++;
    bySport.set(s, sportAgg);
    const yearAgg = byYear.get(y) ?? { year: y, count: 0, buckets: 0 };
    yearAgg.count += b.count;
    yearAgg.buckets++;
    byYear.set(y, yearAgg);
  }
  return {
    totalScanned: rows.length,
    totalUnmatched: rows.length,
    distinctBuckets: buckets.size,
    noKeyRows: noKey,
    top: ranked.slice(0, TOP_N),
    topNUnlock: ranked.slice(0, TOP_N).reduce((s, b) => s + b.count, 0),
    sumMatchable: ranked.reduce((s, b) => s + b.count, 0),
    sportRollup: [...bySport.values()].sort((a, b) => b.count - a.count),
    yearRollup: [...byYear.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  };
}

// CF-HOBBYIQ-CATALOG-SOURCE-HINT (Drew, 2026-08-10). Suggest the
// canonical ingest source for a gap bucket based on sport + year so
// Drew can click straight to where the checklist lives. Baseball →
// baseballcardpedia (BCP has the most comprehensive coverage);
// football/basketball → checklistcenter; other sports → beckett.
function suggestedSourceFor(bucket) {
  const sport = String(bucket.sport ?? "").toLowerCase();
  const year = bucket.year;
  const setSlug = String(bucket.set ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (sport === "baseball" && year) {
    return { label: "BCP", url: `https://baseballcardpedia.com/index.php/${year}_${encodeURIComponent(setSlug)}` };
  }
  if (sport === "football" || sport === "basketball" || sport === "hockey") {
    return { label: "ChecklistCenter", url: `https://www.checklistcenter.com/search?q=${encodeURIComponent(String(year ?? "") + " " + (bucket.set ?? ""))}` };
  }
  return { label: "Beckett", url: `https://www.beckett.com/search/?term=${encodeURIComponent(String(year ?? "") + " " + (bucket.set ?? ""))}` };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const to = process.env.GAP_DIGEST_TO || "drew@hobby-iq.com";

  console.log(`[gap-digest] scanning unmatched pool...`);
  const g = await fetchGapBuckets(conn);
  console.log(`[gap-digest] scanned=${g.totalScanned}  buckets=${g.distinctBuckets}  top=${g.top.length}  unlock=${g.topNUnlock}`);
  if (g.top.length === 0) {
    console.log(`[gap-digest] no meaningful gaps — skipping email per skip-on-empty rule`);
    return;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const N = g.top.length;

  const rowsHtml = g.top.map((b, i) => {
    const src = suggestedSourceFor(b);
    return `
    <tr>
      <td style="padding:12px 12px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:13px;font-family:'SF Mono',Monaco,Consolas,monospace;text-align:right">
        ${i + 1}
      </td>
      <td style="padding:12px 12px;border-bottom:1px solid #2A3344;color:#7CFF72;font-size:14px;font-weight:700;text-align:right">
        ${b.count}
      </td>
      <td style="padding:12px 12px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:13px;font-family:'SF Mono',Monaco,Consolas,monospace">
        ${escHtml(b.year ?? "?")}
      </td>
      <td style="padding:12px 12px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:13px">
        ${escHtml(b.sport ?? "?")}
      </td>
      <td style="padding:12px 12px;border-bottom:1px solid #2A3344;color:#FFFFFF;font-size:14px;font-weight:500">
        ${escHtml(b.set ?? "?")}
      </td>
      <td style="padding:12px 12px;border-bottom:1px solid #2A3344;font-size:12px">
        <a href="${escHtml(src.url)}" style="color:#3DA9FF;text-decoration:none;font-weight:600">${escHtml(src.label)} ↗</a>
      </td>
      <td style="padding:12px 12px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:11px;font-family:'SF Mono',Monaco,Consolas,monospace;opacity:0.75">
        ${escHtml((b.samples[0] || "").slice(0, 60))}
      </td>
    </tr>
  `;
  }).join("");

  // Rollup HTML: sport + year summary rows before the top-N table.
  const sportRollupHtml = (g.sportRollup ?? []).map(s => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1A2332;color:#FFFFFF;font-size:13px;text-transform:capitalize">${escHtml(s.sport)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1A2332;color:#7CFF72;font-size:13px;font-weight:600;text-align:right;font-family:'SF Mono',Monaco,Consolas,monospace">${s.count.toLocaleString("en-US")}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1A2332;color:#C4CDD9;font-size:12px;text-align:right;font-family:'SF Mono',Monaco,Consolas,monospace">${s.buckets.toLocaleString("en-US")}</td>
    </tr>
  `).join("");
  const yearRollupHtml = (g.yearRollup ?? []).map(y => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1A2332;color:#FFFFFF;font-size:13px;font-family:'SF Mono',Monaco,Consolas,monospace">${escHtml(y.year)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1A2332;color:#7CFF72;font-size:13px;font-weight:600;text-align:right;font-family:'SF Mono',Monaco,Consolas,monospace">${y.count.toLocaleString("en-US")}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1A2332;color:#C4CDD9;font-size:12px;text-align:right;font-family:'SF Mono',Monaco,Consolas,monospace">${y.buckets.toLocaleString("en-US")}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HobbyIQ catalog gap digest — ${dateStr}</title>
</head>
<body style="margin:0;padding:0;background:#06101D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#C4CDD9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#06101D;padding:40px 20px">
  <tr><td align="center">
    <table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="max-width:720px;background:#101B2D;border:1px solid #2A3344;border-radius:12px;overflow:hidden">
      <tr>
        <td style="background:linear-gradient(135deg,#2A6A9E,#2C8F66);padding:28px 32px;color:#FFFFFF">
          <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;font-weight:600">Catalog Gap Report</div>
          <div style="font-size:28px;font-weight:700;margin-top:6px;letter-spacing:-0.5px">The HobbyIQ Catalog</div>
          <div style="font-size:13px;opacity:0.85;margin-top:4px">${dateStr} · what to ingest next, ranked by unlock volume</div>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 32px 0 32px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right:16px;vertical-align:top;width:33%">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600">Unmatched pool</div>
                <div style="font-size:36px;font-weight:700;color:#FFFFFF;margin-top:6px;letter-spacing:-1px;line-height:1">${g.totalUnmatched.toLocaleString("en-US")}</div>
                <div style="font-size:11px;color:#C4CDD9;opacity:0.6;margin-top:6px">rows without hobbyiqCardId</div>
              </td>
              <td style="padding:0 16px;border-left:1px solid #2A3344;vertical-align:top;width:34%">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600">Top-${N} unlock</div>
                <div style="font-size:36px;font-weight:700;color:#7CFF72;margin-top:6px;letter-spacing:-1px;line-height:1">${g.topNUnlock.toLocaleString("en-US")}</div>
                <div style="font-size:11px;color:#C4CDD9;opacity:0.6;margin-top:6px">rows unlocked if all seeded</div>
              </td>
              <td style="padding-left:16px;border-left:1px solid #2A3344;vertical-align:top;width:33%">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600">Distinct buckets</div>
                <div style="font-size:36px;font-weight:700;color:#3DA9FF;margin-top:6px;letter-spacing:-1px;line-height:1">${g.distinctBuckets.toLocaleString("en-US")}</div>
                <div style="font-size:11px;color:#C4CDD9;opacity:0.6;margin-top:6px">unique (year, set, sport) combos</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:28px 32px 12px 32px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right:12px;vertical-align:top;width:50%">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600;margin-bottom:10px">Gap by sport</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#0B1424;border:1px solid #2A3344;border-radius:8px;overflow:hidden">
                  <thead>
                    <tr>
                      <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Sport</th>
                      <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Rows</th>
                      <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Sets</th>
                    </tr>
                  </thead>
                  <tbody>${sportRollupHtml}</tbody>
                </table>
              </td>
              <td style="padding-left:12px;vertical-align:top;width:50%">
                <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600;margin-bottom:10px">Top years to attack</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#0B1424;border:1px solid #2A3344;border-radius:8px;overflow:hidden">
                  <thead>
                    <tr>
                      <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Year</th>
                      <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Rows</th>
                      <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Sets</th>
                    </tr>
                  </thead>
                  <tbody>${yearRollupHtml}</tbody>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px 32px 32px">
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600;margin-bottom:14px">Top ${N} sets to add — click Source to jump to the checklist</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#0B1424;border:1px solid #2A3344;border-radius:8px;overflow:hidden">
            <thead>
              <tr>
                <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">#</th>
                <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Rows</th>
                <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Year</th>
                <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Sport</th>
                <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Set</th>
                <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Source</th>
                <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6;font-weight:600">Sample</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 32px 24px 32px;border-top:1px solid #2A3344;background:#0B1424">
          <div style="font-size:11px;color:#C4CDD9;opacity:0.55;line-height:1.5">
            The HobbyIQ Catalog is <code style="color:#3DA9FF">card_catalog</code> in Cosmos — see <code style="color:#3DA9FF">docs/HOBBYIQ-CATALOG.md</code> for the doctrine.<br>
            Sent by <span style="color:#3DA9FF">catalog-gap-digest</span> · fires 6 AM EDT daily · skips silently when the pool is clean.
          </div>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const plainText = [
    `The HobbyIQ Catalog · Gap Report ${dateStr}`,
    ``,
    `Unmatched pool: ${g.totalUnmatched.toLocaleString()} rows · ${g.distinctBuckets.toLocaleString()} distinct buckets · top-${N} would unlock ${g.topNUnlock.toLocaleString()} rows`,
    ``,
    `Gap by sport:`,
    ...((g.sportRollup ?? []).map(s => `  ${String(s.sport).padEnd(12)} ${String(s.count).padStart(8)} rows across ${s.buckets} sets`)),
    ``,
    `Top years to attack:`,
    ...((g.yearRollup ?? []).map(y => `  ${String(y.year).padEnd(6)} ${String(y.count).padStart(8)} rows across ${y.buckets} sets`)),
    ``,
    `Top ${N} sets to add today (year · sport · set → source):`,
    ...g.top.map((b, i) => {
      const src = suggestedSourceFor(b);
      return `  ${String(i + 1).padStart(2)}. ${String(b.count).padStart(4)} rows  ${b.year ?? "?"}  ${b.sport ?? "?"}  ${b.set ?? "?"}  → ${src.label}: ${src.url}`;
    }),
    ``,
    `Doctrine: docs/HOBBYIQ-CATALOG.md`,
  ].join("\n");

  const sendEmail = await loadSendEmail();
  const result = await sendEmail({
    to,
    subject: `The HobbyIQ Catalog · Gap Report ${dateStr} — top-${N} would unlock ${g.topNUnlock.toLocaleString("en-US")} rows`,
    plainText,
    html,
  });
  console.log(`[gap-digest] send result: delivered=${result.delivered} devLogged=${result.devLogged ?? false} error=${result.error ?? ""}`);
  if (!result.delivered) process.exit(1);
}

main().catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
