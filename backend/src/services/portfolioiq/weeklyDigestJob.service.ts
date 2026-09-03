// CF-WEEKLY-DIGEST (Drew, 2026-09-02). The Sunday fanout: build one
// digest per user, persist it, deliver it.
//
// Idempotence, three ways, because "re-run the same week" must be safe:
//   1. The digest is keyed (userId, ISO week). Two runs write the SAME
//      Cosmos doc id — an upsert, never an append.
//   2. Delivery is gated on that doc's `deliveredAt`. A second run for a
//      week already mailed re-persists the digest and sends NOTHING.
//   3. The window is the ISO week, not "the last 7 days from now", so a
//      Tuesday re-run of Sunday's job covers Sunday's week.
//
// Feature detection, not hard dependency. The sell-now radar and the
// market-index series are OPTIONAL inputs: each is loaded through a
// dynamic import inside a try, and a miss yields `null`, which
// buildWeeklyDigest turns into an omitted section. A digest for a user
// whose signals surface is absent is a shorter digest, never a failed one.
//
// Delivery. Email through ACS (services/emailService), which is the only
// delivery infra this repo has for user-facing mail. APNs exists but a
// weekly digest is not a push — it is a read. When ACS is unconfigured
// the digest is still BUILT and PERSISTED, and the in-app view
// (GET /api/portfolio/insights/weekly-digest) serves it. That is the v1
// floor: a digest always exists to be read, whether or not it was mailed.

import {
  listAllPortfolioUserIds,
  readUserDoc,
} from "./portfolioStore.service.js";
import {
  buildWeeklyDigest,
  isoWeekBounds,
  type DigestSignalCandidate,
  type DigestSportIndex,
  type WeeklyDigest,
} from "./weeklyDigestBuild.service.js";
import {
  markWeeklyDigestDelivery,
  readWeeklyDigest,
  upsertWeeklyDigest,
} from "./weeklyDigestStore.service.js";
import { renderWeeklyDigestEmail } from "./weeklyDigestRender.service.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { SendEmailInput, SendEmailResult } from "../emailService.js";

export interface WeeklyDigestJobOptions {
  /** Explicit ISO week ("2026-W36"). Defaults to the week containing
   *  `now` minus one day, so a Sunday-night run reports the week that is
   *  ending rather than the one just starting. */
  weekId?: string;
  /** Only this user. Used by the admin route for a single-user test. */
  userId?: string;
  /** Build + persist but never send. */
  dryRun?: boolean;
  /** Send even when the doc already carries deliveredAt. Off by default —
   *  this is the flag that breaks idempotence, so it is explicit. */
  force?: boolean;
  /** Cap users processed in one run (safety valve for a first prod run). */
  maxUsers?: number;
  now?: Date;
}

export interface WeeklyDigestJobSummary {
  weekId: string;
  usersScanned: number;
  digestsBuilt: number;
  digestsPersisted: number;
  emailsSent: number;
  skipped: {
    noHoldings: number;
    alreadyDelivered: number;
    noEmailOnFile: number;
    emailNotConfigured: number;
    sendFailed: number;
    readFailed: number;
  };
  /** True when the sell-now radar answered for at least one user. The
   *  workflow asserts on this: a run where the surface silently vanished
   *  is a different fact from a quiet week. */
  signalsSurfaceAvailable: boolean;
  marketSurfaceAvailable: boolean;
  emailConfigured: boolean;
  dryRun: boolean;
}

type SendEmailFn = (input: SendEmailInput) => Promise<SendEmailResult>;

/** Optional deps, injected by tests. Absent → resolved dynamically. */
export interface WeeklyDigestJobDeps {
  sendEmail?: SendEmailFn | null;
  loadSignals?: (holdings: PortfolioHolding[]) => Promise<DigestSignalCandidate[] | null>;
  loadSportIndexes?: () => Promise<DigestSportIndex[] | null>;
  resolveEmail?: (userId: string) => Promise<string | null>;
}

// ── Optional-surface loaders ────────────────────────────────────────

