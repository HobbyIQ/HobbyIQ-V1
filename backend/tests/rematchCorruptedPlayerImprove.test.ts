/**
 * THE GREAT REMATCH: a corrupted `player-<name>` is an IMPROVE when the
 * replacement is checklist-backed, and REPORT-ONLY when it is not.
 *
 * CF-A-PLAYER-SEGMENT-IS-A-PERSON (Drew, 2026-09-04). hobbyIqCardId.service.ts
 * argues the pseudo-number is "SAFE BECAUSE THE NAMES ARE CLEAN" and checked
 * that the only way it could at the time -- it looked for names that COLLIDE
 * under slugify and folded the 20 groups it found. It never asked whether each
 * name was A PERSON.
 *
 * The census (data/gap-reports/2026-09-04-player-field-corruption-census.json,
 * 115,535 rows read on 2026-09-04) asks that question:
 *
 *     85,865  clean
 *     15,207  a PRODUCT or brand word inside the name
 *      6,976  a FINISH or parallel word inside the name
 *      4,569  TRUNCATED -- ends mid-name, on a particle
 *      2,902  NOT A PERSON -- a set code, a franchise word
 *     ------
 *     29,654  corrupted = 25.7% of the population
 *
 * So the premise the shape rests on is false for a quarter of the rows, and
 * those rows are keyed to people who do not exist -- which splits the real
 * player's pool and prices a card against sales of nothing.
 *
 * WHAT THIS FILE PINS
 *
 *   1. a corrupted stored player, re-derived onto a clean CHECKLIST-BACKED
 *      identity, classifies IMPROVE and is writable.
 *   2. WITHOUT checklist backing it is CONFLICT / report-only. Knowing the
 *      stored name is wrong is not knowing the right one -- absent beats wrong
 *      on BOTH sides of the swap.
 *   3. a CLEAN stored player is never blanked. The rule reaches corrupted rows
 *      only; a correct T206 Wagner row is untouched.
 *   4. PROTECTED rows stay report-only, as they are for every other class.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));

// `player-mega-box-elly-de` as it sits in the pool: a product word rode into
// the name and the truncation cut "Elly De La Cruz" mid-surname.
const ELLY_TITLE = "2023 Topps Chrome Mega Box Elly De La Cruz #150 Refractor PSA 10";

const storedCorrupt = {
  sport: "baseball", cardYear: 2023, setKey: "topps-chrome",
  cardNumber: "player-mega-box-elly-de", parallel: "Refractor", isAuto: false,
  printRun: null, gradeCompany: "PSA", gradeValue: 10,
};
const derivedClean = { ...storedCorrupt, cardNumber: "150" };

const row = (over: Record<string, unknown> = {}) => ({
  id: "sc-elly", source: "tca-ebay", title: ELLY_TITLE,
  cardId: "hiq:baseball:2023:topps-chrome:player-mega-box-elly-de:refractor:no-auto:psa-10",
  ...over,
});

describe("isCorruptedPlayerName -- the fact, not a confidence", () => {
  it("a name cut mid-surname is corrupted", () => {
    expect(K.isCorruptedPlayerName("mega box elly de")).toBe(true);
    expect(K.isCorruptedPlayerName("jose de la")).toBe(true);
  });

  it("a franchise or layout token means it is not a person", () => {
    expect(K.isCorruptedPlayerName("pokemon swsh fa mew")).toBe(true);
  });

  it("a real name is NOT corrupted -- including real short and particled ones", () => {
    for (const clean of ["greg maddux", "elly de la cruz", "ken griffey jr", "honus wagner"]) {
      expect(K.isCorruptedPlayerName(clean)).toBe(false);
    }
  });
});

describe("a corrupted player name unlocks the re-key", () => {
  it("IMPROVE + writable when the derived identity is checklist-backed", () => {
    const r = K.classifyRow({
      row: row(), stored: storedCorrupt, derived: derivedClean,
      checklistBacked: true, storedPlayerCorrupted: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.writable).toBe(true);
  });

  it("the corruption is read off the row itself when the caller says nothing", () => {
    // `storedPlayerCorrupted` is the caller's fact, but a name ending on a
    // particle is legible from the stored value alone, so the census does not
    // have to be re-run for the rule to hold.
    const r = K.classifyRow({
      row: row(), stored: storedCorrupt, derived: derivedClean,
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
  });

  it("REPORT-ONLY without checklist backing -- wrong is not the same as knowing right", () => {
    const r = K.classifyRow({
      row: row(), stored: storedCorrupt, derived: derivedClean,
      checklistBacked: false, storedPlayerCorrupted: true,
    });
    expect(r.klass).not.toBe(K.IMPROVE);
    expect(r.writable).toBe(false);
  });
});

describe("a CLEAN pseudo-number is left exactly where it is", () => {
  // A T206 Wagner is genuinely unnumbered and its player IS the identifier.
  const wagnerStored = {
    sport: "baseball", cardYear: 1909, setKey: "t206",
    cardNumber: "player-honus-wagner", parallel: "Base", isAuto: false,
    printRun: null,
  };

  it("is not blanked, so a noisy derivation cannot re-key it", () => {
    const r = K.classifyRow({
      row: row({ title: "1909-11 T206 Honus Wagner PSA 2", cardId: "hiq:baseball:1909:t206:player-honus-wagner:base:no-auto" }),
      stored: wagnerStored,
      derived: { ...wagnerStored, cardNumber: "2" },
      checklistBacked: true,
    });
    expect(r.klass).not.toBe(K.IMPROVE);
    expect(r.writable).toBe(false);
  });
});

describe("provenance still outranks the class", () => {
  it("a PROTECTED row is report-only even when the name is corrupted", () => {
    const r = K.classifyRow({
      row: row({ source: "ebay-user-purchase" }),
      stored: storedCorrupt, derived: derivedClean,
      checklistBacked: true, storedPlayerCorrupted: true,
    });
    expect(r.writable).toBe(false);
  });
});
