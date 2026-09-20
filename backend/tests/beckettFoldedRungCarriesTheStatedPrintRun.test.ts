/**
 * CF-A-FOLDED-RUNG-CARRIES-THE-SOURCE-STATED-PRINT-RUN (2026-09-20, review
 * fix on #2364/#2365).
 *
 * The plain-card fold-emission push in convertBeckettChecklistXlsx.cjs's
 * pass 3 used to hardcode `printRun: ""` for EVERY record, folded or not.
 * That is harmless for an ordinary own-cards section (nothing else claims to
 * know its run either) but WRONG once a section folds onto an anchor as a
 * named product tier: the fold TARGET's category is a real product whose
 * print run the source usually states -- just never on the dedicated
 * section's own rows (Beckett's "list below" pointer shape prints the
 * dedicated section, e.g. "Base Silver Autographs" / "Rated Rookies
 * Autographs Purple", as a PLAIN card list with no ladder header of its
 * own; the run is stated on the ANCHOR's own ladder line instead: "Silver -
 * /49 (select cards only, list below)", "Purple - /150 (select cards only,
 * list below)").
 *
 * MEASURED, NOT THEORIZED. Before the SELECT_CARDS_ONLY_NOTE guard (this
 * same PR) existed, the mechanical full-roster ladder stamp -- which DID
 * carry the real run -- emitted a second, identically-keyed row that won
 * the pre-existing dedup (keyed without printRun) over the fold-emission's
 * own blank one. That is the ONLY reason committed 2024 Panini Photogenic
 * Football's `auto-base-autographs,104,Silver,true,49,...` read a real
 * print run before this fix: the duplicate masked the defect. Once
 * SELECT_CARDS_ONLY_NOTE correctly stopped emitting that duplicate for a
 * "select cards only" rung, the fold-emission's own hardcoded blank became
 * the ONLY row left -- regenerating Photogenic with the pre-fix code turns
 * `Silver,true,49` into `Silver,true,` (found in review, confirmed by
 * regenerating the real workbook both ways). Donruss FB's own "Rated
 * Rookies Autographs Purple" (states "/150" on RRA's own ladder) has the
 * identical shape and the identical defect, pinned separately in
 * wave1AcquisitionPackagesMatchTheirCommittedPlannerVerdict.test.ts against
 * the real committed CSV; THIS file pins the general mechanism against a
 * minimal synthetic fixture reproducing Photogenic's exact shape, so the
 * defect is caught even on a workbook this repo has not acquired yet.
 *
 * The fix, in order (never invents a run): (1) the DEDICATED section's own
 * declared ladder, if it states one for its own bare tier; (2) else the
 * FOLD TARGET's (the anchor's) own ladder, for the rung name this section
 * folds as. A disagreement between the two is recorded in the manifest
 * (printRunConflicts) rather than silently resolved either way. Separately,
 * the post-emission dedup now keys on printRun too, and prefers a numbered
 * statement over an unnumbered twin of the identical rung when both somehow
 * survive to that point (numberedVsUnnumberedFindings records the swap).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

const CONVERTER = path.join(__dirname, "..", "scripts", "convertBeckettChecklistXlsx.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "beckett-fold-printrun-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Row = { category: string; cardNumber: string; parallel: string; isAuto: string; printRun: string; player: string };

function convert(sheets: Record<string, unknown[][]>, setKey: string): { rows: Row[]; manifest: Record<string, unknown> } {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const xlsxPath = path.join(TMP, `${setKey}-in.xlsx`);
  XLSX.writeFile(wb, xlsxPath, { bookType: "xlsx" });

  const out = path.join(TMP, `${setKey}.csv`);
  execFileSync(process.execPath, [
    CONVERTER,
    "--xlsx", xlsxPath,
    "--year", "2024", "--set-key", setKey, "--sport", "football",
    "--set-name", `2024 ${setKey}`, "--out", out,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const rows = fs.readFileSync(out, "utf8").trim().split("\n").slice(1).map((line) => {
    const [category, cardNumber, parallel, isAuto, printRun, ...rest] = line.split(",");
    return { category, cardNumber, parallel, isAuto, printRun, player: rest.join(",") };
  });
  const manifest = JSON.parse(fs.readFileSync(out.replace(/\.csv$/, ".manifest.json"), "utf8"));
  return { rows, manifest };
}

describe("Photogenic shape: a same-class colour fold reads its print run from the anchor's own ladder rung", () => {
  it("Base Autographs Silver folds onto Base Autographs as parallel=Silver, printRun=49 -- never blank", () => {
    const { rows, manifest } = convert(
      {
        Autographs: [
          ["Base Autographs Checklist"],
          [],
          ["2 cards."],
          [],
          ["Parallels:"],
          [],
          ["Silver - /49 (select cards only, list below)"],
          ["Blue - /25"],
          [],
          ["1", "Diontae Johnson", "Some Team"],
          ["2", "Someone Else", "Some Team"],
          [],
          ["Base Silver Autographs Checklist"],
          [],
          ["1 cards."],
          [],
          ["1", "Diontae Johnson", "Some Team"],
        ],
      },
      "photogenic-shape",
    );
    const silverRows = rows.filter((r) => r.category === "auto-base-autographs" && r.parallel === "Silver");
    expect(silverRows.length).toBe(1);
    expect(silverRows[0].printRun, "Silver must carry the /49 stated on the anchor's own ladder").toBe("49");
    expect(silverRows[0].isAuto).toBe("true");
    // The mechanically-expanded ladder rung ("Blue - /25", no "select cards
    // only" note) still emits across the full 2-card roster, unaffected.
    const blueRows = rows.filter((r) => r.category === "auto-base-autographs" && r.parallel === "Blue");
    expect(blueRows.length).toBe(2);
    expect(blueRows.every((r) => r.printRun === "25")).toBe(true);
    // No conflict to report -- the anchor states the only run, cleanly.
    expect(manifest.printRunConflicts).toBeUndefined();
    expect(manifest.numberedVsUnnumberedFindings).toBeUndefined();
  });

  it("a dedicated section's OWN stated run wins over a disagreeing anchor rung, and the disagreement is recorded", () => {
    // Synthetic-only shape (no measured fixture needs it yet): the
    // dedicated section's own ladder states a DIFFERENT run than the
    // anchor's rung of the same name. The dedicated section's own
    // statement -- closer to the source -- wins; the disagreement is a
    // manifest finding, never silently dropped either way.
    const { rows, manifest } = convert(
      {
        Autographs: [
          ["Base Autographs Checklist"],
          [],
          ["1 cards."],
          [],
          ["Parallels:"],
          [],
          ["Silver - /49 (select cards only, list below)"],
          [],
          ["1", "Diontae Johnson", "Some Team"],
          [],
          ["Base Silver Autographs Checklist"],
          [],
          ["Parallels:"],
          [],
          ["Silver - /25"],
          [],
          ["1", "Diontae Johnson", "Some Team"],
        ],
      },
      "photogenic-conflict-shape",
    );
    const silverRows = rows.filter((r) => r.category === "auto-base-autographs" && r.parallel === "Silver");
    expect(silverRows.length).toBe(1);
    expect(silverRows[0].printRun, "the dedicated section's own stated run wins").toBe("25");
    expect(manifest.printRunConflicts).toBeDefined();
    expect((manifest.printRunConflicts as unknown[]).length).toBe(1);
  });
});
