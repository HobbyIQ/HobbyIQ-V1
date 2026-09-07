/**
 * CF-A-DEAD-RELAUNCH-ARM-STAYS-DEAD — a script cannot re-enter the dropdown
 * without a relaunch that can see a kill (#1975, 2026-09-07).
 *
 * THE STATE OF PLAY. backfill-runner.yml's "Self-relaunch catalog expansion
 * until RELAUNCH_NEEDED=false" step is now gated on exactly two scripts:
 *
 *     backfill-catalog-cs-images      <- NOT in the dropdown (CF-CS-KILL-SWITCH)
 *     backfill-cs-card-population     <- NOT in the dropdown (CF-CS-KILL-SWITCH)
 *
 * and nothing else. The #1944 ratchet migrated every dispatchable lane off this
 * gate — five in wave 2, reaudit-cardsight-unverified in wave 3 — so what is
 * left is a gate whose entire population is unreachable. Both were removed from the `script:` choice list on 2026-08-02 when
 * Cardsight API calls were halted — the whitelist is the only way to dispatch
 * this workflow, so a script absent from it cannot be run at all. Their arms on
 * the relaunch gate are therefore DEAD CODE: unreachable, and documented as such
 * rather than deleted, because the kill switch is a pause and the names record
 * what has to be re-examined if CS is ever turned back on.
 *
 * WHY THAT MATTERS RATHER THAN BEING TIDY-UP. The RELAUNCH_NEEDED protocol is
 * the OLD one, and it has exactly two real arms:
 *
 *     if   [ "$RN" = "true"  ]  -> re-dispatch
 *     elif [ "$RN" = "false" ]  -> stop, complete
 *     else                      -> ::warning:: "Could not parse ..."   <-- NOT a failure
 *
 * A step KILLED at the 150-minute ceiling prints no line at all, so `$RN` is the
 * EMPTY STRING, which is neither "true" nor "false" and lands on that warning.
 * The job goes GREEN with its work half done. That is #1906's "a killed run is
 * not a finished run" defect, in the protocol the marker-keyed gate has already
 * had fixed twice — and `relaunchNeverCallsAKilledRunFinished` does not see this
 * step, because its population is the MARKER-keyed relaunches.
 *
 * The #1944 ratchet has been migrating lanes off this gate for exactly that
 * reason: wave 2 moved five, wave 3 moved reaudit-cardsight-unverified. Each
 * left this list and joined a marker-keyed step — REMOVED here rather than added
 * there and left on both, since two steps reacting to one budget stop would
 * re-dispatch it twice.
 *
 * THE HAZARD THIS FILE CLOSES. The two dead arms are safe ONLY while their
 * scripts are absent from the dropdown. Restoring a script to that list is a
 * one-line change, in a different part of a 553 KB file, made for an unrelated
 * reason — turning the CS kill switch back off. The moment it lands, a lane that
 * has never been audited for the killed case becomes dispatchable and is
 * silently governed by a warning arm that cannot fail a job. Nothing in the repo
 * connects those two edits today: the dropdown does not know which gate governs
 * a name, and the gate does not know which names are dispatchable.
 *
 * So the rule from #1975 is made to cover them: a script may sit on the
 * RELAUNCH_NEEDED gate while it is UNDISPATCHABLE, or it may be in the dropdown
 * with a MARKER-SHAPE relaunch that distinguishes a kill — never in the dropdown
 * on the RELAUNCH_NEEDED gate alone. The arms stay (documented dead); what is
 * pinned is the pairing.
 *
 * WHY THE ARMS ARE NOT SIMPLY DELETED. #1975 asks that they stay, documented
 * dead, and that is the right call: the CS kill switch is a PAUSE, not a
 * retirement, and these two names are the record of what must be re-audited
 * before Cardsight lanes run again. Deleting them would erase the very
 * connection this file is here to enforce — the next person to re-enable CS
 * would find a dropdown entry and no gate at all, which is worse than a dead arm.
 *
 * WHAT THIS FILE DOES NOT DEMAND. It does not require migrating anything. The
 * dispatchable population of this gate is EMPTY today and the assertion below
 * pins it as a closed set: it may stay empty, and it may never grow. A lane
 * appearing here is the regression — a dispatchable script governed by an arm
 * that cannot fail a job.
 *
 * MUTATION CHECK. Add `backfill-catalog-cs-images` back to the dropdown without
 * moving it to a marker-keyed step and "no dead arm is resurrected into the
 * dropdown" names it. Add any dispatchable script to the RELAUNCH_NEEDED gate
 * and "the soft gate's dispatchable population never grows" names that too.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_PATH = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
const RUNNER = fs.readFileSync(RUNNER_PATH, "utf8").replace(/\r\n/g, "\n");

/** Strip YAML comments: the kill-switch block NAMES the two retired scripts in
 *  prose, and a name in a comment is not an option in a dropdown. D18 learned
 *  this against the marker gate itself. */
