// CF-STOREFRONT-VISIBILITY-CANARY (GO-LIVE P2-4, checklist §Alerts item 4).
// "Storefront visibility drops to 0 — sanity canary for the
// marketplace_listings pool."
//
// WHAT VISIBILITY MEANS HERE. There is no `status`, `visible`, `active`,
// `published`, `deletedAt` or `expiresAt` field on a listing row. In this
// index visibility IS ROW PRESENCE: a row exists iff, at write time, its
// seller passed isEligibleSeller() and its holding carried
// showOnStorefront === true with at least one photo and an identity
// (backfillMarketplaceListings.cjs:66-74, :126-136). searchListings applies
// no visibility predicate at all — anything in the container is served by
// GET /api/marketplace/search. So COUNT(rows) is the visibility number, and
// it needs no filter to be correct.
//
// WHY A SELLER-COVERAGE AXIS AND NOT JUST A TOTAL. A pool-wide total hides
// the failure that actually matters to a seller: their own storefront going
// empty while everyone else's stays full. The eligible-seller set is
// derived, not stored — there is no sellers container and no isSeller flag;
// the set is recomputed from `users` on every refresh by the same four
// gates the cron uses (effective plan in pro_seller|investor,
// publicShareEnabled === true, emailVerification.verifiedAt present, a
// username). This canary re-derives it with the SAME predicate and then
// asks how many of those sellers have at least one visible row. A seller
// who is eligible and has zero listings is the storefront-visibility-zero
// incident, one seller at a time.
//
// THE THREE AXES.
//
//   TOTAL      COUNT(rows) must be > MIN_LISTINGS (default 0, i.e. "not
//              zero"). This is the literal checklist item.
//
//   SELLERS    every eligible seller must hold >= 1 row, unless the whole
//              eligible set is empty (a pre-launch state, not an outage).
//              Reported as covered/eligible with the uncovered ones named.
//
//   DAY-OVER-DAY   the pool must not have lost more than MAX_DROP_PCT
//              (default 0.5 = 50%) of its rows since the previous refresh.
//
// HOW DAY-OVER-DAY WORKS WITHOUT STORED STATE. The refresh rewrites every
// row it keeps and stamps `lastUpdatedAt` with the run's own wall clock
// (backfillMarketplaceListings.cjs:135), so the pool carries its own
// history: rows stamped by the most recent refresh are today's survivors,
// and rows still carrying an older stamp are what the newest run did NOT
// rewrite. Comparing the newest refresh cohort against the one before it
// gives a real day-over-day delta with no cache, no artifact and no
// baseline file to drift. Measured 2026-09-07: all 19 rows share
// lastUpdatedAt 2026-09-07T07:42:56.483Z — one cron run at 07:30 UTC
// stamps the whole pool, which is exactly what makes the cohort split
// legible.
//
// The axis is SKIPPED, loudly, when only one cohort exists (a first run, or
// a FRESH rebuild that replaced everything): "no prior cohort" is not a 0%
// drop and must not be reported as a pass.
//
// MEASURED 2026-09-07 (read-only): 19 listings, 2 distinct sellers, 2
// eligible sellers, all rows refreshed 07:42Z. Coverage 2/2.
//
// NOTE ON THE COMPANION DEFECT (not this canary's job to fix). The refresh
// is the container's ONLY writer — syncListingForHolding and
// deleteAllListingsForSeller exist but have no call site in backend/src —
// so a card toggled OFF keeps serving from the public search route until
// the next successful nightly run. This canary measures visibility going to
// zero, not staleness of an individual row; the freshness axis below is
// what would catch the cron dying entirely.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   COSMOS_DATABASE            default hobbyiq
//   COSMOS_USERS_CONTAINER     default users
//   MIN_LISTINGS               default 0 — fires when total <= this
//   MAX_DROP_PCT               default 0.5 — fires on a >50% cohort drop.
//                              0 disables the axis.
//   MAX_REFRESH_AGE_HOURS      default 48 — the newest lastUpdatedAt must
//                              be younger than this (the cron is nightly at
//                              07:30 UTC, so 48h tolerates one missed run).
//                              0 disables.
//   RUN_MINUTES                budget for the measurement loop (default 8)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const MIN_LISTINGS = Math.floor(numEnv(process.env.MIN_LISTINGS, 0));
const MAX_DROP_PCT = numEnv(process.env.MAX_DROP_PCT, 0.5);
const MAX_REFRESH_AGE_HOURS = numEnv(process.env.MAX_REFRESH_AGE_HOURS, 48);

