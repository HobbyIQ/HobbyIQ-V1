/**
 * CF-BECKETT-A-LEAGUE-LEADERS-CARD-IS-ONE-ROW (2026-09-19).
 *
 * Beckett lists a multi-player card (League Leaders, a dual/triple/quad-
 * player insert) as SEVERAL CONSECUTIVE ROWS under the SAME card number, one
 * per player -- never one row with the roster already joined. Reading each
 * as its own card minted the SAME id for every one of them -- the identical
 * defect class as R30's own same-numbered-different-card shape -- and
 * `lib/insert-set-key.cjs`'s id-collision guard correctly refused the whole
 * 2026 Topps Series 1 Baseball file over it (found live on the checklist-
 * acquisition lane's REPORT: 2,943 rows -> 2,903 distinct ids, 20 ids each
 * claimed by 3 rows, e.g. `hiq:baseball:2026:topps:11:base:no-auto` ==
 * Pete Alonso / Kyle Schwarber / Juan Soto -- Topps's own #11 League Leaders
 * card, not three different cards fighting for one number).
 *
 * THE ROSTER'S OWN OFFLINE PLANNER MISSED THIS because the planning script
 * built its rows without a `player` field at all (`{ category, cardNumber,
 * parallel, isAuto }`, no `player`) before calling `planFile`. With every
 * row's player normalised to the same missing value, `idCollisions`'s own
 * duplicate-vs-collision test (`identityTuple`, which keys on player among
 * other fields) saw three rows that "agreed" on every field it could see and
 * folded them as harmless source duplication (`duplicatesFolded`) instead of
 * flagging a real collision -- the exact wrong answer this file's real rows
 * would produce with player dropped, and the exact right answer
 * (`idCollisions` returns a real collision) once player is included, both
 * pinned below directly against `lib/insert-set-key.cjs`.
 *
 * THE FIX, here: convertBeckettChecklistXlsx.cjs's row reader now merges
 * consecutive rows sharing one card number, within one section, into a
 * single row whose player field is every name joined "/" in source order --
 * reproducing the repo's OWN existing convention for a multi-player card,
 * measured on committed CSVs (`base,152,,false,,Alan Benes/Andy Benes` in
 * 1996-sp-baseball.csv; `insert-league-leaders,1,,false,,Mike Bossy/Marcel
 * Dionne/Guy Lafleur` in 1979-80-o-pee-chee-hockey.csv) rather than
 * inventing a new shape. The merge requires ADJACENCY (the immediately
 * preceding record in the same section) -- a genuine same-numbered
 * DIFFERENT-card collision elsewhere in a section must still refuse, never
 * silently merge.
 *
 * These are the file's OWN exact rows (2026 Topps Series 1 Baseball, card
 * #11, three consecutive rows), extracted as a small synthetic workbook --
 * not the whole 2,943-row file.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IS = require("../scripts/lib/insert-set-key.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeHobbyIqCardId } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js");

const SCRIPT = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");

type Row = (string | number)[];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-league-leaders-"));

function convert(sheets: Record<string, Row[]>) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const xlsxPath = path.join(tmp, `${Math.abs(hash(JSON.stringify(sheets)))}.xlsx`);
  const outPath = xlsxPath.replace(/\.xlsx$/, ".csv");
  XLSX.writeFile(wb, xlsxPath);
  execFileSync(process.execPath, [
    SCRIPT, "--xlsx", xlsxPath, "--year", "2026", "--set-key", "topps",
    "--sport", "baseball", "--set-name", "2026 Topps Series 1 Baseball",
    "--out", outPath, "--source-url", "test",
  ], { encoding: "utf8" });
  const csv = fs.readFileSync(outPath, "utf8").trim().split("\n");
  return csv.slice(1).map((l) => {
    const f = l.split(",");
    return { category: f[0], cardNumber: f[1], parallel: f[2], isAuto: f[3], printRun: f[4], player: f[5] };
  });
}

// The file's own real rows for card #11: three consecutive League Leaders
// rows on the Base sheet, plus a fourth, unrelated card (#12) right after,
// to prove the merge does not run past the number boundary.
const CARD_11_SHEETS: Record<string, Row[]> = {
  Base: [
    ["Base Set"], ["4 cards"],
    ["11", "Pete Alonso,", "New York Mets"],
    ["11", "Kyle Schwarber,", "Philadelphia Phillies"],
    ["11", "Juan Soto,", "New York Mets"],
    ["12", "Daulton Varsho,", "Toronto Blue Jays"],
  ],
};

describe("a League Leaders card is emitted as ONE row, players joined \"/\"", () => {
  it("merges three consecutive same-numbered rows into one, in source order", () => {
    const rows = convert(CARD_11_SHEETS);
    const eleven = rows.filter((r) => r.cardNumber === "11");
    expect(eleven).toHaveLength(1);
    expect(eleven[0].player).toBe("Pete Alonso/Kyle Schwarber/Juan Soto");
  });

  it("does not merge past the card-number boundary", () => {
    const rows = convert(CARD_11_SHEETS);
    const twelve = rows.filter((r) => r.cardNumber === "12");
    expect(twelve).toHaveLength(1);
    expect(twelve[0].player).toBe("Daulton Varsho");
  });

  it("row count drops from 4 raw rows to 2 emitted rows for this extract", () => {
    const rows = convert(CARD_11_SHEETS);
    expect(rows).toHaveLength(2);
  });
});

describe("a genuine same-numbered DIFFERENT card still refuses, never silently merges", () => {
  it("does not merge two NON-adjacent rows sharing a number (a real checklist error stays a collision)", () => {
    // A different card wedged between two rows of the same number: the
    // adjacency requirement means these do NOT merge, so the real
    // id-collision guard downstream still sees two distinct rows fighting
    // for #11 -- exactly the R30 shape this merge must never paper over.
    const sheets: Record<string, Row[]> = {
      Base: [
        ["Base Set"], ["3 cards"],
        ["11", "Pete Alonso,", "New York Mets"],
        ["12", "Daulton Varsho,", "Toronto Blue Jays"],
        ["11", "A Checklist Typo,", "Nowhere"],
      ],
    };
    const rows = convert(sheets);
    const eleven = rows.filter((r) => r.cardNumber === "11");
    expect(eleven).toHaveLength(2);
    expect(eleven.map((r) => r.player)).toEqual(["Pete Alonso", "A Checklist Typo"]);
  });
});

describe("the RC flag on a merged card still strips cleanly", () => {
  it("a rookie among the merged players loses the RC suffix like any other row", () => {
    const sheets: Record<string, Row[]> = {
      Base: [
        ["Base Set"], ["1 cards"],
        ["4", "Jonah Tong,", "New York Mets", "RC"],
        ["4", "Someone Else,", "Some Team"],
      ],
    };
    const rows = convert(sheets);
    const four = rows.filter((r) => r.cardNumber === "4");
    expect(four).toHaveLength(1);
    expect(four[0].player).toBe("Jonah Tong/Someone Else");
  });
});

describe("the offline planner's real defect: dropping `player` hides the collision idCollisions would otherwise catch", () => {
  const computeId = (r: { cardNumber: string; parallel?: string; isAuto?: boolean }) => computeHobbyIqCardId({
    sport: "baseball", year: 2026, setKey: "topps", cardNumber: r.cardNumber,
    parallel: r.parallel || "Base", isAuto: !!r.isAuto, printRun: null, authoritativeSetKey: true,
  });

  it("WITHOUT player, three distinct-player rows read as one card duplicated -- the wrong answer", () => {
    const rowsNoPlayer = [
      { category: "base", cardNumber: "11", parallel: "" },
      { category: "base", cardNumber: "11", parallel: "" },
      { category: "base", cardNumber: "11", parallel: "" },
    ];
    const result = IS.idCollisions(rowsNoPlayer, computeId, null);
    expect(result.collisions).toHaveLength(0);
    expect(result.duplicatesFolded).toBe(2);
  });

  it("WITH player, the same three rows correctly report a real collision", () => {
    const rowsWithPlayer = [
      { category: "base", cardNumber: "11", parallel: "", player: "Pete Alonso" },
      { category: "base", cardNumber: "11", parallel: "", player: "Kyle Schwarber" },
      { category: "base", cardNumber: "11", parallel: "", player: "Juan Soto" },
    ];
    const result = IS.idCollisions(rowsWithPlayer, computeId, null);
    expect(result.collisions).toHaveLength(1);
    expect(result.duplicatesFolded).toBe(0);
    expect(result.collisions[0].rows.map((r: any) => r.player)).toEqual([
      "Pete Alonso", "Kyle Schwarber", "Juan Soto",
    ]);
  });

  it("with the converter's merge applied first, the single joined row never collides at all", () => {
    const mergedRows = [
      { category: "base", cardNumber: "11", parallel: "", player: "Pete Alonso/Kyle Schwarber/Juan Soto" },
    ];
    const result = IS.idCollisions(mergedRows, computeId, null);
    expect(result.collisions).toHaveLength(0);
    expect(result.duplicatesFolded).toBe(0);
    expect(result.ids).toBe(1);
  });
});