/**
 * Sell/watch signals from the sell-now radar.
 *
 * FEATURE DETECTION, per the brief: if the seller-intelligence surface
 * has not landed (or its module throws), this returns null and the digest
 * omits the section. It does NOT throw, and it does NOT return [] — an
 * empty array means "asked, and the answer was none", which is a
 * different fact the digest's footnotes distinguish.
 */
async function defaultLoadSignals(
  holdings: PortfolioHolding[],
): Promise<DigestSignalCandidate[] | null> {
  try {
    const mod = await import("./sellNowRadarAnalyze.service.js");
    if (typeof mod.detectSellNowCandidates !== "function") return null;
    const candidates = await mod.detectSellNowCandidates(holdings);
    if (!Array.isArray(candidates)) return null;
    // The radar's row is structurally our DigestSignalCandidate. Map
    // field-by-field anyway so a shape drift on their side is a compile
    // error here rather than an undefined in a rendered sentence.
    return candidates.map((c) => ({
      holdingId: c.holdingId,
      player: c.player,
      cardTitle: c.cardTitle,
      graderTier: c.graderTier,
      currentMarketValue: c.currentMarketValue,
      purchasePrice: c.purchasePrice,
      unrealizedGainUsd: c.unrealizedGainUsd,
      velocityPerWeek: c.velocityPerWeek,
      velocityBaseline: c.velocityBaseline,
      velocityMultiple: c.velocityMultiple,
      playerMomentum: c.playerMomentum,
      playerDirection: c.playerDirection,
      reason: c.reason,
      urgencyScore: c.urgencyScore,
    }));
  } catch {
    return null;
  }
}

/**
 * Per-sport index, week over week.
 *
 * getMarketIndexes returns a 180-day series and a change across the WHOLE
 * window — not what a weekly digest means by "this week". So we read the
 * series and take the level closest to 7 days back as the comparison
 * point, which is the actual week-over-week number.
 */
async function defaultLoadSportIndexes(): Promise<DigestSportIndex[] | null> {
  try {
    const mod = await import("../insights/marketIndexRead.service.js");
    if (typeof mod.getMarketIndexes !== "function") return null;
    const res = await mod.getMarketIndexes(30);
    if (!res || !Array.isArray(res.indexes)) return null;

    const rows: DigestSportIndex[] = [];
    for (const idx of res.indexes) {
      const series = Array.isArray(idx.series) ? idx.series : [];
      if (series.length === 0 || typeof idx.latestLevel !== "number") continue;
      const latestAt = Date.parse(`${series[series.length - 1].date}T00:00:00Z`);
      const targetMs = latestAt - 7 * 24 * 60 * 60 * 1000;

      // Closest point at or before the target day. When the series does
      // not reach back a week, weekAgoLevel stays null and the row says
      // so in words rather than inventing a comparison.
      let weekAgo: number | null = null;
      for (const p of series) {
        const t = Date.parse(`${p.date}T00:00:00Z`);
        if (Number.isFinite(t) && t <= targetMs) weekAgo = p.level;
      }

      rows.push({
        sport: idx.sport,
        latestLevel: idx.latestLevel,
        weekAgoLevel: weekAgo,
        changePct:
          weekAgo !== null && weekAgo > 0
            ? Math.round(((idx.latestLevel - weekAgo) / weekAgo) * 1000) / 10
            : null,
        basketSize: idx.basketSize ?? null,
        asOf: idx.asOf ?? null,
      });
    }
    return rows;
  } catch {
    return null;
  }
}

async function defaultSendEmail(): Promise<SendEmailFn | null> {
  try {
    const mod = await import("../emailService.js");
    return typeof mod.sendEmail === "function" ? mod.sendEmail : null;
  } catch {
    return null;
  }
}

/** Email + verification state for a userId. Null when we have no address,
 *  or the address was never verified — an unverified address is not a
 *  place we mail unsolicited weekly reports to. */
async function defaultResolveEmail(userId: string): Promise<string | null> {
  try {
    const mod = await import("../authService.js");
    if (typeof mod.getAuthUserById !== "function") return null;
    const user = await mod.getAuthUserById(userId);
    if (!user?.email) return null;
    if (user.emailVerified !== true) return null;
    return user.email;
  } catch {
    return null;
  }
}

