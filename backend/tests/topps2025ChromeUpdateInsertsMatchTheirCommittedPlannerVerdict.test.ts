/**
 * Follow-up acquisition (2026-09-21): 2025 Topps Chrome Update Series
 * Baseball named insert/autograph sets. Diagnosed from a sold_comps sample
 * under baseball/2025/topps-chrome: most "unbacked" USC-prefixed / USA-
 * prefixed sales are a WRONG-KEY defect (landing under bare topps-chrome instead of the already-
 * registered, already-partially-backed topps-chrome-update-series -- flagged
 * for engineering, not staged here). The genuine gaps named 5 sets by
 * cardNumber prefix, all found on checklistinsider.com's OWN 2025 Topps
 * Chrome Update Series product page (not the base 2025 Topps Chrome page,
 * which does not carry these codes): Chrome Update Autographs (AC), Rookie
 * Debut Autographs (CRDA), Chromeography (CHRU), Chrome Legends Autographs
 * (CLA), Night Terrors (NT).
 *
 * setKey is topps-chrome-update-series (already registered in
 * productSetKeys.ts as `S("topps-chrome-update-series", ...)`) -- no new key
 * needed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const INGEST = require_(join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs"));

const DIR = join(__dirname, "..", "data", "checklists", "scraped", "acq-2026-09-21-checklistinsider-topps-chrome-2025-inserts");
const CSV_NAME = "2025-topps-chrome-inserts.csv";

function planDir(dir: string) {
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".csv"));
  return INGEST.planStagedDirectory(dir, files);
}

function csvLines(): string[] {
  return readFileSync(join(DIR, CSV_NAME), "utf8").trim().split("\n").slice(1);
}

describe("2025 Topps Chrome Update Series Baseball inserts (checklistinsider)", () => {
  it("clean file PASSes offline: 3,421 rows, 3,421 distinct ids, 0 collisions, 0 unregistered", () => {
    const plans = planDir(DIR);
    const entry = plans.get(CSV_NAME);
    expect(entry.product).not.toBeNull();
    expect(entry.plan.verdict, JSON.stringify(entry.plan.unregistered)).toBe("pass");
    expect(entry.plan.rows).toBe(3421);
    expect(entry.plan.ids).toBe(3421);
    expect(entry.plan.collisions.length).toBe(0);
  });

  it("setKey is topps-chrome-update-series, already registered -- no new key minted this PR", () => {
    const m = JSON.parse(readFileSync(join(DIR, "2025-topps-chrome-inserts.manifest.json"), "utf8"));
    expect(m.setKey).toBe("topps-chrome-update-series");
  });

  it("HARD CHECK: 0 byte-identical duplicate CSV lines", () => {
    const lines = csvLines();
    const seen = new Set(lines);
    expect(seen.size).toBe(lines.length);
  });

  it("HARD CHECK: every row for a given cardNumber prefix carries ONE consistent isAuto value", () => {
    const lines = csvLines();
    const byPrefix = new Map<string, Set<string>>();
    for (const l of lines) {
      const cols = l.split(",");
      const cardNumber = cols[1];
      const isAuto = cols[3];
      const m = /^[A-Za-z0-9]+-/.exec(cardNumber);
      const prefix = m ? m[0] : cardNumber;
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
      byPrefix.get(prefix)!.add(isAuto);
    }
    for (const [prefix, values] of byPrefix) {
      expect(values.size, `prefix ${prefix} has mixed isAuto values: ${[...values].join(",")}`).toBe(1);
    }
    // Confirm the 4 autograph sets are all true and Night Terrors is false.
    expect(byPrefix.get("AC-")).toEqual(new Set(["true"]));
    expect(byPrefix.get("CRDA-")).toEqual(new Set(["true"]));
    expect(byPrefix.get("CHRU-")).toEqual(new Set(["true"]));
    expect(byPrefix.get("CLA-")).toEqual(new Set(["true"]));
    expect(byPrefix.get("NT-")).toEqual(new Set(["false"]));
  });

  it("Chrome Legends Autographs (CLA-) base row carries printRun 50, not blank -- the source states the base card itself as /50", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-chrome-legends-autographs,CLA-AB,"));
    const baseRow = lines.find((l) => l.split(",")[2] === "");
    expect(baseRow).toBeDefined();
    expect(baseRow!.split(",")[4]).toBe("50");
  });

  it("Chrome Update Autographs (AC-) has exactly 110 distinct cards, not the page's stated 127 -- the trailing 17-card RA- continuation is deliberately excluded (out of this task's target prefix scope)", () => {
    const lines = csvLines().filter((l) => l.startsWith("auto-chrome-update-autographs,"));
    const cardNumbers = new Set(lines.map((l) => l.split(",")[1]));
    expect(cardNumbers.size).toBe(110);
    expect([...cardNumbers].every((c) => c.startsWith("AC-"))).toBe(true);
  });
});
