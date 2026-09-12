// CF-MARKET-MOVERS-PERSISTED-SNAPSHOT (Fable, 2026-09-12).
//
// Admin-token-gated dispatch + poll surface for refreshing every scheduled
// market-movers snapshot shape (see marketMoversSnapshot.service.ts). The
// refresh walks sold_comps with a raw cross-partition scan per shape — the
// same query the public /market-movers route falls back to on a cold
// shape — and under fleet load that can comfortably exceed the App
// Service front end's 240s idle cut (see longJobTracker.ts's own case
// studies: dailyiq/brief, personal-prospect-breakout, cleanliness
// anomalies all hit exactly this wall). So this dispatches (202 + jobId)
// and the caller (backend/scripts/poll-admin-job.cjs, from the "Daily
// Market Signals Refresh" workflow) polls to completion instead of
// holding one HTTP response open — same pattern as
// POST /api/cleanliness/anomalies?force=true.
import { Router, type Request, type Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import * as longJobs from "../services/ops/longJobTracker.js";
import { refreshAllScheduledSnapshots } from "../services/compiq/marketMoversSnapshot.service.js";

type RefreshResult = Awaited<ReturnType<typeof refreshAllScheduledSnapshots>>;

// One refresh at a time, process-wide: the scheduled shapes are the same
// list every time, so a second dispatch must adopt the run in flight
// rather than start a rival walk of the same shapes.
const SNAPSHOT_JOB_KIND = "market-movers-snapshot-refresh";
const SNAPSHOT_JOB_KEY = "all-scheduled-shapes";

const router = Router();
// CF-ADMIN-GATE-SCOPE (mirrors cleanliness.routes.ts:21-29). MUST stay
// path-scoped — this router is mounted at the bare "/api" in app.ts, so an
// unscoped router.use(requireAdmin) would 401/503 every OTHER route
// mounted after it.
router.use("/admin/market-movers", requireAdmin);

// POST /api/admin/market-movers/refresh-snapshots — dispatches the refresh
// of every scheduled shape and returns immediately with a jobId.
router.post("/admin/market-movers/refresh-snapshots", (_req: Request, res: Response) => {
  const { job, alreadyRunning } = longJobs.dispatch<RefreshResult>(
    SNAPSHOT_JOB_KIND,
    SNAPSHOT_JOB_KEY,
    () => refreshAllScheduledSnapshots(),
  );
  res.status(202).json({
    success: true,
    accepted: true,
    status: "running",
    alreadyRunning,
    jobId: job.jobId,
    startedAt: new Date(job.startedAt).toISOString(),
    poll: "/api/admin/market-movers/refresh-snapshots/status",
  });
});

// Poll surface. A worker that never issued the id answers `unknown-here`
// (never `idle`, never a settled verdict) — with 2 serving instances,
// roughly half of all polls land on the other worker.
router.get("/admin/market-movers/refresh-snapshots/status", (req: Request, res: Response) => {
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : null;
  const lookup = longJobs.lookupJob<RefreshResult>(SNAPSHOT_JOB_KIND, SNAPSHOT_JOB_KEY, jobId);
  const payload = longJobs.buildStatusPayload(lookup);
  res.json({ success: true, ...payload });
});

export default router;