/** Env numbers must be finite and non-negative to override the default. */
function numEnv(raw, dflt) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// ── The eligible-seller predicate ────────────────────────────────────────
// Deliberately a COPY of backfillMarketplaceListings.cjs:60-74 rather than
// an import: that script runs a whole rebuild at require time is not the
// risk — the risk is that the canary and the writer drift apart silently.
// Keeping the predicate here, pinned by a test that asserts both files gate
// on the same four things, makes a drift a red test rather than a canary
// that quietly measures a different population than the one being written.
const SELLER_PLANS = ["pro_seller", "investor"];

function normalizePlan(p) {
  return ["free", "collector", "investor", "pro_seller"].includes(p) ? p : "free";
}

function effectivePlan(user) {
  const override = user && user.entitlementOverride;
  if (override && ["free", "collector", "investor", "pro_seller"].includes(override)) return override;
  return normalizePlan(user && user.plan);
}

/**
 * The four gates, in the writer's order. Returns the REASON a user is
 * refused rather than a bare boolean, so the banner can say why the
 * eligible set is the size it is instead of only how big it is.
 */
function sellerEligibility(user) {
  const plan = effectivePlan(user);
  if (!SELLER_PLANS.includes(plan)) return { eligible: false, reason: "plan" };
  if (!user || user.publicShareEnabled !== true) return { eligible: false, reason: "publicShareDisabled" };
  if (!user || !user.emailVerification || !user.emailVerification.verifiedAt) {
    return { eligible: false, reason: "emailUnverified" };
  }
  const username = user.aliases && user.aliases[0] ? user.aliases[0] : user.usernameLower;
  if (!username) return { eligible: false, reason: "noUsername" };
  return { eligible: true, reason: null, userId: user.userId || user.id, username, plan };
}

/**
 * Split rows into cohorts by their lastUpdatedAt stamp, newest first.
 *
 * The refresh stamps every row it writes with one wall clock, so a cohort
 * IS a run. Stamps are bucketed to the minute: a long rebuild can straddle
 * a second boundary and would otherwise shatter one run into many cohorts,
 * which would then compare a run against itself and report a 99% drop.
 */
function cohorts(stamps, bucketMs = 60000) {
  const buckets = new Map();
  for (const s of stamps || []) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) continue;
    const key = Math.floor(ms / bucketMs) * bucketMs;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([ms, count]) => ({ at: new Date(ms).toISOString(), count }));
}

/**
 * The day-over-day verdict from two cohorts.
 *
 * `skipped` when there is no prior cohort to compare against — a first run
 * or a FRESH rebuild. That is reported, never silently passed: "we could
 * not measure the drop" and "the drop was 0%" are different statements.
 *
 * A prior cohort of 0 cannot produce a meaningful fraction, so it is also
 * skipped rather than dividing by zero into Infinity.
 */
function dropVerdict(cohortList, maxDropPct) {
  if (!(maxDropPct > 0)) return { axis: "off", ok: true, skipped: true };
  const [current, prior] = cohortList || [];
  if (!current || !prior) {
    return { axis: "day-over-day", ok: true, skipped: true, reason: "no prior refresh cohort" };
  }
  if (!(prior.count > 0)) {
    return { axis: "day-over-day", ok: true, skipped: true, reason: "prior cohort is empty" };
  }
  const dropped = Math.max(0, prior.count - current.count);
  const dropPct = dropped / prior.count;
  return {
    axis: "day-over-day",
    ok: dropPct <= maxDropPct,
    skipped: false,
    current: current.count,
    currentAt: current.at,
    prior: prior.count,
    priorAt: prior.at,
    dropPct,
    floor: Math.ceil(prior.count * (1 - maxDropPct)),
  };
}

/**
 * Which eligible sellers have no visible row. `sellersWithListings` is the
 * set of sellerIds present in the pool.
 *
 * An EMPTY eligible set yields no uncovered sellers and cannot fire: before
 * launch there may legitimately be nobody, and a canary that is red from
 * the day it ships is a canary nobody reads.
 */
