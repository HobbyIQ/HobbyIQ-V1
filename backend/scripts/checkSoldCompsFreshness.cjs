// CF-FRESHNESS-CANARY (Drew, 2026-08-07). Cron-driven canary that
// checks freshness of every primary sold_comps ingest source and
// fails loudly if any of them stalls.
//
// Motivating case: 2026-08-03..07 TCA firehose APPLY-fallback bug —
// green workflow runs, zero data writes, no alert for 5 days. First
// version of this canary reported OK because CH runtime API calls
// masked TCA being dead. Per-source check is the correct signal.
//
// D13 (2026-08-29) — alert gates prove delivery. Staleness alone cannot
// tell the firehose from the webhook trickle: while the nightly firehose
// is dead, the 30-minute webhook keeps the last observedAt fresh, so the
// 08-03 outage shape reads "OK" here. Second axis: MIN_ROWS_24H, a
// per-source floor on the trailing-24h row COUNT. Off by default; the
// workflow sets the floor from measured daily counts.
//
// Sources monitored (must all be < MAX_STALENESS_HOURS old):
//   tca-ebay      — nightly TCA firehose cron (primary volume feed)
//   cardhedge     — runtime CH getCardSales calls (deprecated 2026-08-02
//                   but still active until phase 3 lands)
//
// Sources NOT monitored (write sporadically, no alert):
//   holding, user-ebay, portfolio-import, ch-daily-manual, admin-*
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   MAX_STALENESS_HOURS        default 25 (tolerates one full inter-
//                              cron window for nightly sources)
//   MONITOR_SOURCES            comma-separated override; default
//                              "tca-ebay,cardhedge"
//   MIN_ROWS_24H               per-source row floor for the trailing 24h,
//                              "tca-ebay=2300,cardhedge=0" — 0 or absent
//                              disables the axis for that source. Default
//                              off. Fails when COUNT(rows observed in the
//                              last 24h) < floor; always prints the count.
//
// D33 (2026-09-02) — the VOLUME FLOOR axis, and why a static floor was not
// enough. MIN_ROWS_24H must be hand-set per source, so in practice exactly
// one source carried a number (tca-ebay=25000) and every other source ran
// with no volume alert at all. cardhedge is the case that proves the cost:
// it fell from ~1.2M rows/day (08-17..19) to ~12k-100k across the lapse and
// no axis could see it, because nobody wants to hand-maintain a static
// number for a spiky demand-driven feed.
//
// This axis derives the floor instead of being told it: each source's
// last-full-day count is compared against a rolling baseline — the MEDIAN
// of the trailing BASELINE_DAYS full days before it — and the source alerts
// when it lands under VOLUME_FLOOR_FRACTION of that baseline.
//
//   median, not mean: the pool takes backfill spikes (tca-ebay 438,651 on
//   08-29 against a ~90k/day norm). A mean baseline inherits the spike and
//   then reads the next normal day as a collapse; a median ignores it.
//
//   NOT weekday-aware: measured 2026-09-02 over 21 days, per-weekday medians
//   for both live sources are pure noise at n=3 (tca-ebay dow0 spans
//   7,077..299,151 — the spread is the outage and the backfill, not a weekly
//   cycle). Bucketing by weekday here would fit the outage. Revisit only if a
//   weekly shape is actually demonstrated over a clean multi-week window.
//
//   MIN_BASELINE_ROWS is what keeps retired and tiny sources quiet: a source
//   whose own baseline is under the minimum is EXEMPT and can never fire.
//   This is self-maintaining — cardsight (retired, 21d median 0) and
//   user-entry exempt themselves by their own volume, with no exclusion list
//   to update when a source dies.
//
// Env (volume axis):
//   VOLUME_FLOOR_FRACTION      default 0.5 — alert under this fraction of
//                              baseline. 0 disables the axis entirely.
//   BASELINE_DAYS              default 14 — trailing full days of baseline.
//   MIN_BASELINE_ROWS          default 1000 — a source whose baseline is
//                              below this is exempt (retired / tiny).
//   VOLUME_SOURCES             comma-separated; default = MONITOR_SOURCES
//                              plus the known-quiet sources, so a collapse
//                              is visible on sources staleness never watched.
//
// Exit codes: 0 all axes OK · 1 any axis failed / query error · 2 no env.

const { CosmosClient } = require("@azure/cosmos");

const MAX_STALENESS_HOURS = Number(process.env.MAX_STALENESS_HOURS || 25);
const MONITOR_SOURCES = (process.env.MONITOR_SOURCES || "tca-ebay,cardhedge")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Volume axis. Env-tunable; the defaults are the shipped policy.
const VOLUME_FLOOR_FRACTION = numEnv(process.env.VOLUME_FLOOR_FRACTION, 0.5);
const BASELINE_DAYS = Math.max(1, Math.floor(numEnv(process.env.BASELINE_DAYS, 14)));
const MIN_BASELINE_ROWS = Math.max(0, Math.floor(numEnv(process.env.MIN_BASELINE_ROWS, 1000)));
const VOLUME_SOURCES = (process.env.VOLUME_SOURCES ||
  [...new Set([...MONITOR_SOURCES, "cardsight", "user-entry"])].join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

/** Env numbers must be finite and non-negative to override the default. */
function numEnv(raw, dflt) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Integer median. Even length averages the two middles (floored). */
function median(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.floor((s[mid - 1] + s[mid]) / 2);
}

/**
 * One verdict per source for the volume axis.
 *
 * `current` is the source's last-full-day count; `baselineCounts` the
 * BASELINE_DAYS full days before it. A source is EXEMPT — and can never
 * fire — when its own baseline is under minBaseline, which is what keeps
 * retired (cardsight) and tiny (user-entry) sources from flapping.
 *
 * fraction <= 0 disables the axis: no verdicts at all.
 */
function volumeVerdicts(perSource, { fraction, minBaseline }) {
  if (!(fraction > 0)) return [];
  const verdicts = [];
  for (const [source, data] of Object.entries(perSource)) {
    const current = Number(data?.current ?? 0);
    const baseline = median((data?.baselineCounts ?? []).map(Number));
    const exempt = baseline < minBaseline;
    const floor = Math.floor(baseline * fraction);
    verdicts.push({
      source,
      current,
      baseline,
      floor,
      exempt,
      // An exempt source is never below: the floor does not apply to it.
      ok: exempt ? true : current >= floor,
    });
  }
  return verdicts;
}

/**
 * "tca-ebay=2300,cardhedge=0" → Map { "tca-ebay" → 2300, "cardhedge" → 0 }.
 * Blank / malformed entries are ignored; a non-finite or negative floor
 * is ignored; 0 means "axis off for this source".
 */
function parseMinRowsSpec(spec) {
  const out = new Map();
  for (const part of String(spec || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const source = trimmed.slice(0, eq).trim();
    const floor = Number(trimmed.slice(eq + 1).trim());
    if (!source || !Number.isFinite(floor) || floor < 0) continue;
    out.set(source, Math.floor(floor));
  }
  return out;
}

/**
 * counts: { [source]: rowsLast24h }; floors: Map<source, floor>.
 * One verdict per source with a floor > 0. `ok` iff count >= floor.
 */
function rowFloorVerdicts(counts, floors) {
  const verdicts = [];
  for (const [source, floor] of floors) {
    if (!(floor > 0)) continue;
    const count = Number(counts[source] ?? 0);
    verdicts.push({ source, count, floor, ok: count >= floor });
  }
  return verdicts;
}

async function withRetry429(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const code = err && (err.code ?? err.statusCode);
      const throttled = code === 429 || code === "429" || /429|throttl|request rate/i.test(String(err && err.message));
      if (!throttled) throw err;
      const waitMs = Number(err.retryAfterInMs) || Math.min(30_000, 500 * 2 ** attempt);
      console.log(`[freshness-canary] ${label}: 429 — retry ${attempt}/6 in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function latestObservedAtForSource(sc, source) {
  const q = await withRetry429(() => sc.items.query({
    query: "SELECT TOP 1 c.observedAt FROM c WHERE c.source = @source AND IS_DEFINED(c.observedAt) ORDER BY c.observedAt DESC",
    parameters: [{ name: "@source", value: source }],
  }, { maxItemCount: 1 }).fetchAll(), `latest ${source}`);
  return q.resources[0]?.observedAt ?? null;
}

async function rowsLast24hForSource(sc, source, sinceIso) {
  const q = await withRetry429(() => sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = @source AND c.observedAt >= @since",
    parameters: [{ name: "@source", value: source }, { name: "@since", value: sinceIso }],
  }, { maxItemCount: 1 }).fetchAll(), `rows24h ${source}`);
  return Number(q.resources[0] ?? 0);
}

/**
 * Rows for one source over one UTC calendar day [dayIso, nextDayIso).
 *
 * Deliberately one narrow COUNT per (source, day) rather than a GROUP BY
 * over the window: measured 2026-09-02, the narrow form is ~1.7s / ~259 RU,
 * while an unbounded `GROUP BY c.source, LEFT(c.observedAt,10)` over the
 * same span did not return in 10 minutes against this container.
 */
async function rowsForSourceDay(sc, source, dayIso, nextDayIso) {
  const q = await withRetry429(() => sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = @source AND c.observedAt >= @a AND c.observedAt < @b",
    parameters: [
      { name: "@source", value: source },
      { name: "@a", value: dayIso },
      { name: "@b", value: nextDayIso },
    ],
  }, { maxItemCount: 1 }).fetchAll(), `day ${source} ${dayIso}`);
  return Number(q.resources[0] ?? 0);
}

/** UTC calendar day string N days before `now`. */
function dayKey(now, daysAgo) {
  return new Date(now - daysAgo * 86400000).toISOString().slice(0, 10);
}

/**
 * Last-full-day count plus the BASELINE_DAYS full days before it, per source.
 * Day 1 back is the last COMPLETE UTC day — today is still filling and would
 * read as a collapse on every run before ~24:00 UTC.
 */
async function collectVolume(sc, sources, now, baselineDays) {
  const perSource = {};
  for (const source of sources) {
    const current = await rowsForSourceDay(sc, source, dayKey(now, 1), dayKey(now, 0));
    const baselineCounts = [];
    for (let i = 2; i <= baselineDays + 1; i++) {
      baselineCounts.push(await rowsForSourceDay(sc, source, dayKey(now, i), dayKey(now, i - 1)));
    }
    perSource[source] = { current, baselineCounts };
  }
  return perSource;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  const minRows = parseMinRowsSpec(process.env.MIN_ROWS_24H);

  console.log(`[freshness-canary] monitoring sources: ${MONITOR_SOURCES.join(", ")}`);
  console.log(`[freshness-canary] threshold: ${MAX_STALENESS_HOURS}h`);
  const floorsOn = [...minRows].filter(([, f]) => f > 0);
  console.log(`[freshness-canary] row floors (24h): ${floorsOn.length ? floorsOn.map(([s, f]) => `${s}>=${f}`).join(", ") : "off"}`);

  const now = Date.now();
  const results = [];
  for (const source of MONITOR_SOURCES) {
    const latest = await latestObservedAtForSource(sc, source);
    const stalenessH = latest ? (now - new Date(latest).getTime()) / 3600000 : Infinity;
    results.push({ source, latest, stalenessH });
  }

  console.log("");
  console.log("source              latest observedAt                staleness");
  console.log("------------------  ---------------------------      ---------");
  for (const r of results) {
    const label = r.source.padEnd(18);
    const ts = (r.latest ?? "(never)").padEnd(32);
    const staleness = r.stalenessH === Infinity ? "∞" : `${r.stalenessH.toFixed(1)}h`;
    console.log(`${label}  ${ts}  ${staleness}`);
  }
  console.log("");

  // Row-count axis — always print the count for every floored source.
  let verdicts = [];
  if (floorsOn.length) {
    const sinceIso = new Date(now - 24 * 3600000).toISOString();
    const counts = {};
    for (const [source] of floorsOn) counts[source] = await rowsLast24hForSource(sc, source, sinceIso);
    verdicts = rowFloorVerdicts(counts, minRows);
    console.log("source              rows (last 24h)   floor     verdict");
    console.log("------------------  ---------------   -------   -------");
    for (const v of verdicts) {
      console.log(`${v.source.padEnd(18)}  ${String(v.count).padStart(15)}   ${String(v.floor).padStart(7)}   ${v.ok ? "ok" : "BELOW"}`);
    }
    console.log("");
  }

  // Volume axis — last full day vs a rolling median baseline.
  let volume = [];
  if (VOLUME_FLOOR_FRACTION > 0) {
    const perSource = await collectVolume(sc, VOLUME_SOURCES, now, BASELINE_DAYS);
    volume = volumeVerdicts(perSource, {
      fraction: VOLUME_FLOOR_FRACTION,
      minBaseline: MIN_BASELINE_ROWS,
    });
    console.log(`volume floor: last full day (${dayKey(now, 1)}) vs median of the ${BASELINE_DAYS} days before it`);
    console.log("source              last full day    baseline    floor      verdict");
    console.log("------------------  --------------   ---------   --------   -------");
    for (const v of volume) {
      const verdict = v.exempt ? `exempt (base<${MIN_BASELINE_ROWS})` : v.ok ? "ok" : "COLLAPSED";
      console.log(
        `${v.source.padEnd(18)}  ${String(v.current).padStart(14)}   ${String(v.baseline).padStart(9)}   ${String(v.floor).padStart(8)}   ${verdict}`,
      );
    }
    console.log("");
  }

  let failed = false;
  const stale = results.filter((r) => r.stalenessH > MAX_STALENESS_HOURS);
  if (stale.length) {
    failed = true;
    for (const r of stale) {
      const st = r.stalenessH === Infinity ? "NEVER" : `${r.stalenessH.toFixed(1)}h`;
      console.error(`::error::sold_comps source=${r.source} STALE: last write ${st} ago (threshold ${MAX_STALENESS_HOURS}h)`);
    }
  }
  const below = verdicts.filter((v) => !v.ok);
  if (below.length) {
    failed = true;
    for (const v of below) {
      console.error(`::error::sold_comps source=${v.source} ROWS-24H: ${v.count} rows in the last 24h, floor ${v.floor} — the feed is trickling, not flowing`);
    }
  }
  const collapsed = volume.filter((v) => !v.ok);
  if (collapsed.length) {
    failed = true;
    for (const v of collapsed) {
      const pct = v.baseline > 0 ? ((v.current / v.baseline) * 100).toFixed(1) : "0.0";
      console.error(
        `::error::sold_comps source=${v.source} VOLUME-COLLAPSE: ${v.current} rows on ${dayKey(now, 1)} vs baseline ${v.baseline}/day ` +
        `(${pct}% of normal, floor ${v.floor} = ${VOLUME_FLOOR_FRACTION}x the ${BASELINE_DAYS}-day median) — supply has collapsed, not merely slowed`,
      );
    }
  }

  // Every source the volume axis looked at is accounted for on one line:
  // checked = fired + passed + exempt. A source that silently vanished from
  // the report is itself a defect, so the arithmetic is stated, not implied.
  const exemptCount = volume.filter((v) => v.exempt).length;
  const passedCount = volume.filter((v) => v.ok && !v.exempt).length;
  const accounted = collapsed.length + passedCount + exemptCount;
  console.log(
    `[freshness-canary] volume axis: ${volume.length} checked = ${collapsed.length} collapsed + ${passedCount} ok + ${exemptCount} exempt  ` +
    `${accounted === volume.length ? "RECONCILES" : "MISMATCH"}`,
  );

  if (failed) {
    console.error(`::error::Check TCA Firehose Ingest workflow: https://github.com/HobbyIQ/HobbyIQ-V1/actions/workflows/tca-firehose-ingest.yml`);
    process.exit(1);
  }

  console.log(`[freshness-canary] OK — all ${results.length} monitored sources fresh${verdicts.length ? `; ${verdicts.length} row floor(s) met` : ""}${volume.length ? `; ${passedCount} volume floor(s) met, ${exemptCount} exempt` : ""}`);
}

module.exports = { parseMinRowsSpec, rowFloorVerdicts, median, volumeVerdicts, numEnv, dayKey };

if (require.main === module) {
  main().catch((e) => { console.error("::error::[freshness-canary] FAILED:", e?.message || e); process.exit(1); });
}
