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
// without those two the converted movers drop out of the population. So is
// one through scripts/lib/relocate-sold-comp.cjs (D19): a re-key of a
// sold_comps row is an upsert and deletes the script itself never spells. A
// `.patch(` is a write. A `.replace(` is a write only in its Cosmos shape:
// `.replace(doc)`, never `.replace(/&/g, "&amp;")`.
//
// `patchCatalogRowFields(` (D35, 2026-09-01) is the healer class: a script
// that fills derived fields in place spells none of the other verbs — it
// never upserts, replaces or deletes, and its own `.patch(` lives inside
// catalogRowOps rather than in the script. repair-missing-search-fields
// swept 341,306 rows and was invisible to every list here, on both the
// writer side and the debt side: not a writer, so not missing, so not debt.
// A whole healer class outside the net is the "helper nobody calls" failure
// one level up.
const WRITE_CALL = /items\.bulk\(|\.upsert\(|\.create\(|\.delete\(\)|\.replace\((?![/"'`])|\.patch\(|moveCatalogRow\(|retireCatalogRow\(|relocateSoldComp\(|patchCatalogRowFields\(/;

/** Writes to Cosmos that are not rows. `cosmos-throughput` replaces an
 *  OFFER (RU scaling); there is nothing to reconcile against.
 *
 *  `mutation-valuation-core` writes no Cosmos at all — it is the mutation
 *  harness, and its only writes are `fs.writeFileSync` against a disposable
 *  copy of the source tree. It is in the population because WRITE_CALL reads
 *  `normalized.replace(m.find, m.replace)` — a String.replace on that temp
 *  copy — as a Cosmos `.replace(doc)`. See the FALSE POSITIVES note below;
 *  the regex is not fixed here, so the script is classified where it belongs.
 *  A reconciliation on a job that writes no rows would be a banner over
 *  nothing. */
const NOT_ROW_WRITERS = new Set(["cosmos-throughput", "mutation-valuation-core"]);

// ── KNOWN FALSE POSITIVES in this file's own nets (NOTE-ONLY, 2026-09-02) ──
//
// Found while wiring the pricing-invariant auditor (PR #1641). Both are
// imprecision in the DETECTORS here, not defects in the scripts they flag, and
// both are worked around above by classifying the script rather than by
// loosening a regex — a net that is quietly relaxed catches less than it
// claims, which is the failure this whole file exists to prevent.
//
//   1. WRITE_CALL reads String.replace as a Cosmos replace.
//      `\.replace\((?![/"'`])` excludes a literal first argument, so
//      `.replace(/&/g, "&amp;")` is correctly ignored — but a VARIABLE first
//      argument is not. `normalized.replace(m.find, m.replace)` in
//      mutation-valuation-core.cjs:157 operates on a string read from a temp
//      file; the script never imports @azure/cosmos. A tighter net would
//      require a Cosmos handle in scope, or match `.replace(` only on a
//      receiver that resolves to a container/item.
//
//   2. `needsBuild` sees `dist/` inside a BLOCK comment.
//      It strips `^\s*//` line comments before testing for `dist/`, but not
//      `/* … */`. collision-triage.cjs:292 mentions "dist/" in prose inside a
//      block comment — the file requires no compiled code — so
//      valuation-mutation-ci.yml was reported as running a dist-requiring
//      script without a build step. stripComments() already in this file does
//      handle block comments; needsBuild should use it.
//
// Neither is fixed in PR #1641: changing a shared governance net is its own
// change with its own blast radius across ~104 runner writers and ~25 cron
// writers, and it does not belong in a pricing-auditor PR. TODO: file as a
// follow-up issue and reuse stripComments() in needsBuild.

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
 * Cron-invoked write scripts still unwired. These run on a schedule with no
 * dry-run and nobody watching the log, so a throttling collapse here is a
 * green run every night. 23 on 2026-08-29 (v2); D18 wired all 23 the same
 * day. Sorted. May only shrink — and it is empty, so any name here is a
 * regression.
 */
const UNRECONCILED_CRON = new Set<string>([]);

/**
 * A script that requires compiled code (`dist/`) must be run by a workflow
 * that compiles it — dist/ is gitignored, so nothing else puts it there.
 * grade-explode (nightly) and sold-comps-ch-backfill required dist/ and
 * crashed at require() until D18 added the build step; wiring reportWrites
 * (compiled TS) into every cron writer makes this the rule, not the case.
 * Workflows still invoking a dist-requiring script without a build step.
 * Sorted. May only shrink.
 *
 * Empty from D18 until PR #1641, whose single entry is a DETECTOR false
 * positive rather than a workflow that will crash at require() — the one case
 * this list holds that is not real debt, and it says so in place. It is
 * removable without touching the workflow, the moment needsBuild stops reading
 * block comments.
 */
// valuation-mutation-ci.yml is here for FALSE POSITIVE #2 above, not for real
// debt: neither script it runs requires compiled code. mutation-valuation-core
// spells no `dist/` at all, and lib/collision-triage.cjs is deliberately
// dist-free ("`isChecklist` is INJECTED rather than required, so this lib stays
// free of dist/ and the tests pin the rule without a build") — the only
// `dist/` in it is that sentence, inside a BLOCK comment that `needsBuild` does
// not strip. Adding a pointless build step to satisfy a bad match would be
// fixing the wrong thing; removing this entry is the follow-up's job, once
// needsBuild reuses stripComments().
const UNBUILT_WORKFLOWS = new Set<string>(["valuation-mutation-ci.yml"]);
const BUILD_STEP = /npm run build|npx tsc\b|\btsc\b/;

// ── the budget marker ⇔ relaunch contract ───────────────────────────────
//
// CF-RELAUNCH-ONLY-ON-BUDGET (2026-08-29): a fleet script stops at its own
// budget, PRINTS the marker, and the runner re-dispatches iff the marker is in
// the log. A printer without a marker-keyed relaunch step stops after one
// cycle with every run green; a relaunch step keyed on a marker its script
// never prints re-dispatches nothing, for the same reason.
const BUDGET_MARKER = /stopped at the .*budget/;

/**
 * Whitelisted marker-printers with NO relaunch step at all, as of D18
 * (2026-08-29). The nine that relaunched on a count — which loops forever on
 * a slot down to rows it cannot change and stops early on a budget stop that
 * changed nothing — are marker-keyed since D18, and rehome (which printed no
 * marker and was SIGKILLed at the step ceiling) now owns a clock under it.
 * These three run one cycle and stop, green, with work left; giving them a
 * relaunch step is an ops decision (a fleet that keeps going), not a lint fix.
 * Sorted. May only shrink.
 */
const RELAUNCH_NOT_KEYED_ON_MARKER = new Set([
  "apply-setkey-rulings",
  "map-yearprefixed-setkeys",
  "retire-prose-parallel-rows",
]);

type Script = { name: string; src: string };
function load(names: string[]): Script[] {
  return names
    .map((name) => ({ name, file: path.join(SCRIPTS, `${name}.cjs`) }))
    .filter((s) => fs.existsSync(s.file))
    .map((s) => ({ name: s.name, src: fs.readFileSync(s.file, "utf8") }));
}
/** Runner writers: whitelisted and writes. (v2 also required an APPLY token
 *  somewhere in the source; D18 dropped that — a writer with NO switch is
 *  always-live under the runner and was invisible to this net, which is how
 *  recover-chrome-collapse-damage sat outside every list.) */
function runnerWriters(): Script[] {
  return load(whitelisted()).filter((s) => WRITE_CALL.test(s.src) && !NOT_ROW_WRITERS.has(s.name));
}

// ── the runner's switches ───────────────────────────────────────────────
//
// The runner exports exactly the *_APPLY switches below, derived from
// `inputs.apply`. A whitelisted writer that reads some other name
// (RECOVER_MODE, INGEST_APPLY) is permanently dry under it — an "APPLY"
// dispatch prints plausible counters and writes nothing — and one that reads
// no switch at all writes on `apply=false`. Both were live in D11's audit.
const RUNNER_FLAGS = /\b(BACKFILL_APPLY|RESLUG_APPLY|APPROVE_APPLY)\b/;
/** The *_APPLY names the runner actually exports, read from the yml so the
 *  regex above cannot drift from it. */
function runnerExportedFlags(): string[] {
  const yml = fs.readFileSync(RUNNER, "utf8");
  const start = yml.indexOf("- name: Run backfill (");
  const block = yml.slice(start, yml.indexOf("\n        run:", start));
  return [...block.matchAll(/^\s+([A-Z_]*APPLY[A-Z_]*):\s*\$\{\{ inputs\.apply/gm)].map((m) => m[1]).sort();
}
/** Whitelisted scripts that write through a service the WRITE_CALL net cannot
 *  see — repriceHoldingsForUser, the staging endpoints, upsertMomentumSignal /
 *  upsertCalibration, upsertCatalogEntry. Named here so the switch guard
 *  covers them; every one wrote on `apply=false` or never at all before D18. */
const SERVICE_WRITERS = [
  "drain-staging-backlog",
  "ingest-2026-bowman-auto-checklist",
  "refresh-calibration-multipliers",
  "refresh-market-signals",
  "reprice-user-holdings",
];
/** Cron writers: invoked by a workflow and writes. No APPLY needed — a cron
 *  is always live. */
function cronWriters(): Script[] {
  return load(cronInvoked()).filter((s) => WRITE_CALL.test(s.src) && !NOT_ROW_WRITERS.has(s.name));
}
// A CALL, outside comments. `const { reportWrites } = require(...)` is an
// import, and an import nobody calls is the "helper nobody calls" this file
// exists to catch — D18's mutation check found the old `includes` passed it.
const stripComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const wired = (s: Script) => /\breportWrites\(/.test(stripComments(s.src));
const wiredFile = (f: string) => fs.existsSync(f) && /\breportWrites\(/.test(stripComments(fs.readFileSync(f, "utf8")));

type RelaunchStep = {
  name: string;
  scripts: string[];
  keyedOnMarker: boolean;
  /** The raw `if:` expression, so the apply gate can be read off it. */
  gate: string;
  /** Every `-f apply=<value>` this step re-dispatches with. */
  applyForwards: string[];
};
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
      gate: /^\s*if:\s*(.*)$/m.exec(step)?.[1]?.trim() ?? "",
      applyForwards: [...step.matchAll(/-f apply=("[^"]*"|\S+)/g)].map((m) => m[1]),
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
    const stale = [...UNRECONCILED, ...UNRECONCILED_CRON].filter((name) => wiredFile(path.join(SCRIPTS, `${name}.cjs`)));
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
      expect(wiredFile(path.join(SCRIPTS, `${name}.cjs`)), `${name} lost its reconciliation`).toBe(true);
    }
  });

  it("the healer class is inside the net — seen as a writer, and wired", () => {
    // D35, 2026-09-01. Both halves matter, and the first is the one that was
    // missing: repair-missing-search-fields patched 341,306 rows through
    // patchCatalogRowFields and WRITE_CALL could not see it, so "not in the
    // missing list" meant nothing. Asserting only `wired` would pass even if
    // WRITE_CALL lost the verb again and the script fell back out of the
    // population — so the writer-visibility is pinned by name too.
    const writers = new Set(runnerWriters().map((s) => s.name));
    for (const name of ["repair-missing-search-fields", "retire-wiki-footer-catalog-rows"]) {
      expect(writers.has(name), `${name} writes to Cosmos but WRITE_CALL cannot see it — it is outside the net, not compliant with it`).toBe(true);
      expect(wiredFile(path.join(SCRIPTS, `${name}.cjs`)), `${name} lost its reconciliation`).toBe(true);
    }
  });

  it("the debt is measured, so it can be seen shrinking", () => {
    const runner = runnerWriters(), cron = cronWriters();
    const rw = runner.filter(wired).length, cw = cron.filter(wired).length;
    // eslint-disable-next-line no-console
    console.log(`runner write-scripts reconciling: ${rw}/${runner.length}  (debt ${runner.length - rw})\ncron write-scripts reconciling:   ${cw}/${cron.length}  (debt ${cron.length - cw})`);
    expect(rw).toBeGreaterThanOrEqual(4);
    // D18: every cron writer reconciles. 0/23 before; the population may grow,
    // the wired fraction may not fall.
    //
    // 23 -> 24 (PR #1641, 2026-09-02): audit-pricing-invariants is a cron
    // writer — nightly, unattended, no dry-run, and it patches the auditFlag
    // marker under APPLY. It shipped without reportWrites and was the 24th
    // name this floor exists to notice; raising the floor with it is what
    // keeps `cron.length === wired` an exact statement rather than one a stale
    // number lets drift. (mutation-valuation-core is NOT counted: it writes no
    // Cosmos rows — see NOT_ROW_WRITERS and false positive #1.)
    expect(cron.length).toBeGreaterThanOrEqual(24);
    expect(cw).toBe(cron.length);
  });

  it("every whitelisted writer reads a switch the runner exports", () => {
    expect(runnerExportedFlags(), "the runner's exported switches moved — update RUNNER_FLAGS").toEqual(["APPROVE_APPLY", "BACKFILL_APPLY", "RESLUG_APPLY"]);
    const writers = [...runnerWriters(), ...load(SERVICE_WRITERS)];
    const deaf = writers.filter((s) => !RUNNER_FLAGS.test(stripComments(s.src))).map((s) => s.name);
    expect(deaf, `whitelisted, writes, and reads none of ${runnerExportedFlags().join("/")} — permanently dry, or live on apply=false, under the runner:\n  ${deaf.join("\n  ")}`)
      .toEqual([]);
  });

  it("the service writers the switch guard names are still whitelisted", () => {
    const wl = new Set(whitelisted());
    const gone = SERVICE_WRITERS.filter((n) => !wl.has(n) || !fs.existsSync(path.join(SCRIPTS, `${n}.cjs`)));
    expect(gone, `not whitelisted (or deleted) — remove from SERVICE_WRITERS:\n  ${gone.join("\n  ")}`).toEqual([]);
  });

  it("every cron workflow that runs a dist-requiring script builds dist first", () => {
    const requiresDist = new Map<string, boolean>();
    const needsBuild = (name: string) => {
      if (!requiresDist.has(name)) {
        const f = path.join(SCRIPTS, `${name}.cjs`);
        requiresDist.set(name, fs.existsSync(f) && /dist\//.test(fs.readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "")));
      }
      return requiresDist.get(name)!;
    };
    const unbuilt: string[] = [];
    for (const f of fs.readdirSync(WORKFLOWS)) {
      if (!/\.ya?ml$/.test(f) || f === "backfill-runner.yml") continue;
      const yml = fs.readFileSync(path.join(WORKFLOWS, f), "utf8");
      const dist = [...new Set([...yml.matchAll(/scripts\/([A-Za-z0-9_./-]*?)\.cjs/g)].map((m) => m[1]))].filter(needsBuild);
      if (dist.length && !BUILD_STEP.test(yml) && !UNBUILT_WORKFLOWS.has(f)) unbuilt.push(`${f} -> ${dist.join(", ")}`);
    }
    expect(unbuilt, `these run a script that requires dist/ and never build it — the script crashes at require():\n  ${unbuilt.join("\n  ")}`)
      .toEqual([]);
    const stale = [...UNBUILT_WORKFLOWS].filter((f) => !fs.existsSync(path.join(WORKFLOWS, f)) || BUILD_STEP.test(fs.readFileSync(path.join(WORKFLOWS, f), "utf8")));
    expect(stale, `now builds (or gone) — remove from UNBUILT_WORKFLOWS:\n  ${stale.join("\n  ")}`).toEqual([]);
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
    // D18 floor: 15 before, 25 after (nine count-gated steps + rehome).
    expect(ok).toBeGreaterThanOrEqual(25);
  });
});

// ── a report relaunches as a report ─────────────────────────────────────
//
// CF-REPORT-RELAUNCHES-AS-A-REPORT (D34, 2026-08-30). Observed on run
// 33330120651: a REPORT-ONLY repair-bcp-misfiled-parallels printed
// "stopped at the 140-minute budget — the relaunch continues from here"
// and its relaunch step produced no output. Every marker-gated step carried
// `&& inputs.apply == true` and re-dispatched `-f apply=true`, so a report
// longer than one budget could never finish and an accidental relaunch of
// one would have come back as a WRITE.
//
// The marker is mode-blind: the scripts print it from the same line in both
// modes, and the runner's single `run:` step tees the same /tmp/backfill.log
// in both modes. So the gate must be mode-blind too, and `apply` must be
// forwarded verbatim like every other input.
describe("a marker-gated relaunch fires in report mode, and as a report", () => {
  const markerGated = () => relaunchSteps().filter((r) => r.keyedOnMarker);

  it("finds the marker-gated steps", () => {
    expect(markerGated().length).toBeGreaterThanOrEqual(37);
  });

  it("the one run step tees the log the relaunch greps, in both modes", () => {
    const yml = fs.readFileSync(RUNNER, "utf8");
    const start = yml.indexOf("- name: Run backfill (");
    const step = yml.slice(start, yml.indexOf("\n      - name:", start + 10));
    // A single unconditional tee — not an `if: apply` branch, and not a
    // second log file a report would write instead.
    expect(step).toContain("| tee /tmp/backfill.log");
    expect(step).not.toMatch(/^\s*if:/m);
    // The invariant is about the RELAUNCH's evidence: every marker grep must
    // read the one log the single run step tees, or a relaunch decides on a
    // file nothing wrote. Scoped to the grep lines for that reason -- the
    // canary gate's own /tmp/canary-after.log (added 2026-09-03) is written
    // and read inside one step and no relaunch ever greps it.
    const grepped = new Set([...yml.matchAll(/grep -[a-zA-Z]*\s+"[^"]*"\s+(\/tmp\/[a-z._-]+\.log)/g)].map((m) => m[1]));
    expect([...grepped], "the relaunch greps exactly the file the run step writes").toEqual(["/tmp/backfill.log"]);
  });

  it("no marker-gated step gates itself on apply — the marker is the gate", () => {
    const applyGated = markerGated().filter((r) => /inputs\.apply\s*==\s*true/.test(r.gate));
    expect(applyGated.map((r) => r.name),
      `a report that stops at its budget can never finish — these relaunch only for APPLY:\n  ${applyGated.map((r) => r.name).join("\n  ")}`)
      .toEqual([]);
  });

  it("every marker-gated step still refuses to relaunch a cancel", () => {
    // #1361: relaunch iff the budget marker, never on cancel/failure.
    const unguarded = markerGated().filter((r) => !r.gate.includes("!cancelled()"));
    expect(unguarded.map((r) => r.name)).toEqual([]);
  });

  it("no marker-gated step ESCALATES a relaunch into a write", () => {
    // The defect this guards is one-directional and always was: a relaunch
    // that hardcodes `apply=true` turns a REPORT that ran out of budget into a
    // WRITE nobody dispatched (#1578). That is what must stay at zero.
    const escalating = markerGated().filter((r) => r.applyForwards.some((v) => /true/.test(v) && !/inputs\.apply/.test(v)));
    expect(escalating.map((r) => `${r.name}: ${r.applyForwards.join(" ")}`),
      "a report relaunch would come back as a WRITE:")
      .toEqual([]);
  });

  it("only the rematch DE-escalates, and only because its gate cannot survive a re-dispatch", () => {
    // AMENDED 2026-09-03 (audit finding 5). `apply=false` is the opposite
    // direction and cannot produce an unrequested write -- but it is still a
    // deviation from "forward verbatim", so it is named here rather than
    // waved through, and every OTHER step must still forward verbatim.
    //
    // The rematch is the one lane whose apply is gated by a canary baseline
    // captured on THIS runner's /tmp. A re-dispatch is a fresh runner with a
    // fresh /tmp, so a continuation apply would run with no before-state and
    // no gate -- the gate would be skippable by simply being slow. The
    // continuation therefore runs as a REPORT (which still finishes the
    // shard's census), and the apply is re-dispatched by hand with its
    // before/apply/after triple intact.
    const deEscalating = markerGated().filter((r) => r.applyForwards.some((v) => /false/.test(v) && !/inputs\.apply/.test(v)));
    expect(deEscalating.map((r) => r.name)).toEqual([
      "Self-relaunch rematch-sold-comps until the shard is finished",
    ]);
    // everything else forwards verbatim, exactly as before
    const others = markerGated().filter((r) => !/rematch-sold-comps/.test(r.name));
    expect(others.filter((r) => r.applyForwards.some((v) => !/inputs\.apply/.test(v))).map((r) => r.name)).toEqual([]);
  });

  it("every marker-gated step re-dispatches apply exactly once", () => {
    const wrong = markerGated().filter((r) => r.applyForwards.length !== 1);
    expect(wrong.map((r) => `${r.name}: ${r.applyForwards.length}`)).toEqual([]);
  });

  it("the defect run's own script relaunches in report mode", () => {
    // The observed failure, pinned by name.
    const step = relaunchSteps().find((r) => r.scripts.includes("repair-bcp-misfiled-parallels"));
    expect(step, "no relaunch step for the script that exposed this").toBeDefined();
    expect(step!.keyedOnMarker).toBe(true);
    expect(step!.gate).not.toMatch(/inputs\.apply/);
    expect(step!.applyForwards).toEqual(['"${{ inputs.apply }}"']);
  });
});