/** Is ACS actually configured? Distinguishes "we did not send" from "we
 *  could not send", which is the D13 lesson: a zero with no provider is a
 *  defect, a zero with a provider is a quiet week. */
export function isEmailConfigured(): boolean {
  return Boolean(
    (process.env.ACS_EMAIL_CONNECTION_STRING ?? "").trim() &&
      (process.env.EMAIL_FROM_ADDRESS ?? "").trim(),
  );
}

// ── The job ─────────────────────────────────────────────────────────

/**
 * Build one user's digest from their stored doc. Exported so the admin
 * route can preview a single user without running the fanout.
 */
export async function buildDigestForUser(
  userId: string,
  opts: { weekId?: string; now?: Date } = {},
  deps: WeeklyDigestJobDeps = {},
): Promise<WeeklyDigest | null> {
  const now = opts.now ?? new Date();
  const bounds = weekBoundsFor(now, opts.weekId);
  const doc = await readUserDoc(userId);
  const holdings = Object.values(doc.holdings ?? {}) as PortfolioHolding[];

  const loadSignals = deps.loadSignals ?? defaultLoadSignals;
  const loadIndexes = deps.loadSportIndexes ?? defaultLoadSportIndexes;
  const [signals, sportIndexes] = await Promise.all([
    holdings.length > 0 ? loadSignals(holdings) : Promise.resolve(null),
    loadIndexes(),
  ]);

  return buildWeeklyDigest({
    userId,
    weekId: bounds.weekId,
    weekStart: bounds.weekStart,
    weekEnd: bounds.weekEnd,
    holdings,
    priceHistoryByHolding: (doc.priceHistoryByHolding ?? {}) as Record<
      string,
      // CF-A-MOVER-NEEDS-CORROBORATION: rungLabel MUST survive this cast —
      // it is the only evidence the movers gate has. Dropping it here would
      // silently re-open the "every reprice is a sale" bug.
      { at: string; value: number; valuationStatus?: string; rungLabel?: string }[]
    >,
    signals,
    sportIndexes,
    now,
  });
}

/** The week a run covers: `weekId` when given, else the week containing
 *  yesterday — so a Sunday-evening cron reports the week that just ended
 *  rather than the one starting at midnight. */
