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
 *   - 2024 Panini Prizm Football (Beckett S3)        PASS (was REFUSE, 23
 *     unregistered -- all 23 were genuine, now registered)
 *   - 2024 Panini Phoenix Football (Beckett S3)       PASS (2026-09-20:
 *     regenerated with the #2350-fixed converter -- 16,209 -> 20,309 rows,
 *     recovering the 14 declared unnumbered base parallels the old heldRows
 *     gate was blocking on; the 23 unregistered genuine named
 *     inserts/autos this surfaced are now registered in productSetKeys.ts,
 *     each measured at 0% roster agreement against Base's own numbering --
 *     see that file's own registration comment for the evidence)
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
 *   - 2025-26 Topps Holiday Basketball (Beckett S3)   REFUSE persists, 2
 *     unregistered (2026-09-20: regenerated with the #2350-fixed converter;
 *     the odds-line-becomes-section-name defect this describe block used to
 *     pin is GONE -- every real section name now appears. What remains is a
 *     DIFFERENT, pre-existing defect: the bare "Autographs" header repeats
 *     over two groups whose rosters genuinely disagree at the same card
 *     code -- a duplicate-code/multi-signer shape, the same class Select
 *     Football is held for, out of scope for a converter-regeneration pass)
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

describe("2024 Panini Phoenix Football (Beckett S3) — PASS (2026-09-20: regenerated with the #2350-fixed converter, keys registered)", () => {
  it("planStagedDirectory reports PASS: zero unregistered keys, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-phoenix-fb");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    // 16,209 (old, heldRows-gated, pre-#2350) -> 20,309: recovers the 14
    // declared unnumbered base parallels the old converter silently dropped.
    expect(entry.plan.rows).toBe(20309);
    expect(entry.plan.ids).toBe(20309);
  });

  it("FIXED: the 14 previously-missing declared unnumbered base parallels now land as rows", () => {
    // Workbook's own "Parallels:" block on the Base sheet declares Hyper,
    // Ice, International, Lazer, Orange, Orange Fade, Orange Hyper, Orange
    // Lazer, Pandora, Purple, Purple Fade, Purple Hyper, Purple Lazer,
    // Silver -- all 14 now land, alongside the two (Wave, White Shimmer)
    // that already worked before the fix.
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
    for (const recovered of [
      "Hyper", "Ice", "International", "Lazer", "Orange", "Orange Fade",
      "Orange Hyper", "Orange Lazer", "Pandora", "Purple", "Purple Fade",
      "Purple Hyper", "Purple Lazer", "Silver", "Wave", "White Shimmer",
    ]) {
      expect(parallels.has(recovered), `expected "${recovered}" to be present`).toBe(true);
    }
    // No heldRows gate any more -- the converter defect that required one is
    // fixed.
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-phoenix-fb", "2024-panini-phoenix-football.manifest.json"),
        "utf8",
      ),
    );
    expect(m.heldRows).toBeUndefined();
  });

  it("the 23 registered keys are genuine own-named products, 0% roster agreement with Base at the same numbers", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-phoenix-fb", "2024-panini-phoenix-football.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const rows = lines.map((l) => {
      const parts = l.split(",");
      return { category: parts[0], cardNumber: parts[1], parallel: parts[2], player: parts.slice(5).join(",") };
    });
    const baseByNum = new Map<string, string>();
    for (const r of rows) if (r.category === "base" && r.parallel === "") baseByNum.set(r.cardNumber, r.player);
    for (const cat of [
      "insert-rookie-rising", "insert-contours", "auto-rookie-phenoms-jersey-autographs",
      "auto-rookie-silhouettes", "insert-treasured-tandems", "insert-franchise-future-material",
      "insert-archetype", "auto-calligraphy",
    ]) {
      const catRows = rows.filter((r) => r.category === cat && r.parallel === "");
      expect(catRows.length, cat).toBeGreaterThan(0);
      let agree = 0;
      for (const r of catRows) {
        const bp = baseByNum.get(r.cardNumber);
        if (bp !== undefined && bp.trim().toLowerCase() === r.player.trim().toLowerCase()) agree++;
      }
      expect(agree, `${cat} must share zero players with Base at the same numbers`).toBe(0);
    }
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

describe("2025-26 Topps Holiday Basketball (Beckett S3) — REFUSE persists, but the #2350 converter defect is FIXED; a different, pre-existing defect remains", () => {
  // UPDATED (2026-09-20). Regenerated with the #2350-fixed converter: the
  // odds-line-becomes-section-name defect (Defect B) this describe block
  // used to pin is GONE -- every real section name (Frostbite Finishers,
  // Hidden Elf, Making The Nice List, Evergreen, Base - SSP Variations, ...)
  // now appears correctly in sectionsReport, and no "1:N packs" artifact
  // category reaches the planner at all. Row count is unchanged (4606, a
  // pure rename with this workbook's own odds-line shape, per #2350's own
  // report). What remains is a DIFFERENT, pre-existing defect #2350 never
  // targeted: the Autographs sheet's bare "Autographs" header repeats
  // (never renamed to anything more specific) over TWO groups of rows that
  // genuinely disagree -- the identical code "BCA-CW" names Jalen Wilson in
  // the first group and Cody Williams in the second, a real multi-signer/
  // duplicate-code shape (the same class task instructions hold 2024 Panini
  // Select Football for: "duplicated-section naming"), never a fold
  // candidate (no roster agreement to fold on) and out of scope here.
  it("planStagedDirectory reports unregistered-set-keys for the split 'Autographs' pair, not the odds-line artifacts", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-topps-holiday-basketball");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual(["topps-holiday-autographs", "topps-holiday-autographs-2"]);
    expect(entry.plan.rows).toBe(4606);
  });

  it("FIXED: every real section name from the #2350 regression proof now appears, zero odds-line artifacts", () => {
    const m = JSON.parse(
      readFileSync(
        join(SCRAPED_ROOT, "acq-2026-09-19-beckett-topps-holiday-basketball", "2025-26-topps-holiday-basketball.manifest.json"),
        "utf8",
      ),
    );
    const oddsLineSections = m.sectionsReport.filter((s: { section: string }) => /^1:[\d,]+ packs/.test(s.section));
    expect(oddsLineSections.length).toBe(0);
    const names = m.sectionsReport.map((s: { section: string }) => s.section);
    for (const real of ["Frostbite Finishers", "Hidden Elf", "Making The Nice List", "Evergreen", "Base - SSP Variations"]) {
      expect(names, real).toContain(real);
    }
    // No heldRows gate any more -- the converter defect that required one is
    // fixed.
    expect(m.heldRows).toBeUndefined();
  });

  it("the split 'Autographs' pair is a genuine disagreeing-roster duplicate code, not a fold candidate", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-topps-holiday-basketball", "2025-26-topps-holiday-basketball.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const rows = lines.map((l) => {
      const parts = l.split(",");
      return { category: parts[0], cardNumber: parts[1], player: parts.slice(5).join(",") };
    });
    const a1 = new Map(rows.filter((r) => r.category === "auto-autographs").map((r) => [r.cardNumber, r.player]));
    const a2 = rows.filter((r) => r.category === "auto-autographs-2");
    expect(a2.length).toBeGreaterThan(0);
    let disagree = 0;
    for (const r of a2) {
      const other = a1.get(r.cardNumber);
      if (other !== undefined && other.trim().toLowerCase() !== r.player.trim().toLowerCase()) disagree++;
    }
    expect(disagree, "every shared code must disagree on player -- this is not a roster subset").toBe(a2.length);
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
