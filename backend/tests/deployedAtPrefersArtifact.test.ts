/**
 * CF-DEPLOYEDAT-WAS-PINNED-TO-A-RETIRED-APP-SETTING (Fable, 2026-09-16).
 *
 * THE DEFECT. Production `/api/health` reported, on 2026-09-15:
 *
 *   sha         31f1829…            a 2026-09-15 build
 *   builtAt     2026-09-15T14:28:28Z  correct, stamped into the dist
 *   deployedAt  2026-09-07T18:54:13Z  EIGHT DAYS STALE
 *
 * `getDeployedAt()` read `DEPLOYED_AT` first and the artifact's `builtAt`
 * second. `DEPLOYED_AT` was part of the GIT_SHA/GIT_SHA_SHORT/GIT_BRANCH/
 * DEPLOYED_AT quad written by a workflow step that CF-DEPLOY-RESTARTS-ONCE
 * removed on 2026-09-07 — because the `az webapp config appsettings set` it ran
 * was the second restart of every deploy.
 *
 * The step went. The SETTINGS stayed. Verified on prod: all four are still
 * present, so `DEPLOYED_AT` is frozen at the instant of its last write and
 * shadows a `builtAt` that was correct all along.
 *
 * This is the same failure the SHA fields were already moved off env for, and
 * why `getGitSha` reads the artifact first: a value that cannot be refreshed is
 * worse than one that is merely approximate, because it looks authoritative
 * while being wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ARTIFACT_BUILT_AT = "2026-09-15T14:28:28.142Z";
const STALE_ENV = "2026-09-07T18:54:13Z";

/** A valid artifact. `loadBuildInfo` REQUIRES both `sha` and `shaShort` to be
 *  strings and returns null otherwise — a fixture missing either one silently
 *  exercises the no-artifact path instead of the one under test. */
const ARTIFACT = {
  sha: "31f1829569d0989ae1cba556dce5fa2b1f7b5bfe",
  shaShort: "31f1829",
  branch: "main",
  builtAt: ARTIFACT_BUILT_AT,
};

/** Load buildInfo with a controlled artifact, as a deployed container has. */
async function loadWithArtifact(artifact: Record<string, unknown> | null) {
  vi.resetModules();
  // The module under test imports from "fs", not "node:fs" — the mock must
  // use the SAME specifier or it silently does nothing and BUILD_INFO stays null.
  vi.doMock("fs", async (importActual) => {
    const actual = (await importActual()) as Record<string, unknown> & {
      readFileSync: (...a: unknown[]) => unknown;
      existsSync: (...a: unknown[]) => boolean;
    };
    return {
      ...actual,
      default: actual,
      existsSync: (p: unknown) =>
        String(p).includes("build-info.json") ? artifact !== null : actual.existsSync(p),
      readFileSync: (p: unknown, ...rest: unknown[]) =>
        String(p).includes("build-info.json") && artifact !== null
          ? JSON.stringify(artifact)
          : actual.readFileSync(p, ...rest),
    };
  });
  return import("../src/services/ops/buildInfo.js");
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.doUnmock("fs"); vi.unstubAllEnvs(); vi.resetModules(); });

describe("deployedAt comes from the artifact, not a retired app setting", () => {
  it("prefers builtAt even when a STALE DEPLOYED_AT is set", async () => {
    vi.stubEnv("DEPLOYED_AT", STALE_ENV);
    const m = await loadWithArtifact(ARTIFACT);

    // MUTATION CHECK: with the old `env ?? artifact` order this returned the
    // 09-07 value — the exact eight-day-stale reading prod was serving.
    expect(m.getDeployedAt()).toBe(ARTIFACT_BUILT_AT);
    expect(m.getDeployedAt()).not.toBe(STALE_ENV);
  });

  it("still falls back to DEPLOYED_AT when there is no artifact", async () => {
    vi.stubEnv("DEPLOYED_AT", STALE_ENV);
    const m = await loadWithArtifact(null);

    // A build with no dist/build-info.json (a dev shell, an old package) keeps
    // whatever the env can tell it. The fix changes precedence, not support —
    // removing the fallback would make this field simply absent there.
    expect(m.getDeployedAt()).toBe(STALE_ENV);
  });

  it("is undefined when neither source has anything", async () => {
    vi.stubEnv("DEPLOYED_AT", "");
    const m = await loadWithArtifact(null);

    // The route renders this as "unknown". Honest absence beats a guess.
    expect(m.getDeployedAt()).toBeUndefined();
  });

  it("matches the artifact-first rule the SHA fields already use", async () => {
    vi.stubEnv("DEPLOYED_AT", STALE_ENV);
    vi.stubEnv("GIT_SHA", "0000000000000000000000000000000000000000");
    const m = await loadWithArtifact(ARTIFACT);

    // One rule for every build field: the package is the authority, env is the
    // fallback. A reader should not have to remember which fields invert it.
    expect(m.getGitSha()).toBe("31f1829569d0989ae1cba556dce5fa2b1f7b5bfe");
    expect(m.getDeployedAt()).toBe(ARTIFACT_BUILT_AT);
  });
});

describe("the artifact is stamped at build time", () => {
  it("write-build-info.cjs stamps builtAt itself — no workflow input needed", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../scripts/write-build-info.cjs", import.meta.url), "utf8",
    );

    // This is why the fix is one line of precedence and NOT a workflow change:
    // the build already records its own timestamp, into the package that ships.
    // It cannot go stale without the dist itself being stale, which is exactly
    // what this field should surface.
    expect(src).toMatch(/builtAt:\s*new Date\(\)\.toISOString\(\)/);
  });
});