function weekBoundsFor(now: Date, weekId?: string): { weekId: string; weekStart: string; weekEnd: string } {
  if (weekId) {
    // Rebuild bounds from the id so an explicit re-run of an older week
    // gets that week's dates, not this week's.
    const m = /^(\d{4})-W(\d{2})$/.exec(weekId.trim());
    if (m) {
      const year = Number(m[1]);
      const week = Number(m[2]);
      // ISO: Jan 4 is always in week 1.
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4Day = jan4.getUTCDay() || 7;
      const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
      const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
      const sunday = new Date(monday.getTime() + 6 * 86400000);
      return {
        weekId: weekId.trim(),
        weekStart: monday.toISOString().slice(0, 10),
        weekEnd: sunday.toISOString().slice(0, 10),
      };
    }
  }
  return isoWeekBounds(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

export async function runWeeklyDigestJob(
  opts: WeeklyDigestJobOptions = {},
  deps: WeeklyDigestJobDeps = {},
): Promise<WeeklyDigestJobSummary> {
  const now = opts.now ?? new Date();
  const bounds = weekBoundsFor(now, opts.weekId);
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;

  const summary: WeeklyDigestJobSummary = {
    weekId: bounds.weekId,
    usersScanned: 0,
    digestsBuilt: 0,
    digestsPersisted: 0,
    emailsSent: 0,
    skipped: {
      noHoldings: 0,
      alreadyDelivered: 0,
      noEmailOnFile: 0,
      emailNotConfigured: 0,
      sendFailed: 0,
      readFailed: 0,
    },
    signalsSurfaceAvailable: false,
    marketSurfaceAvailable: false,
    emailConfigured: isEmailConfigured(),
    dryRun,
  };

  const loadSignals = deps.loadSignals ?? defaultLoadSignals;
  const loadIndexes = deps.loadSportIndexes ?? defaultLoadSportIndexes;
  const resolveEmail = deps.resolveEmail ?? defaultResolveEmail;
  const sendEmail = deps.sendEmail === undefined ? await defaultSendEmail() : deps.sendEmail;

  // The index is portfolio-independent: read it ONCE for the whole run
  // rather than per user. Five sports x N users of identical reads would
  // be the same answer N times at N times the RU.
  const sportIndexes = await loadIndexes();
  summary.marketSurfaceAvailable = Array.isArray(sportIndexes);

  const userIds = opts.userId
    ? [opts.userId]
    : (await listAllPortfolioUserIds()).slice(0, opts.maxUsers ?? Number.MAX_SAFE_INTEGER);

  for (const userId of userIds) {
    summary.usersScanned++;

    let doc;
    try {
      doc = await readUserDoc(userId);
    } catch {
      summary.skipped.readFailed++;
      continue;
    }
    const holdings = Object.values(doc.holdings ?? {}) as PortfolioHolding[];
    if (holdings.length === 0) {
      summary.skipped.noHoldings++;
      continue;
    }

    const signals = await loadSignals(holdings);
    if (Array.isArray(signals)) summary.signalsSurfaceAvailable = true;

    const digest = buildWeeklyDigest({
      userId,
      weekId: bounds.weekId,
      weekStart: bounds.weekStart,
      weekEnd: bounds.weekEnd,
      holdings,
      priceHistoryByHolding: (doc.priceHistoryByHolding ?? {}) as Record<
        string,
        // CF-A-MOVER-NEEDS-CORROBORATION: rungLabel must survive this cast too.
        { at: string; value: number; valuationStatus?: string; rungLabel?: string }[]
      >,
      signals,
      sportIndexes,
      now,
    });
    summary.digestsBuilt++;

    // Persist FIRST. The in-app view is the delivery floor — a digest
    // that was built but could not be mailed must still be readable.
    if (!dryRun) {
      const persisted = await upsertWeeklyDigest(digest);
      if (persisted) summary.digestsPersisted++;
    }

    if (dryRun) continue;

    // Idempotence gate: a week already delivered is not re-sent.
    if (!force) {
      const existing = await readWeeklyDigest(userId, bounds.weekId);
      if (existing?.deliveredAt) {
        summary.skipped.alreadyDelivered++;
        continue;
      }
    }

    if (!summary.emailConfigured || !sendEmail) {
      summary.skipped.emailNotConfigured++;
      await markWeeklyDigestDelivery(userId, bounds.weekId, {
        delivered: false,
        reason: "acs-unconfigured",
      });
      continue;
    }

    const to = await resolveEmail(userId);
    if (!to) {
      summary.skipped.noEmailOnFile++;
      await markWeeklyDigestDelivery(userId, bounds.weekId, {
        delivered: false,
        reason: "no-verified-email",
      });
      continue;
    }

    const content = renderWeeklyDigestEmail(digest);
    let result: SendEmailResult | null = null;
    try {
      result = await sendEmail({ to, ...content });
    } catch {
      result = null;
    }

    if (result?.delivered === true) {
      summary.emailsSent++;
      await markWeeklyDigestDelivery(userId, bounds.weekId, { delivered: true, channel: "email" });
    } else {
      summary.skipped.sendFailed++;
      await markWeeklyDigestDelivery(userId, bounds.weekId, {
        delivered: false,
        // The address is NEVER part of the reason. [[secrets-never-to-stdout]]
        // is about secrets; this is the same instinct about PII.
        reason: result?.devLogged ? "acs-unconfigured" : result?.error || "email-provider-failed",
      });
    }
  }

  // One summary line, always — the workflow greps this.
  console.log(JSON.stringify({
    event: "weekly_digest_run",
    weekId: summary.weekId,
    usersScanned: summary.usersScanned,
    digestsBuilt: summary.digestsBuilt,
    digestsPersisted: summary.digestsPersisted,
    emailsSent: summary.emailsSent,
    signalsSurfaceAvailable: summary.signalsSurfaceAvailable,
    marketSurfaceAvailable: summary.marketSurfaceAvailable,
    emailConfigured: summary.emailConfigured,
    dryRun: summary.dryRun,
  }));

  return summary;
}
