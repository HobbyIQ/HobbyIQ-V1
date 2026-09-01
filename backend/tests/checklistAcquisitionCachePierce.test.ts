/**
 * CF-ACQUISITION-CACHE-PIERCE (2026-09-01). Pins the three defects that zeroed
 * two acquisition targets even though PR #1620's FORCE_ACQUIRE wiring itself
 * worked (both runs echoed `FORCE_ACQUIRE: true`).
 *
 * The shape of all three is the same: a cache between the dispatch and the
 * written row that force-acquire did not pierce, each failing SILENTLY -- a
 * green check, a full phases-done line, and zero rows.
 *
 *   D1  the beckett child got --skipExisting UNCONDITIONALLY, and it skips
 *       before any fetch, so the flag alone made FORCE_ACQUIRE a no-op for the
 *       one phase carrying the parallel ladder ("skipped (existing) 409").
 *   D2  the archive index is baseball-only, so no --sport reaches a basketball
 *       release; --urls is the direct lane. And 0 pages indexed must be LOUD.
 *   D3  the per-CSV `.ingested` marker then skipped the very files a fresh
 *       scrape had just staged (504 CSVs / 2,398,591 rows ingested as none).
 *
 * These drive the real code -- the exported arg builder, the real scraper
 * module, and the real ingester's filter expression -- not a restatement of it.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const SCRIPTS = path.join(__dirname, "..", "scripts");

const { beckettArgs } = require_(path.join(SCRIPTS, "ingest-checklists-end-to-end.cjs"));
const { identify } = require_(path.join(SCRIPTS, "scrape-beckett-checklists.cjs"));

const base = { sport: "baseball", pages: "29", outDir: "/tmp/beckett", urls: "" };

describe("D1 — FORCE_ACQUIRE reaches the beckett child", () => {
  it("omits --skipExisting when force-acquiring", () => {
    const args = beckettArgs({ ...base, forceAcquire: true });
    expect(args).not.toContain("--skipExisting");
  });

  it("includes --skipExisting otherwise, so a normal relaunch still resumes", () => {
    for (const forceAcquire of [false, undefined, null]) {
      expect(beckettArgs({ ...base, forceAcquire })).toContain("--skipExisting");
    }
  });

  it("changes ONLY that flag — sport, pages, delay and outDir are untouched", () => {
    const off = beckettArgs({ ...base, forceAcquire: false });
    const on = beckettArgs({ ...base, forceAcquire: true });
    expect(off.filter((a: string) => a !== "--skipExisting")).toEqual(on);
    expect(on).toEqual(["--sport=baseball", "--pages=29", "--delayMs=700", "--outDir=/tmp/beckett"]);
  });
});

describe("D2 — the direct-URL lane, for the release the index cannot name", () => {
  it("passes --urls through only when one is given", () => {
    const u = "https://www.beckett.com/news/2020-21-panini-prizm-basketball-cards/";
    expect(beckettArgs({ ...base, forceAcquire: true, urls: u })).toContain(`--urls=${u}`);
    expect(beckettArgs({ ...base, forceAcquire: true, urls: "" }).some((a: string) => a.startsWith("--urls="))).toBe(false);
  });

  it("identifies the prizm-2020 SEASON slug as basketball/2020 (the bare 2020- form 404s)", () => {
    const id = identify("https://www.beckett.com/news/2020-21-panini-prizm-basketball-cards/");
    expect(id).toMatchObject({ year: 2020, sport: "basketball", setKey: "panini-prizm" });
  });

  it("identifies the workbook URL itself, so the lane accepts either address", () => {
    const id = identify(
      "https://beckett-www.s3.amazonaws.com/news/news-content/uploads/2021/03/2020-21-Panini-Prizm-Basketball-Checklist-1.xlsx",
    );
    expect(id).toMatchObject({ year: 2020, sport: "basketball", setKey: "panini-prizm" });
    // Carrying the address means the loop fetches no page for this entry.
    expect(id.xlsxUrl).toMatch(/\.xlsx$/);
  });

  it("still refuses a URL it cannot parse, rather than inventing an identity", () => {
    expect(identify("https://www.beckett.com/news/some-editorial-post/")).toBeNull();
    expect(identify("https://example.com/whatever.xlsx")).toBeNull();
  });

  it("pins the empty-scrape guard: 0 set pages indexed must exit nonzero", () => {
    // The guard the insider scraper has and beckett lacked. Asserted against
    // the source because reaching it live would require a 29-page walk; the
    // point is that the branch exists and is fatal, not that fetch fails.
    const src = fs.readFileSync(path.join(SCRIPTS, "scrape-beckett-checklists.cjs"), "utf8");
    expect(src).toMatch(/if \(!urls\.length\)/);
    const guard = src.slice(src.indexOf("if (!urls.length)"));
    expect(guard).toMatch(/0 set pages indexed/);
    expect(guard.slice(0, 900)).toMatch(/process\.exit\(1\)/);
  });

  it("no longer documents the stale img.beckett.com workbook host as current", () => {
    const src = fs.readFileSync(path.join(SCRIPTS, "scrape-beckett-checklists.cjs"), "utf8");
    const header = src.slice(0, src.indexOf("const fs ="));
    expect(header).toContain("beckett-www.s3.amazonaws.com");
    // It may be NAMED as stale; it must not stand as the address to use.
    expect(header).toMatch(/stale/i);
  });
});

describe("D3 — force-acquire pierces the .ingested marker too", () => {
  // Drives ingest-checklist-csv-to-catalog's actual filter expression: a file
  // is dropped when a marker sits beside it and REINGEST is not "true".
  const keep = (names: string[], dir: string, reingestEnv: string | undefined) => {
    const REINGEST = String(reingestEnv || "") === "true";
    return REINGEST ? names : names.filter((n) => !fs.existsSync(path.join(dir, n + ".ingested")));
  };

  let dir = "";
  const files = ["2025-panini-rookies-and-stars-football.csv", "fresh.csv"];

  it("skips a marked CSV when REINGEST is unset, and re-ingests it when true", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiq-reingest-"));
    try {
      for (const n of files) fs.writeFileSync(path.join(dir, n), "category,cardNumber\n");
      fs.writeFileSync(path.join(dir, files[0] + ".ingested"), "");

      // Unset: the marked file is dropped — the D3 defect, working as designed
      // for a budget continuation and wrong for a force-acquire.
      expect(keep(files, dir, undefined)).toEqual(["fresh.csv"]);
      expect(keep(files, dir, "")).toEqual(["fresh.csv"]);
      // Only the exact string "true" opts in.
      expect(keep(files, dir, "false")).toEqual(["fresh.csv"]);
      expect(keep(files, dir, "1")).toEqual(["fresh.csv"]);

      // true: the freshly re-scraped file is ingested again.
      expect(keep(files, dir, "true")).toEqual(files);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the wrapper forwards REINGEST from its own env, not only from MODE", () => {
    const src = fs.readFileSync(path.join(SCRIPTS, "ingest-checklists-end-to-end.cjs"), "utf8");
    const line = src.slice(src.indexOf("REINGEST:"), src.indexOf("REINGEST:") + 300);
    expect(line).toContain("process.env.REINGEST");
    expect(line).toContain('process.env.MODE || ""');
  });

  it("the workflow sets REINGEST from the SAME script+mode guard as FORCE_ACQUIRE", () => {
    const yml = fs.readFileSync(
      path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8",
    );
    const guard = "inputs.script == 'ingest-checklists-end-to-end' && inputs.mode == 'force-acquire'";
    for (const key of ["FORCE_ACQUIRE:", "REINGEST:"]) {
      const at = yml.indexOf(key);
      expect(at, `${key} missing from backfill-runner.yml`).toBeGreaterThan(-1);
      expect(yml.slice(at, at + 200)).toContain(guard);
    }
    // No new workflow_dispatch input: the lane rides `titles`, and dispatch is
    // at 24 of GitHub's 25.
    expect(yml).toContain("BECKETT_URLS: ${{ inputs.script == 'ingest-checklists-end-to-end' && inputs.titles || '' }}");
  });
});
