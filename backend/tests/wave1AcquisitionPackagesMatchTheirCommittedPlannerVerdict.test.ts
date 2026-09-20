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
 * full per-key evidence). Donruss Football stays REFUSE: 16 of its 18
 * unregistered keys were genuine and are now registered, but the remaining 2
 * (`rated-rookies-autographs`, `optic-rated-rookies-preview-autographs`) are
 * a 100% roster match against Base's own Rated Rookies subset -- on-card
 * autograph PARALLELS of the base rookie cards, not real sets -- and are
 * deliberately left unregistered pending a converter fold, so the file still
 * refuses on those two.
 *
 *   - 2024 Panini Prizm Football (Beckett S3)        PASS (was REFUSE, 23
 *     unregistered -- all 23 were genuine, now registered)
 *   - 2024 Panini Phoenix Football (Beckett S3)       REFUSE, 23 unregistered
 *     (untouched by this PR -- held pending the converter fix, out of scope)
 *   - 2024 Panini Donruss Football, full workbook     REFUSE, 2 unregistered
 *     (was 18; 16 genuine keys now registered, 2 fold-candidates deliberately
 *     left unregistered -- see productSetKeys.ts's own comment)
 *     (Base+Press Proof already staged in #2304 under
 *     acq-2026-09-19-beckett-football-donruss-mosaic/ -- THIS package is the
 *     FULL workbook including Autographs/Memorabilia/Inserts, a separate
 *     directory so it does not collide with or duplicate that prior stage)
 *   - 2024-25 Panini Prizm Basketball (Beckett S3)    PASS (was REFUSE, 19
 *     unregistered -- all 19 were genuine, now registered)
 *   - 2025 Topps Holiday Baseball (Beckett S3)        PASS, zero unregistered
 *   - 2025-26 Topps Holiday Basketball (Beckett S3)   REFUSE, 2 unregistered
 *     (both are a converter defect, not a real set -- see the hazard note
 *     below and the PR body: the Autographs sheet's odds-line "1:379 packs"
 *     is being read as the section name in place of the sheet's own generic
 *     "Autographs" header; the Base and Inserts sheets on this SAME workbook
 *     converted cleanly because their sheets carry real distinguishing
 *     section names, so this is scoped to the Autographs sheet only)
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

describe("2024 Panini Donruss Football, full workbook (Beckett S3) — REFUSE persists, 2 fold-candidates not genuine sets", () => {
  it("planStagedDirectory reports unregistered-set-keys for the 2 held-out fold-candidates only, down from 18", () => {
    const { entry } = planPackage("acq-2026-09-19-beckett-panini-donruss-fb-full");
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("refuse");
    expect(entry.plan.reason).toBe("unregistered-set-keys");
    const keys = entry.plan.unregistered.map((u: { setKey: string }) => u.setKey).sort();
    expect(keys).toEqual([
      "panini-donruss-optic-rated-rookies-preview-autographs",
      "panini-donruss-rated-rookies-autographs",
    ]);
    expect(entry.plan.rows).toBe(6369);
  });

  it("the 2 held-out keys are a 100% roster match against Base's own Rated Rookies — parallels, not sets", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full", "2024-panini-donruss-football.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const rows = lines.map((l) => {
      const parts = l.split(",");
      return { category: parts[0], cardNumber: parts[1], player: parts.slice(5).join(",") };
    });
    const baseRatedRookies = new Set(
      rows
        .filter((r) => r.category === "base" && Number(r.cardNumber) >= 301 && Number(r.cardNumber) <= 400)
        .map((r) => `${r.cardNumber}::${r.player.trim().toLowerCase()}`),
    );
    for (const cat of [
      "auto-rated-rookies-autographs",
      "auto-rated-rookies-autographs-orange",
      "auto-rated-rookies-autographs-purple",
      "auto-optic-rated-rookies-preview-autographs",
    ]) {
      const roster = rows
        .filter((r) => r.category === cat)
        .map((r) => `${r.cardNumber}::${r.player.trim().toLowerCase()}`);
      expect(roster.length, cat).toBeGreaterThan(0);
      expect(roster.every((t) => baseRatedRookies.has(t)), `${cat} must be a 100% subset of base Rated Rookies`).toBe(true);
    }
  });

  it("does not collide with the prior base-only stage's own directory", () => {
    // #2304 staged Base+Press Proof only (2,900 rows) under
    // acq-2026-09-19-beckett-football-donruss-mosaic/. This package is a
    // SEPARATE directory carrying the full workbook (base+autos+mem+
    // inserts, 6,369 rows) -- both are one CSV per package directory.
    const priorDir = join(SCRAPED_ROOT, "acq-2026-09-19-beckett-football-donruss-mosaic");
    const priorFiles = readdirSync(priorDir).filter((f: string) => f.endsWith(".csv"));
    expect(priorFiles).toEqual(["2024-panini-donruss-football.csv"]);
    const thisDir = join(SCRAPED_ROOT, "acq-2026-09-19-beckett-panini-donruss-fb-full");
    const thisFiles = readdirSync(thisDir).filter((f: string) => f.endsWith(".csv"));
    expect(thisFiles).toEqual(["2024-panini-donruss-football.csv"]);
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
