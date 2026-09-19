/**
 * R55 — A SPLIT MOVE MAY NOT NAME MORE THAN ITS DESTINATION
 * (Drew, 2026-09-15; slot-3 split-scope census, run 34972416544).
 *
 * `classifySplitScope` asked only whether the title names what the destination
 * HAS. It never asked whether the title names something the destination LACKS,
 * and on the slot-3 census that is a live defect: the destination identity says
 * `Base` while the title states a parallel or an insert.
 *
 *   "Jahmyr Gibbs 2024 Prestige Heroes Holo Foil #3"
 *        -> football:2024:panini-prestige:3:Base:no-auto
 *   "2025-26 SP Authentic Acetate Retro Future Watch ... #226 SSP"
 *        -> hockey:2025:sp-authentic:226:Base:no-auto
 *   "Nikita Zadorov Retro 2025-26 O-Pee-Chee #351"
 *        -> hockey:2025:o-pee-chee:351:Base:no-auto
 *
 * Each names a real card the destination slug does not: Heroes is an insert,
 * Acetate Retro Future Watch SSP is a distinct card, Retro is its own O-Pee-Chee
 * printing. Moving the sale onto the plain Base slug files it on a card it is
 * not — worse than leaving it split, because a split is at least visible.
 *
 * Every title in this file is a REAL pool row from that run's own IMPROVE
 * evidence block, committed at `tests/fixtures/r32-improve-evidence-2026-09-15
 * .json` (never a scratchpad path — the runner has only what is committed, so
 * evidence that is not committed is not evidence).
 *
 * THE DETECTOR IS REUSED, NOT REBUILT. `parallelIsUnconfirmed` is the flag
 * CF-A-STATED-PARALLEL-IS-NEVER-EVICTED-TO-BASE added for exactly this shape,
 * and it is injected because `split-scope.cjs` is pure by contract.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SS = require_(path.join(backend, "scripts", "lib", "split-scope.cjs"));
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));
const pti = require_(path.join(backend, "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"));
const fixture = require_(path.join(
  backend, "tests", "fixtures", "r32-improve-evidence-2026-09-15.json",
)) as {
  source: { splitScope: { judged: number; wouldMove: number; byAxis: Record<string, { move: number }> } };
  rows: { id: string; tier: string; title: string; stored: string; derived: string }[];
};

/** The detector the driver injects: the parser's own "the title states a
 *  finish this identity does not account for" flag, asked with the
 *  DESTINATION's product context. */
const titleStatesUnaccountedFinish = (title: string, destSide: { setKey?: string; cardYear?: number }) => {
  const t = String(title ?? "");
  if (!t.trim() || !destSide) return null;
  const setKey = String(destSide.setKey ?? "").toLowerCase();
  const year = Number(destSide.cardYear);
  if (!setKey || !Number.isFinite(year)) return null;
  try {
    return pti.parseListingIdentity(t, undefined, { setKey, year }).parallelIsUnconfirmed === true;
  } catch { return null; }
};

/** A HIQ-SPLIT row whose cardId side is backed and whose hobbyiqCardId side is
 *  not, so the judge reaches the move arm and R55 is the only thing left. */
function judge(title: string, dest: string, opts: Record<string, unknown> = {}) {
  // JUDGED ON cardNumber, NOT setKey. The axis has to be one the title
  // actually names, or the row parks at `title-does-not-name-destination`
  // before R55 is ever reached -- these titles write "Prestige", not the
  // registered spelling `panini-prestige`, so a setKey-axis harness would
  // test the wrong refusal. The number IS in every one of these titles, so the
  // cardNumber axis is what puts the row on the move arm where R55 lives.
  const destNumber = String(dest).split(":")[3];
  return SS.classifySplitScope(
    {
      cardId: `hiq:${dest}`,
      hobbyiqCardId: `hiq:football:2024:unknown:${destNumber}9:base:no-auto`,
      title,
    },
    ["cardNumber"],
    { isRegisteredSetKey: (k: string) => String(k).toLowerCase() !== "unknown", ...opts },
  );
}

