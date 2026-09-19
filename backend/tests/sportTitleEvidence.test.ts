/**
 * sport-title-evidence.cjs -- the R76 gazetteer.
 *
 * Pins the module BOTH the restore lane (revert-set-sport-repair.cjs) and
 * setSportAuthority.cjs's own veto reuse, against:
 *   - the census's 300-row hand-judged validation sample (0 misses required
 *     -- see r76/validation-300.json, ported to fixtures/r76/validation-300.json)
 *   - the 7 false-positive phrase-exclusion cases the full-population sweep
 *     found (Wizards of the Coast, Phantasmal Flames, Lightning Strike x2)
 *   - the three named known-good cases from the ruling: a 1989 O-Pee-Chee
 *     Trevor Linden Canucks hockey card, a 1997-98 Metal Universe Indiana
 *     Pacers basketball card, and a Kobe Bryant "Lightning Strikes"
 *     basketball insert that must NOT be pulled toward hockey by the word
 *     "lightning".
 *   - a byte check that the committed source carries no 0x08/0x00 bytes (a
 *     heredoc-authored file would turn every \b into byte 0x08; this module
 *     is built entirely on \b-shaped word-boundary regexes).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../scripts/lib/sport-title-evidence.cjs") as {
  sportEvidence: (title: string) => { sports: Set<string>; hits: Array<{ word: string; sport: string }>; onlyAmbiguousWords: boolean };
  judgeRestoreVerdict: (input: { title: string; sportBefore: string; currentSport: string }) => { verdict: "restore" | "keep" | "leave"; reason: string; detail: string };
  AMBIGUOUS_NICKNAMES: Map<string, Set<string>>;
};

const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "r76");
const VALIDATION_300 = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "validation-300.json"), "utf8")) as Array<{
  id: string; title: string; sportBefore: string; sport: string; sampleStratum: string;
}>;
const FALSE_POSITIVES = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "false-positive-exclusions.json"), "utf8")) as Array<{
  id: string; title: string; cardId: string; reason: string;
}>;

describe("sport-title-evidence: source hygiene", () => {
  it.each([
    ["scripts/lib/sport-title-evidence.cjs"],
    ["scripts/lib/setSportAuthority.cjs"],
    ["scripts/revert-set-sport-repair.cjs"],
  ])("%s carries no byte 0x08 or 0x00 -- a heredoc turns \\b into 0x08, and this R76 surface is all word-boundary regexes", (rel) => {
    const bytes = fs.readFileSync(path.resolve(__dirname, "..", rel));
    let has08 = false, has00 = false;
    for (const b of bytes) {
      if (b === 0x08) has08 = true;
      if (b === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });
});

describe("sport-title-evidence: the 300-row census validation sample", () => {
  it("reproduces restore for all 300 rows (0 misses, matching the census's own validation-300.json conclusion)", () => {
    const misses: Array<{ id: string; title: string; verdict: unknown }> = [];
    for (const row of VALIDATION_300) {
      const verdict = mod.judgeRestoreVerdict({ title: row.title, sportBefore: row.sportBefore, currentSport: row.sport });
      if (verdict.verdict !== "restore") misses.push({ id: row.id, title: row.title, verdict });
    }
    expect(misses).toEqual([]);
  });

  it("loaded all 300 rows (guards against an empty/truncated fixture silently passing)", () => {
    expect(VALIDATION_300.length).toBe(300);
  });
});

describe("sport-title-evidence: the 7 full-population false-positive misses (R76 phrase exclusions)", () => {
  it("never lets 'Wizards of the Coast' Pokemon cards register basketball evidence from 'wizards'", () => {
    const row = FALSE_POSITIVES.find((r) => r.id === "tca-ebay::307079114175")!;
    const { sports } = mod.sportEvidence(row.title);
    expect(sports.has("basketball")).toBe(false);
  });

  it("never lets a 'Phantasmal Flames' Pokemon card register hockey evidence from 'flames'", () => {
    const row = FALSE_POSITIVES.find((r) => r.id === "tca-ebay::168576096718")!;
    const { sports } = mod.sportEvidence(row.title);
    expect(sports.has("hockey")).toBe(false);
  });

  it("never lets a soccer 'Lightning Strike' insert (Ronaldo/Mbappe, UEFA Champions League) register hockey evidence from 'lightning'", () => {
    for (const id of [
      "tca-ebay::goldin_202107-1820-0000-1d0dd408-feba-2125-90a6-b0c6aec80654",
      "tca-ebay::goldin_202107-1820-0000-85468ea9-5057-af57-174b-4d172cedc3f7",
    ]) {
      const row = FALSE_POSITIVES.find((r) => r.id === id)!;
      const { sports } = mod.sportEvidence(row.title);
      expect(sports.has("hockey")).toBe(false);
      expect(sports.has("soccer")).toBe(true); // UEFA / Champions League still name soccer correctly
    }
  });

  it("never lets a soccer 'Lightning Strike' insert (Kanu, AFC Ajax) register hockey evidence from 'lightning'", () => {
    const row = FALSE_POSITIVES.find((r) => r.id === "tca-ebay::318669158839")!;
    const { sports } = mod.sportEvidence(row.title);
    expect(sports.has("hockey")).toBe(false);
  });

  it("every one of the 7 false-positive rows is excluded from its spurious sport", () => {
    for (const row of FALSE_POSITIVES) {
      const { sports } = mod.sportEvidence(row.title);
      if (row.reason === "WoC") expect(sports.has("basketball")).toBe(false);
      if (row.reason === "phantasmal") expect(sports.has("hockey")).toBe(false);
      if (row.reason === "ronaldo-mbappe" || row.reason === "kanu") expect(sports.has("hockey")).toBe(false);
    }
  });
});

describe("sport-title-evidence: known-good cases named in the R76 ruling", () => {
  it("1989 O-Pee-Chee Trevor Linden RC Canucks restores to hockey (title backs sportBefore=hockey, not baseball)", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "1989 O-PEE-CHEE #89 TREVOR LINDEN RC CANUCKS",
      sportBefore: "hockey",
      currentSport: "baseball",
    });
    expect(verdict.verdict).toBe("restore");
  });

  it("1997-98 Metal Universe Indiana Pacers restores to basketball (title backs sportBefore=basketball, not baseball)", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "1997-98 Metal Universe Championship Reggie Miller Indiana Pacers",
      sportBefore: "basketball",
      currentSport: "baseball",
    });
    expect(verdict.verdict).toBe("restore");
  });

  it("Kobe Bryant 'Lightning Strikes' stays basketball -- the flip was right, KEEP, never pulled toward hockey by 'lightning'", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "2000-01 Upper Deck Kobe Bryant Lightning Strikes Los Angeles Lakers",
      sportBefore: "baseball",
      currentSport: "basketball",
    });
    expect(verdict.verdict).toBe("keep");
  });
});

describe("sport-title-evidence: ambiguous nicknames resolve directionally, exactly as the census's own classifier did", () => {
  it("'Kings' (NBA + NHL) still restores a basketball card wrongly flipped to baseball -- neither league fields a baseball Kings", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "1994-95 FLEER ULTRA HAKEEM OLAJUWON REBOUND KINGS #6 PSA 8 NM-MT HOF LOW POP",
      sportBefore: "basketball",
      currentSport: "baseball",
    });
    expect(verdict.verdict).toBe("restore");
  });

  it("'Kings' still restores a hockey card wrongly flipped to baseball", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "2008-09 UPPER DECK YOUNG GUNS DREW DOUGHTY BGS 9.5 #220 LOS ANGELES KINGS",
      sportBefore: "hockey",
      currentSport: "baseball",
    });
    expect(verdict.verdict).toBe("restore");
  });

  it("'Kings' alone leaves basketball-vs-hockey undecided when THAT is the actual dispute (both-named)", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "Some Kings Card With Nothing Else Naming A League",
      sportBefore: "basketball",
      currentSport: "hockey",
    });
    expect(verdict.verdict).toBe("leave");
    expect(verdict.reason).toBe("both-named");
  });

  it("AMBIGUOUS_NICKNAMES is computed from real multi-league overlaps, not empty", () => {
    expect(mod.AMBIGUOUS_NICKNAMES.get("kings")).toEqual(new Set(["hockey", "basketball"]));
    expect(mod.AMBIGUOUS_NICKNAMES.has("redskins")).toBe(false); // NFL-only, unambiguous
  });
});

describe("sport-title-evidence: third-sport and no-evidence leave", () => {
  it("a title naming a THIRD sport (neither before nor current) is left, not guessed", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "2018 Topps Chrome UEFA Champions League Lightning Strike Gold #LSKM Kylian Mbappe",
      sportBefore: "hockey",
      currentSport: "basketball",
    });
    expect(verdict.verdict).toBe("leave");
    expect(verdict.reason).toBe("third-sport");
  });

  it("a title naming no recognised sport is left as no-evidence", () => {
    const verdict = mod.judgeRestoreVerdict({
      title: "Card #17 Mint Condition Gem",
      sportBefore: "basketball",
      currentSport: "baseball",
    });
    expect(verdict.verdict).toBe("leave");
    expect(verdict.reason).toBe("no-evidence");
  });
});
