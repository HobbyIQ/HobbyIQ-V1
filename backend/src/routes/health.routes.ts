import { Router } from "express";
import {
  getBuildInfo,
  getBuildInfoSource,
  getDeployedAt,
  getGitBranch,
  getGitSha,
  getGitShaShort,
} from "../services/ops/buildInfo.js";
// CF-HEALTH-DEEP-P1 (Drew, 2026-07-26). /api/health/deep probes actual
// downstream dependencies (Cosmos reachability + critical envs). The
// shallow /api/health above just says "process is alive" — deep says
// "process is READY to serve traffic". Ops-monitoring should hit deep
// for meaningful alarms; App Service liveness stays on shallow so a
// dep blip doesn't kill the container.
import { getPortfolioContainer } from "../services/portfolioiq/portfolioStore.service.js";

const router = Router();

const PROBE_TIMEOUT_MS = 3_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function probeCosmos(): Promise<{ status: "ok" | "degraded" | "down"; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const container = await withTimeout(getPortfolioContainer(), PROBE_TIMEOUT_MS);
    if (!container) {
      return { status: "down", latencyMs: Date.now() - t0, error: "container unavailable" };
    }
    // Cheapest reachability signal: point-read on a synthetic id.
    // Cosmos returns 404 quickly (single RU); anything else is degradation.
    try {
      await withTimeout(
        container.item("__healthprobe__", "__healthprobe__").read(),
        PROBE_TIMEOUT_MS,
      );
    } catch (err: any) {
      if (err?.code === 404 || err?.statusCode === 404) {
        return { status: "ok", latencyMs: Date.now() - t0 };
      }
      throw err;
    }
    return { status: "ok", latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return {
      status: "down",
      latencyMs: Date.now() - t0,
      error: err?.message ?? String(err),
    };
  }
}

// ── Build identity ────────────────────────────────────────────
//
// CF-DEPLOY-SCRIPT-RESTART-FIX introduced dist/build-info.json, written by
// scripts/write-build-info.cjs during `npm run build`, so the SHA ships inside
// the deployed package.
//
// CF-DEPLOY-RESTARTS-ONCE (2026-09-07) moved the read into
// services/ops/buildInfo, because /api/health is no longer the only consumer:
// engineMeta (engineVersion on every pricing response) and workerLifecycle
// (gitSha on worker_shutdown) read the same identity, and all three must agree
// now that the GIT_SHA* App Settings are no longer written after each deploy.
// That appsettings write was a config/write, which recycles every worker — the
// second of the two restarts per deploy behind #1977's ten-minute mean process
// lifetime.
const BUILD_INFO = getBuildInfo();

