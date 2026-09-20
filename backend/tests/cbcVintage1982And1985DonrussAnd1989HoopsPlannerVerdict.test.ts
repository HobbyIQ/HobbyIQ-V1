/**
 * CF-WAVE-BRANCH-TRUTH (2026-09-20). Follows the pattern in
 * wave1AcquisitionPackagesMatchTheirCommittedPlannerVerdict.test.ts and
 * beckettPackagesMatchTheirCommittedPlannerVerdict.test.ts: pins the
 * sanctioned ingester's OWN planStagedDirectory verdict for each package this
 * PR ships, measured with nothing but what THIS branch provides.
 *
 * Three packages, all from the 2026-09-20 full census's ranked "genuinely
 * missing checklist" list (Donruss baseball 1982-1990 and NBA Hoops
 * 1989-90/1990-91):
 *
 *   - 1982 Donruss Baseball (cardboardconnection)        PASS, 0 unregistered
 *   - 1985 Donruss Baseball (cardboardconnection)        PASS, 0 unregistered
 *   - 1989-90 NBA Hoops Basketball (cardboardconnection) PASS, 0 unregistered
 *
 * All three resolve to setKeys already registered in productSetKeys.ts
 * before this PR (bare `donruss` for pre-2009 Donruss per that file's own
 * "as-named" ruling comment; `nba-hoops` per the D-series ruling backing the
 * sibling 2022-23/2023-24 nba-hoops packages) -- no new registrations were
 * needed or made in this PR.
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

describe("1982 Donruss Baseball (cardboardconnection) — PASS", () => {
  it("planStagedDirectory reports PASS: bare 'donruss' key, zero unregistered, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-20-cardboardconnection-donruss-1982");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(1982);
    expect(entry.product.setKey).toBe("donruss");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(653);
    expect(entry.plan.ids).toBe(653);
  });

  it("Diamond Kings occupies #1-26 on its OWN — the source never prints a separate plain-base row for those numbers, so there is no collision with base's own #27+ range", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-cardboardconnection-donruss-1982", "1982-donruss-baseball.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const dk = lines.filter((l) => l.startsWith("insert-diamond-kings,"));
    expect(dk.length).toBe(26);
    const nums = dk.map((l) => Number(l.split(",")[1]));
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(26);
    // Base's own numbering starts at 27, the source's own boundary right after Diamond Kings ends.
    const baseNums = lines.filter((l) => l.startsWith("base,")).map((l) => Number(l.split(",")[1]));
    expect(Math.min(...baseNums)).toBe(27);
    // Zero overlap between the two categories' numbers -- this is why planStagedDirectory reports 0 collisions.
    const baseNumSet = new Set(baseNums);
    expect(nums.some((n) => baseNumSet.has(n))).toBe(false);
  });
});

describe("1985 Donruss Baseball (cardboardconnection) — PASS", () => {
  it("planStagedDirectory reports PASS: bare 'donruss' key, zero unregistered, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-20-cardboardconnection-donruss-1985");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("baseball");
    expect(entry.product.year).toBe(1985);
    expect(entry.product.setKey).toBe("donruss");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(653);
    expect(entry.plan.ids).toBe(653);
  });

  it("Diamond Kings (#1-26) and Rated Rookie (#27-46) each occupy their own numbers, base starts fresh at #47 — zero overlap, hence 0 planner collisions", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-cardboardconnection-donruss-1985", "1985-donruss-baseball.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    const dk = lines.filter((l) => l.startsWith("insert-diamond-kings,"));
    const rr = lines.filter((l) => l.startsWith("insert-rated-rookie,"));
    const base = lines.filter((l) => l.startsWith("base,"));
    expect(dk.length).toBe(26);
    expect(rr.length).toBe(20);
    const dkNums = dk.map((l) => Number(l.split(",")[1]));
    const rrNums = rr.map((l) => Number(l.split(",")[1]));
    const baseNums = base.map((l) => Number(l.split(",")[1]));
    expect(Math.min(...dkNums)).toBe(1);
    expect(Math.max(...dkNums)).toBe(26);
    expect(Math.min(...rrNums)).toBe(27);
    expect(Math.max(...rrNums)).toBe(46);
    expect(Math.min(...baseNums)).toBe(47);
    const allNums = new Set([...dkNums, ...rrNums]);
    expect(baseNums.some((n) => allNums.has(n))).toBe(false);
  });

  it("team names were dropped from the player field, not concatenated onto it", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-cardboardconnection-donruss-1985", "1985-donruss-baseball.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    // Source line 1: "1 Ryne Sandberg - Chicago Cubs DK" -> player must be exactly "Ryne Sandberg".
    const row1 = lines.find((l) => l.startsWith("insert-diamond-kings,1,"));
    expect(row1).toBeDefined();
    expect(row1!.endsWith(",Ryne Sandberg")).toBe(true);
  });
});

describe("1989-90 NBA Hoops Basketball (cardboardconnection) — PASS", () => {
  it("planStagedDirectory reports PASS: 'nba-hoops' key already registered, zero unregistered, zero collisions", () => {
    const { entry } = planPackage("acq-2026-09-20-cardboardconnection-nba-hoops-1989-90");
    expect(entry.product).not.toBeNull();
    expect(entry.product.sport).toBe("basketball");
    expect(entry.product.year).toBe(1989);
    expect(entry.product.setKey).toBe("nba-hoops");
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.unregistered).toEqual([]);
    expect(entry.plan.collisions).toEqual([]);
    expect(entry.plan.rows).toBe(353);
    expect(entry.plan.ids).toBe(353);
  });

  it("Series 1 (#1-300) and Series 2 (#301-353) both land as plain base rows, card-type markers (SP/AS/Coach/RC) stripped", () => {
    const csv = readFileSync(
      join(SCRAPED_ROOT, "acq-2026-09-20-cardboardconnection-nba-hoops-1989-90", "1989-90-nba-hoops-basketball.csv"),
      "utf8",
    );
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
    expect(lines.every((l) => l.startsWith("base,"))).toBe(true);
    const nums = lines.map((l) => Number(l.split(",")[1]));
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(353);
    expect(new Set(nums).size).toBe(353);
    // No row's player field carries a trailing card-type/rookie marker.
    for (const l of lines) {
      const player = l.split(",").slice(5).join(",");
      expect(player).not.toMatch(/\s(SP|AS|Coach|RC)$/);
    }
  });
});
