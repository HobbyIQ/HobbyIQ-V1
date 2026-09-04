/**
 * CF-THE-SIDECAR-NAME-IS-A-CONTRACT (2026-09-04).
 *
 * The tcgdex-ja modern lane wrote its sidecars as `<stem>.csv.meta.json`. The
 * ingest it feeds -- ingest-checklist-csv-to-catalog.cjs, productOf() -- reads
 * `<stem>.manifest.json`, and so do build-parallel-vocabulary.cjs,
 * ingest-scraped-checklist.cjs and migrate-checklists-to-one-format.cjs. Every
 * other scraper lane in the repo emits that name.
 *
 * THE FAILURE WAS SILENT, which is why it needs a pin rather than a fix alone.
 * On a missing manifest productOf() falls back to parsing the FILENAME, and
 * `2022-s12a-pokemon` PARSES -- sport=pokemon, year=2022, setKey=s12a. Nothing
 * errors; the rows land. What is lost is what a filename cannot carry:
 *
 *     setName    "2022 s12a"  instead of  "Japanese VSTARユニバース"
 *     sourceUrl  null         instead of  the tcgdex set URL
 *
 * -- 52 catalog products named after their own key, and 7,182 rows with no
 * provenance back to the source that minted them.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { productOf } = require("../scripts/ingest-checklist-csv-to-catalog.cjs");

const DIR = path.join(__dirname, "..", "data", "checklists", "tcgdex-ja-modern");
const csvs = fs.readdirSync(DIR).filter((f) => f.endsWith(".csv")).sort();

describe("the tcgdex-ja modern lane ships the sidecar its ingest reads", () => {
  it("stages 52 products", () => {
    expect(csvs).toHaveLength(52);
  });

  it("every CSV has a .manifest.json beside it — the name productOf() reads", () => {
    for (const csv of csvs) {
      const manifest = path.join(DIR, csv.replace(/\.csv$/, ".manifest.json"));
      expect(fs.existsSync(manifest), `${csv} has no .manifest.json`).toBe(true);
    }
  });

  it("no .csv.meta.json survives — that name is read by a DIFFERENT ingest", () => {
    // ingest-product-checklist.cjs reads `<name>.csv.meta.json`. It is not this
    // lane's ingest, and shipping both names would leave the two disagreeing.
    const strays = fs.readdirSync(DIR).filter((f) => f.endsWith(".meta.json"));
    expect(strays).toEqual([]);
  });

  it("productOf() takes setName and sourceUrl FROM THE MANIFEST, not the filename", () => {
    for (const csv of csvs) {
      const p = productOf(path.join(DIR, csv));
      expect(p, `${csv} did not resolve`).not.toBeNull();
      // The Japanese set NAME, never the filename's "<year> <key>" echo.
      expect(p.setName).toMatch(/^Japanese /);
      expect(p.setName).not.toMatch(/^\d{4} /);
      // Provenance back to the source that minted the row.
      expect(p.sourceUrl).toMatch(/^https:\/\/api\.tcgdex\.net\/v2\/ja\/sets\//);
      expect(p.sport).toBe("pokemon");
      expect(Number.isFinite(p.year)).toBe(true);
    }
  });

  it("the manifest setKey is the BARE OFFICIAL CODE and productOf() keeps it", () => {
    for (const csv of csvs) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(DIR, csv.replace(/\.csv$/, ".manifest.json")), "utf8"),
      );
      const p = productOf(path.join(DIR, csv));
      expect(p.setKey).toBe(manifest.setKey);
      expect(p.setKey).toBe(String(manifest.tcgdexId).toLowerCase());
      expect(p.setKey).not.toMatch(/^swsh/);
      expect(p.setKey).not.toMatch(/^japanese-/);
    }
  });

  // THE MUTATION. This is what proves the pin above is load-bearing: rename the
  // sidecar back to the old name and productOf() silently degrades rather than
  // failing, which is exactly how 52 products lost their names unnoticed.
  it("MUTATION: under the old .csv.meta.json name the setName and sourceUrl are LOST", () => {
    const csv = "2022-s12a-pokemon.csv";
    const good = productOf(path.join(DIR, csv));
    expect(good.setName).toBe("Japanese VSTARユニバース");
    expect(good.sourceUrl).toBe("https://api.tcgdex.net/v2/ja/sets/S12a");

    const manifest = path.join(DIR, "2022-s12a-pokemon.manifest.json");
    const stray = path.join(DIR, "2022-s12a-pokemon.csv.meta.json");
    fs.renameSync(manifest, stray);
    try {
      const degraded = productOf(path.join(DIR, csv));
      // It does NOT throw — it falls back to the filename, and that is the bug.
      expect(degraded.setKey).toBe("s12a");        // survives, by luck of the name
      expect(degraded.setName).toBe("2022 s12a");  // the set's NAME is gone
      expect(degraded.sourceUrl).toBeNull();       // the provenance is gone
    } finally {
      fs.renameSync(stray, manifest);
    }
    // and restored
    expect(productOf(path.join(DIR, csv)).setName).toBe("Japanese VSTARユニバース");
  });

  it("the manifest carries the row count the CSV actually holds", () => {
    for (const csv of csvs) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(DIR, csv.replace(/\.csv$/, ".manifest.json")), "utf8"),
      );
      const dataRows = fs.readFileSync(path.join(DIR, csv), "utf8").trim().split("\n").length - 1;
      expect(manifest.rowCount, `${csv} rowCount`).toBe(dataRows);
    }
  });
});
