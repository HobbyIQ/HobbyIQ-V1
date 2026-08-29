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
 * v2 (D14, 2026-08-29). The D11 inventory found the v1 net had holes the
 * writers fell through: 23 patch-only writers (`.patch(` was not a write),
 * the one camelCase script (`reslugAllSoldComps` failed the kebab-case name
 * regex and was invisible), and every cron writer (52 workflows, ~40 writers,
 * zero of them reconciling — the population was the runner whitelist only).
 * And a second guard the fleets need: a script that stops at its budget must
 * have a relaunch step keyed on that marker, or the fleet stops silently with
 * every run green; ten relaunch steps gate on progress > 0 instead, and four
 * marker-printers have no relaunch step at all.
 *
 * `.replace(` is matched only in its Cosmos shape (no string / regex literal
 * as the first argument) — the v1 pattern also matched HTML-escaping and
 * called eight digest / calibration scripts writers.
 *
 * Every debt list here is a DEBT list, not an exemption list. It may shrink
 * and must never grow — adding a name to it is how this fails to work a
 * second time. Wiring a script means understanding its own counters, because
 * a wrong `intended` is worse than no guard at all: it turns a real shortfall
 * green.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");
const SCRIPTS = path.join(__dirname, "..", "scripts");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const RUNNER = path.join(WORKFLOWS, "backfill-runner.yml");

/** Scripts the runner is allowed to dispatch. camelCase and underscores are
 *  names too — `reslugAllSoldComps` was invisible to `[a-z0-9-]`. */
function whitelisted(): string[] {
  const yml = fs.readFileSync(RUNNER, "utf8");
  const start = yml.indexOf("description: \"Backfill script to run\"");
  const tail = yml.slice(start);
  const end = tail.indexOf("\n      apply:");
  const block = end > 0 ? tail.slice(0, end) : tail;
  return [...block.matchAll(/^\s+-\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/gm)].map((m) => m[1]);
}

/** Scripts a cron workflow runs — every workflow but the runner, by the path
 *  it invokes (`scripts/comp-quality/backfill-search-fields.cjs` keeps its
 *  sub-directory). A cron has no dry-run switch: it is always live. */
function cronInvoked(): string[] {
  const names = new Set<string>();
  for (const f of fs.readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(f) || f === "backfill-runner.yml") continue;
    const yml = fs.readFileSync(path.join(WORKFLOWS, f), "utf8");
    for (const m of yml.matchAll(/scripts\/([A-Za-z0-9_./-]*?)\.cjs/g)) names.add(m[1]);
  }
  return [...names].sort();
}

