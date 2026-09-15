/**
 * CF-NEVER-HARDCODE-A-SLOT-HOST (Fable, 2026-09-15).
 *
 * THE INCIDENT. The first staging-slot deploy (run 34986071521) polled
 * `https://hobbyiq3-staging.azurewebsites.net` and got connection failure (000)
 * forty times, then correctly refused to swap. But it refused for a WORKFLOW
 * BUG, not a bad build: that hostname does not exist. An App Service slot
 * carries the same unique suffix production does, so the real host is
 * `hobbyiq3-staging-aebjecgpd7bvbshq.centralus-01.azurewebsites.net` — a suffix
 * nobody can guess and nobody should be typing.
 *
 * A gate that fails for its own reasons is the most expensive kind of false
 * negative: it looks exactly like the build being broken, and the honest
 * response (investigate the build) is wasted effort.
 *
 * These pins hold the fix. The workflow is shell inside YAML, which no
 * compiler checks, so this file is the only thing standing between a typo and
 * a red deploy — which is precisely why the bug reached a run in the first
 * place.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/daily-refresh.yml", import.meta.url));
const yml = readFileSync(WORKFLOW, "utf8");
/** Comments explain the bug by name; only executable lines are the subject. */
const shell = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("no App Service hostname is hardcoded in the deploy path", () => {
  it("never references the non-existent bare slot host", () => {
    // MUTATION CHECK: this exact string is what cost run 34986071521.
    expect(shell).not.toContain("hobbyiq3-staging.azurewebsites.net");
  });

  it("resolves BOTH hosts from Azure", () => {
    // `defaultHostName` is the authority. Reading it means the suffix is never
    // written down, so it can never drift or be mistyped.
    const resolves = shell.match(/az webapp show .*--query defaultHostName/g) ?? [];
    expect(resolves.length).toBeGreaterThanOrEqual(2);
    // One of them must ask for the slot specifically.
    expect(shell).toMatch(/az webapp show[^\n]*--slot staging[^\n]*defaultHostName/);
  });

  it("refuses when the slot host equals production's", () => {
    // If `--slot` were ignored, both lookups return the same host — and the
    // deploy would then warm and smoke PRODUCTION while calling it "the slot",
    // and swap an unverified build. Failing closed is the only safe answer.
    expect(shell).toMatch(/SLOT_HOST"?\s*=\s*"?\$PROD_HOST/);
    expect(shell).toMatch(/slot host equals production host/);
  });

  it("uses the resolved hosts for the warm, the smoke and the verify", () => {
    // The three places that must target the slot (or production) by resolved
    // name rather than by a literal.
    expect(shell).toMatch(/SLOT="\$\{\{ steps\.hosts\.outputs\.slot \}\}"/);
    expect(shell).toMatch(/SMOKE_BASE_URL:\s*\$\{\{ steps\.hosts\.outputs\.slot \}\}/);
    expect(shell).toMatch(/PROD="\$\{\{ steps\.hosts\.outputs\.prod \}\}"/);
  });
});

describe("the deploy targets the slot, and the gate still gates", () => {
  it("deploys with slot-name: staging", () => {
    // Confirmed against run 34986071521's log: `slot-name: staging` was passed
    // and the package landed ("Successfully deployed web package to App
    // Service"). This pins that it stays that way — a deploy that silently
    // targeted production would defeat the entire design.
    expect(shell).toMatch(/slot-name:\s*staging/);
  });

  it("still refuses to swap when the slot smoke fails", () => {
    expect(shell).toMatch(/steps\.slot-smoke\.outcome[^\n]*!=[^\n]*success/);
    expect(shell).toMatch(/NOT swapping/);
  });

  it("swaps only after the smoke, and verifies production afterwards", () => {
    const order = ["Smoke the staging slot", "Refuse the swap", "Swap staging into production", "Verify production is serving"];
    let last = -1;
    for (const step of order) {
      const at = yml.indexOf(step);
      expect(at, `missing step: ${step}`).toBeGreaterThan(-1);
      expect(at, `step out of order: ${step}`).toBeGreaterThan(last);
      last = at;
    }
  });
});

describe("the workflow is well-formed", () => {
  it("carries no control characters", () => {
    // Two were introduced while authoring this file by hand — a `\\1` sed
    // backreference that became \\x01, and a `\\n` that became a real newline
    // mid-string. Both produced YAML that either failed to parse or ran
    // subtly wrong, and neither is visible when reading the diff.
    const bad = [...yml].filter((c) => {
      const n = c.charCodeAt(0);
      return n < 9 || (n > 13 && n < 32);
    });
    expect(bad).toEqual([]);
  });

  it("has no flattened shell continuations", () => {
    // The slot-smoke step was written with backslash continuations that got
    // collapsed onto one line. It happened to still work; it would not have
    // survived the next edit. An env: block replaced it.
    expect(shell).not.toMatch(/SMOKE_BASE_URL="[^"]*"\s{2,}TIER1_HARNESS_TOKEN=/);
  });

  it("stays well under the 512 KB runner-workflow ceiling", () => {
    // A workflow over 512 KB dispatches with zero jobs and no error.
    expect(Buffer.byteLength(yml, "utf8")).toBeLessThan(512 * 1024);
  });
});