// ---------------------------------------------------------------------------
// DREW'S THREE EXAMPLES
// ---------------------------------------------------------------------------
describe("R55 parks a move whose title names more than the destination", () => {
  it.each([
    ["Jahmyr Gibbs 2024 Prestige Heroes Holo Foil #3 Detroit Lions Star Pro Bowl",
      "football:2024:panini-prestige:3:base:no-auto"],
    ["2025-26 SP Authentic Acetate Retro Future Watch Connor McDavid Edmonton #226 SSP",
      "hockey:2025:sp-authentic:226:base:no-auto"],
    ["Nikita Zadorov Retro 2025-26 O-Pee-Chee #351 Boston Bruins",
      "hockey:2025:o-pee-chee:351:base:no-auto"],
  ])("%s", (title, dest) => {
    const v = judge(title, dest, { titleStatesUnaccountedFinish });
    expect(v.verdict).toBe("split-park");
    expect(v.reason).toBe("split-scope-parks:title-names-more-than-destination");
    // A park has no destination, by definition.
    expect(v.destination).toBeNull();
  });

  it("MUTATION: without the guard every one of them moves", () => {
    // The pins above would also pass against a judge that parked for some
    // unrelated reason. This is what makes them about R55.
    for (const [title, dest] of [
      ["Jahmyr Gibbs 2024 Prestige Heroes Holo Foil #3 Detroit Lions Star Pro Bowl",
        "football:2024:panini-prestige:3:base:no-auto"],
      ["2025-26 SP Authentic Acetate Retro Future Watch Connor McDavid Edmonton #226 SSP",
        "hockey:2025:sp-authentic:226:base:no-auto"],
      ["Nikita Zadorov Retro 2025-26 O-Pee-Chee #351 Boston Bruins",
        "hockey:2025:o-pee-chee:351:base:no-auto"],
    ] as [string, string][]) {
      expect(judge(title, dest).verdict).toBe("split-move");
    }
  });
});

// ---------------------------------------------------------------------------
// WHAT MUST STILL MOVE
// ---------------------------------------------------------------------------
describe("R55 narrows and never widens", () => {
  it("a fill onto the destination's OWN rung stays a move", () => {
    // Drew's carve-out: "printRun/parallel fills stay allowed when the stated
    // rung is in the product's ladder". The destination NAMES Press Proof
    // Silver, so nothing in the title is unaccounted for.
    const v = judge(
      "2024 Panini Donruss - Ka'imi Fairbairn #113 Press Proof Silver /100",
      "football:2024:panini-donruss:113:press-proof-silver:no-auto:num-100",
      { titleStatesUnaccountedFinish },
    );
    expect(v.verdict).toBe("split-move");
  });

  it("a title naming nothing beyond the destination stays a move", () => {
    const v = judge(
      "2024 Panini Prizm #301 Caleb Williams - Raw",
      "football:2024:panini-prizm:301:base:no-auto",
      { titleStatesUnaccountedFinish },
    );
    expect(v.verdict).toBe("split-move");
  });

  it("an unasked caller keeps today's behaviour", () => {
    // `null` means the driver could not ask. The guard must not park on
    // absence, or a caller without the parser parks every row.
    const v = judge(
      "Jahmyr Gibbs 2024 Prestige Heroes Holo Foil #3 Detroit Lions Star Pro Bowl",
      "football:2024:panini-prestige:3:base:no-auto",
      { titleStatesUnaccountedFinish: () => null },
    );
    expect(v.verdict).toBe("split-move");
  });

  it("R55 is asked LAST — an earlier park keeps its own reason", () => {
    // Both sides unbacked parks before R55 is reached, and the reason must
    // still say so; a guard that rewrote earlier verdicts would hide them.
    const v = SS.classifySplitScope(
      { cardId: "hiq:football:2024:unknown:3:base:no-auto",
        hobbyiqCardId: "hiq:football:2024:unknown:9:base:no-auto",
        title: "Jahmyr Gibbs 2024 Prestige Heroes Holo Foil #3" },
      ["setKey"],
      { isRegisteredSetKey: () => false, titleStatesUnaccountedFinish },
    );
    expect(v.verdict).toBe("split-park");
    expect(v.reason).toBe("neither-side-checklist-backed");
  });
});

// ---------------------------------------------------------------------------
// THE BLANK VOCABULARY MIRROR
// ---------------------------------------------------------------------------
describe("splitScopeMirrorsGenericParallels", () => {
  it("split-scope's blank-parallel set is identical to the classifier's", () => {
    // R55 only fires where the destination says "blank", and both modules must
    // mean the same thing by that. They are duplicated (split-scope is pure and
    // must not require the classifier, which needs a built dist/), so this is
    // what keeps them from drifting.
    expect([...SS.GENERIC_PARALLELS].sort()).toEqual([...K.GENERIC_PARALLELS].sort());
  });
});