// A write that goes through catalogRowOps (D5 PR 3/4) is still a write —
// without those two the converted movers drop out of the population. A
// `.patch(` is a write. A `.replace(` is a write only in its Cosmos shape:
// `.replace(doc)`, never `.replace(/&/g, "&amp;")`.
const WRITE_CALL = /items\.bulk\(|\.upsert\(|\.create\(|\.delete\(\)|\.replace\((?![/"'`])|\.patch\(|moveCatalogRow\(|retireCatalogRow\(/;

/** Writes to Cosmos that are not rows. `cosmos-throughput` replaces an
 *  OFFER (RU scaling); there is nothing to reconcile against. */
const NOT_ROW_WRITERS = new Set(["cosmos-throughput"]);

/**
 * Runner-whitelisted write scripts still unwired, as of 2026-08-29 (v2 net).
 * Every one of these can finish, exit 0, and have written nothing.
 * Sorted. May only shrink.
 */
const UNRECONCILED = new Set([
  "auto-label-catalog-variants",
  "auto-quarantine-contaminated-pools",
  "backfill-autostyle-from-title",
  "backfill-bowman-mega-box-reslug",
  "backfill-canonicalize-chrome-slugs",
  "backfill-cardsight-title-identity",
  "backfill-cardsight-unverified-flag",
  "backfill-catalog-driven-canonicalize",
  "backfill-composite-fields",
  "backfill-composite-v3",
  "backfill-grade-from-ch-daily",
  "backfill-grade-from-title",
  "backfill-insert-setkey",
  "backfill-isauto-cross-sport",
  "backfill-isauto-from-cardnumber",
  "backfill-parallel-enrichment",
  "backfill-printrun-from-title",
  "backfill-searchtokens-all-sports",
  "backfill-stage2-title-parser",
  "backfill-stage3-price-sanity",
  "backfill-sub-channel-vocabulary",
  "backfill-verify-queue-grades",
  "baseline-pool-snapshot",
  "dedupe-catalog-by-hobbyiq",
  "fix-catalog-parallel-as-player",
  "migrate-cardsight-to-staging",
  "normalize-catalog-schema",
  "promote-sold-comps-trust-tier",
  "reaudit-cardsight-unverified",
  "repair-parallel-from-title",
  "rescore-anomalies",
  "reslug-bowman-paper-vs-bowman",
  "reslug-brand-root-refinement",
  "reslug-chrome-draft-collision",
  "reslug-chrome-prospects-and-wave",
  "reslug-cross-brand-fix",
  "reslug-cross-product-mis-slug",
  "reslug-fleer-stickers",
  "reslug-heritage-vs-topps-chrome",
  "reslug-player-sport-fix",
  "reslug-recover-cardnumbers",
  "reslug-speckle-recovery",
  "reslug-suspicious-setkeys",
  "reslugAllSoldComps",
  "retire-flattened-attestations",
  "score-all-sold-comps",
]);

/**
 * Cron-invoked write scripts still unwired, as of 2026-08-29. These run on a
 * schedule with no dry-run and nobody watching the log, so a throttling
 * collapse here is a green run every night. Sorted. May only shrink.
 */
const UNRECONCILED_CRON = new Set([
  "apply-sold-comps-dedup",
  "backfill-identity-method",
  "backfill-null-slugs",
  "backfill-sold-comps-content-hash",
  "backfill-sold-comps-from-ch",
  "backfillCatalogCardYearFromSlug",
  "backfillMarketplaceListings",
  "cardsight-bulk/phase-b-crawl-pricing",
  "comp-quality/backfill-search-fields",
  "comp-quality/compute-slug-phash-centroids",
  "comp-quality/phash-verify-and-reslug",
  "drainCatalogSeedQueue",
  "explodeCatalogGrades",
  "merge-unambiguous-printrun",
  "promote-staging-pending",
  "purge-old-sales-derived",
  "requeueMatchableAwaitingCatalog",
  "reslug-setkey-from-setname",
  "rollup-sold-comps-daily",
  "sold-comps-cleaner",
  "sold-comps-cross-source-dedup",
  "tca-firehose-ingest",
  "tca-match-enricher",
]);

// ── the budget marker ⇔ relaunch contract ───────────────────────────────
//
// CF-RELAUNCH-ONLY-ON-BUDGET (2026-08-29): a fleet script stops at its own
// budget, PRINTS the marker, and the runner re-dispatches iff the marker is in
// the log. A printer without a marker-keyed relaunch step stops after one
// cycle with every run green; a relaunch step keyed on a marker its script
// never prints re-dispatches nothing, for the same reason.
const BUDGET_MARKER = /stopped at the .*budget/;

/**
 * Whitelisted marker-printers whose relaunch step is missing or gates on
 * progress > 0 instead of the marker, as of 2026-08-29. Four have no relaunch
 * step at all (apply-setkey-rulings, fold-unnumbered-twins,
 * map-yearprefixed-setkeys, retire-prose-parallel-rows); the rest relaunch
 * on a count, which loops forever on a slot that is down to rows it cannot
 * change and stops early on a budget stop that changed nothing.
 * Sorted. May only shrink.
 */
const RELAUNCH_NOT_KEYED_ON_MARKER = new Set([
  "apply-setkey-rulings",
  "backfill-playerslug",
  "canonicalize-vendor-shaped-rows",
  "conform-card-profile",
  "map-pokemon-setkeys-to-checklist",
  "map-yearprefixed-setkeys",
  "materialize-graded-identities",
  "repair-parallel-subset-fold",
  "repair-pokemon-glued-numbers",
  "retire-numbered-base-rows",
  "retire-prose-parallel-rows",
  "retire-unreferenced-graded-rows",
]);

type Script = { name: string; src: string };
function load(names: string[]): Script[] {
  return names
    .map((name) => ({ name, file: path.join(SCRIPTS, `${name}.cjs`) }))
    .filter((s) => fs.existsSync(s.file))
    .map((s) => ({ name: s.name, src: fs.readFileSync(s.file, "utf8") }));
}
/** Runner writers: whitelisted, writes, and has an APPLY switch to be on. */
function runnerWriters(): Script[] {
  return load(whitelisted()).filter((s) => WRITE_CALL.test(s.src) && /APPLY/.test(s.src) && !NOT_ROW_WRITERS.has(s.name));
}
/** Cron writers: invoked by a workflow and writes. No APPLY needed — a cron
 *  is always live. */
function cronWriters(): Script[] {
  return load(cronInvoked()).filter((s) => WRITE_CALL.test(s.src) && !NOT_ROW_WRITERS.has(s.name));
}
const wired = (s: Script) => s.src.includes("reportWrites");

type RelaunchStep = { name: string; scripts: string[]; keyedOnMarker: boolean };
/** Every runner step that re-dispatches the workflow, which scripts it fires
 *  for, and whether it fires on the budget marker (comments stripped, so a
 *  comment quoting the marker does not count as a gate). */
function relaunchSteps(): RelaunchStep[] {
  const yml = fs.readFileSync(RUNNER, "utf8");
  return yml
    .split(/\n(?=      - name:)/)
    .filter((step) => /gh workflow run backfill-runner\.yml/.test(step))
    .map((step) => ({
      name: /- name:\s*(.*)/.exec(step)?.[1]?.trim() ?? "?",
      scripts: [...step.matchAll(/inputs\.script == '([^']+)'/g)].map((m) => m[1]),
      keyedOnMarker: BUDGET_MARKER.test(step.replace(/^\s*#.*$/gm, "")),
    }));
}
function markerPrinters(): string[] {
  return load(whitelisted()).filter((s) => BUDGET_MARKER.test(s.src)).map((s) => s.name);
}
function markerKeyedScripts(): Set<string> {
  return new Set(relaunchSteps().filter((r) => r.keyedOnMarker).flatMap((r) => r.scripts));
}

describe("every backfill that writes must reconcile", () => {
  it("finds the runner's whitelist, camelCase included", () => {
    const wl = whitelisted();
    expect(wl.length).toBeGreaterThan(50);
    expect(wl).toContain("normalize-catalog-format");
    expect(wl).toContain("reslugAllSoldComps");
  });

  it("finds the cron population", () => {
    const cron = cronInvoked();
    expect(cron.length).toBeGreaterThan(10);
    expect(cron).toContain("refresh-market-signals");
    expect(cron).toContain("comp-quality/backfill-search-fields");
  });

  it("no runner write script outside the debt list can finish green having written nothing", () => {
    const missing = runnerWriters()
      .filter((s) => !wired(s) && !UNRECONCILED.has(s.name))
      .map((s) => s.name);
    expect(missing, `these write to Cosmos but never reconcile:\n  ${missing.join("\n  ")}`)
      .toEqual([]);
  });

  it("no cron write script outside the debt list can run green every night having written nothing", () => {
    const missing = cronWriters()
      .filter((s) => !wired(s) && !UNRECONCILED_CRON.has(s.name))
      .map((s) => s.name);
    expect(missing, `these cron scripts write to Cosmos but never reconcile:\n  ${missing.join("\n  ")}`)
      .toEqual([]);
  });

  it("the debt lists only name scripts that are genuinely still unwired", () => {
    // Once a script is wired, its name has to come OUT of the list, or the list
    // stops meaning anything and quietly re-permits the next regression.
    const stale = [...UNRECONCILED, ...UNRECONCILED_CRON].filter((name) => {
      const f = path.join(SCRIPTS, `${name}.cjs`);
      return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("reportWrites");
    });
    expect(stale, `wired but still listed as debt — remove from the debt list:\n  ${stale.join("\n  ")}`)
      .toEqual([]);
  });

  it("the debt lists only name scripts the net can still see", () => {
    // A name the population no longer contains (deleted, de-whitelisted, no
    // longer a writer) is inert debt: it looks covered and guards nothing.
    const runner = new Set(runnerWriters().map((s) => s.name));
    const cron = new Set(cronWriters().map((s) => s.name));
    const inert = [
      ...[...UNRECONCILED].filter((n) => !runner.has(n)).map((n) => `${n} (runner)`),
      ...[...UNRECONCILED_CRON].filter((n) => !cron.has(n)).map((n) => `${n} (cron)`),
    ];
    expect(inert, `not in the population any more — remove from the debt list:\n  ${inert.join("\n  ")}`)
      .toEqual([]);
  });

  it("the ones already wired stay wired", () => {
    for (const name of [
      "normalize-catalog-format", "repair-refractor-mislabel",
      "merge-bare-colour-parallels", "dedupe-catalog-partition-shadows",
      "annotate-checklist-backing", "emit-staging-to-pool",
    ]) {
      const src = fs.readFileSync(path.join(SCRIPTS, `${name}.cjs`), "utf8");
      expect(src, `${name} lost its reconciliation`).toContain("reportWrites");
    }
  });

  it("the debt is measured, so it can be seen shrinking", () => {
    const runner = runnerWriters(), cron = cronWriters();
    const rw = runner.filter(wired).length, cw = cron.filter(wired).length;
    // eslint-disable-next-line no-console
    console.log(`runner write-scripts reconciling: ${rw}/${runner.length}  (debt ${runner.length - rw})\ncron write-scripts reconciling:   ${cw}/${cron.length}  (debt ${cron.length - cw})`);
    expect(rw).toBeGreaterThanOrEqual(4);
  });
});

describe("every fleet script that stops at its budget is relaunched on the marker", () => {
  it("parses the runner's relaunch steps", () => {
    const steps = relaunchSteps();
    expect(steps.length).toBeGreaterThan(10);
    const reslug = steps.find((s) => s.scripts.includes("reslugAllSoldComps"));
    expect(reslug?.keyedOnMarker, "the re-slug relaunch is the reference implementation of the marker gate").toBe(true);
  });

  it("every whitelisted marker-printer has a relaunch step keyed on the marker, or is declared debt", () => {
    const keyed = markerKeyedScripts();
    const missing = markerPrinters().filter((n) => !keyed.has(n) && !RELAUNCH_NOT_KEYED_ON_MARKER.has(n));
    expect(missing, `print "stopped at the … budget" but nothing re-dispatches on it — the fleet stops silently, green:\n  ${missing.join("\n  ")}`)
      .toEqual([]);
  });

  it("every relaunch step keyed on the marker names a script that prints it", () => {
    const printers = new Set(markerPrinters());
    const phantom = [...markerKeyedScripts()].filter((n) => !printers.has(n));
    expect(phantom, `relaunch waits for a marker the script never prints — it will never re-dispatch:\n  ${phantom.join("\n  ")}`)
      .toEqual([]);
  });

  it("the relaunch debt only names scripts still missing a marker-keyed relaunch", () => {
    const keyed = markerKeyedScripts();
    const stale = [...RELAUNCH_NOT_KEYED_ON_MARKER].filter((n) => keyed.has(n));
    expect(stale, `now keyed on the marker — remove from RELAUNCH_NOT_KEYED_ON_MARKER:\n  ${stale.join("\n  ")}`)
      .toEqual([]);
  });

  it("the relaunch debt only names whitelisted scripts that still print the marker", () => {
    const printers = new Set(markerPrinters());
    const inert = [...RELAUNCH_NOT_KEYED_ON_MARKER].filter((n) => !printers.has(n));
    expect(inert, `no longer a whitelisted marker-printer — remove from RELAUNCH_NOT_KEYED_ON_MARKER:\n  ${inert.join("\n  ")}`)
      .toEqual([]);
  });

  it("the relaunch debt is measured", () => {
    const printers = markerPrinters(), keyed = markerKeyedScripts();
    const ok = printers.filter((n) => keyed.has(n)).length;
    // eslint-disable-next-line no-console
    console.log(`marker-printers relaunched on the marker: ${ok}/${printers.length}  (debt ${printers.length - ok})`);
    expect(ok).toBeGreaterThanOrEqual(11);
  });
});
