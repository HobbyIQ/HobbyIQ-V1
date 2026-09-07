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
 * When the running build was deployed. DEPLOYED_AT was part of the App Settings
 * quad that is no longer written, so the artifact's build time is the fallback.
 * (Env first here, unlike the SHA: if an operator-initiated deploy did set
 * DEPLOYED_AT, that is closer to "deployed" than the build timestamp.)
 */
export function getDeployedAt(): string | undefined {
  return envOrUndefined("DEPLOYED_AT") ?? BUILD_INFO?.builtAt;
}

/** Where the identity above came from — for operator-facing surfaces. */
export function getBuildInfoSource(): "build-info" | "env" {
  return BUILD_INFO ? "build-info" : "env";
}
