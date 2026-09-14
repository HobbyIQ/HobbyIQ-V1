/**
 * THE `split` CENSUS SCOPE (report-only), #2137 follow-on.
 *
 * DREW'S RULING, 2026-09-13: "report first, rule later" on split-identity
 * repair. The census already flags every HIQ-SPLIT row (a stored `cardId` and
 * `hobbyiqCardId` naming two DIFFERENT hiq: cards -- lib/split-identity.cjs,
 * pinned separately in splitIdentityCensus.test.ts). This file pins the NEW
 * piece: lib/split-scope.cjs's `classifySplitScope`, which decides, per
 * HIQ-SPLIT row, whether a future (human-gated) repair would MOVE the row to
 * one side or PARK it --
 *
 *   split-move  exactly ONE side is checklist-backed AND the title names
 *               that side's differing segment(s) (the product name for a
 *               setKey split, the print-run token for printRun, the parallel
 *               words for parallel, the literal number for cardNumber, the
 *               sport word for sport).
 *   split-park  neither side is checklist-backed, or BOTH are, or the title
 *               does not name the destination. Per memory
 *               (project_split_identity_pool_rows): PARK lists, never
 *               repoint by hobbyiqCardId alone -- picking a side without
 *               title evidence is exactly the guess this scope refuses.
 *
 * AND the permanent apply refusal: `scope=split` (rematch-classify.cjs's
 * parseApplyScope) and `WAVE2_APPLY_SCOPE=split` (wave2-fleet.sh) must both
 * REFUSE, naming Drew's "report first" decision -- there is no apply path for
 * this scope, ever, by design, not by omission.
 */
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type SplitScopeVerdict = {
  verdict: "split-move" | "split-park";
  judgedAxes: string[];
  destination: "cardId" | "hobbyiqCardId" | null;
  backed: { cardId: boolean; hobbyiqCardId: boolean };
  titleNamed: string[];
  titleUnnamed: string[];
  reason: string;
};
type SplitIdentityResult = { klass: string; segments: string[]; split: boolean; reason: string };
type SplitScopeModule = {
  classifySplitScope: (row: { cardId: string; hobbyiqCardId: string; title: string }, segments: string[], opts?: unknown) => SplitScopeVerdict;
  AXES_THIS_SCOPE_JUDGES: string[];
  defaultIsRegisteredSetKey: (setKey: string) => boolean;
  cardNumberIsWellFormed: (n: string) => boolean;
};
type SplitIdentityModule = { classifyIdentity: (row: { cardId?: string; hobbyiqCardId?: string }) => SplitIdentityResult; HIQ_SPLIT: string };
type K = {
  parseApplyScope: (raw: string) => { classes: Set<string>; ok: boolean; reason: string };
  classifySplitScope: SplitScopeModule["classifySplitScope"];
  SPLIT_SCOPE_AXES: string[];
  SPLIT_CLASSES: { HIQ_SPLIT: string };
};

const SCOPE = require_(path.join(backend, "scripts", "lib", "split-scope.cjs")) as SplitScopeModule;
const SPLIT = require_(path.join(backend, "scripts", "lib", "split-identity.cjs")) as SplitIdentityModule;
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as K;

/** Drives the real two-module pipeline exactly as rematch-sold-comps.cjs
 *  does: classifyIdentity first (to get the differing segments), then
 *  classifySplitScope off those segments. */
function judge(cardId: string, hobbyiqCardId: string, title: string): SplitScopeVerdict {
  const split = SPLIT.classifyIdentity({ cardId, hobbyiqCardId });
  expect(split.klass).toBe(SPLIT.HIQ_SPLIT); // every fixture below must actually BE a split
  return SCOPE.classifySplitScope({ cardId, hobbyiqCardId, title }, split.segments);
}

describe("split-scope.cjs is re-exported from rematch-classify.cjs", () => {
  it("K.classifySplitScope and K.SPLIT_SCOPE_AXES exist and agree with the leaf module", () => {
    expect(typeof K.classifySplitScope).toBe("function");
    expect(K.SPLIT_SCOPE_AXES).toEqual(SCOPE.AXES_THIS_SCOPE_JUDGES);
  });
});

