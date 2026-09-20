/**
 * CF-WAVE1-BRANCH-TRUTH (2026-09-19). Follows the pattern in
 * beckettPackagesMatchTheirCommittedPlannerVerdict.test.ts (the #2337
 * "PR body must be true of the branch alone" fix): pins the sanctioned
 * ingester's OWN planStagedDirectory verdict for each package this PR ships,
 * measured with nothing but what THIS branch (based on #2337) provides. No
 * package here depends on any sibling PR's key registrations.
 *
 * Six packages, one Wave-1 acquisition each. UPDATED (2026-09-19, follow-on
 * registration PR, precedent #2276/#2342): Prizm Football and Prizm
 * Basketball now PASS -- their genuine named insert/auto keys are registered
 * in productSetKeys.ts (see that file's own registration comment for the
 * full per-key evidence).
 *
 * UPDATED AGAIN (2026-09-20, Donruss FB converter fold). Donruss Football
 * now PASSES too. The 2 keys deliberately left unregistered by the prior
 * update (`rated-rookies-autographs`, `optic-rated-rookies-preview-
 * autographs`) were never real sets -- both are a 100% roster match against
 * Base's own Rated Rookies subset (#301-400), on-card autograph PARALLELS of
 * the base rookie cards. Rather than register a fake key for a parallel
 * (the doctrine violation the prior update correctly refused to commit),
 * `convertBeckettChecklistXlsx.cjs`'s classifySections gained a cross-auto-
 * class roster fold: a signed section ("Rated Rookies Autographs") whose own
 * name extends a non-flagship, unsigned base-category anchor ("Rated
 * Rookies") now folds onto it as the bare signed tier, isAuto=true, exactly
 * the same mechanism the pre-existing nameless-section roster fold already
 * used one auto-class narrower. Its own colour rungs (Orange, Purple, the
 * Optic Preview auto) fold one level further, onto "Rated Rookies
 * Autographs" itself, via a new partial-roster-with-extras branch in the
 * main classify loop (best.pct < 1 via extendsName, zero disagreements, the
 * shortfall fully explained as roster extras -- the same evidence bar the
 * pre-existing #420 Super Box Exclusive shape already uses, just reached
 * from a different call site). A held-out extra that itself matches the
 * FOLD ANCHOR'S OWN grandparent (Rated Rookies Autographs Purple's #364 is
 * not in RRA's own 63-card list, but IS a real numbered Rated Rookies base
 * card) is rescued into the same fold rather than left an orphan. Separately,
 * a genuine converter defect this fold surfaced and fixed: the ladder rung
 * "Purple - /150 (select cards only, list below)" was being mechanically
 * stamped onto RRA's full 63-card roster (like the correctly-full-roster
 * Gold -/25 and Black -/10 siblings) despite its own note saying it does
 * not cover every card -- 12 synthetic Purple auto rows for base cards never
 * actually printed with one. Fixed via a new SELECT_CARDS_ONLY_NOTE guard at
 * the ladder-emission site, which defers to the real, roster-verified,
 * separately-printed "Rated Rookies Autographs Purple" section instead.
 *
 * REVIEW FIX (2026-09-20). The SELECT_CARDS_ONLY_NOTE guard above, by
 * removing the mechanical-ladder duplicate for Purple, unmasked a SEPARATE,
 * pre-existing defect: the fold-emission's own plain-card push hardcoded
 * printRun: "" for every record, folded or not -- the removed duplicate
 * used to carry the real run and win the pre-existing dedup, so the blank
 * never surfaced. Fixed at the source: the fold-emission now resolves
 * printRun from the dedicated section's own ladder if it states one, else
 * the fold target's own ladder rung of the same name -- never invented, a
 * disagreement recorded in the manifest (printRunConflicts) rather than
 * silently resolved. Donruss RRA Purple now correctly carries printRun=150
 * (was blank); Orange/Optic Preview correctly stay blank (no source states
 * a run for either). See beckettFoldedRungCarriesTheStatedPrintRun.test.ts
 * for the general synthetic-fixture pin (reproduces the identical shape
 * against 2024 Panini Photogenic Football's own committed "Base Autographs
 * Silver" fold, which the same defect affects on that already-shipped
 * package -- not regenerated here, out of scope for this PR).
 *
 *   - 2024 Panini Prizm Football (Beckett S3)        PASS (was REFUSE, 23
 *     unregistered -- all 23 were genuine, now registered)
 *   - 2024 Panini Phoenix Football (Beckett S3)       REFUSE on THIS branch
 *     alone (untouched by this PR -- held pending the converter fix, out of
 *     scope; a stacked follow-on PR regenerates it with this same converter
 *     fix and registers its own 23 genuine named inserts/autos, moving it
 *     to PASS THERE)
 *   - 2024 Panini Donruss Football, full workbook     PASS (was REFUSE, 2
 *     unregistered -- both are the fold-candidates above, now folded as
 *     parallels rather than registered as fake keys; rows 6369 -> 9606,
 *     net of Defect A's ~3,300 recovered unnumbered parallels (#2350) minus
 *     the Purple mechanical-ladder over-count this same PR fixes)
 *     (Base+Press Proof already staged in #2304 under
 *     acq-2026-09-19-beckett-football-donruss-mosaic/ -- THIS package is the
 *     FULL workbook including Autographs/Memorabilia/Inserts, a separate
 *     directory so it does not collide with or duplicate that prior stage)
 *   - 2024-25 Panini Prizm Basketball (Beckett S3)    PASS (was REFUSE, 19
 *     unregistered -- all 19 were genuine, now registered)
 *   - 2025 Topps Holiday Baseball (Beckett S3)        PASS, zero unregistered
 *   - 2025-26 Topps Holiday Basketball (Beckett S3)   REFUSE on THIS branch
 *     alone (untouched by this PR; the stacked follow-on PR regenerates it,
 *     confirming the odds-line-becomes-section-name defect is fixed but
 *     leaving it REFUSE for a different, pre-existing, genuinely
 *     disagreeing-roster duplicate-code reason -- see that PR's own copy of
 *     this describe block)
 *   - 2025 Topps Chrome Football (Beckett S3, bonus)  REFUSE, 1 unregistered
 *     ("Team Camo Variation" -- AMBIGUOUS 75% roster overlap with
 *     Rookies #301-400, correctly left unfolded pending a human ruling)
 *
 * A seventh package, already committed to main outside any acq- directory
 * (`data/checklists/scraped/2024-panini-select-basketball.csv`, 27
 * unregistered named insert/auto keys, all genuine), is added below: all 27
 * are now registered, but the file still REFUSES -- not on key registration,
 * on 53 id-COLLISIONS in two dual/multi-signer products (`Select Pairings
 * Signatures`, an explicitly-paired autograph insert, and `2024 Origins
 * Update Autographs`) where more than one player shares a (cardNumber,
 * parallel) address. That is a card-identity/multi-signer scoping question,
 * out of scope for a productSetKeys.ts-only PR (computeHobbyIqCardId is
 * explicitly not touched here).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const SCRAPED_ROOT = join(__dirname, "..", "data", "checklists", "scraped");

function planPackage(dirName: string) {
  const dir = join(SCRAPED_ROOT, dirName);
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  expect(files.length, `${dirName} must have exactly one staged CSV`).toBe(1);
  const plans = INGEST.planStagedDirectory(dir, files);
  const entry = plans.get(files[0]);
  return { dir, file: files[0], entry };
}

describe("2024 Panini Prizm Football (Beckett S3) — PASS after this PR's registrations", () => {
  it("planStagedDirectory reports PASS: all 23 genuine named inserts are now registered", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-prizm-fb");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(29980);
    expect(entry.plan.ids).toBe(29980);
  });

  it("the on-card base autograph parallels fold onto the base roster with isAuto true", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-prizm-fb", "2024-panini-prizm-football.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean);
    const silverAutoRows = lines.filter((l) => l.includes("Base Autographs Prizm Silver"));
    expect(silverAutoRows.length).toBe(115);
    for (const l of silverAutoRows) expect(l.startsWith("base,")).toBe(true);
  });
});

describe("2024 Panini Phoenix Football (Beckett S3) — REFUSE on this branch alone", () => {
  // Kept at its PRE-regeneration REFUSE state on THIS branch (per
  // CF-WAVE1-BRANCH-TRUTH's own rule: this file pins what THIS branch
  // provides, nothing a sibling/follow-on PR ships). Phoenix FB moves to
  // PASS in the stacked follow-on PR (registers the 23 genuine keys this
  // same converter fold surfaces once regenerated) -- see that PR's own
  // copy of this describe block.
  it("planStagedDirectory reports unregistered-set-keys for 23 genuine named inserts, not PASS", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-phoenix-fb");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    expect(entry.plan.unregistered.length).toBe(23);
    expect(entry.plan.rows).toBe(16209);
  });

  it("HAZARD: 14 declared unnumbered base parallels never landed as rows (converter gap, not a fold)", () => {
    // Workbook's own "Parallels:" block on the Base sheet declares Hyper,
    // Ice, International, Lazer, Orange, Orange Fade, Orange Hyper, Orange
    // Lazer, Pandora, Purple, Purple Fade, Purple Hyper, Purple Lazer,
    // Silver -- none of the 14 appear anywhere in the base rows for ANY
    // card, while Wave/White Shimmer (also unnumbered, declared right after
    // them in the same block) DID land. This pins the gap so a future
    // converter fix is visible as a row-count change here, not a silent
    // fix nobody notices.
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-phoenix-fb", "2024-panini-phoenix-football.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const parallels = new Set(
      lines
        .filter((l) => l.startsWith("base,"))
        .map((l) => {
          const cols = l.split(",");
          return cols[2];
        }),
    );
    for (const missing of [
      "Hyper", "Ice", "International", "Lazer", "Orange", "Orange Fade",
      "Orange Hyper", "Orange Lazer", "Pandora", "Purple", "Purple Fade",
      "Purple Hyper", "Purple Lazer", "Silver",
    ]) {
      expect(parallels.has(missing), `expected "${missing}" to still be missing (hazard pin)`).toBe(false);
    }
    // Sibling unnumbered parallels declared in the same block DID land.
    expect(parallels.has("Wave")).toBe(true);
    expect(parallels.has("White Shimmer")).toBe(true);
  });

  it("carries a heldRows gate — this package cannot be ingested half-right, even after keys are registered", () => {
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-phoenix-fb", "2024-panini-phoenix-football.manifest.json"),
        "utf8",
      ),
    );
    expect(m.heldRows).toBeDefined();
    expect(m.heldRows.rows).toBe(16209);
    expect(m.heldRows.reason).toMatch(/14 declared unnumbered base parallels/);
    expect(m.heldRows.reason).toMatch(/converter defect/);
  });
});

describe("2024 Panini Donruss Football, full workbook (Beckett S3) — PASS, the 2 fold-candidates now fold as parallels", () => {
  it("planStagedDirectory reports PASS: zero unregistered keys, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-donruss-fb-full");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    // 6369 (main, pre-#2350) -> 9606: Defect A's own recovered unnumbered
    // parallels (+3,300, #2350) plus this PR's fold turning the two
    // formerly-separate-category fold-candidates into parallel rows on
    // panini-donruss-rated-rookies, net of removing the ~63-row mechanical
    // full-roster "Purple" over-emission this same PR's SELECT_CARDS_ONLY_
    // NOTE guard fixes (Purple is a "select cards only" rung, not a
    // full-roster one like its Gold/Black siblings).
    expect(entry.plan.rows).toBe(9606);
    expect(entry.plan.ids).toBe(9606);
  });

  it("the 2 former fold-candidates are now parallel rows on the base Rated Rookies category, isAuto true", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full", "2024-panini-donruss-football.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const rows = lines.map((l) => {
      // parallel is column 3 and may be double-quoted/comma-free here (no
      // rung name in this file contains a literal comma), so a plain split
      // is safe for this fixed check.
      const parts = l.split(",");
      return { category: parts[0], cardNumber: parts[1], parallel: parts[2], isAuto: parts[3], player: parts.slice(5).join(",") };
    });
    // The two former standalone categories no longer exist at all -- every
    // row that used to live under them now lives under "base" with a named
    // parallel, isAuto=true.
    expect(rows.some((r) => r.category === "auto-rated-rookies-autographs-orange")).toBe(false);
    expect(rows.some((r) => r.category === "auto-optic-rated-rookies-preview-autographs")).toBe(false);
    // The bare signed tier: "Rated Rookies Autographs" is now the PARALLEL
    // label on the base Rated Rookies category (#301-400), never its own
    // category.
    const bareAutoRows = rows.filter((r) => r.category === "base" && r.parallel === "Rated Rookies Autographs");
    expect(bareAutoRows.length).toBe(63);
    expect(bareAutoRows.every((r) => r.isAuto === "true")).toBe(true);
    // Its own further colour ladder (Gold, Black -- full roster, no "select
    // cards only" qualifier) rides on the SAME base category, still isAuto.
    for (const colour of ["Gold", "Black"]) {
      const colourRows = rows.filter((r) => r.category === "base" && r.parallel === colour);
      expect(colourRows.length, colour).toBe(63);
      expect(colourRows.every((r) => r.isAuto === "true"), colour).toBe(true);
    }
  });

  it("Orange/Purple/Optic Preview fold onto Rated Rookies Autographs's own category, including the rescued grandparent extras", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full", "2024-panini-donruss-football.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const rows = lines.map((l) => {
      const parts = l.split(",");
      return { category: parts[0], cardNumber: parts[1], parallel: parts[2], isAuto: parts[3] };
    });
    const under = (parallel: string) =>
      rows.filter((r) => r.category === "auto-rated-rookies-autographs" && r.parallel === parallel);
    // Orange: 51 cards declared, 50 agree with RRA's own 63-card roster, 1
    // (#364) has no counterpart there but DOES match the grandparent (base
    // Rated Rookies) and is rescued rather than orphaned -- all 51 present.
    expect(under("Orange").length).toBe(51);
    // Purple: 52 declared, 49 agree directly, 3 (#364/#374/#388) rescued via
    // the grandparent -- all 52 present, none silently dropped or left as a
    // synthetic full-roster stamp.
    expect(under("Purple").length).toBe(52);
    // Optic Preview (the signed Autographs-sheet section, distinct from the
    // unsigned "Optic Preview Holo" insert that already folded onto base
    // Rated Rookies before this PR): 60 declared, all 60 land here -- every
    // number agrees with RRA directly or is rescued via the grandparent.
    expect(under("Optic Preview").length).toBe(60);
    for (const parallel of ["Orange", "Purple", "Optic Preview"]) {
      expect(under(parallel).every((r) => r.isAuto === "true"), parallel).toBe(true);
    }
  });

  it("REVIEW FIX: the fold-emission print run comes from the SOURCE, never hardcoded blank", () => {
    // Found in review: the plain-card fold push used to hardcode printRun
    // "" for every record, folded or not. Before the SELECT_CARDS_ONLY_NOTE
    // guard existed, a duplicate mechanical-ladder row (which DID carry the
    // real run) happened to win the pre-existing dedup over this blank one,
    // masking the defect; once that duplicate stopped being emitted, the
    // hardcoded blank became the only row left. The ladder's own anchor
    // rung ("Purple - /150", "Gold - /25", "Black - /10") is now the source
    // this fold-emission reads its printRun from.
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full", "2024-panini-donruss-football.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const rows = lines.map((l) => {
      const parts = l.split(",");
      return { category: parts[0], cardNumber: parts[1], parallel: parts[2], printRun: parts[4] };
    });
    // Purple states "/150" on RRA's own ladder -- every folded Purple row
    // (both the direct-agreement ones and the grandparent-rescued ones)
    // must carry it.
    const purpleRows = rows.filter((r) => r.category === "auto-rated-rookies-autographs" && r.parallel === "Purple");
    expect(purpleRows.length).toBe(52);
    expect(purpleRows.every((r) => r.printRun === "150"), "every Purple row must carry the stated /150").toBe(true);
    // Orange and Optic Preview state no run anywhere in the source (neither
    // their own dedicated section nor RRA's own ladder) -- blank is
    // correct here, never invented.
    for (const parallel of ["Orange", "Optic Preview"]) {
      const parRows = rows.filter((r) => r.category === "auto-rated-rookies-autographs" && r.parallel === parallel);
      expect(parRows.length, parallel).toBeGreaterThan(0);
      expect(parRows.every((r) => r.printRun === ""), `${parallel} must stay blank -- no source states a run`).toBe(true);
    }
    // The bare "Rated Rookies Autographs" tier (Blue, unnamed on the
    // source's own ladder) also stays blank -- no run stated for it either.
    const bareRows = rows.filter((r) => r.category === "base" && r.parallel === "Rated Rookies Autographs");
    expect(bareRows.length).toBe(63);
    expect(bareRows.every((r) => r.printRun === "")).toBe(true);
    // Gold and Black (the mechanical full-roster ladder path, a different
    // code path than the fold-emission this fix touches) are unaffected --
    // still /25 and /10.
    const goldRows = rows.filter((r) => r.category === "base" && r.parallel === "Gold");
    const blackRows = rows.filter((r) => r.category === "base" && r.parallel === "Black");
    expect(goldRows.every((r) => r.printRun === "25")).toBe(true);
    expect(blackRows.every((r) => r.printRun === "10")).toBe(true);
    // No printRunConflicts or numberedVsUnnumberedFindings for this
    // workbook -- the fix resolves cleanly, no disagreement to record.
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full", "2024-panini-donruss-football.manifest.json"),
        "utf8",
      ),
    );
    expect(m.printRunConflicts).toBeUndefined();
    expect(m.numberedVsUnnumberedFindings).toBeUndefined();
  });

  it("does not collide with the prior base-only stage's own directory", () => {
    // #2304 staged Base+Press Proof only (2,900 rows) under
    // acq-2026-09-19-beckett-football-donruss-mosaic/. This package is a
    // SEPARATE directory carrying the full workbook (base+autos+mem+
    // inserts) -- both are one CSV per package directory.
    const priorDir = join(SCRAPED_ROOT, "acq-2026-09-19-beckett-football-donruss-mosaic");
    const priorFiles = readdirSync(priorDir).filter((f: string) => f.endsWith(".csv"));
    expect(priorFiles).toEqual(["2024-panini-donruss-football.csv"]);
    const thisDir = join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full");
    const thisFiles = readdirSync(thisDir).filter((f: string) => f.endsWith(".csv"));
    expect(thisFiles).toEqual(["2024-panini-donruss-football.csv"]);
  });

  it("carries the one remaining, pre-existing, understood dropped-declared-parallel finding (Jersey Number)", () => {
    // Unrelated to this PR's fold: "Jersey Number Checklist"'s own first
    // card row is preceded by a bare footnote line ("No #7, 14, 28, 47,
    // 108") that gets misread as the section's real header (a pre-existing
    // "premature section header" shape, same class as #2337's own fix,
    // measured present on main before this PR touched anything) -- so no
    // section is ever actually named "Jersey Number" for the pointer
    // ("Jersey Number - (print runs vary, list below)", declared on both
    // Base Set and Rated Rookies) to match against. Recorded, not hidden:
    // --allow-dropped-parallels was used ONLY for this one understood,
    // pre-existing finding, never to mask a drop this PR's own fold caused.
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full", "2024-panini-donruss-football.manifest.json"),
        "utf8",
      ),
    );
    expect(m.allowDroppedParallelsUsed).toBe(true);
    expect(m.droppedDeclaredParallels).toEqual([
      { sheet: "Base", section: "Base Set", parallel: "Jersey Number - (print runs vary, list below)" },
      { sheet: "Base", section: "Rated Rookies", parallel: "Jersey Number - (print runs vary, list below)" },
    ]);
  });
});

describe("2024-25 Panini Prizm Basketball (Beckett S3) — PASS after this PR's registrations", () => {
  it("planStagedDirectory reports PASS: all 19 genuine named inserts are now registered", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-prizm-bk");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(29837);
    expect(entry.plan.ids).toBe(29837);
  });
});

describe("2024 Panini Select Basketball (hobbymonitor, already committed to main) — REFUSE persists, id-collisions not key registration", () => {
  it("planStagedDirectory reports PASS on key registration but REFUSE on 53 id-collisions in two dual/multi-signer inserts", () => {
    const files = ["2024-panini-select-basketball.csv"];
    const plans = INGEST.planStagedDirectory(SCRAPED_ROOT, files);
    const entry = plans.get(files[0]);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.collisions?.slice(0, 3))).toBe("refuse");
    expect(entry.plan.reason).toBe("id-collisions");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.rows).toBe(25999);
    expect(entry.plan.collisions.length).toBe(53);
  });

  it("every collision is concentrated in the two dual/multi-signer products, not a registration defect", () => {
    const files = ["2024-panini-select-basketball.csv"];
    const plans = INGEST.planStagedDirectory(SCRAPED_ROOT, files);
    const entry = plans.get(files[0]);
    const bySetKey = new Map<string, number>();
    for (const c of entry.plan.collisions) {
      const setKey = c.id.split(":")[3];
      bySetKey.set(setKey, (bySetKey.get(setKey) || 0) + 1);
    }
    expect(Object.fromEntries(bySetKey)).toEqual({
      "panini-select-select-pairings-signatures": 50,
      "panini-select-2024-origins-update-autographs": 3,
    });
  });
});

describe("2025 Topps Holiday Baseball (Beckett S3) — PASS, ingestible as-is", () => {
  it("planStagedDirectory reports PASS with zero unregistered keys and zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-topps-holiday-baseball");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(1253);
    expect(entry.plan.ids).toBe(1253);
  });
});

describe("2025-26 Topps Holiday Basketball (Beckett S3) — REFUSE, converter defect not a real set", () => {
  // Kept at its PRE-regeneration REFUSE state on THIS branch (same
  // CF-WAVE1-BRANCH-TRUTH rule as Phoenix FB above). The stacked follow-on
  // PR regenerates this package: confirms the odds-line-becomes-section-
  // name defect (Defect B) below is fixed, but leaves the package REFUSE
  // for a DIFFERENT, pre-existing reason (a genuine disagreeing-roster
  // duplicate code on the Autographs sheet) -- see that PR's own copy of
  // this describe block.
  it("planStagedDirectory reports unregistered-set-keys for the odds-line artifact categories", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-topps-holiday-basketball");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual(["topps-holiday-1379-packs", "topps-holiday-1379-packs-2"]);
  });

  it("HAZARD: an odds line ('1:N packs') becomes the section name on 4 of the 4 non-Base sheets that have one", () => {
    // The workbook's Autographs/Relics/Inserts sheets each open with a
    // generic repeated header ("Autographs" row 0 is identical across every
    // subset on that sheet) and NO other distinguishing name above the odds
    // line -- so the converter's section splitter falls back to "1:379
    // packs" / "1:75 packs" / etc as if it were the section's own name.
    // Base has ONE instance too ("1:23 packs") but it lands on the already-
    // correct "base" category as an anchor, so it is harmless there.
    //
    // Only 2 of the resulting categories -- both on the Autographs sheet --
    // actually reach the planner as unregistered (auto-1379-packs and its
    // "-2" split twin); the same-shaped categories on Relics/Inserts
    // (insert-175-packs, insert-1392-packs, insert-1345-packs,
    // insert-154-packs, insert-1200-packs, insert-110-packs, and the two
    // "Advent-exclusive" categories) do NOT surface in planFile's own
    // `unregistered` list, for a reason this test does not resolve (that is
    // subsetsToSeparate/rungFoldingFor's own fold logic in
    // insert-set-key.cjs, out of scope for an acquisition package to
    // rewrite) -- pinned here as measured, not theorized.
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-topps-holiday-basketball", "2025-26-topps-holiday-basketball.manifest.json"),
        "utf8",
      ),
    );
    const oddsLineSections = m.sectionsReport.filter((s: { section: string }) => /^1:[\d,]+ packs(?: \(Advent-exclusive\))?$/.test(s.section));
    expect(oddsLineSections.length).toBe(11);
    const bySheet = new Map<string, number>();
    for (const s of oddsLineSections) bySheet.set(s.sheet, (bySheet.get(s.sheet) || 0) + 1);
    expect(bySheet.get("Base")).toBe(1);
    expect(bySheet.get("Autographs")).toBe(2);
    expect(bySheet.get("Relics")).toBe(4);
    expect(bySheet.get("Inserts")).toBe(4);
    // The Base sheet's own instance is harmless -- it still lands on "base".
    const baseOddsLine = oddsLineSections.find((s: { sheet: string }) => s.sheet === "Base");
    expect(baseOddsLine.category).toBe("base");
  });

  it("carries a heldRows gate — this package cannot be ingested half-right, even after keys are registered", () => {
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-topps-holiday-basketball", "2025-26-topps-holiday-basketball.manifest.json"),
        "utf8",
      ),
    );
    expect(m.heldRows).toBeDefined();
    expect(m.heldRows.rows).toBe(4606);
    expect(m.heldRows.reason).toMatch(/odds line read as section name/);
    expect(m.heldRows.reason).toMatch(/Autographs sheet/);
  });
});

describe("2025 Topps Chrome Football (Beckett S3, bonus find) — REFUSE, one AMBIGUOUS insert", () => {
  it("planStagedDirectory reports a single unregistered key, the AMBIGUOUS Team Camo Variation", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-topps-chrome-fb-2025");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual(["topps-chrome-team-camo-variation"]);
    expect(entry.plan.rows).toBe(1926);
  });

  it("the converter left Team Camo Variation unfolded rather than guess at a 75% roster overlap", () => {
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-topps-chrome-fb-2025", "2025-topps-chrome-football.manifest.json"),
        "utf8",
      ),
    );
    const teamCamo = m.sectionsReport.find((s: { section: string }) => s.section === "Team Camo Variation");
    expect(teamCamo).toBeDefined();
    expect(teamCamo.cards).toBe(400);
  });
});
