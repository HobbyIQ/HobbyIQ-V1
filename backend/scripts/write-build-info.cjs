// CF-DEPLOY-SCRIPT-RESTART-FIX — postbuild script.
//
// Writes dist/build-info.json with the current git SHA + build timestamp.
// Backend reads this file at module load to expose a code-baked shaFromCode
// field on /api/health, distinct from the env-var-derived build.shaShort.
//
// The deploy script's [5/5] verification polls shaFromCode to detect TRUE
// dist-swap (env-var SHA can match while old dist is still serving — that
// was the root cause of the 3-for-3 silent old-dist deploys this session).
//
// Invoked via `npm run build` chain (tsc emits dist/, this script appends
// build-info.json). Idempotent + safe to run repeatedly.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function readGitSha() {
  // Prefer env var if set (deploy-script context). Falls through to git
  // command for local dev / CI without explicit env wiring.
  const env = process.env.GIT_SHA;
  if (env && env.trim()) return env.trim();
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function readGitShaShort() {
  const env = process.env.GIT_SHA_SHORT;
  if (env && env.trim()) return env.trim();
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function readGitBranch() {
  const env = process.env.GIT_BRANCH;
  if (env && env.trim()) return env.trim();
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

const distDir = path.resolve(__dirname, "..", "dist");
if (!fs.existsSync(distDir)) {
  console.error(`[write-build-info] dist/ does not exist at ${distDir}. Run tsc first.`);
  process.exit(1);
}

const buildInfo = {
  sha: readGitSha(),
  shaShort: readGitShaShort(),
  branch: readGitBranch(),
  builtAt: new Date().toISOString(),
};

const out = path.join(distDir, "build-info.json");
fs.writeFileSync(out, JSON.stringify(buildInfo, null, 2) + "\n");
console.log(`[write-build-info] wrote ${out} sha=${buildInfo.shaShort} branch=${buildInfo.branch}`);