describe("setKey axis", () => {
  it("split-move: unknown setKey vs. a registered product the title names", () => {
    const v = judge(
      "hiq:football:2025:unknown:81:base:no-auto",
      "hiq:football:2025:donruss-elite:81:base:no-auto:num-499",
      "2025 Donruss Elite Football #81 Base /499",
    );
    expect(v.verdict).toBe("split-move");
    expect(v.destination).toBe("hobbyiqCardId");
    expect(v.judgedAxes).toContain("setKey");
    expect(v.backed).toEqual({ cardId: false, hobbyiqCardId: true });
  });

  it("split-park: same shape, but the title never names the destination product", () => {
    const v = judge(
      "hiq:football:2025:unknown:81:base:no-auto",
      "hiq:football:2025:donruss-elite:81:base:no-auto:num-499",
      "2025 Football Rookie Card #81",
    );
    expect(v.verdict).toBe("split-park");
    expect(v.destination).toBeNull();
    expect(v.reason).toContain("title-does-not-name-destination");
  });

  it("split-park: BOTH sides are registered products (a genuine two-product ambiguity, not a one-sided fix)", () => {
    const v = judge(
      "hiq:football:2025:panini-donruss:14:base:no-auto",
      "hiq:football:2025:panini-optic:14:base:no-auto",
      "2025 Panini Donruss Optic Football #14 Base",
    );
    expect(v.verdict).toBe("split-park");
    expect(v.reason).toBe("both-sides-checklist-backed");
  });

  it("split-park: NEITHER side is a registered product", () => {
    const v = judge(
      "hiq:football:2025:unknown:14:base:no-auto",
      "hiq:football:2025:unspecified:14:base:no-auto",
      "2025 Football Card #14",
    );
    expect(v.verdict).toBe("split-park");
    expect(v.reason).toBe("neither-side-checklist-backed");
  });
});

describe("printRun axis", () => {
  it("split-park: an isolated printRun split (same setKey both sides) is ALWAYS both-backed-or-neither -- there is no one-sided destination", () => {
    // This is a real, measured shape (see census-slot-1.json's panini-prizm
    // #332 samples): the product agrees on both sides and only the print-run
    // segment is present on one. Checklist-backedness here depends only on
    // setKey + cardNumber, so an isolated printRun split can never produce
    // "exactly one side backed" -- it parks by construction, which is the
    // correct call: filling a blank printRun is an ordinary IMPROVE concern,
    // not a split-identity move.
    const v = judge(
      "hiq:football:2025:panini-prizm:332:base:no-auto",
      "hiq:football:2025:panini-prizm:332:base:no-auto:num-1",
      "2025 Panini Prizm Football #332 Base /1",
    );
    expect(v.verdict).toBe("split-park");
    expect(v.reason).toBe("both-sides-checklist-backed");
  });

  it("split-move: printRun differs ALONGSIDE a setKey split whose destination states the serial", () => {
    const v = judge(
      "hiq:football:2025:unknown:97:refractor:no-auto",
      "hiq:football:2025:topps-finest:97:refractor:no-auto:num-99",
      "2025 Topps Finest Football #97 Refractor /99",
    );
    expect(v.verdict).toBe("split-move");
    expect(v.judgedAxes).toEqual(expect.arrayContaining(["setKey", "printRun"]));
    expect(v.titleNamed).toEqual(expect.arrayContaining(["printRun"]));
  });

  it("split-park: printRun differs but the title never states the serial", () => {
    const v = judge(
      "hiq:football:2025:unknown:97:refractor:no-auto",
      "hiq:football:2025:topps-finest:97:refractor:no-auto:num-99",
      "2025 Topps Finest Football #97 Refractor",
    );
    expect(v.verdict).toBe("split-park");
    expect(v.reason).toContain("printRun");
  });
});