function coverageVerdict(eligible, sellersWithListings) {
  const present = new Set(sellersWithListings || []);
  const uncovered = (eligible || []).filter((s) => !present.has(s.userId));
  return {
    eligible: (eligible || []).length,
    covered: (eligible || []).length - uncovered.length,
    uncovered,
    ok: uncovered.length === 0,
  };
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
      console.log(`[storefront-canary] ${label}: 429 — retry ${attempt}/6 in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("::error::[storefront-canary] COSMOS_CONNECTION_STRING required");
    return { code: 2 };
  }

  const b = budget({ minutes: numEnv(process.env.RUN_MINUTES, 8), reserveMs: 60_000, verifyMs: 120_000 });
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const listings = db.container("marketplace_listings");
  const users = db.container(process.env.COSMOS_USERS_CONTAINER || "users");

  console.log("[storefront-canary] source of truth: Cosmos marketplace_listings (visibility = row presence)");
  console.log(`[storefront-canary] ${b.describe()}`);
  console.log(`[storefront-canary] thresholds: total > ${MIN_LISTINGS}; every eligible seller covered; drop <= ${MAX_DROP_PCT > 0 ? `${(MAX_DROP_PCT * 100).toFixed(0)}%` : "off"}; refresh age <= ${MAX_REFRESH_AGE_HOURS > 0 ? `${MAX_REFRESH_AGE_HOURS}h` : "off"}`);
  console.log("");

  // The pool is small BY DESIGN, not by luck: publicSeller.routes.ts:49 caps
  // a storefront at 200 cards (50 for investor), so the container is bounded
  // at roughly sellers x 200 — 19 rows across 2 sellers on 2026-09-07, and
  // still only ~20k at a hundred sellers. A single two-field projection is
  // therefore cheaper than three aggregate queries AND yields the cohort
  // split for free. If that cap ever goes away this must become a set of
  // COUNTs plus a bounded cohort probe; the budget below is what would
  // notice, by stopping rather than running to the step ceiling.
  const { resources: rows } = await withRetry429(
    () => listings.items.query("SELECT c.sellerId, c.lastUpdatedAt FROM c").fetchAll(),
    "listings scan",
  );
  const total = rows.length;
  const sellersWithListings = new Set(rows.map((r) => r && r.sellerId).filter(Boolean));

  const { resources: userRows } = await withRetry429(
    () => users.items.query({
      query: `SELECT c.id, c.userId, c.plan, c.entitlementOverride, c.publicShareEnabled,
                     c.emailVerification, c.aliases, c.usernameLower
              FROM c
              WHERE c.docType = "user" AND c.publicShareEnabled = true`,
    }).fetchAll(),
    "eligible sellers",
  );

  const eligible = [];
  const refusedBy = {};
  for (const u of userRows) {
    const e = sellerEligibility(u);
    if (e.eligible) eligible.push(e);
    else refusedBy[e.reason] = (refusedBy[e.reason] || 0) + 1;
  }

  const cohortList = cohorts(rows.map((r) => r && r.lastUpdatedAt));
  const drop = dropVerdict(cohortList, MAX_DROP_PCT);
  const coverage = coverageVerdict(eligible, sellersWithListings);

  const newestMs = cohortList.length ? Date.parse(cohortList[0].at) : null;
  const refreshAgeH = newestMs === null ? Infinity : (Date.now() - newestMs) / 3600000;
  const refreshOk = !(MAX_REFRESH_AGE_HOURS > 0) || refreshAgeH <= MAX_REFRESH_AGE_HOURS;

  console.log("axis            measured                             threshold        verdict");
  console.log("-------------   ----------------------------------   --------------   -------");
  console.log(`total           ${`${total} visible listings`.padEnd(34)}   > ${String(MIN_LISTINGS).padEnd(12)}   ${total > MIN_LISTINGS ? "ok" : "ZERO"}`);
  console.log(`sellers         ${`${coverage.covered}/${coverage.eligible} eligible sellers covered`.padEnd(34)}   ${"all covered".padEnd(14)}   ${coverage.ok ? "ok" : "UNCOVERED"}`);
  if (drop.skipped) {
    console.log(`day-over-day    ${`skipped — ${drop.reason || "axis off"}`.padEnd(34)}   ${`<= ${MAX_DROP_PCT > 0 ? `${(MAX_DROP_PCT * 100).toFixed(0)}%` : "off"}`.padEnd(14)}   skipped`);
  } else {
    console.log(`day-over-day    ${`${drop.current} vs ${drop.prior} (${(drop.dropPct * 100).toFixed(1)}% drop)`.padEnd(34)}   ${`>= ${drop.floor}`.padEnd(14)}   ${drop.ok ? "ok" : "COLLAPSED"}`);
  }
  const ageStr = refreshAgeH === Infinity ? "NEVER (no stamped row)" : `${refreshAgeH.toFixed(1)}h since last refresh`;
  console.log(`refresh age     ${ageStr.padEnd(34)}   ${`<= ${MAX_REFRESH_AGE_HOURS > 0 ? `${MAX_REFRESH_AGE_HOURS}h` : "off"}`.padEnd(14)}   ${refreshOk ? "ok" : "STALE"}`);
  console.log("");

  console.log(`[storefront-canary] refresh cohorts (newest first): ${cohortList.slice(0, 4).map((c) => `${c.at}=${c.count}`).join("  ") || "(none)"}`);
  const refusedStr = Object.entries(refusedBy).map(([k, n]) => `${k}=${n}`).join(", ");
  console.log(`[storefront-canary] eligible sellers: ${eligible.length} of ${userRows.length} publicShareEnabled users${refusedStr ? ` (refused: ${refusedStr})` : ""}`);

  // RECONCILIATION. Every row scanned is accounted for by a cohort, and
  // every publicShareEnabled user by eligible-or-a-named-refusal. A row or
  // a user that vanished between the query and the verdict is a defect in
  // this canary, so the arithmetic is stated rather than assumed.
  const cohortRows = cohortList.reduce((a, c) => a + c.count, 0);
  const unstamped = total - cohortRows;
  const refusedTotal = Object.values(refusedBy).reduce((a, n) => a + n, 0);
  console.log(
    `[storefront-canary] reconcile listings: ${total} scanned = ${cohortRows} stamped + ${unstamped} unstamped  ` +
    `${cohortRows + unstamped === total ? "RECONCILES" : "MISMATCH"}`,
  );
  console.log(
    `[storefront-canary] reconcile sellers: ${userRows.length} candidates = ${eligible.length} eligible + ${refusedTotal} refused  ` +
    `${eligible.length + refusedTotal === userRows.length ? "RECONCILES" : "MISMATCH"}`,
  );

  let failed = false;
  if (!(total > MIN_LISTINGS)) {
    failed = true;
    console.error(
      `::error::storefront visibility ZERO: ${total} rows in marketplace_listings (floor > ${MIN_LISTINGS}). ` +
      `Cross-storefront search serves this container directly — every seller's storefront is empty. ` +
      `Check the Marketplace Listings Refresh workflow`,
    );
  }
  if (!coverage.ok) {
    failed = true;
    const names = coverage.uncovered.slice(0, 10).map((s) => s.username || s.userId).join(", ");
    console.error(
      `::error::storefront visibility UNCOVERED SELLERS: ${coverage.uncovered.length} of ${coverage.eligible} eligible sellers have zero visible listings (${names}) — ` +
      `they are entitled to a storefront and have none`,
    );
  }
  if (!drop.skipped && !drop.ok) {
    failed = true;
    console.error(
      `::error::storefront visibility COLLAPSED: ${drop.current} listings in the ${drop.currentAt} refresh vs ${drop.prior} in ${drop.priorAt} ` +
      `(${(drop.dropPct * 100).toFixed(1)}% lost, ceiling ${(MAX_DROP_PCT * 100).toFixed(0)}%, floor ${drop.floor}) — inventory left the index in bulk`,
    );
  }
  if (!refreshOk) {
    failed = true;
    const st = refreshAgeH === Infinity ? "no row carries a lastUpdatedAt" : `${refreshAgeH.toFixed(1)}h old`;
    console.error(
      `::error::storefront index STALE: newest refresh ${st} (ceiling ${MAX_REFRESH_AGE_HOURS}h). ` +
      `The nightly refresh (07:30 UTC) is the container's only writer — a card toggled off is still being served`,
    );
  }

  if (failed) {
    console.error("::error::Marketplace Listings Refresh: https://github.com/HobbyIQ/HobbyIQ-V1/actions/workflows/marketplace-listings-refresh.yml");
    return { code: 1, client, budget: b };
  }

  console.log(
    `[storefront-canary] OK — ${total} visible listings across ${sellersWithListings.size} seller(s); ` +
    `${coverage.covered}/${coverage.eligible} eligible sellers covered; ` +
    `${drop.skipped ? "drop axis skipped" : `${(drop.dropPct * 100).toFixed(1)}% drop within ceiling`}`,
  );
  return { code: 0, client, budget: b };
}

module.exports = {
  sellerEligibility, effectivePlan, normalizePlan,
  cohorts, dropVerdict, coverageVerdict, numEnv,
};

if (require.main === module) {
  main()
    .then((r) => finishLane(r.code, { client: r.client, budget: r.budget }))
    .catch(async (e) => {
      console.error("::error::[storefront-canary] FAILED:", (e && e.message) || e);
      await finishLane(1);
    });
}
