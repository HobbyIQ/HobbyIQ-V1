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

// CF-GAP-DIGEST-TRIAGE (Drew, 2026-08-31). The digest now renders the
// TRIAGED checklist-gap report alongside the original unmatched-pool ranking:
// every gap is classified before the mail is built, the night-over-night diff
// says what closed, and the headline is honest that the dispatchable list may
// be EMPTY. Env additions:
//   GAP_TRIAGE_HISTORY_DIR   where checklist-gap-report.cjs persisted (default backend/data/gap-reports)
//   GAP_TRIAGE_ASOF          ISO date the run is judged against (default today)
//   GAP_DIGEST_DRY_RUN       "1" renders + prints, sends NOTHING

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const DRY_RUN = String(process.env.GAP_DIGEST_DRY_RUN || "") === "1";

function loadTriage() {
  const p = path.resolve(__dirname, "..", "dist", "services", "catalog", "gapTriage.service.js");
  if (!fs.existsSync(p)) throw new Error(`gapTriage not built at ${p} — run npm run build first`);
  return require(p);
}
function loadHistory() {
  const p = path.resolve(__dirname, "..", "dist", "services", "catalog", "gapHistory.service.js");
  if (!fs.existsSync(p)) throw new Error(`gapHistory not built at ${p} — run npm run build first`);
  return require(p);
}

/** Tonight's persisted gap report and the prior night's, from the history dir. */
function loadPersistedReports(dir) {
  if (!fs.existsSync(dir)) return { current: null, currentDate: null, prior: null, priorDate: null };
  const files = fs.readdirSync(dir)
    .filter((f) => /^gap-report-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const read = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; }
  };
  const curFile = files[files.length - 1];
  const priFile = files[files.length - 2];
  const cur = curFile ? read(curFile) : null;
  const pri = priFile ? read(priFile) : null;
  return {
    current: cur ? (cur.gaps ?? cur) : null,
    currentDate: cur ? (cur.date ?? null) : null,
    prior: pri ? (pri.gaps ?? pri) : null,
    priorDate: pri ? (pri.date ?? null) : null,
  };
}

/**
 * The checklist-backed twin probe, as a Cosmos count. Uses the SAME
 * checklist-source filter the gap report itself uses — a vendor-row count
 * would resurrect the inflation the report exists to defeat.
 */
const CHECKLIST_SOURCES = [
  "checklist", "checklistcenter", "beckett", "baseballcardpedia", "bccp",
  "cardboardchecklist", "cardboardconnection", "hobbymonitor", "tcgdex",
  "checklistinsider", "almanac", "tcdb",
];

function makeTwinProbe(conn) {
  const cat = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || "hobbyiq")
    .container("card_catalog");
  const srcClause = CHECKLIST_SOURCES.map((_, i) => `STARTSWITH(c.source, @s${i})`).join(" OR ");
  const srcParams = CHECKLIST_SOURCES.map((s, i) => ({ name: `@s${i}`, value: s }));
  const cache = new Map();
  return async (sport, year, candidateSetKey) => {
    const k = `${sport}|${year}|${candidateSetKey}`;
    if (cache.has(k)) return cache.get(k);
    const { resources } = await cat.items.query({
      query: `SELECT VALUE COUNT(1) FROM c
              WHERE c.sport=@sp AND c.year=@y AND c.setKey=@k
                AND STARTSWITH(c.id,'hiq:') AND (${srcClause})`,
      parameters: [
        { name: "@sp", value: sport },
        { name: "@y", value: Number(year) },
        { name: "@k", value: candidateSetKey },
        ...srcParams,
      ],
    }).fetchAll();
    const n = resources[0] || 0;
    cache.set(k, n);
    return n;
  };
}

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

const TAG_COLOR = {
  "DISPATCHABLE": "#7CFF72",
  "VOCAB-TWIN": "#FFC46B",
  "IMPOSSIBLE-COMPS": "#FF7C7C",
  "UNRELEASED": "#8FA3BF",
  "UNREACHABLE": "#8FA3BF",
};

