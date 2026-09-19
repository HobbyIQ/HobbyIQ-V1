/**
 * CF-A-SCOPE-DIR-IS-A-COPY-OR-IT-IS-A-FORK, follow-up (2026-09-19).
 *
 * `backend/data/checklists/2026-topps-chrome-oneshot/` and
 * `backend/data/checklists/2026-bowman-oneshot/` exist for the same reason as
 * `tcgdex-ja-sv10/` (PR #2263): `ingest-checklist-csv-to-catalog.cjs` takes a
 * whole DIRECTORY (`fs.readdirSync(DIR)`, no per-file filter). The originals
 * live in the shared `backend/data/checklists/scraped/` directory, which
 * holds hundreds of other staged files -- scoping an ingest at that directory
 * to land ONE of them would re-upsert every other file in it too (fresh
 * lastSeenAt/ETag churn, the same risk class as the 2026-09-14 Bush/Mantle
 * incident).
 *
 * UNLIKE ja-sv10, these two directories are NOT byte-identical to their
 * originals: a 2026-09-19 bounded Cosmos diagnosis found both original
 * checklists (2026-topps-chrome-baseball.csv, 2026-bowman-full.csv) were
 * staged and NEVER actually ingested (17/25 and 22/25 of a sampled not-backed
 * set had zero catalog rows anywhere for their exact card numbers, and zero
 * rows anywhere carried a source tag tracing to either file's own scrape
 * date). Each copy here had a small R67 different-players-same-number
 * collision trimmed out before planStagedDirectory would pass:
 *   - 2026-topps-chrome-oneshot: 8 rows (two Cooperstown Calls classes
 *     sharing CC-N numbering with different players per class)
 *   - 2026-bowman-oneshot: 24 rows (the Ultimate Autograph Booklet, 24
 *     different signers sharing card number UAC-1)
 * So the contract here is SUBSET, not byte equality: every row in the scope
 * directory's CSV must appear verbatim in the original, and the manifest must
 * say in writing what was trimmed and why.
 *
 * THESE DIRECTORIES ARE DISPOSABLE. Each exists to scope one APPLY and may be
 * deleted afterwards -- see its README. When one goes, its half of this file
 * goes with it via the `describe.skipIf` guards below.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DATA = path.resolve(__dirname, "..", "data", "checklists");

function parseCsvRows(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean).slice(1);
}

const CASES = [
  {
    scopeDir: path.join(DATA, "2026-topps-chrome-oneshot"),
    scopeCsv: "2026-topps-chrome-baseball.csv",
    originalPath: path.join(DATA, "scraped", "2026-topps-chrome-baseball.csv"),
  },
  {
    scopeDir: path.join(DATA, "2026-bowman-oneshot"),
    scopeCsv: "2026-bowman-baseball.csv",
    originalPath: path.join(DATA, "scraped", "2026-bowman-full.csv"),
  },
];

for (const { scopeDir, scopeCsv, originalPath } of CASES) {
  const present = fs.existsSync(scopeDir);
  const manifestPath = path.join(scopeDir, `${scopeCsv.replace(/\.csv$/, "")}.manifest.json`);

  describe.skipIf(!present)(`${path.basename(scopeDir)} is a trimmed subset, never a fork`, () => {
    it("holds exactly one CSV — a second one defeats the whole point", () => {
      const files = fs.readdirSync(scopeDir).filter((f) => f.endsWith(".csv"));
      expect(files).toEqual([scopeCsv]);
    });

    it("every row in the scope copy appears verbatim in the original", () => {
      const here = fs.readFileSync(path.join(scopeDir, scopeCsv), "utf8");
      expect(fs.existsSync(originalPath), `original ${originalPath} is missing`).toBe(true);
      const original = fs.readFileSync(originalPath, "utf8");
      const originalRows = new Set(parseCsvRows(original));
      const hereRows = parseCsvRows(here);
      const notInOriginal = hereRows.filter((r) => !originalRows.has(r));
      expect(notInOriginal, "scope copy contains a row not present in the original — synthesized data").toEqual([]);
    });

    it("the manifest declares readyToIngest: false and says what was trimmed", () => {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(m.readyToIngest).toBe(false);
      expect(m.trimmedFromOriginal, "manifest must record what rows were trimmed and why").toBeTruthy();
      expect(typeof m.trimmedFromOriginal.why).toBe("string");
      expect(m.trimmedFromOriginal.why.length).toBeGreaterThan(0);
    });

    it("says in writing why it exists and that it may be deleted", () => {
      const readme = path.join(scopeDir, "README.md");
      expect(fs.existsSync(readme), "the scope dir needs a README stating it is disposable").toBe(true);
      const text = fs.readFileSync(readme, "utf8");
      expect(text).toMatch(/scope/i);
      expect(text).toMatch(/delete/i);
    });
  });
}
