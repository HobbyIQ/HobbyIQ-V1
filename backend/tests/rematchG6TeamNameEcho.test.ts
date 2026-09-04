/**
 * A TEAM NAME IS NOT A PARALLEL -- G6 READ ONE AS ONE.
 *
 * CF-A-TEAM-NAME-IS-NOT-A-FINISH, at G6 (found auditing the live pool AFTER
 * the base-eviction apply ran on all 32 shards, 2026-09-04).
 *
 * The apply moved 4,283 of the 9,265 base-in-refractor rows and left 4,982.
 * Re-running the COMMITTED classifier over the survivors to ask why each one
 * stayed put, the single commonest refusal on the Bowman cells was G6's
 * `title-echoes-slug-parallel` -- fired on a ONE-WORD COLOUR parallel whose
 * only occurrence in the title is the TEAM:
 *
 *   ...:red:...    "Jon Papelbon 2006 Bowman #76 Boston RED SOX MLB READ"
 *   ...:blue:...   "Vladimir Guerrero Jr. 2025 Bowman #27 BLUE JAYS MLB"
 *   ...:white:...  "... #12 Chicago WHITE SOX ..."
 *   ...:green:...  "... GREEN BAY Packers ..."
 *
 * Every one of those sellers named NO finish. The rows are base sales sitting
 * on colour slugs -- precisely the split pool the GREAT REMATCH exists to end
 * -- and G6 was standing in front of them holding the door shut. This is the
 * over-broad direction `rematchSlugParallelEcho.test.ts` names in its own
 * comments: the failure that "silently halts the program rather than
 * announcing itself", because nothing complains about an eviction not made.
 *
 * THE PRECEDENT WAS ALREADY IN THE TREE, TWICE, AND G6 WAS THE THIRD SITE.
 * `titleNearMissesFinish` was narrowed for the identical shape (the census
 * sample's truncated "Diamondb" read as a typo of the finish word "diamond",
 * refusing a genuine eviction), and measure-bowman-base-refractor-mix.cjs
 * strips the same phrases before it tokenizes a title at all. G6 shipped
 * without the guard both of its neighbours already had.
 *
 * THE FIX IS PHRASE-STRIPPING, NOT A COLOUR BLOCKLIST, and the difference is
 * the whole safety argument: a genuine "Blue Refractor /150 Blue Jays" title
 * must still defend its row. Removing the TEAM PHRASE and then looking for
 * the colour in what remains keeps that row refused while releasing the row
 * whose only blue is the Jays.
 *
 * Pinned BOTH ways, because this narrowing is the direction that can do
 * damage: the four team titles must evict, and the honest parallels -- multi
 * word, colour-plus-team, and the original 12 DAMAGED rows G6 was built for --
 * must still refuse.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;

/**
 * THE FIXTURE IS THE FINDING. Real survivor rows, quoted from the live pool
 * after the apply, each with the colour slug it is stranded on. `storedParallel`
 * is "Base" on every one -- guard 2 passes, the row's own hand says base, and
 * only G6 stood between the sale and its base pool.
 */
const STRANDED = [
  { slug: "red", title: "Jon Papelbon 2006 Bowman #76 Boston Red Sox MLB READ FREE SHIPPING AutographDen", team: "Red Sox" },
  { slug: "blue", title: "Vladimir Guerrero Jr. 2025 Bowman #27 Blue Jays MLB READ FREE SHIP AutographDen", team: "Blue Jays" },
  { slug: "blue", title: "Andrés Giménez 2025 Topps Chrome #70 Blue Jays Insert ? SEE SCAN! FREE SHIP", team: "Blue Jays" },
  { slug: "white", title: "2019 Bowman #12 Chicago White Sox Eloy Jimenez Rookie", team: "White Sox" },
  { slug: "green", title: "2021 Bowman #5 Green Bay Packers Aaron Rodgers", team: "Green Bay" },
];

describe("the team name no longer counts as the seller naming a finish", () => {
  it.each(STRANDED)("$team does not echo the $slug slug", ({ slug, title }) => {
    expect(K.titleEchoesSlugParallel(title, slug)).toBeNull();
    expect(K.storedParallelStatedInTitle({
      title, storedSlug: `hiq:baseball:2025:bowman:27:${slug}:no-auto`,
      stored: { parallel: "Base" }, setKey: "bowman",
    })).toBeNull();
  });

  it("strips the phrase, not the colour -- a colour outside the team still echoes", () => {
    // The row that proves this is not a colour blocklist. "Blue" appears
    // twice: once as the parallel the seller named, once as the team. Strip
    // the team and the parallel is still there, so the row stays put.
    const both = "2025 Bowman Chrome Blue Refractor /150 Blue Jays Vladimir Guerrero Jr.";
    expect(K.titleEchoesSlugParallel(both, "blue")).toBe("blue");
    expect(K.titleEchoesSlugParallel(both, "blue-refractor")).toBe("blue-refractor");
  });

  it("leaves multi-word parallels untouched -- they could never collide with a team", () => {
    expect(K.titleEchoesSlugParallel("2025 Topps Chrome Pink Refractor #12", "pink-refractor")).toBe("pink-refractor");
    expect(K.titleEchoesSlugParallel("2023 Bowman Chrome Cam Collier Auto CPA-CC", "base-refractor")).toBeNull();
  });

  it("does NOT disturb the 12 DAMAGED rows G6 was built for", () => {
    // The regression that would matter most: G6's whole reason for existing is
    // a parallel the corpus has never heard of defending itself. None of these
    // phrases is a team, so none is touched.
    const mercury = "2025 Topps Cosmic Chrome Joe Burrow Planetary Pursuit Mercury #PPM-JB Bengals";
    expect(K.titleEchoesSlugParallel(mercury, "mercury")).toBe("mercury");
    expect(K.titleEchoesSlugParallel("2025 Topps Cosmic Chrome Cam Skattebo Planetary Pursuit EARTH Rookie RC #PPEA-CS", "earth")).toBe("earth");
    expect(K.titleEchoesSlugParallel("Topps 2025 Cosmic Chrome Justin Jefferson Vikings Venus Insert #PPV-JJ", "venus")).toBe("venus");
    expect(K.titleEchoesSlugParallel("2025 Score - Rookies Derrick Harmon #81 Signatures (AU, RC)", "signatures")).toBe("signatures");
  });

  it("the stripper is exported and removes only the phrase", () => {
    expect(K.titleWithoutTeamNames("Boston Red Sox Blue Refractor")).not.toMatch(/red\s+sox/);
    // The colour that was NOT part of a team survives, which is the property
    // the honest-title case above depends on.
    expect(K.titleWithoutTeamNames("Boston Red Sox Blue Refractor")).toMatch(/blue/);
  });
});