// ---------------------------------------------------------------------------
// THE WHOLE SAMPLE, COUNTED
// ---------------------------------------------------------------------------
describe("R55 measured over the run's own 140 IMPROVE evidence rows", () => {
  const toSide = (ident: string) => {
    const p = String(ident).split(":");
    return { sport: p[0], cardYear: Number(p[1]), setKey: p[2], cardNumber: p[3], parallel: p[4] };
  };

  // PIN UPDATED 2026-09-19 (R66 PR 2 follow-up, byte-corruption repair).
  //
  // `statedFinishFromChecklist.ts` carried TWO `/\bbase\b/i` regexes (this
  // module's own "the seller said Base" refusal, and the reader's matching
  // guard) written through a shell heredoc at some earlier point in this
  // repo's history, which silently turned `\b` (word boundary) into a raw
  // 0x08 backspace BYTE -- a regex requiring a literal backspace character
  // around the word, which real listing titles never contain. Confirmed
  // present on `main` and at every commit back to 0b1114a4, so this predates
  // R66 entirely; `git grep -nP '\x08' -- backend/src backend/scripts`
  // found it (and 5 other unrelated instances, fixed alongside it -- see
  // this PR's own handback for the full list, none in a declared
  // derivation-stamp-input file).
  //
  // THE EFFECT ON THIS PIN, MEASURED ROW BY ROW. Fixing the byte made "the
  // seller said Base" (this file's own `titleStatesAnUnconfirmedFinish`,
  // `if (/\bbase\b/i.test(t)) return false;`) match for the first time ever,
  // and 3 of the 49 previously-parked rows literally state the word "Base"
  // in their title:
  //
  //   "Lionel Messi 2025-26 Panini Donruss Road to FIFA World Cup Orange
  //    Base /99 #154" -- the seller wrote "Base" outright; "Orange" here is
  //    not this module's business to override once the seller has spoken,
  //    per this file's own doctrine ("CF-NO-REFRACTOR-IS-A-BASE forbids
  //    overriding them"). Un-parking it is the doctrine working correctly
  //    for the first time, not a new gap.
  //   "2025 Topps Chrome MLS - Base & Rookie Cards #1-200 - Pick Your
  //    Card!" and "2024 Topps Chrome Football Base #1-200 (You Pick) -
  //    Legends & Current Players" -- both ALSO say "Base" AND are lot
  //    listings (#1-200, "Pick Your Card"/"You Pick") -- exactly the
  //    already-documented "KNOWN GAP" category below, which is why the
  //    second test's lot-shaped count grows from 4 to 6 rather than
  //    shrinking: these two didn't stop being lot-shaped, they simply
  //    moved from the (wrongly) parked bucket into the gap this file
  //    already names.
  //
  // No row moved the OTHER direction (a real finish silently un-parked);
  // verified by diffing the full 86-row park/no-park list before and after
  // the byte fix and finding exactly these 3 flips, all onto an explicit
  // seller "Base" statement.
  it("parks 46 of the 86 Base-destination rows, and keeps 40", () => {
    let destBase = 0, parked = 0;
    for (const r of fixture.rows) {
      const dest = toSide(r.derived);
      if (!SS.GENERIC_PARALLELS.has(String(dest.parallel ?? "").toLowerCase())) continue;
      destBase++;
      if (titleStatesUnaccountedFinish(r.title, dest) === true) parked++;
    }
    expect(fixture.rows.length).toBe(140);
    expect(destBase).toBe(86);
    expect(parked).toBe(46);
    expect(destBase - parked).toBe(40);
  });

  it("KNOWN GAP: 6 lot listings still move, and R55 is not the rule for them", () => {
    // Recorded rather than fixed. A lot states no single card's identity, so
    // these are wrong for a different reason than "the title names more than
    // the destination" -- the same `isMultiCardLot` refusal the parallel
    // readers carry, which this scope does not yet apply. Widening R55 to
    // cover them would be ruling on something Drew did not rule on; this test
    // is the record so the gap is visible rather than assumed closed.
    //
    // GREW FROM 4 TO 6 (2026-09-19, byte-corruption repair, see above): the
    // 2 additional rows ("Topps Chrome MLS ... Pick Your Card!", "Topps
    // Chrome Football ... (You Pick)") were ALREADY lot-shaped before this
    // fix -- they were simply miscounted as "parked" because the seller's
    // own "Base" statement in a lot title used to be invisible to the dead
    // regex. They belong in this bucket, not the parked one.
    const lotShaped: string[] = [];
    for (const r of fixture.rows) {
      const dest = toSide(r.derived);
      if (!SS.GENERIC_PARALLELS.has(String(dest.parallel ?? "").toLowerCase())) continue;
      if (titleStatesUnaccountedFinish(r.title, dest) === true) continue;
      if (/\blot\b|\bpick your card\b|#\d+-\d+|\bcomplete\b/i.test(r.title)) lotShaped.push(r.title);
    }
    expect(lotShaped).toHaveLength(6);
  });
});
