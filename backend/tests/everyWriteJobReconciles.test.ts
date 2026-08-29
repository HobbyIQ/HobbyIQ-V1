/**
 * CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW, made structural.
 *
 * writeReconciliation.ts was added on 2026-08-25 to stop a backfill exiting 0
 * having written almost nothing. It was wired into exactly one script, and the
 * very next day normalize-catalog-format dropped 3,805,355 of 8,944,939
 * intended writes across 28 slots — every slot green, because nothing made it
 * call the guard.
 *
 * A helper nobody calls is not a safeguard, it is a file. So this test asserts
 * the property directly: every whitelisted backfill script that writes to
 * Cosmos must reconcile what it wrote against what it intended.
 *
 * UNRECONCILED is a debt list, not an exemption list. It may shrink and must
 * never grow — adding a name to it is how this fails to work a second time.
 * Wiring a script means understanding its own counters, because a wrong
 * `intended` is worse than no guard at all: it turns a real shortfall green.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");
const SCRIPTS = path.join(__dirname, "..", "scripts");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "backfill-runner.yml");

/** Scripts the runner is allowed to dispatch. */
function whitelisted(): string[] {
  const yml = fs.readFileSync(WORKFLOW, "utf8");
  const start = yml.indexOf("description: \"Backfill script to run\"");
  const tail = yml.slice(start);
  const end = tail.indexOf("\n      apply:");
  const block = end > 0 ? tail.slice(0, end) : tail;
  return [...block.matchAll(/^\s+-\s+([a-z0-9][a-z0-9-]*)\s*$/gm)].map((m) => m[1]);
}

const WRITE_CALL = /items\.bulk\(|\.upsert\(|\.delete\(\)|\.replace\(/;

/**
 * Known-unwired write scripts, as of 2026-08-25. Every one of these can finish,
 * exit 0, and have written nothing. Shrink this list; do not extend it.
 */
const UNRECONCILED = new Set([
  "reslug-chrome-prospects-and-wave", "reslug-brand-root-refinement",
  "backfill-isauto-from-cardnumber", "ingest-product-checklist",
  "backfill-cardsight-title-identity", "backfill-canonicalize-chrome-slugs",
  "backfill-catalog-driven-canonicalize", "backfill-stage2-title-parser",
  "backfill-stage3-price-sanity", "promote-sold-comps-trust-tier",
  "baseline-pool-snapshot", "backfill-cardsight-unverified-flag",
  "migrate-cardsight-to-staging", "backfill-grade-from-title",
  "backfill-bowman-mega-box-reslug", "backfill-sub-channel-vocabulary",
  "auto-quarantine-contaminated-pools",
  "normalize-catalog-schema", "dedupe-catalog-by-hobbyiq",
  "backfill-searchtokens-all-sports", "fix-catalog-parallel-as-player",
  "auto-label-catalog-variants", "rescore-anomalies", "score-all-sold-comps",
  "reaudit-cardsight-unverified", "retire-flattened-attestations",
]);

function writeScripts(): { name: string; src: string }[] {
  return whitelisted()
    .map((name) => ({ name, file: path.join(SCRIPTS, `${name}.cjs`) }))
    .filter((s) => fs.existsSync(s.file))
    .map((s) => ({ name: s.name, src: fs.readFileSync(s.file, "utf8") }))
    .filter((s) => WRITE_CALL.test(s.src) && /APPLY/.test(s.src));
}

describe("every backfill that writes must reconcile", () => {
  it("finds the runner's whitelist", () => {
    const wl = whitelisted();
    expect(wl.length).toBeGreaterThan(50);
    expect(wl).toContain("normalize-catalog-format");
  });

  it("no write script outside the debt list can finish green having written nothing", () => {
    const missing = writeScripts()
      .filter((s) => !s.src.includes("reportWrites") && !UNRECONCILED.has(s.name))
      .map((s) => s.name);
    expect(missing, `these write to Cosmos but never reconcile:\n  ${missing.join("\n  ")}`)
      .toEqual([]);
  });

  it("the debt list only names scripts that are genuinely still unwired", () => {
    // Once a script is wired, its name has to come OUT of the list, or the list
    // stops meaning anything and quietly re-permits the next regression.
    const stale = [...UNRECONCILED].filter((name) => {
      const f = path.join(SCRIPTS, `${name}.cjs`);
      return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("reportWrites");
    });
    expect(stale, `wired but still listed as debt — remove from UNRECONCILED:\n  ${stale.join("\n  ")}`)
      .toEqual([]);
  });

  it("the four already wired stay wired", () => {
    for (const name of [
      "normalize-catalog-format", "repair-refractor-mislabel",
      "merge-bare-colour-parallels", "dedupe-catalog-partition-shadows",
    ]) {
      const src = fs.readFileSync(path.join(SCRIPTS, `${name}.cjs`), "utf8");
      expect(src, `${name} lost its reconciliation`).toContain("reportWrites");
    }
  });

  it("the debt is measured, so it can be seen shrinking", () => {
    const all = writeScripts();
    const wired = all.filter((s) => s.src.includes("reportWrites")).length;
    // eslint-disable-next-line no-console
    console.log(`write-scripts reconciling: ${wired}/${all.length}  (debt ${all.length - wired})`);
    expect(wired).toBeGreaterThanOrEqual(4);
  });
});
