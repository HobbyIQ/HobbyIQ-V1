/**
 * The scope refusal, and the ORDER that makes it real.
 *
 * The lesson (#1565, and MODE=source before it): a whole-scope write must be
 * asked for by name, and the refusal must sit ABOVE every require that can
 * throw. With a stale or absent `dist`, a refusal below the requires is
 * unreachable and the job exits on a MODULE_NOT_FOUND that merely LOOKS like a
 * refusal -- exit 1, no message, and a reader who believes the scope held.
 *
 * These tests run with `dist` deliberately unavailable, so a MODULE_NOT_FOUND
 * cannot masquerade as the refusal: the refusal must print its own words.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs");
const source = fs.readFileSync(script, "utf8");

function run(env: Record<string, string>): { code: number | null; out: string } {
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd: backend,
      // The env is REPLACED, not spread: inheriting an ambient SPORTS/YEARS
      // would hand the script the very scope this asserts it does not have.
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? null, out: String(err.stderr ?? "") + String(err.stdout ?? "") };
  }
}

// CF-CHRONIC-REDS-SLOW (2026-09-03). Each test here spawns a real node
// child (execFileSync) to run the shipped consolidate script and read its
// refusal banner. Process spawn plus that script's own module load is
// seconds per case in isolation and multiples of that under a full-suite
// fork storm, which pushed "accepts SCOPE=all" past the 30s default. The
// spawn IS the test -- it proves the refusal ordering in the real binary --
// so raise the ceiling rather than stub the child. Assertions unchanged.
describe("consolidate-catalog-duplicates -- the scope refusal", { timeout: 180_000 }, () => {
  it("REFUSES with exit 1 and ONE line when given no SPORTS and no YEARS", () => {
    const { code, out } = run({ COSMOS_CONNECTION_STRING: "dummy" });
    expect(code).toBe(1);
    expect(out).toMatch(/consolidate the ENTIRE catalog/i);
    expect(out).toMatch(/SCOPE=all/);
  });

  it("REFUSES an unknown MODE with exit 1", () => {
    const { code, out } = run({ COSMOS_CONNECTION_STRING: "dummy", SPORTS: "baseball", MODE: "bogus" });
    expect(code).toBe(1);
    expect(out).toMatch(/MODE="bogus" is not one of/);
  });

  it("accepts SCOPE=all as the explicit whole-scope opt-in", () => {
    // It must get PAST the scope gate. It then fails on the requires (no dist
    // in this checkout), which is a DIFFERENT failure and must not print the
    // refusal -- that is exactly the confusion this ordering prevents.
    const { out } = run({ COSMOS_CONNECTION_STRING: "dummy", SCOPE: "all" });
    expect(out).not.toMatch(/consolidate the ENTIRE catalog/i);
  });

  it("puts the refusal AHEAD of every require that can throw", () => {
    const refusal = source.indexOf("consolidate the ENTIRE catalog");
    expect(refusal).toBeGreaterThan(-1);

    // Every top-level require EXCEPT the node builtins, which cannot fail.
    const risky = [...source.matchAll(/^[ \t]*(?:const|let|var)\b[^\n]*\brequire\([^\n]*$/gm)].filter(
      (m) => !/require\((["'])(?:node:)?(?:path|crypto|fs)\1\)/.test(m[0]),
    );
    expect(risky.length).toBeGreaterThan(0);
    for (const m of risky) expect(m.index ?? 0).toBeGreaterThan(refusal);
  });

  it("the MODE refusal is also above the requires", () => {
    const modeRefusal = source.indexOf("is not one of");
    const firstDistRequire = source.indexOf('require(path.join(backend, "dist"');
    expect(modeRefusal).toBeGreaterThan(-1);
    if (firstDistRequire > -1) expect(modeRefusal).toBeLessThan(firstDistRequire);
  });
});