const stripComments = (s: string) => s.replace(/^\s*#.*$/gm, "");

/** The `script:` choice list — the whitelist, and the ONLY way to dispatch this
 *  workflow. A script absent from it cannot be run at all. */
function dropdown(): string[] {
  const block = /^      script:\n[\s\S]*?^        options:\n([\s\S]*?)(?=^      \w+:\n)/m
    .exec(RUNNER)?.[1] ?? "";
  return stripComments(block)
    .split("\n")
    .map((l) => /^\s*-\s+(\S+)\s*$/.exec(l)?.[1])
    .filter((x): x is string => Boolean(x));
}

const DROPDOWN = dropdown();

/** The step that still speaks the old RELAUNCH_NEEDED protocol, and the scripts
 *  its `if:` gate names. */
function relaunchNeededStep(): { src: string; gate: string; scripts: string[] } {
  // Matched on the step's NAME, not on a mention of RELAUNCH_NEEDED: two other
  // steps discuss this protocol at length in their comments (explaining which
  // lanes left this gate and why), and a comment is not a gate.
  const src = RUNNER.split(/\n(?=      - name:)/)
    .find((s) => /^      - name: Self-relaunch catalog expansion/.test(s)) ?? "";
  // The gate may span lines, so take from `if:` to the next key at step indent.
  const gate = /^\s*if:\s*([\s\S]*?)(?=\n\s{8}[a-z-]+:)/m.exec(src)?.[1] ?? "";
  return {
    src,
    gate,
    scripts: [...gate.matchAll(/inputs\.script == '([^']+)'/g)].map((m) => m[1]),
  };
}

const SOFT = relaunchNeededStep();

/** Scripts governed by a MARKER-keyed relaunch — the protocol that distinguishes
 *  a kill from a finish, per relaunchNeverCallsAKilledRunFinished. */
function markerGovernedScripts(): Set<string> {
  const names = RUNNER.split(/\n(?=      - name:)/)
    .filter((s) => /gh workflow run backfill-runner\.yml/.test(s))
    .filter((s) => /stopped at the \.\*budget/.test(stripComments(s)))
    .flatMap((s) => [...s.matchAll(/inputs\.script == '([^']+)'/g)].map((m) => m[1]));
  return new Set(names);
}

const MARKER_GOVERNED = markerGovernedScripts();

/** The two arms retired under CF-CS-KILL-SWITCH: on the gate, absent from the
 *  dropdown, deliberately left in place as documentation. */
const DOCUMENTED_DEAD = ["backfill-catalog-cs-images", "backfill-cs-card-population"];

/** The dispatchable lanes still on the soft gate. EMPTY, and that is the whole
 *  point: the #1944 ratchet has migrated every lane that could actually be
 *  dispatched, leaving this gate holding nothing but the two dead arms. A CLOSED
 *  set — it may stay empty, and it may never grow. */
const KNOWN_SOFT_LANES: string[] = [];

describe("the census finds the gate and the whitelist", () => {
  it("parses the dropdown", () => {
    // 167 at the time of writing. A floor, not an equality.
    expect(DROPDOWN.length).toBeGreaterThanOrEqual(150);
    expect(DROPDOWN).toContain("rematch-sold-comps");
  });

  it("finds the step that still speaks the RELAUNCH_NEEDED protocol", () => {
    expect(SOFT.src).toMatch(/Self-relaunch catalog expansion/);
    expect(SOFT.scripts.length).toBeGreaterThanOrEqual(1);
  });

  it("that step's third arm is still a warning, which is why the pairing matters", () => {
    // If this ever becomes a failure the whole hazard evaporates and this file
    // can go. Until then, the softness is the premise of every rule below.
    const run = stripComments(SOFT.src);
    expect(run).toMatch(/::warning::/);
    expect(
      /Could not parse RELAUNCH_NEEDED/.test(run),
      "the empty string a KILLED step leaves is neither 'true' nor 'false', so it lands here",
    ).toBe(true);
    expect(
      /\n\s*exit 1\b/.test(run.slice(run.lastIndexOf("else"))),
      "if the else arm now exits non-zero, a killed lane on this gate finally fails the job — "
        + "update this file rather than leaving a stale premise in place.",
    ).toBe(false);
  });
});

describe("no dead arm is resurrected into the dropdown", () => {
  for (const script of DOCUMENTED_DEAD) {
    it(`${script} is on the soft gate, so it must stay undispatchable`, () => {
      expect(
        SOFT.scripts,
        `${script} is no longer on the RELAUNCH_NEEDED gate. If it was migrated to a `
          + `marker-keyed step, drop it from DOCUMENTED_DEAD here; if the arm was simply `
          + `deleted, that is fine too — but say which.`,
      ).toContain(script);

      // THE RULE. Undispatchable, or marker-governed. Never dropdown + soft gate.
      const inDropdown = DROPDOWN.includes(script);
      const markerGoverned = MARKER_GOVERNED.has(script);
      expect(
        !inDropdown || markerGoverned,
        `${script} has re-entered the \`script:\` dropdown while still gated ONLY by the `
          + `RELAUNCH_NEEDED step.\n\n`
          + `That step has two real arms and a warning: \`true\` re-dispatches, \`false\` stops, `
          + `and ANYTHING ELSE — including the empty string a step KILLED at the 150-minute `
          + `ceiling leaves, because a killed step prints no line at all — reaches a `
          + `\`::warning::\` that does NOT fail the job. So this lane can now be dispatched, be `
          + `killed at the ceiling, go GREEN, and leave its work half done. That is #1906.\n\n`
          + `It was safe to leave the arm in place ONLY because CF-CS-KILL-SWITCH had removed `
          + `the script from the whitelist on 2026-08-02, making it undispatchable. Restoring `
          + `it to the dropdown removes that protection, and the two edits are far apart in a `
          + `553 KB file made for unrelated reasons.\n\n`
          + `TO CLEAR THIS TEST: give ${script} a MARKER-SHAPE relaunch — budget marker -> `
          + `re-dispatch, \`finishLane: exiting code 0\` + successful step -> finished, non-zero `
          + `code -> verdict, neither -> KILLED and fail — as `
          + `relaunchNeverCallsAKilledRunFinished requires of every other dispatchable lane, and `
          + `REMOVE it from the RELAUNCH_NEEDED gate (never both: two steps reacting to one `
          + `budget stop re-dispatch it twice). Then drop it from DOCUMENTED_DEAD here.`,
      ).toBe(true);
    });
  }
});

describe("the soft gate's dispatchable population never grows", () => {
  const dispatchableOnSoftGate = SOFT.scripts.filter(
    (s) => DROPDOWN.includes(s) && !MARKER_GOVERNED.has(s),
  );

  it("is empty, and every name on the gate is a documented-dead one", () => {
    expect(
      [...dispatchableOnSoftGate].sort(),
      `the set of DISPATCHABLE lanes governed only by the RELAUNCH_NEEDED gate has changed.\n\n`
        + `It may SHRINK — that is the #1944 ratchet doing its work, and the fix is to drop the `
        + `migrated name from KNOWN_SOFT_LANES in this file.\n\n`
        + `It must never GROW. A new name here is a lane that can be dispatched, killed at the `
        + `150-minute ceiling, and reported GREEN with its work half done, because this step's `
        + `third arm is a ::warning:: that does not fail the job. Put the new lane on a `
        + `marker-keyed relaunch step instead.`,
    ).toEqual([...KNOWN_SOFT_LANES].sort());
  });

  it("and every one of them really is undispatchable-or-known, never silently new", () => {
    // Restates the same closed set from the other direction: nothing on the gate
    // is unaccounted for.
    const accounted = new Set([...DOCUMENTED_DEAD, ...KNOWN_SOFT_LANES, ...MARKER_GOVERNED]);
    expect(
      SOFT.scripts.filter((s) => !accounted.has(s)),
      "these scripts sit on the RELAUNCH_NEEDED gate and are in neither the documented-dead set "
        + "nor the known-soft set, so nothing in the repo says whether they can survive a kill",
    ).toEqual([]);
  });
});

describe("the kill switch still says why the dead arms are dead", () => {
  it("names both retired scripts in the whitelist's own comment", () => {
    // The arms are kept as documentation; documentation that stops naming its
    // subject is just dead code again.
    const killSwitch = /CF-CS-KILL-SWITCH[\s\S]{0,1200}/.exec(RUNNER)?.[0] ?? "";
    for (const script of DOCUMENTED_DEAD) {
      expect(
        killSwitch,
        `the CF-CS-KILL-SWITCH block no longer names ${script}. That comment is the only record `
          + `of WHY the script is absent from the dropdown and why its relaunch arm is left `
          + `standing; without it the arm reads as an oversight and gets "cleaned up".`,
      ).toContain(script);
    }
  });
});