router.get(["/", ""], (req, res) => {
  res.json({
    ok: true,
    status: "ok",
    service: "HobbyIQ API",
    brand: "HobbyIQ",
    port: Number(process.env.PORT || 8080),
    environment: process.env.NODE_ENV || "production",
    timestamp: new Date().toISOString(),
    services: {
      cosmos: !!process.env.COSMOS_ENDPOINT ? "configured" : "fallback",
      redis: !!process.env.REDIS_HOST ? "configured" : "fallback",
      appInsights: !!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ? "active" : "off",
    },
    // Build metadata. Response SHAPE is unchanged — `build.shaShort` is
    // greped by the deploy verification in .github/workflows/deploy-worker.yml
    // and must keep existing. What changed is where it READS FROM.
    //
    // CF-DEPLOY-RESTARTS-ONCE (2026-09-07). The artifact is now the primary
    // source and the env vars are the fallback, so that the GIT_SHA* App
    // Settings no longer have to be written after every deploy. That write
    // was a config/write, and a config/write recycles every worker: it was
    // the second of the two restarts per deploy that #1977 traced to a
    // ten-minute mean process lifetime in production.
    //
    // dist/build-info.json is baked by scripts/write-build-info.cjs at
    // `npm run build`, so it ships inside the package. Preferring it is not
    // merely equivalent to the env vars, it is strictly more truthful: a file
    // inside dist/ CANNOT report a SHA unless the dist carrying it is the dist
    // the process actually loaded. The env-var quad could — that is precisely
    // how the 3-for-3 silent old-dist deploys passed shaShort verification
    // while serving stale code.
    //
    // Env fallback is retained for any container started outside the build
    // chain (no build-info.json present), and deployedAt still reads DEPLOYED_AT
    // with the artifact's build time as its fallback.
    //
    // shaFromCode* / branchFromCode / builtAt stay as explicit artifact-only
    // fields — existing consumers (the deploy script's [5/5] dist-swap poll)
    // read them and must not change meaning.
    build: {
      sha: getGitSha() ?? "unknown",
      shaShort: getGitShaShort() ?? "unknown",
      branch: getGitBranch() ?? "unknown",
      deployedAt: getDeployedAt() ?? "unknown",
      // Source of the three fields above, so an operator can tell at a glance
      // whether they came from the deployed artifact or from stale env vars.
      shaSource: getBuildInfoSource(),
      // CF-DEPLOY-SCRIPT-RESTART-FIX additions:
      shaFromCode: BUILD_INFO?.sha ?? null,
      shaFromCodeShort: BUILD_INFO?.shaShort ?? null,
      branchFromCode: BUILD_INFO?.branch ?? null,
      builtAt: BUILD_INFO?.builtAt ?? null,
    },
  });
});

// CF-HEALTH-DEEP-P1 (Drew, 2026-07-26). Readiness probe. Returns 200
// when the process is ready to serve production traffic (Cosmos
// reachable + all critical envs set); 503 when a critical dependency
// is down or missing. Intended for ops-monitoring dashboards, NOT for
// App Service liveness (that stays on shallow /api/health — a transient
// Cosmos blip should not cause App Service to kill and restart the
// container, which would just move the failure without fixing it).
router.get("/deep", async (_req, res) => {
  const t0 = Date.now();

  const [cosmos] = await Promise.all([probeCosmos()]);

  const criticalEnvsMissing: string[] = [];
  if (!process.env.COSMOS_CONNECTION_STRING && !process.env.COSMOS_ENDPOINT) {
    criticalEnvsMissing.push("COSMOS_CONNECTION_STRING/COSMOS_ENDPOINT");
  }
  if (!process.env.AUTH_SESSION_SECRET) {
    criticalEnvsMissing.push("AUTH_SESSION_SECRET");
  }
  if (!process.env.CARD_HEDGE_API_KEY) {
    criticalEnvsMissing.push("CARD_HEDGE_API_KEY");
  }

  const recommendedEnvsMissing: string[] = [];
  if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    recommendedEnvsMissing.push("APPLICATIONINSIGHTS_CONNECTION_STRING");
  }
  if (!process.env.CARDSIGHT_API_KEY) {
    recommendedEnvsMissing.push("CARDSIGHT_API_KEY");
  }

  const ok = cosmos.status === "ok" && criticalEnvsMissing.length === 0;
  const status = ok
    ? "healthy"
    : cosmos.status === "down" || criticalEnvsMissing.length > 0
      ? "down"
      : "degraded";

  const body = {
    ok,
    status,
    uptimeSec: Math.floor(process.uptime()),
    totalLatencyMs: Date.now() - t0,
    timestamp: new Date().toISOString(),
    build: {
      // CF-DEPLOY-RESTARTS-ONCE: artifact first, env fallback — same rule as
      // the shallow probe above.
      shaShort: getGitShaShort() ?? "unknown",
      shaFromCodeShort: BUILD_INFO?.shaShort ?? null,
    },
    checks: {
      cosmos,
      config: {
        status: criticalEnvsMissing.length === 0 ? "ok" : "down",
        criticalEnvsMissing,
        recommendedEnvsMissing,
      },
    },
  };

  res.status(ok ? 200 : 503).json(body);
});

export default router;
