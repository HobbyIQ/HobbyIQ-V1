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
