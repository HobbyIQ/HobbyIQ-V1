// CF-DEPLOY-RESTARTS-ONCE (2026-09-07). One reader for the deployed build's
// identity, so every consumer agrees and none of them depends on App Settings.
//
// WHY THIS EXISTS. The GIT_SHA / GIT_SHA_SHORT / GIT_BRANCH / DEPLOYED_AT quad
// used to be written by an `az webapp config appsettings set` step at the end
// of every deploy. That write is a config/write, and a config/write recycles
// every worker — it was the SECOND of the two restarts per deploy that #1977
// traced to a ~10 minute mean process lifetime, which in turn meant no long
// setInterval had ever fired in production. Removing that step is the fix, but
// it leaves the env vars permanently unset, and three places read them:
//
//   routes/health.routes.ts        build.sha/shaShort/branch on /api/health
//   services/compiq/engineMeta.ts  engineVersion on EVERY pricing response
//   services/ops/workerLifecycle.ts  gitSha on the worker_shutdown event
//
// All three now resolve through here: the deployed artifact first, the env vars
// second. scripts/write-build-info.cjs writes dist/build-info.json during
// `npm run build`, so the SHA ships inside the package.
//
// This is strictly MORE truthful than the env vars were. A file inside dist/
// cannot report a SHA unless the dist carrying it is the dist the process
// actually loaded; an App Setting can be updated while the old dist keeps
// serving, which is exactly how the 3-for-3 silent old-dist deploys passed
// their shaShort verification.

import { readFileSync } from "fs";
import { resolve } from "path";

export interface BuildInfo {
  sha: string;
  shaShort: string;
  branch: string;
  builtAt: string;
}

/**
 * Read once at module load and cache. build-info.json is baked into the
 * artifact and cannot change while the process lives, so re-reading it per
 * request would be pure syscall overhead.
 *
 * Resolution: dist/services/ops/buildInfo.js -> ../../build-info.json is
 * dist/build-info.json. Under vitest the same relative walk lands on
 * src/build-info.json, which does not exist, so tests get null and the env
 * fallback — the intended behaviour, not an accident.
 */
function loadBuildInfo(): BuildInfo | null {
  try {
    const raw = readFileSync(
      resolve(__dirname, "..", "..", "build-info.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.sha === "string" &&
      typeof parsed.shaShort === "string"
    ) {
      return parsed as BuildInfo;
    }
    return null;
  } catch {
    return null;
  }
}

const BUILD_INFO: BuildInfo | null = loadBuildInfo();

/** The parsed artifact build-info, or null when it is not present. */
export function getBuildInfo(): BuildInfo | null {
  return BUILD_INFO;
}

function envOrUndefined(name: string): string | undefined {
  const v = (process.env[name] ?? "").trim();
  return v === "" ? undefined : v;
}

/** Full 40-char SHA of the deployed build. Artifact first, env fallback. */
export function getGitSha(): string | undefined {
  return BUILD_INFO?.sha ?? envOrUndefined("GIT_SHA");
}

/** Short SHA of the deployed build. Artifact first, env fallback. */
export function getGitShaShort(): string | undefined {
  return BUILD_INFO?.shaShort ?? envOrUndefined("GIT_SHA_SHORT");
}

/** Branch the deployed build came from. Artifact first, env fallback. */
export function getGitBranch(): string | undefined {
  return BUILD_INFO?.branch ?? envOrUndefined("GIT_BRANCH");
}

/**
 * When the running build was deployed.
 *
 * CF-DEPLOYEDAT-WAS-PINNED-TO-A-RETIRED-APP-SETTING (Fable, 2026-09-16).
 *
 * This preferred the DEPLOYED_AT env var, on the reasoning that "if an
 * operator-initiated deploy did set DEPLOYED_AT, that is closer to 'deployed'
 * than the build timestamp." That reasoning was sound while something still
 * wrote it. Nothing has since 2026-09-07, when CF-DEPLOY-RESTARTS-ONCE removed
 * the "Update build metadata App Settings" step because the
 * `az webapp config appsettings set` it ran was the SECOND restart of every
 * deploy (see docs/reports/2026-09-07-app-service-recycles-and-telemetry-loss).
 *
 * The step went; the SETTINGS stayed. Measured on prod, 2026-09-15:
 *
 *   GIT_SHA, GIT_SHA_SHORT, GIT_BRANCH, DEPLOYED_AT   still present
 *   /api/health -> deployedAt  2026-09-07T18:54:13Z   <- frozen, the last write
 *                  builtAt     2026-09-15T14:28:28Z   <- correct, from the dist
 *                  sha         31f1829 (a 09-15 build)
 *
 * So a fresh build reported a deploy date eight days stale, and every other
 * build field was right — the artifact already carried the truth and the env
 * var was shadowing it. That is the same failure the SHA fields were moved off
 * env for, and the reason `getGitSha` reads the artifact FIRST: a value that
 * cannot be refreshed is worse than one that is merely approximate, because it
 * looks authoritative while being wrong.
 *
 * Artifact first now, for the same reason. `builtAt` is stamped by
 * scripts/write-build-info.cjs at build time and ships inside the package, so
 * it cannot be stale without the dist itself being stale — which is precisely
 * what one wants this field to detect. DEPLOYED_AT survives only as a fallback
 * for a build with no artifact, and for the day someone starts writing it
 * again on purpose.
 *
 * This deliberately does NOT delete the stale app settings: that is a live
 * production config change and belongs to Drew, not to a code path. Once the
 * artifact is preferred, the leftovers are inert.
 */
export function getDeployedAt(): string | undefined {
  return BUILD_INFO?.builtAt ?? envOrUndefined("DEPLOYED_AT");
}

/** Where the identity above came from — for operator-facing surfaces. */
export function getBuildInfoSource(): "build-info" | "env" {
  return BUILD_INFO ? "build-info" : "env";
}
