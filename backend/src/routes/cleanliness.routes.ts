// CF-CLEANLINESS-ROUTES (Drew, 2026-08-01). Admin endpoint that returns
// the cleanliness report. Backs the /app/admin/cleanliness dashboard.

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { computeCleanlinessReport } from "../services/portfolioiq/cleanliness.service.js";
import { computeBadActorReport } from "../services/portfolioiq/badActorDetection.service.js";
import * as longJobs from "../services/ops/longJobTracker.js";
import type { AnomalyReport } from "../services/portfolioiq/anomalyDetection.service.js";

/** detectAnomalies resolves null when no baseline snapshot exists yet. */
type AnomalyReportResult = AnomalyReport | null;

// One rescan at a time, process-wide: the scan is global (it walks the whole
// baseline), so a second dispatch must adopt the run in flight rather than
// start a rival walk of the same rows.
const ANOMALY_JOB_KIND = "cleanliness-anomalies";
const ANOMALY_JOB_KEY = "global";

const router = Router();
// CF-ADMIN-GATE-SCOPE (Drew, 2026-08-12). MUST stay path-scoped. This
// router is mounted at the bare "/api" in app.ts, so an unscoped
// router.use(requireAdmin) runs for EVERY /api/* request that reaches
// it — and requireAdmin ends the response instead of calling next(),
// so every route mounted after it in app.ts became unreachable
// (401 "Invalid admin token" in prod, 503 in CI where the token is
// unset). That shadowed /api/account, /api/entitlements,
// /api/subscriptions and /api/reference from 2026-07-31 until this fix.
router.use("/cleanliness", requireAdmin);

router.get("/cleanliness/report", async (_req, res, next) => {
  try {
    const report = await computeCleanlinessReport(false);
    if (!report) {
      res.status(503).json({ success: false, error: "Cosmos not configured" });
      return;
    }
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

router.post("/cleanliness/refresh", async (_req, res, next) => {
  try {
    const report = await computeCleanlinessReport(true);
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

router.get("/cleanliness/bad-actors", async (req, res, next) => {
  try {
    const force = req.query.force === "true";
    const report = await computeBadActorReport(force);
    if (!report) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

router.get("/cleanliness/learning", async (_req, res, next) => {
  try {
    const { summarizeLearning } = await import("../services/portfolioiq/learningEvents.service.js");
    const summary = await summarizeLearning();
    if (!summary) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, summary });
  } catch (err) { next(err); }
});

router.post("/cleanliness/train-weights", async (req, res, next) => {
  try {
    const { trainConfidenceWeights } = await import("../services/portfolioiq/confidenceWeightsLearner.service.js");
    const fromDaysBack = req.query.days ? Number(req.query.days) : 30;
    const learned = await trainConfidenceWeights({ fromDaysBack });
    if (!learned) { res.json({ success: true, message: "not enough training data yet — try again after more human decisions have accumulated" }); return; }
    res.json({ success: true, learned });
  } catch (err) { next(err); }
});

router.get("/cleanliness/current-weights", async (_req, res, next) => {
  try {
    const { loadCurrentWeights } = await import("../services/portfolioiq/confidenceWeightsLearner.service.js");
    const w = await loadCurrentWeights();
    res.json({ success: true, weights: w });
  } catch (err) { next(err); }
});

router.get("/cleanliness/slug-audit", async (req, res, next) => {
  try {
    const { computeSlugAuditReport } = await import("../services/portfolioiq/slugAudit.service.js");
    const force = req.query.force === "true";
    const report = await computeSlugAuditReport(force);
    if (!report) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

router.get("/cleanliness/fmv-accuracy", async (_req, res, next) => {
  try {
    const { computeFmvAccuracySummary } = await import("../services/portfolioiq/fmvAccuracy.service.js");
    const summary = await computeFmvAccuracySummary();
    if (!summary) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, summary });
  } catch (err) { next(err); }
});

// CF-LONG-CRONS-DIE-AT-THE-IDLE-CUT (2026-09-09). ?force=true is a full
// rescan, and it never once answered the nightly cron: App Insights shows 11
// requests to this path over 14 days, ALL ResultCode 0, every one cut at
// 89.9s. #1985 read that as a client budget and raised the curl ceiling to
// 900s — but the App Service front end cuts an idle connection at 240s no
// matter what the client is willing to wait, so the lane would simply have
// started dying at 240 instead of 90. The scan itself completes server-side;
// nobody was left holding the socket to receive it.
//
// So a forced rescan is now a DISPATCH: 202 + jobId, and the caller polls
// /cleanliness/anomalies/status. The cached read below is untouched — the
// admin dashboard (adminApi.fetchAnomalies) never passes force, answers off
// the 5-minute cache, and must keep returning the report inline.
router.get("/cleanliness/anomalies", async (req, res, next) => {
  try {
    const { detectAnomalies } = await import("../services/portfolioiq/anomalyDetection.service.js");
    const force = req.query.force === "true";
    if (force) {
      const { job, alreadyRunning } = longJobs.dispatch(ANOMALY_JOB_KIND, ANOMALY_JOB_KEY, () =>
        detectAnomalies({ force: true }),
      );
      res.status(202).json({
        success: true,
        accepted: true,
        status: "running",
        alreadyRunning,
        jobId: job.jobId,
        startedAt: new Date(job.startedAt).toISOString(),
        poll: "/api/cleanliness/anomalies/status",
      });
      return;
    }
    const report = await detectAnomalies({ force });
    if (!report) { res.status(503).json({ success: false, error: "no baseline snapshot yet — run baseline-pool-snapshot first" }); return; }
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

// Poll surface for the dispatched rescan. A worker that never issued the id
// answers `unknown-here` (never `idle`, never a settled verdict) — with 2
// serving instances, roughly half of all polls land on the other worker.
router.get("/cleanliness/anomalies/status", async (req, res, next) => {
  try {
    const jobId = typeof req.query.jobId === "string" ? req.query.jobId : null;
    const lookup = longJobs.lookupJob<AnomalyReportResult>(
      ANOMALY_JOB_KIND,
      ANOMALY_JOB_KEY,
      jobId,
    );
    const payload = longJobs.buildStatusPayload(lookup);
    // A finished scan that found no baseline is a real answer, not a
    // failure to answer: report it as such so the lane's banner can say
    // which of the two it saw.
    if (payload.status === "done") {
      const { result, ...rest } = payload as Record<string, unknown>;
      if (result === null) {
        res.json({
          success: true,
          ...rest,
          report: null,
          error: "no baseline snapshot yet — run baseline-pool-snapshot first",
        });
        return;
      }
      res.json({ success: true, ...rest, report: result });
      return;
    }
    res.json({ success: true, ...payload });
  } catch (err) { next(err); }
});

export default router;