describe("parallel axis", () => {
  it("split-move: unknown setKey/base parallel vs. a registered product whose named parallel the title states", () => {
    const v = judge(
      "hiq:football:2025:unknown:213:base:no-auto",
      "hiq:football:2025:panini-donruss:213:aqua:no-auto:num-349",
      "2025 Panini Donruss Football #213 Aqua /349",
    );
    expect(v.verdict).toBe("split-move");
    expect(v.judgedAxes).toEqual(expect.arrayContaining(["parallel"]));
  });

  it("split-park: the checklist-backed destination's own parallel segment is 'base' -- nothing to name, so the row parks rather than guessing", () => {
    const v = judge(
      "hiq:football:2025:unknown:213:aqua:no-auto",
      "hiq:football:2025:panini-donruss:213:base:no-auto",
      "2025 Panini Donruss Football #213 Aqua",
    );
    expect(v.verdict).toBe("split-park");
    expect(v.destination).toBeNull();
  });
});

describe("cardNumber axis", () => {
  it("split-move: unknown setKey vs. a registered product whose card number the title states", () => {
    const v = judge(
      "hiq:football:2025:unknown:81:base:no-auto",
      "hiq:football:2025:donruss-elite:82:base:no-auto",
      "2025 Donruss Elite Football #82 Base",
    );
    expect(v.verdict).toBe("split-move");
    expect(v.judgedAxes).toEqual(expect.arrayContaining(["cardNumber"]));
  });

  it("split-park: the title states neither card number", () => {
    const v = judge(
      "hiq:football:2025:unknown:81:base:no-auto",
      "hiq:football:2025:donruss-elite:82:base:no-auto",
      "2025 Donruss Elite Football Rookie Base",
    );
    expect(v.verdict).toBe("split-park");
  });
});

describe("sport axis", () => {
  it("split-move: unknown setKey/wrong sport vs. a registered product whose sport the title states", () => {
    const v = judge(
      "hiq:baseball:2025:unknown:81:base:no-auto",
      "hiq:football:2025:donruss-elite:81:base:no-auto",
      "2025 Donruss Elite Football #81 Base",
    );
    expect(v.verdict).toBe("split-move");
    expect(v.judgedAxes).toEqual(expect.arrayContaining(["sport"]));
    expect(v.destination).toBe("hobbyiqCardId");
  });

  it("split-park: the title never names either sport", () => {
    const v = judge(
      "hiq:baseball:2025:unknown:81:base:no-auto",
      "hiq:football:2025:donruss-elite:81:base:no-auto",
      "2025 Rookie Card #81 Base",
    );
    expect(v.verdict).toBe("split-park");
  });

  it("sport synonyms count as naming the sport (NFL for football, NBA for basketball)", () => {
    const v = judge(
      "hiq:baseball:2025:unknown:81:base:no-auto",
      "hiq:football:2025:donruss-elite:81:base:no-auto",
      "2025 NFL Donruss Elite #81 Base",
    );
    expect(v.verdict).toBe("split-move");
  });
});

describe("out-of-scope axes are parked, not silently ignored", () => {
  it("a split that differs ONLY on an axis this scope does not judge (auto) reports no-judged-axis", () => {
    const v = judge(
      "hiq:football:2025:panini-donruss:81:base:auto",
      "hiq:football:2025:panini-donruss:81:base:no-auto",
      "2025 Panini Donruss Football #81 Base Auto",
    );
    expect(v.verdict).toBe("split-park");
    expect(v.judgedAxes).toEqual([]);
    expect(v.reason).toBe("no-judged-axis:split-differs-only-on-auto-cardYear-or-grade");
  });
});

