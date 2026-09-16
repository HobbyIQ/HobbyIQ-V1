/**
 * CF-A-REGENERATE-MUST-NOT-ERASE-A-RULING (2026-09-15).
 *
 * R47 added three 2025 Allen & Ginter mini rungs -- Mini Gold Border, Mini
 * Black Border, Mini Black -- covering 406 pool rows. They are checklist-backed
 * in card_catalog but absent from every scraped FILE, because they came from
 * `baseballcardpedia-ladders-2026-09-04` and `checklistcenter-2026-08-30`,
 * which were never scraped into one.
 *
 * They were added by HAND-EDITING the generated JSON, which works exactly
 * once. MEASURED: regenerating from the three source dirs with the overlay
 * disabled produces ZERO mini rungs for that product -- the ruling silently
 * gone, and nothing in the output to notice it.
 *
 * So the ruling lives in a committed overlay the builder reads on every run.
 * The overlay is INPUT, like the CSVs; the generated file is OUTPUT.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(backend, "scripts", "build-parallel-vocabulary.cjs");
const OVERLAY = path.join(backend, "data", "checklist-parallel-overlays.json");
const SRC = "C:/tmp/ci/csv2";
const AG = "baseball|2025|topps-allen-ginter";

interface Corpus { products?: Record<string, { parallels?: { name?: string; overlay?: unknown }[] }>; }

function build(overlayPath: string): Corpus {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "ovl-")), "c.json");
  execFileSync(process.execPath, [BUILDER, `--dirs=${SRC}`, `--overlay=${overlayPath}`, `--out=${out}`], { stdio: "ignore" });
  return JSON.parse(readFileSync(out, "utf8")) as Corpus;
}
const minis = (c: Corpus) =>
  (c.products?.[AG]?.parallels ?? []).filter((x) => /^mini/i.test(String(x.name)));

const maybe = existsSync(SRC) ? describe : describe.skip;

/**
 * NO PRODUCT SILENTLY LOSES NAMES (the acquisition researcher's ask,
 * 2026-09-15).
 *
 * The rebuild that took the corpus 627 -> 660 also dropped
 * `baseball|2025|topps-allen-ginter` from 11 rungs to 8 -- R47's three A&G
 * mini rungs, 406 pool rows -- and nothing in the output said so. A count that
 * moves in the right direction overall (+162 names) hides a regression inside
 * one cell.
 *
 * So the SHIPPED file is asserted per product against the previous one: every
 * name a product had must still be accounted for, either as a parallel or as
 * an insert-set child. A name that is in neither is a silent drop and fails
 * here with the product named.
 */
describe("the shipped corpus loses no product and no unexplained name", () => {
  const shipped = JSON.parse(
    readFileSync(path.join(backend, "data", "checklist-parallel-names.json"), "utf8"),
  ) as {
    products?: Record<string, {
      parallels?: { name?: string }[];
      insertSets?: { children: string[] }[];
    }>;
  };

  /** The corpus as main has it, read without a worktree. */
  function onMain(): typeof shipped | null {
    try {
      const raw = execFileSync("git", ["show", "origin/main:backend/data/checklist-parallel-names.json"],
        { cwd: path.resolve(backend, ".."), encoding: "utf8", maxBuffer: 1 << 28 });
      return JSON.parse(raw) as typeof shipped;
    } catch { return null; }   // origin/main not fetched -- absence is not evidence
  }

  it("A&G 2025 keeps all three mini rungs — the regression this guards", () => {
    const ag = shipped.products?.["baseball|2025|topps-allen-ginter"];
    expect(ag).toBeTruthy();
    const minis = (ag!.parallels ?? []).filter((x) => /^mini/i.test(String(x.name)));
    expect(minis.map((x) => String(x.name)).sort())
      .toEqual(["Mini Black", "Mini Black Border", "Mini Gold Border"]);
  });

  it("no product on main is missing from the shipped corpus", () => {
    const prev = onMain(); if (!prev) return;
    const gone = Object.keys(prev.products ?? {}).filter((k) => !(k in (shipped.products ?? {})));
    expect(gone).toEqual([]);
  });

  it("every name a product had is still accounted for", () => {
    const prev = onMain(); if (!prev) return;
    const lost: string[] = [];
    for (const [key, before] of Object.entries(prev.products ?? {})) {
      const after = shipped.products?.[key];
      if (!after) continue;                       // covered by the test above
      const had = new Set((before.parallels ?? []).map((x) => String(x.name).toLowerCase()));
      for (const x of after.parallels ?? []) had.delete(String(x.name).toLowerCase());
      for (const s of after.insertSets ?? []) for (const c of s.children) had.delete(c.toLowerCase());
      // A name may also have been CLEANED to a different spelling; compare on
      // the cleaned key so a re-spelling is not reported as a loss.
      const normed = new Set([
        ...(after.parallels ?? []).map((x) => String(x.name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
        ...(after.insertSets ?? []).flatMap((s) => s.children.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())),
      ]);
      for (const n of [...had]) {
        if (normed.has(n.replace(/[^a-z0-9]+/g, " ").trim())) had.delete(n);
      }
      if (had.size) lost.push(`${key}: ${[...had].slice(0, 4).join(", ")}`);
    }
    expect(lost.slice(0, 10)).toEqual([]);
  });
});

maybe("the overlay survives a regenerate", () => {
  it("the overlay file carries R47's three rungs with their provenance", () => {
    const o = JSON.parse(readFileSync(OVERLAY, "utf8")) as {
      overlays?: { ruling?: string; source?: string; parallels?: { name: string }[] }[];
    };
    const ag = (o.overlays ?? []).find((e) => (e as { setKey?: string }).setKey === "topps-allen-ginter");
    expect(ag).toBeTruthy();
    expect(ag!.parallels!.map((p) => p.name).sort())
      .toEqual(["Mini Black", "Mini Black Border", "Mini Gold Border"]);
    // Provenance is the point: the file says which ruling admitted the name.
    expect(ag!.ruling).toMatch(/R47/);
    expect(ag!.source).toMatch(/baseballcardpedia|checklistcenter/);
  });

  it("WITHOUT the overlay a regenerate loses all three -- the risk, measured", () => {
    expect(minis(build("/nonexistent-overlay.json")).length).toBe(0);
  });

  it("WITH the overlay all three survive, carrying their provenance", () => {
    const m = minis(build(OVERLAY));
    expect(m.map((x) => String(x.name)).sort())
      .toEqual(["Mini Black", "Mini Black Border", "Mini Gold Border"]);
    expect(m.every((x) => x.overlay)).toBe(true);
  });
});