function tagSectionHtml(title, blurb, rows) {
  if (!rows.length) return "";
  const body = rows.map((r) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:12px;font-family:'SF Mono',Monaco,Consolas,monospace">${escHtml(r.sport)} ${escHtml(r.year)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #2A3344;color:#FFFFFF;font-size:13px;font-weight:600">${escHtml(r.setKey)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:12px;text-align:right;font-family:'SF Mono',Monaco,Consolas,monospace">${Number(r.uncovered).toLocaleString("en-US")}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #2A3344;color:#C4CDD9;font-size:11px;line-height:1.45">${escHtml(r.reason)}</td>
    </tr>`).join("");
  return `
  <tr><td style="padding:8px 32px 20px 32px">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${TAG_COLOR[rows[0].tag] || "#C4CDD9"};font-weight:700;margin-bottom:4px">${escHtml(title)} · ${rows.length}</div>
    <div style="font-size:11px;color:#C4CDD9;opacity:0.6;margin-bottom:10px;line-height:1.5">${escHtml(blurb)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#0B1424;border:1px solid #2A3344;border-radius:8px;overflow:hidden">
      <thead><tr>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">Sport / Year</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">Set key</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">Uncov.</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid #2A3344;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">Why</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </td></tr>`;
}

function renderTriageHtml(t, d, headline, diffHead) {
  const by = (tag) => t.gaps.filter((x) => x.tag === tag);
  const dispatch = by("DISPATCHABLE");
  const headlineText = headline(t);
  const emptyNote = dispatch.length === 0
    ? `<div style="padding:14px 16px;background:#0B1424;border:1px solid #2A3344;border-left:3px solid #8FA3BF;border-radius:6px;color:#C4CDD9;font-size:13px;line-height:1.6">
         <strong style="color:#FFFFFF">Dispatchable list is empty.</strong> Every gap on tonight's report triages away — nothing to acquire. The work, where there is any, is slug and vocabulary repair below.
       </div>` : "";

  const diffHtml = d ? `
  <tr><td style="padding:20px 32px 4px 32px">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600;margin-bottom:8px">What moved since last night</div>
    <div style="font-size:14px;color:#FFFFFF;font-weight:600;margin-bottom:10px">${escHtml(diffHead(d))}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding-right:14px;vertical-align:top;width:25%">
          <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">Closed</div>
          <div style="font-size:26px;font-weight:700;color:#7CFF72;line-height:1.2">${d.closed.length}</div>
        </td>
        <td style="padding:0 14px;border-left:1px solid #2A3344;vertical-align:top;width:25%">
          <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">New</div>
          <div style="font-size:26px;font-weight:700;color:#FF7C7C;line-height:1.2">${d.added.length}</div>
        </td>
        <td style="padding:0 14px;border-left:1px solid #2A3344;vertical-align:top;width:25%">
          <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">Moved</div>
          <div style="font-size:26px;font-weight:700;color:#3DA9FF;line-height:1.2">${d.changed.length}</div>
        </td>
        <td style="padding-left:14px;border-left:1px solid #2A3344;vertical-align:top;width:25%">
          <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#C4CDD9;opacity:0.6">Cards closed</div>
          <div style="font-size:26px;font-weight:700;color:#7CFF72;line-height:1.2">${d.uncoveredClosed.toLocaleString("en-US")}</div>
        </td>
      </tr>
    </table>
  </td></tr>` : "";

  return `
  <tr><td style="padding:28px 32px 0 32px;border-top:1px solid #2A3344">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#C4CDD9;opacity:0.7;font-weight:600">Checklist gap triage</div>
    <div style="font-size:20px;font-weight:700;color:#FFFFFF;margin-top:6px;line-height:1.35">${escHtml(headlineText)}</div>
    <div style="margin-top:14px">${emptyNote}</div>
  </td></tr>
  ${diffHtml}
  ${tagSectionHtml("Dispatchable", "Real, released, correctly keyed, and a wired lane can reach it. This is the only list an acquisition run should be handed.", dispatch)}
  ${tagSectionHtml("Vocab twin — we already own it", "The checklist exists under another setKey. Fetching re-downloads what we hold; repair the key instead.", by("VOCAB-TWIN"))}
  ${tagSectionHtml("Impossible comps — route to slug repair", "A future release carrying sales. A card cannot sell before it exists, so the slug is wrong, not the checklist.", by("IMPOSSIBLE-COMPS"))}
  ${tagSectionHtml("Unreleased", "Not printed yet. No publisher can have a checklist; nothing to do but wait.", by("UNRELEASED"))}
  ${tagSectionHtml("Unreachable by any wired lane", "Real and correctly keyed, but no wired source covers this era/sport. Dispatching would miss by construction.", by("UNREACHABLE"))}`;
}

function renderTriageText(t, d, headline, diffHead) {
  const by = (tag) => t.gaps.filter((x) => x.tag === tag);
  const lines = ["", "─".repeat(64), `CHECKLIST GAP TRIAGE — ${headline(t)}`, ""];
  if (d) {
    lines.push(`What moved: ${diffHead(d)}`);
    lines.push(`  closed=${d.closed.length}  new=${d.added.length}  moved=${d.changed.length}  cards closed=${d.uncoveredClosed.toLocaleString()}`);
    lines.push("");
  }
  const sections = [
    ["DISPATCHABLE", "the only list an acquisition run should be handed"],
    ["VOCAB-TWIN", "already ours under another key — repair the key, do not fetch"],
    ["IMPOSSIBLE-COMPS", "future release with sales — route to slug repair"],
    ["UNRELEASED", "not printed yet — wait"],
    ["UNREACHABLE", "no wired lane covers it"],
  ];
  for (const [tag, blurb] of sections) {
    const rows = by(tag);
    lines.push(`${tag} (${rows.length}) — ${blurb}`);
    if (rows.length === 0) lines.push(`  (none)`);
    for (const r of rows) {
      lines.push(`  ${r.sport} ${r.year} ${r.setKey}  ${r.uncovered} uncovered`);
      lines.push(`      ${r.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
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

  // CF-GAP-DIGEST-TRIAGE. Classify the persisted checklist-gap report and
  // diff it against the prior night. Read-only throughout.
  const asOf = process.env.GAP_TRIAGE_ASOF || dateStr;
  const historyDir = process.env.GAP_TRIAGE_HISTORY_DIR
    || path.resolve(__dirname, "..", "data", "gap-reports");
  const { classifyGaps, triageHeadline } = loadTriage();
  const { diffGapReports, diffHeadline } = loadHistory();
  const persisted = loadPersistedReports(historyDir);

  let triage = null;
  let diff = null;
  if (persisted.current) {
    console.log(`[gap-digest] triaging ${persisted.current.length} persisted gaps (asOf=${asOf}, dir=${historyDir})`);
    triage = await classifyGaps(persisted.current, {
      twinProbe: makeTwinProbe(conn),
      asOf,
    });
    diff = diffGapReports(persisted.current, persisted.prior, persisted.priorDate);
    console.log(`[gap-digest] triage: ${triageHeadline(triage)}`);
    console.log(`[gap-digest]   ` + Object.entries(triage.byTag).map(([k, v]) => `${k}=${v}`).join("  "));
    console.log(`[gap-digest] diff: ${diffHeadline(diff)}`);
    console.log(`[gap-digest]   closed=${diff.closed.length} new=${diff.added.length} moved=${diff.changed.length} unchanged=${diff.unchanged.length}`);
  } else {
    console.log(`[gap-digest] no persisted gap report under ${historyDir} — triage sections omitted`);
  }

  const triageHtml = triage ? renderTriageHtml(triage, diff, triageHeadline, diffHeadline) : "";
  const triageText = triage ? renderTriageText(triage, diff, triageHeadline, diffHeadline) : "";

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
      ${triageHtml}
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
    triageText,
    ``,
    `Doctrine: docs/HOBBYIQ-CATALOG.md`,
  ].join("\n");

  // The headline must stay honest in the SUBJECT too: when nothing is
  // dispatchable, the subject says so rather than implying a work queue.
  const subject = triage
    ? (triage.dispatchable.length === 0
        ? `The HobbyIQ Catalog · Gap Report ${dateStr} — nothing to dispatch (${triage.total} gaps triaged)`
        : `The HobbyIQ Catalog · Gap Report ${dateStr} — ${triage.dispatchable.length} dispatchable of ${triage.total} gaps`)
    : `The HobbyIQ Catalog · Gap Report ${dateStr} — top-${N} would unlock ${g.topNUnlock.toLocaleString("en-US")} rows`;

  if (DRY_RUN) {
    console.log(`\n[gap-digest] DRY RUN — nothing sent. Subject would be:`);
    console.log(`  ${subject}`);
    console.log(`\n${triageText || "(no triage sections — nothing persisted)"}`);
    console.log(`[gap-digest] html bytes=${html.length}  text bytes=${plainText.length}  to=${to}`);
    return;
  }

  const sendEmail = await loadSendEmail();
  const result = await sendEmail({
    to,
    subject,
    plainText,
    html,
  });
  console.log(`[gap-digest] send result: delivered=${result.delivered} devLogged=${result.devLogged ?? false} error=${result.error ?? ""}`);
  if (!result.delivered) process.exit(1);
}

main().catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