describe("the `split` scope IS an apply path now: it is R32 -- Drew's ruling, 2026-09-14", () => {
  /**
   * THIS BLOCK ENCODED THE PRE-RULING STATE AND HAS BEEN UPDATED TO THE RULED
   * ONE. A pin follows a ruling.
   *
   * #2141 (2026-09-13) refused `scope=split` outright, permanently, because
   * the ruling then in force was "report first, rule later" on split-identity
   * repair. Drew read the report and ruled on 2026-09-14:
   *
   *   "a split-identity row (stored cardId != hobbyiqCardId) moves to the
   *    checklist-backed side when the title names that side's differing
   *    segment (product name, parallel, print run, card number)."
   *
   * R32-SPLIT-MOVES-TO-THE-NAMED-SIDE is that ruling. `split` is FOLDED INTO
   * it as a synonym rather than kept as a separate refusing word -- the word
   * that named the report now names the class the ruling armed.
   *
   * WHAT IS PINNED HERE IS THE SAFETY THE REFUSAL USED TO PROVIDE, RESTATED AS
   * THE RULING'S OWN GUARDS: a split row with NO TITLE EVIDENCE still refuses,
   * and it refuses on the ruling's named legs, not on the old blanket ban. So
   * deleting R32's title test or its measured-backing requirement still goes
   * red -- the mutation intent is preserved, it is simply pointed at the guard
   * that now carries the safety instead of at the ban that used to.
   */
  it("parseApplyScope now ARMS 'split', as a synonym for r32", () => {
    const r = K.parseApplyScope("split");
    expect(r.ok).toBe(true);
    expect([...r.classes]).toEqual([K.SPLIT_MOVES_TO_THE_NAMED_SIDE]);
  });

  it("'split' and 'r32' are the SAME class -- one definition, not two", () => {
    expect([...K.parseApplyScope("split").classes]).toEqual([...K.parseApplyScope("r32").classes]);
  });

  it("'split' combined with a real class arms the union, like every other scope", () => {
    const r = K.parseApplyScope("split,improve");
    expect(r.ok).toBe(true);
    expect([...r.classes].sort()).toEqual([K.IMPROVE, K.SPLIT_MOVES_TO_THE_NAMED_SIDE].sort());
  });

  it("is spelling/case/underscore insensitive, like every other scope token", () => {
    for (const spelling of ["SPLIT", "Split", " split "]) {
      const r = K.parseApplyScope(spelling);
      expect(r.ok, spelling).toBe(true);
      expect([...r.classes], spelling).toEqual([K.SPLIT_MOVES_TO_THE_NAMED_SIDE]);
    }
  });

  it("an ordinary scope is unaffected by the fold", () => {
    expect(K.parseApplyScope("improve").ok).toBe(true);
    expect(K.parseApplyScope("r26").ok).toBe(true);
  });

  it("r32 is DELIBERATELY ABSENT from `both` and `all` -- a ruled scope is asked for by name", () => {
    for (const word of ["both", "all", "all-classes"]) {
      expect([...K.parseApplyScope(word).classes], word).not.toContain(K.SPLIT_MOVES_TO_THE_NAMED_SIDE);
    }
  });

  // ── THE SAFETY THE OLD REFUSAL CARRIED, NOW CARRIED BY THE RULING'S GUARDS ──

  it("A SPLIT ROW WITH NO TITLE EVIDENCE STILL REFUSES -- the ruling's central condition", () => {
    // The exact row the report-only era would have parked. It still does not
    // move: the title names neither side's differing segment.
    const r = K.splitMovesToTheNamedSideEvidence({
      row: {
        cardId: "hiq:football:2025:panini-phoenix:1:base:no-auto",
        hobbyiqCardId: "hiq:football:2025:panini:1:base:no-auto",
        title: "2025 Football Card #1",
      },
      splitClass: K.SPLIT_CLASSES.HIQ_SPLIT,
      splitSegments: ["setKey"],
      backedSides: { cardId: true, hobbyiqCardId: false },
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("title-does-not-name-destination");
  });

  it("AN UNMEASURED SIDE IS NOT A BACKED SIDE -- an apply never runs on the shape proxy", () => {
    const r = K.splitMovesToTheNamedSideEvidence({
      row: {
        cardId: "hiq:football:2025:panini-phoenix:1:base:no-auto",
        hobbyiqCardId: "hiq:football:2025:panini:1:base:no-auto",
        title: "2025 Panini Phoenix Football #1 Base",
      },
      splitClass: K.SPLIT_CLASSES.HIQ_SPLIT,
      splitSegments: ["setKey"],
      backedSides: null,
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("checklist-backing-not-measured");
  });

  it("THE REPORT IS UNTOUCHED -- classifySplitScope still parks what it parked", () => {
    // The move/park report #2141 built is the SAME module R32 gates over, so a
    // dispatch sized against that report is sized against these same rows.
    const v = K.classifySplitScope(
      {
        cardId: "hiq:football:2025:bowman:195:x-fractor:no-auto",
        hobbyiqCardId: "hiq:football:2025:bowman:195:base:no-auto",
        title: "2025 Bowman Football #195",
      },
      ["parallel"],
    );
    expect(v.verdict).toBe("split-park");
  });
});

describe("wave2-fleet.sh: WAVE2_APPLY_SCOPE=split refuses by name, not as a generic unknown scope", () => {
  const FLEET = path.join(backend, "scripts", "wave2", "wave2-fleet.sh");
  const fleetSrc = fs.readFileSync(FLEET, "utf8");

  function findBash(): string | null {
    for (const candidate of ["bash", "C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash", "/bin/bash"]) {
      try { execFileSync(candidate, ["-c", "true"], { stdio: "ignore" }); return candidate; } catch { /* next */ }
    }
    return null;
  }
  const BASH = findBash();
  const itShell = (name: string, fn: () => void) => it.runIf(BASH !== null)(name, fn, 30_000);

  function toShellPath(p: string): string {
    const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    return win ? `/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}` : p;
  }

  /**
   * UPDATED FROM THE PRE-RULING PIN (Drew, 2026-09-14). This used to assert
   * that the fleet named `split` as a PERMANENT REFUSAL ahead of the allowlist.
   * R32 is the ruling that gave it an apply path, so the fleet now REWRITES the
   * token to `r32` ahead of the allowlist -- same position in the file, same
   * "handled by name before the generic check" property, opposite verdict.
   */
  it("the source rewrites split to r32 BY NAME, ahead of the ordinary allowlist check", () => {
    const splitIdx = fleetSrc.indexOf("split) SCOPE=r32 ;;");
    const allowlistIdx = fleetSrc.indexOf("improve|r26|r27|r28|r31|r32|r33) ;;");
    expect(splitIdx).toBeGreaterThan(0);
    expect(allowlistIdx).toBeGreaterThan(splitIdx);
    // The ruling is NAMED at the point of the rewrite, so an operator reading
    // the source learns why the #2141 refusal is gone.
    expect(fleetSrc.slice(Math.max(0, splitIdx - 1200), splitIdx)).toContain("2026-09-14");
  });

  it("the #2141 permanent refusal is GONE, not merely bypassed", () => {
    expect(fleetSrc).not.toContain("has no apply path");
  });

  itShell("WAVE2_APPLY_SCOPE=split is no longer refused at startup", () => {
    // The pre-ruling pin asserted exit 2 with "has no apply path". R32 armed
    // the scope, so the startup validation must now let it through -- whatever
    // the script goes on to do about its census directory.
    let stderr = "";
    try {
      execFileSync(BASH!, [toShellPath(FLEET), "census"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAVE2_APPLY_SCOPE: "split", WAVE2_DISPATCH: "false" },
      });
    } catch (e: unknown) {
      stderr = String((e as { stderr?: Buffer | string }).stderr ?? "");
    }
    expect(stderr).not.toContain("has no apply path");
    expect(stderr).not.toContain("is not one of improve");
  });

  itShell("an UNKNOWN scope is still refused -- the fold did not open the allowlist", () => {
    try {
      execFileSync(BASH!, [toShellPath(FLEET), "census"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAVE2_APPLY_SCOPE: "r34", WAVE2_DISPATCH: "false" },
      });
      expect.unreachable("expected the script to exit nonzero");
    } catch (e: unknown) {
      const err = e as { status?: number; stderr?: Buffer | string };
      expect(err.status).toBe(2);
      expect(String(err.stderr)).toContain("is not one of improve");
    }
  });

  const cutDispatcher = (src: string) => src.slice(0, src.indexOf('case "${1:-}" in'));

  itShell("every real scope is unaffected by the split special-case", () => {
    for (const scope of ["improve", "r26", "r27", "r28", "r31", "r32", "r33"]) {
      const dir = mkdtempSync(path.join(tmpdir(), "wave2-split-scope-ok-"));
      const harness = path.join(dir, "h.sh");
      writeFileSync(harness, `${cutDispatcher(fleetSrc)}\necho SCOPE_OK=$SCOPE\n`, "utf8");
      const out = execFileSync(BASH!, [toShellPath(harness)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WAVE2_APPLY_SCOPE: scope },
      });
      expect(out.trim()).toBe(`SCOPE_OK=${scope}`);
    }
  });
});