/**
 * GUARD 3 WAS THE BINDING REFUSAL, AND IT HAD THE SAME BUG.
 *
 * G6 above is one of TWO refusals these rows collected. The finish VOCABULARY
 * fired first: Bowman genuinely prints a bare "Red", "Blue", "White" and
 * "Green" parallel, so each is a legitimate finish TOKEN, and the corpus is
 * right about the word. What was wrong is the OCCURRENCE -- the only place the
 * colour appears in these titles is the team name.
 *
 * Measured over 921,000 rows of the live pool, 193 of 1,501 surviving
 * base-in-refractor rows (12.9%) are refused by guard 3 on a colour that
 * occurs nowhere but a team name.
 *
 * The strip is applied AT THE BASE-EVICTION CALL SITE, not inside
 * `titleNamesFinish`, because the IMPROVE guards consult the same predicate
 * and a false answer there makes THOSE guards more conservative. This pin
 * holds that boundary: base-eviction sees the stripped witness, the shared
 * vocabulary function is unchanged for every other caller.
 */
describe("guard 3 -- the finish vocabulary no longer reads a team as a finish", () => {
  const evict = (title: string, year: number, setKey: string, seg: string) => {
    const slug = `hiq:baseball:${year}:${setKey}:1:${seg}:no-auto`;
    const stored = { sport: "baseball", cardYear: year, setKey, cardNumber: "1", parallel: "Base", isAuto: false, printRun: null };
    return K.baseEvictionEvidence({
      row: { id: "x", cardId: slug, source: "cardhedge", title },
      stored, derived: { ...stored }, storedSlug: slug,
      baseDestSlug: "hiq:baseball:2006:bowman:1:base:no-auto", baseDestBacked: true,
    });
  };

  it("the four team titles now QUALIFY -- the sale reaches its base pool", () => {
    expect(evict("Jon Papelbon 2006 Bowman #76 Boston Red Sox MLB READ", 2006, "bowman", "red").qualifies).toBe(true);
    expect(evict("Vladimir Guerrero Jr. 2025 Bowman #27 Blue Jays MLB", 2025, "bowman", "blue").qualifies).toBe(true);
    expect(evict("2019 Bowman #12 Chicago White Sox Eloy Jimenez Rookie", 2019, "bowman", "white").qualifies).toBe(true);
    expect(evict("2021 Bowman #5 Green Bay Packers Aaron Rodgers", 2021, "bowman", "green").qualifies).toBe(true);
  });

  it("a colour named OUTSIDE the team still refuses -- both guards say so", () => {
    const r = evict("2025 Bowman Chrome Blue Refractor /150 Blue Jays Vlad Jr", 2025, "bowman-chrome", "blue");
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("title-names-a-finish");
  });

  it("the shared vocabulary predicate itself is UNCHANGED -- IMPROVE is not touched", () => {
    // The boundary that keeps this fix inside the one lane the audit cleared.
    // If this flips, `titleNamesFinish` was edited and the IMPROVE guards moved
    // with it.
    expect(K.titleNamesFinish("Jon Papelbon 2006 Bowman #76 Boston Red Sox", { year: 2006, setKey: "bowman" })).toBe(true);
  });
});

describe("MUTATION PIN -- the stranded row is released, the honest one is not", () => {
  const strandedInput = (over: Record<string, unknown> = {}) => {
    const slug = "hiq:baseball:2006:bowman:76:red:no-auto";
    const stored = {
      sport: "baseball", cardYear: 2006, setKey: "bowman", cardNumber: "76",
      parallel: "Base", isAuto: false, printRun: null,
    };
    return {
      row: { id: "sc-papelbon", cardId: slug, source: "cardhedge", title: STRANDED[0].title },
      stored, derived: { ...stored }, checklistBacked: true,
      storedSlug: slug, baseDestSlug: "hiq:baseball:2006:bowman:76:base:no-auto",
      baseDestBacked: true,
      ...over,
    };
  };

  it("the Papelbon row is a BASE-EVICTION again, and writable", () => {
    const r = K.classifyRow(strandedInput());
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(true);
    // and the refusal that used to be here is gone by name
    expect(r.reasons.join(",")).not.toMatch(/title-echoes-slug-parallel/);
  });

  it("the same row whose title DOES name the colour outside the team stays refused", () => {
    // One word added -- the parallel the seller actually named. The row must
    // flip straight back to refused, or the narrowing is over-broad.
    const honest = "Jon Papelbon 2006 Bowman #76 Red Refractor Boston Red Sox MLB";
    const r = K.classifyRow(strandedInput({
      row: { id: "sc-papelbon", cardId: "hiq:baseball:2006:bowman:76:red:no-auto", source: "cardhedge", title: honest },
    }));
    expect(r.subclass).not.toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(false);
  });
});
