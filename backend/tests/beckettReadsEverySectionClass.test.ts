/**
 * CF-BECKETT-READS-EVERY-SECTION-CLASS (2026-09-04).
 *
 * The lane census found the Beckett lane "healthy on autos" with a residual
 * that was "relic-only ... a vocabulary gap, not a section skip". Reading the
 * source proved the second half of that wrong in an interesting way: relics
 * ride as `insert-<subset>` by design — the catalog has no cardType field, and
 * the subset name IS the memorabilia vocabulary, exactly as
 * fetchHobbyMonitorChecklist.cjs (the lane the census called complete) emits
 * them. Nothing was missing from the row shape.
 *
 * What was missing was the SECTION NAME, which four separate defects in the
 * converter were deleting before it could reach the row. Measured across 48
 * live workbooks pulled from the Beckett archive:
 *
 *   1. SUPERSET SHEETS. SKIP_SHEETS knew five literal spellings. Publishers use
 *      six more ("Master Card List", "Master Checklist", "Parallel Guide",
 *      "Metal - Parallels", "Holo Prospect Sigs Parallels", "Aquatic -
 *      Parallels") for 105,483 re-listed card lines. A Master Card List is a
 *      WIDE MATRIX, so its columns are product/subset, not number/player, and it
 *      emitted rows like `2026 Leaf Electrum Baseball,,false,,Achromatic`.
 *
 *   2. SHEET -> CARD TYPE. categoryFor() matched three sheet names as literals
 *      and swept the rest into insert-. "Autographed Relics" (391 cards) and
 *      "Multi-Signed Autographs" (96) are sheets whose own titles say SIGNED,
 *      and every one of those 487 cards was emitted isAuto=false. A checklist is
 *      the authority for isAuto; this lane was overruling it.
 *
 *   3. COUNT LINES. isCountLine had no trailing-period branch, so 2024 Bowman's
 *      "100 cards." became the section. All 18 section names in that product
 *      were replaced by their own card counts (`insert-15-cards`,
 *      `auto-1-card`) while the row count stayed plausible.
 *
 *   4. LADDERS. LADDER_HEAD required a colon that ZERO of the 90 bare
 *      "Parallels" headers in the corpus carry, and parseRung demanded a word
 *      from a twelve-item finish vocabulary that 1,594 numbered colour rungs
 *      ("Gold /10", "Platinum 1/1", "Emerald /5") fail. Each rejected line then
 *      became a section, which is why the corpus contains sections named
 *      "Superfractor /1". printRun is the one field a sale title can never
 *      reconstruct.
 *
 * These tests pin the four fixes against committed workbooks, and pin the
 * no-regression case: 2026 Topps Tier One converts BYTE-IDENTICALLY before and
 * after, because none of the four defects touch it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseRung, categoryFor, isSupersetSheet, isCountLine, LADDER_HEAD } =
  require("../scripts/convertBeckettChecklistXlsx.cjs");

const CONVERTER = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");
const FIXTURES = path.join(__dirname, "fixtures", "beckett");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-sections-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Row = {
  category: string; cardNumber: string; parallel: string;
  isAuto: string; printRun: string; player: string;
};

/** Run the real converter over a committed workbook and read back its rows. */
function convert(fixture: string, setKey: string, year = 2026): Row[] {
  const out = path.join(TMP, `${setKey}.csv`);
  execFileSync(process.execPath, [
    CONVERTER,
    "--xlsx", path.join(FIXTURES, fixture),
    "--year", String(year), "--set-key", setKey,
    "--set-name", `${year} ${setKey}`, "--out", out,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // The converter quotes only fields containing a comma or quote, and the
  // fields this suite asserts on never do — a split is enough and keeps the
  // test free of a CSV dependency.
  return fs.readFileSync(out, "utf8").trim().split("\n").slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...rest] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: rest.join(",") };
  });
}

const sectionsOf = (rows: Row[]) => new Set(rows.map((r) => r.category));

