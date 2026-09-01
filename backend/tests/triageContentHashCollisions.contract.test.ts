/**
 * THE TRIAGE'S CONTRACT.
 *
 * This script exists to unblock D30's folds, which means it must triage the
 * SAME population D30 refuses over. A classifier that groups differently, or
 * reads a narrower slice of the pool, produces a beautiful report about cards
 * nobody was blocked on. Those parity properties are asserted on the source,
 * because a behavioural test cannot see them without a live Cosmos.
 *
 * The scope refusal is asserted BEHAVIOURALLY, with `dist` deliberately
 * unavailable, so a MODULE_NOT_FOUND cannot masquerade as a refusal (#1565).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "triage-contenthash-collisions.cjs");
const source = fs.readFileSync(scriptPath, "utf8");
const consolidate = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");

function run(env: Record<string, string>): { code: number | null; out: string } {
  try {
    const out = execFileSync(process.execPath, [scriptPath], {
      cwd: backend,
      // REPLACED, not spread: an ambient SPORTS would hand the script the very
      // scope this asserts it does not have.
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

describe("the scope refusal — a whole-catalog triage must say its own name", () => {
  it("REFUSES with exit 1 when given no SPORTS and no YEARS", () => {
    const { code, out } = run({ COSMOS_CONNECTION_STRING: "dummy" });
    expect(code).toBe(1);
    expect(out).toMatch(/triage the ENTIRE catalog/i);
    expect(out).toMatch(/SCOPE=all/);
  });

  it("REFUSES an unknown MODE with exit 1", () => {
    const { code, out } = run({ COSMOS_CONNECTION_STRING: "dummy", SPORTS: "football", MODE: "delete-everything" });
    expect(code).toBe(1);
    expect(out).toMatch(/is not one of/);
  });

  it("the refusal sits ABOVE every require that can throw", () => {
    // With a stale or absent dist/, a refusal below the requires is unreachable
    // and the job dies on MODULE_NOT_FOUND that merely LOOKS like a refusal.
    const refusal = source.indexOf("triage the ENTIRE catalog");
    const firstHeavyRequire = source.indexOf('require("@azure/cosmos")');
    expect(refusal).toBeGreaterThan(-1);
    expect(firstHeavyRequire).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(firstHeavyRequire);
  });
});

describe("report mode has no write path at all", () => {
  it("MODE defaults to report", () => {
    expect(source).toMatch(/const MODE = String\(process\.env\.MODE \|\| "report"\)/);
  });

  it("APPLY requires BOTH the apply flag AND the write mode named", () => {
    // A runner dispatch carrying apply=true for another lane must not turn this
    // report into a write by accident.
    expect(source).toMatch(/const APPLY = \(process\.env\.BACKFILL_APPLY === "true" \|\| process\.env\.APPLY === "true"\) && MODE === "apply-true-dupes"/);
  });

  it("BACKFILL_APPLY is honoured — the runner exports it, not APPLY", () => {
    expect(source).toMatch(/BACKFILL_APPLY/);
  });

  it("the only write is the flag helper, and it is guarded by APPLY", () => {
    const writeSite = source.indexOf("await flagSuperseded(");
    const guard = source.indexOf('if (APPLY && verdict.class === "TRUE-DUPE"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(writeSite);
  });

  it("the pool reader is read-only", () => {
    const start = source.indexOf("async function salesUnder");
    const body = source.slice(start, source.indexOf("return out;", start));
    expect(body).not.toMatch(/\.patch\(|\.upsert\(|\.delete\(|\.replace\(/);
    expect(body).toMatch(/SELECT /);
  });
});

describe("only the class this script PROVED is ever auto-applied", () => {
  it("the apply branch is reachable for TRUE-DUPE only", () => {
    const branch = source.slice(source.indexOf("if (APPLY && verdict.class"));
    const block = branch.slice(0, branch.indexOf("\n      }"));
    expect(block).toMatch(/TRUE-DUPE/);
    expect(block).not.toMatch(/DISTINCT-CARDS/);
    expect(block).not.toMatch(/AMBIGUOUS/);
  });

  it("DISTINCT-CARDS is routed to relocation, never to a flag", () => {
    const block = source.slice(source.indexOf('} else if (verdict.class === "DISTINCT-CARDS")'), source.indexOf("} else {\n        stats.ambiguous++"));
    expect(block).toMatch(/RELOCATE/);
    expect(block).toMatch(/move, never delete/);
    expect(block).not.toMatch(/flagSuperseded/);
  });

  it("AMBIGUOUS says out loud that a human must rule", () => {
    expect(source).toMatch(/HUMAN RULING REQUIRED\. Never auto-acted on\./);
  });
});

describe("it triages the SAME population D30 refuses over", () => {
  it("it groups with groupKeyOf, exactly as the fleet does", () => {
    expect(source).toMatch(/groupKeyOf\(r, FORCE_AUTO_PREFIXES\)/);
    expect(consolidate).toMatch(/groupKeyOf\(r, FORCE_AUTO_PREFIXES\)/);
  });

  it("it shards on the same hash-of-identity axis, so slot N reads slot N's groups", () => {
    expect(source).toMatch(/shardOfIdentity\(key, SLOTS, sha1\) !== SLOT/);
    expect(consolidate).toMatch(/shardOfIdentity\(key, SLOTS, sha1\) !== SLOT/);
  });

  it("it selects the same catalog population: hiq rows, non-graded", () => {
    for (const src of [source, consolidate]) {
      expect(src).toMatch(/STARTSWITH\(c\.id, "hiq:"\)/);
      expect(src).toMatch(/NOT IS_DEFINED\(c\.gradeTier\)/);
    }
  });

  it("it reads the same sales WIDTH — the extending keys included", () => {
    // A narrower read would miss the `:num-N` and grade-segment keys the
    // pre-flight probes, and under-report the very collisions it must explain.
    for (const src of [source, consolidate]) {
      expect(src).toMatch(/c\.hobbyiqCardId = @s OR STARTSWITH\(c\.hobbyiqCardId, @p\)/);
    }
  });

  it("it hashes against the WINNER's partition, as the fold would", () => {
    expect(source).toMatch(/cardId: winnerId/);
    expect(consolidate).toMatch(/contentHashOf\(\{ \.\.\.row, cardId: winnerId \}\)/);
  });

  it("it buckets on the LEGACY hash, which D30's pre-flight does not compute", () => {
    // THE REACH PROPERTY. Post-D31 `contentHashOf` hashes the parallel WHOLE,
    // so `Uncommon` / `Uncommon Refractor` no longer collide under it. A row
    // STORED before D31 carries the legacy hash, where the trailing
    // " Refractor" was stripped and the two hashed identically -- and those
    // stored rows ARE the DISTINCT-CARDS population. Bucketing on the fresh
    // hash alone would report zero of the class this script exists to name.
    expect(source).toMatch(/const h = legacyContentHashOf\(at\)/);
    expect(source).toMatch(/legacyContentHashOf/);
    // and it still records the fresh form, to say which era a collision is from
    expect(source).toMatch(/fresh: contentHashOf\(at\)/);
    expect(source).toMatch(/legacy-only/);
  });

  it("the legacy bucket is a SUPERSET, so nothing the fresh hash joins is split", () => {
    // Where the two forms agree the string is identical, so every fresh-hash
    // collision is also a legacy-hash collision. The comment must say so, since
    // this is the argument for bucketing on one form rather than both.
    expect(source).toMatch(/SUPERSET/);
  });

  it("it uses the shared contentHash mirror, not a local copy", () => {
    expect(source).toMatch(/require\(path\.join\(backend, "scripts", "lib", "relocate-sold-comp\.cjs"\)\)/);
  });

  it("its projection carries sourceExternalId — the classification cannot work without it", () => {
    const start = source.indexOf("async function salesUnder");
    const body = source.slice(start, source.indexOf("return out;", start));
    expect(body).toMatch(/c\.sourceExternalId/);
  });
});

describe("the report reconciles and reports its budget", () => {
  it("every cluster lands in exactly one class, and the count is reconciled", () => {
    expect(source).toMatch(/RECONCILES/);
    expect(source).toMatch(/clusters === findings\.length \? "OK" : "MISMATCH"/);
  });

  it("apply mode prints the reconciled equation", () => {
    expect(source).toMatch(/reconciled: intended .* = written .* \+ skipped .* \+ failed/);
  });

  it("it prints the budget marker the runner relaunches on", () => {
    expect(source).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
  });

  it("the summary names all three classes and both counts", () => {
    expect(source).toMatch(/TRUE-DUPE\s+\$\{f\(stats\.trueDupe\)\}/);
    expect(source).toMatch(/DISTINCT-CARDS\s+\$\{f\(stats\.distinctCards\)\}/);
    expect(source).toMatch(/AMBIGUOUS\s+\$\{f\(stats\.ambiguous\)\}/);
  });
});
