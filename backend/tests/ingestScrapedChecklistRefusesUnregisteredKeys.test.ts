/**
 * CF-A-SECOND-INGESTER-IS-A-SECOND-SET-OF-RULES (2026-09-19).
 *
 * ingest-scraped-checklist.cjs minted every row on `manifest.setKey` verbatim
 * -- no insert-set separation, no id-collision guard, no unregistered-key
 * refusal -- while ingest-checklist-csv-to-catalog.cjs, reading the exact
 * same checklist-csv-contract shape, refuses on those two things via
 * lib/insert-set-key.cjs. Two ingesters disagreeing about a row's ADDRESS is
 * the defect CF-ONE-DERIVATION-OR-TWO-CENSUSES already names, and it was
 * live: converting 2024 Panini Zenith Football (Beckett S3 source) and
 * reporting through this script printed "0 refused" while the ids it would
 * have minted collapsed 5,423 rows onto 3,238 addresses -- 646 real
 * collisions, one write per second silently overwriting the last.
 *
 * This pins that ingest-scraped-checklist.cjs now measures the SAME plan
 * ingest-checklist-csv-to-catalog.cjs does before writing anything, and:
 *   (a) REFUSES, exit 1, zero rows minted -- neither DRY-RUN nor APPLY --
 *       on a file whose insert sets are not yet registered normalizeSetKey
 *       fixed points, naming every key and its row count;
 *   (b) is BYTE-IDENTICAL, dry-run output, on a file with no such clash --
 *       the shape every staged product had before this fix, and the shape
 *       most staged products still take (one set per file, one numbering
 *       run) -- so nothing this script already did correctly moves.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "..", "scripts", "ingest-scraped-checklist.cjs");
const BACKEND = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-scraped-refuse-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function run(csvPath: string, env: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: BACKEND,
      encoding: "utf8",
      env: { ...process.env, CSV_PATH: csvPath, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: String(e.stdout || "") + String(e.stderr || ""), status: typeof e.status === "number" ? e.status : 1 };
  }
}

function stage(name: string, csv: string, manifest: Record<string, unknown>): string {
  const csvPath = path.join(TMP, `${name}.csv`);
  fs.writeFileSync(csvPath, csv);
  fs.writeFileSync(csvPath.replace(/\.csv$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
  return csvPath;
}

describe("a same-numbered clash refuses the whole file, before any write", () => {
  // "panini-prizm" is a real normalizeSetKey FIXED POINT with a real brand
  // catch-all: any longer key starting "panini-prizm-" that is not itself
  // registered folds back onto the bare flagship. A made-up product prefix
  // with no such rule passes normalizeSetKey unchanged (a no-op is trivially
  // its own fixed point) and never demonstrates a real refusal -- this is
  // exactly the shape 2024 Panini Zenith Football's real keys hit
  // (`panini-zenith-z-marquee` -> `panini-zenith`), reused here so the test
  // exercises the real registry rather than inventing one.
  it("refuses DRY-RUN with exit 1 and names every unregistered key", () => {
    // Card #1, blank parallel, unsigned -- claimed by TWO distinct named
    // insert sets with their own numbering that happens to start at 1, the
    // exact shape 2024 Panini Zenith Football measured.
    const csv = [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,,false,,Real Base Player",
      "insert-alpha-set,1,,false,,Alpha Player One",
      "insert-beta-set,1,,false,,Beta Player One",
    ].join("\n");
    const csvPath = stage("clashing-product", csv, {
      sport: "football", year: 2024, setKey: "panini-prizm", setName: "2024 Test Panini Prizm",
      parallelColumnAuthoritative: true,
    });
    const { stdout, status } = run(csvPath);
    expect(status).toBe(1);
    expect(stdout).toMatch(/REFUSED/);
    expect(stdout).toMatch(/unregistered-set-keys/);
    expect(stdout).toMatch(/panini-prizm-alpha-set/);
    expect(stdout).toMatch(/panini-prizm-beta-set/);
    expect(stdout).toMatch(/NO ROWS WRITTEN/);
  });

  it("refuses APPLY the same way -- never reaches a Cosmos call", () => {
    const csv = [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "insert-alpha-set,1,,false,,Alpha Player One",
      "insert-beta-set,1,,false,,Beta Player One",
    ].join("\n");
    const csvPath = stage("clashing-product-apply", csv, {
      sport: "football", year: 2024, setKey: "panini-prizm", setName: "2024 Test Panini Prizm 2",
      parallelColumnAuthoritative: true,
    });
    // No COSMOS_CONNECTION_STRING at all -- if this reached upsertCatalogEntry
    // it would throw a connection error, not print a clean REFUSED banner.
    const { stdout, status } = run(csvPath, { APPLY: "true", COSMOS_CONNECTION_STRING: "" });
    expect(status).toBe(1);
    expect(stdout).toMatch(/REFUSED/);
    expect(stdout).not.toMatch(/ECONNREFUSED|getaddrinfo|Cosmos/i);
  });
});

describe("a file with no same-numbered clash is unaffected", () => {
  it("mints byte-identical output to the pre-guard behaviour", () => {
    // One set, one numbering run -- the shape every staged product had before
    // R30 existed, and the shape most still take. The plan's own `separate`
    // set is empty here, so setKeyFor returns the plain product key for every
    // row: nothing about this output may move.
    const csv = [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,,false,,Player One",
      "base,2,,false,,Player Two",
      "insert-shiny-parallel,1,Refractor,false,99,Player One",
    ].join("\n");
    const csvPath = stage("clean-product", csv, {
      sport: "baseball", year: 2024, setKey: "test-clean-product", setName: "2024 Test Clean Product",
      parallelColumnAuthoritative: true,
    });
    const { stdout, status } = run(csvPath);
    expect(status).toBe(0);
    expect(stdout).not.toMatch(/REFUSED/);
    expect(stdout).toMatch(/hiq:baseball:2024:test-clean-product:1:base:no-auto/);
    expect(stdout).toMatch(/hiq:baseball:2024:test-clean-product:2:base:no-auto/);
    // The lone insert row rides ITS OWN category on the flagship key (no
    // clash to separate), Refractor on the parallel axis -- unchanged shape.
    expect(stdout).toMatch(/total would-upsert=3/);
  });

  it("is unaffected on a real, previously-staged file (1957 Topps Basketball)", () => {
    const realCsv = path.join(BACKEND, "data", "checklists", "scraped", "1957-topps-basketball.csv");
    if (!fs.existsSync(realCsv)) return; // committed fixture may move; skip rather than fail the suite
    const { stdout, status } = run(realCsv);
    expect(status).toBe(0);
    expect(stdout).not.toMatch(/REFUSED/);
    expect(stdout).toMatch(/total would-upsert=80/);
  });
});