// ---------------------------------------------------------------------------
describe("a superset sheet is not a section", () => {
  it("names the roster sheets by shape, not by one more literal", () => {
    for (const n of [
      "Master Card List", "Master Checklist", "Parallel Guide",
      "Metal - Parallels", "Holo Prospect Sigs Parallels", "Aquatic - Parallels",
      "Full Checklist", "Team Sets", "Teams", "Checklist", "Master",
    ]) expect(isSupersetSheet(n), n).toBe(true);
  });

  it("keeps every sheet that actually lists cards", () => {
    // Including the two that carry a leading space or a hyphen — " Base" is
    // 2026 Panini Immaculate's own spelling, and an equality test missed it.
    for (const n of [
      "Base", " Base", "Base - Prospects", "Prospects", "Autographs", "Inserts",
      "Memorabilia", "Memorabilia Cards", "Relics", "Autographed Relics",
      "Multi-Signed Autographs", "Variations", "Optic", "Updates",
    ]) expect(isSupersetSheet(n), n).toBe(false);
  });

  it("emits no matrix row from 2026 Leaf Electrum's Master Card List", () => {
    const rows = convert("2026-Leaf-Electrum-Baseball-Checklist.xlsx", "leaf-electrum");
    expect(rows.length).toBeGreaterThan(0);
    // The tell of the wide matrix: the product name lands in the cardNumber
    // column and the subset lands in the player column.
    expect(rows.filter((r) => /Leaf Electrum Baseball/i.test(r.cardNumber))).toHaveLength(0);
    expect(sectionsOf(rows).has("insert-master-card-list")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the sheet names the card type", () => {
  it("reads a signature off any sheet whose title says signed", () => {
    expect(categoryFor("Autographed Relics", "Definitive Rookie Patch Autographs"))
      .toBe("auto-definitive-rookie-patch-autographs");
    expect(categoryFor("Multi-Signed Autographs", "Electrum Collection"))
      .toBe("auto-electrum-collection");
    expect(categoryFor("Autographs", "Chrome Prospect Autographs"))
      .toBe("auto-chrome-prospect-autographs");
  });

  it("leaves an unsigned memorabilia sheet as its own named subset", () => {
    // Relics ride as insert-<subset>. The subset name IS the memorabilia
    // vocabulary — the same shape the hobbymonitor lane emits — so a "cardType"
    // field would be a second way to say what the category already says.
    expect(categoryFor("Relics", "Tier One Relics")).toBe("insert-tier-one-relics");
    expect(categoryFor("Memorabilia", "Stamp Of Approval")).toBe("insert-stamp-of-approval");
    expect(categoryFor("Memorabilia Cards", "Definitive Helmet Collection"))
      .toBe("insert-definitive-helmet-collection");
  });

  it("files a base run as base however the sheet spells it", () => {
    for (const sheet of ["Base", " Base", "Base - Prospects", "Prospects"]) {
      expect(categoryFor(sheet, "Base Set"), sheet).toBe("base");
    }
  });

  it("marks 2026 Leaf Electrum's 26 multi-signed cards as signed", () => {
    const rows = convert("2026-Leaf-Electrum-Baseball-Checklist.xlsx", "leaf-electrum");
    const multi = rows.filter((r) => /^auto-(electrum-collection|intermetallic)/.test(r.category));
    expect(multi).toHaveLength(26);
    // Before the fix every one of these read insert-*, isAuto=false — a card
    // the publisher lists on a sheet called "Multi-Signed Autographs".
    for (const r of multi) expect(r.isAuto, r.cardNumber).toBe("true");
  });

  it("keeps an autographed relic signed AND named as memorabilia", () => {
    const rows = convert("2026-Topps-Tier-One-Baseball-Checklist.xlsx", "tier-one");
    const signedRelics = rows.filter((r) => /^auto-.*relic/.test(r.category));
    const plainRelics = rows.filter((r) => /^insert-.*relic/.test(r.category));
    expect(signedRelics.length).toBeGreaterThan(0);
    expect(plainRelics.length).toBeGreaterThan(0);
    for (const r of signedRelics) expect(r.isAuto).toBe("true");
    // A swatch is not a signature: an unsigned relic stays unsigned.
    for (const r of plainRelics) expect(r.isAuto).toBe("false");
  });
});

// ---------------------------------------------------------------------------
describe("a count line is not a section", () => {
  it("reads the trailing period 2024 Bowman writes", () => {
    for (const s of ["100 cards.", "1 card.", "15 cards.", "1,372 cards."]) {
      expect(isCountLine([s]), s).toBe(true);
    }
    // ...without swallowing the older spelling, or a real section.
    expect(isCountLine(["100 cards"])).toBe(true);
    expect(isCountLine(["Base Set"])).toBe(false);
    expect(isCountLine(["55 Bowman Anime Checklist"])).toBe(false);
  });

  it("recovers every 2024 Bowman section name", () => {
    const rows = convert("2024-Bowman-Baseball-Checklist.xlsx", "bowman", 2024);
    const cats = sectionsOf(rows);
    // Before the fix these were the ONLY names this product produced.
    for (const wrong of [
      "insert-15-cards", "insert-20-cards", "insert-100-cards",
      "auto-1-card", "auto-51-cards", "auto-87-cards",
    ]) expect(cats.has(wrong), wrong).toBe(false);
    // ...and these are the names Beckett actually printed.
    for (const right of [
      "insert-55-bowman-anime-checklist",
      "insert-bowman-scouts-top-100-checklist",
      "auto-chrome-prospect-autographs-checklist",
      "auto-2024-bowman-ultimate-autograph-book-card-checklist",
    ]) expect(cats.has(right), right).toBe(true);
    // Not one category may be named by a bare card count.
    for (const c of cats) expect(c, c).not.toMatch(/^(insert|auto)-\d+-cards?$/);
  });
});

// ---------------------------------------------------------------------------
describe("a colour with a serial on it is a rung, not a section", () => {
  it("opens a ladder on a bare 'Parallels' as well as 'Parallels:'", () => {
    // Zero of the 90 headers in the corpus carry the colon the old pattern
    // required; all 90 are written bare.
    expect(LADDER_HEAD.test("Parallels")).toBe(true);
    expect(LADDER_HEAD.test("Parallels:")).toBe(true);
    expect(LADDER_HEAD.test("Base Set")).toBe(false);
  });

  it("reads a print run with or without the dash", () => {
    expect(parseRung("Gold /10")).toMatchObject({ name: "Gold", printRun: 10 });
    expect(parseRung("Platinum 1/1")).toMatchObject({ name: "Platinum", printRun: 1 });
    expect(parseRung("Emerald /5")).toMatchObject({ name: "Emerald", printRun: 5 });
    // The dashed spellings the ladder fix already pinned keep working.
    expect(parseRung("Refractors – /499")).toMatchObject({ name: "Refractors", printRun: 499 });
    expect(parseRung("Superfractors - 1/1")).toMatchObject({ name: "Superfractors", printRun: 1 });
  });

  it("accepts a rung on stated odds, and a named finish with neither", () => {
    expect(parseRung("Green /99 (1:83)")).toMatchObject({ name: "Green", printRun: 99, note: "1:83" });
    expect(parseRung("Shimmer Refractors")).toMatchObject({ name: "Shimmer Refractors", printRun: null });
  });

  it("still refuses prose, a footnote and a count line", () => {
    // Evidence, not vocabulary — but a line with NO evidence is not a rung, or
    // every card would gain a parallel called "cards".
    for (const s of [
      "*Odds as provided by Topps", "*Plates were made for this product",
      "100 cards.", "100 cards", "Base Set", "Parallels",
      "Chrome Prospects Checklist", "",
      // An UNSTATED run is not a print run.
      "Aspirations /99 or fewer (See list below)",
    ]) expect(parseRung(s), s).toBeNull();
  });

  it("keeps 2026 Donruss Elite's whole base ladder, print runs and all", () => {
    const rows = convert("2026-Donruss-Elite-Baseball-Checklist.xlsx", "donruss-elite");
    const base = rows.filter((r) => r.category === "base");
    const ladder = new Map(base.filter((r) => r.parallel).map((r) => [r.parallel, r.printRun]));
    // The rungs the finish-word whitelist used to reject outright.
    expect(ladder.get("Gold")).toBe("10");
    expect(ladder.get("Platinum")).toBe("3");
    expect(ladder.get("Black")).toBe("25");
    expect(ladder.get("Purple")).toBe("49");
    expect(ladder.get("Bronze")).toBe("35");
    expect(ladder.get("Blue")).toBe("199");
    // A printing plate is a /1 parallel, and it is the LAST rung of the ladder:
    // it only survives once a refused line stops closing the ladder early.
    expect(ladder.get("Printing Plates")).toBe("1");
    expect(ladder.get("Elite")).toBe("1");
    expect(rows.filter((r) => r.printRun).length).toBeGreaterThan(4000);
  });

  it("does not let refused prose inside a ladder steal the section name", () => {
    const rows = convert("2026-Donruss-Elite-Baseball-Checklist.xlsx", "donruss-elite");
    // "Aspirations /99 or fewer (See list below)" is the 12th of 22 rungs. When
    // it became the section, the ten rungs after it were discarded.
    for (const c of sectionsOf(rows)) {
      expect(c, c).not.toMatch(/aspirations-99-or-fewer|see-list-below/);
    }
  });
});

// ---------------------------------------------------------------------------
describe("a product without the newly-read sections is unchanged", () => {
  it("converts 2026 Topps Tier One byte-identically to the pre-fix output", () => {
    // The no-regression control. Tier One has no superset sheet beyond the two
    // already skipped, no count line with a period, no bare "Parallels" header
    // and no unlisted rung — so all four fixes are no-ops on it and its output
    // must not move by a single byte. If this test ever goes red, a fix above
    // has reached a product it was never meant to touch.
    const rows = convert("2026-Topps-Tier-One-Baseball-Checklist.xlsx", "tier-one");
    expect(rows).toHaveLength(1702);
    expect(rows.filter((r) => r.category === "base")).toHaveLength(100);
    expect(rows.filter((r) => r.isAuto === "true")).toHaveLength(1016);
    expect(rows.filter((r) => /^insert-/.test(r.category))).toHaveLength(586);
    // Its relic sheet was read before this change and is read the same way now.
    expect(sectionsOf(rows).has("insert-tier-one-relics")).toBe(true);
    expect(rows.filter((r) => r.category === "insert-tier-one-relics")).toHaveLength(79);
  });
});

// ---------------------------------------------------------------------------
describe("a page without the section yields none", () => {
  it("mints no relic, memorabilia or multi-signed row from a product with no such sheet", () => {
    // THE MUTATION GUARD. The fixes above widen what the converter READS; they
    // must never make it INVENT. 2024 Bowman's Memorabilia sheet is present but
    // EMPTY (ten blank rows), and it has no Relics, Autographed Relics or
    // Multi-Signed Autographs sheet at all — so the honest output carries not
    // one row from any of them. Emit-anyway turns this red.
    const rows = convert("2024-Bowman-Baseball-Checklist.xlsx", "bowman", 2024);
    expect(rows.length).toBeGreaterThan(0);
    for (const c of sectionsOf(rows)) {
      expect(c, c).not.toMatch(/relic|memorabilia|patch|multi-signed/);
    }
  });

  it("mints no printing-plate parallel for a product whose ladder never lists one", () => {
    // 2026 Leaf Electrum publishes no plate rung. A converter that templated the
    // hobby's usual ladder onto every product would add one here, which is the
    // cross join no-synthetic-parallels forbids.
    const rows = convert("2026-Leaf-Electrum-Baseball-Checklist.xlsx", "leaf-electrum");
    expect(rows.filter((r) => /printing plate/i.test(r.parallel))).toHaveLength(0);
  });

  it("mints no parallel from prose sitting inside a real ladder", () => {
    // The other half of the mutation guard. 2024 Bowman has no ladder at all,
    // so "invent a rung" has nothing to invent FROM there. 2026 Donruss Elite
    // does: its ladders carry an unstated run ("Aspirations /99 or fewer (See
    // list below)") and a footnote among the real rungs. A converter that
    // accepted any line inside a ladder would mint both as parallels.
    const rows = convert("2026-Donruss-Elite-Baseball-Checklist.xlsx", "donruss-elite");
    const parallels = new Set(rows.map((r) => r.parallel));
    for (const p of parallels) {
      expect(p, p).not.toMatch(/or fewer|see list|odds|cards$|^\*/i);
    }
  });

  it("leaves every parallel blank when the product states no ladder", () => {
    // Blank means unknown, never "Base". 2024 Bowman's workbook is a card list
    // with no "Parallels" block anywhere, so every row must carry an empty
    // parallel rather than a guessed one.
    const rows = convert("2024-Bowman-Baseball-Checklist.xlsx", "bowman", 2024);
    expect(rows.filter((r) => r.parallel !== "")).toHaveLength(0);
    expect(rows.filter((r) => r.printRun !== "")).toHaveLength(0);
  });
});
