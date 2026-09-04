/**
 * CF-AN-UNATTESTED-CSV-IS-WORSE-THAN-NO-CSV +
 * CF-A-TICKET-IS-A-RUNG-NOT-A-CARD-LINE +
 * CF-THE-CHILD-MAY-WRITE-EITHER-KEY  (2026-09-04)
 *
 * The hobbymonitor lane finished 192/192 with 22 `failed` control docs. Three
 * of the four classes were OUR defects, not the source's, and every one of
 * them is pinned here against bytes fetched from the live release pages.
 *
 * A. CLEANLINESS GATE, 5 products (2023/24 + 2024/25 Panini basketball, 2024 +
 *    2025 Prizm Football, 2025/26 Topps Basketball), all refused as
 *    "cartesian". Every ladder this lane emits is dense BY CONSTRUCTION: the
 *    fetcher joins each rung of a subset onto every card of that same subset,
 *    so `rows == cards x rungs` with no gaps is the CORRECT shape. Measured on
 *    the live 2024 Prizm Football page: 19 of its categories are perfectly
 *    dense, base among them at 400 cards x 63 rungs = 25,200 ladder rows --
 *    byte-for-byte the shape the production verdict named. Density therefore
 *    carries NO signal on this lane; provenance is the only separator, exactly
 *    as #1726 says. The proof that the gate was never the problem is 2009/10
 *    Topps Basketball, which INGESTED cleanly in production and is refused by
 *    the identical rule the moment its sidecar is taken away.
 *
 * B. SHORT INGEST, 14 products. A measurement error, not lost data -- see
 *    setKeyCandidates.
 *
 * C. "parallel is a card line", 2 products. Real published rungs.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require_ = createRequire(import.meta.url);
const driver = require_("../scripts/ingest-universe-driver.cjs");

const FIX = path.join(__dirname, "fixtures", "hobbymonitor");
const DENSE = path.join(FIX, "prizm-base-ladder-dense.csv");
const TICKETS = path.join(FIX, "contenders-ticket-rungs.csv");

/** Copy a staged CSV somewhere WITHOUT its manifest, to read the gate's
 *  unattested verdict on identical bytes. */
function stripManifest(csv: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-unattested-"));
  const out = path.join(dir, path.basename(csv));
  fs.copyFileSync(csv, out);
  return out;
}

describe("A: a checklist-backed full ladder is attested, and admitted", () => {
  it("admits the 2024 Prizm Football base ladder, which is perfectly dense", () => {
    // The fixture is a whole-card slice of the live page: every card carries
    // every rung, no gaps -- the exact signature the gate refuses unattested.
    const r = driver.gateStagedCsv(DENSE);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("the fixture really IS the refused shape — density is not being dodged", () => {
    const unattested = stripManifest(DENSE);
    expect(driver.ladderIsAttested(unattested)).toBe(false);
    const r = driver.gateStagedCsv(unattested);
    // MUTATION RED: if the sidecar stopped being what admits this file, this
    // assertion would pass for the wrong reason. It must name the cartesian.
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pairs every one of \d+ cards with every one of \d+ rungs/);
    expect(r.reason).toMatch(/cartesian product, not a ladder/);
  });

  it("attestation is what flips the verdict, on the same bytes", () => {
    expect(driver.ladderIsAttested(DENSE)).toBe(true);
    const unattested = stripManifest(DENSE);
    expect(fs.readFileSync(DENSE, "utf8")).toBe(fs.readFileSync(unattested, "utf8"));
    expect(driver.gateStagedCsv(DENSE).ok).toBe(true);
    expect(driver.gateStagedCsv(unattested).ok).toBe(false);
  });

  it("a synthetic cross-join with NO attestation is still refused", () => {
    // The 11.49M-row graveyard's own shape, unattested: it must stay out.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-synth-"));
    const csv = path.join(dir, "synthetic.csv");
    const rows = ["category,cardNumber,parallel,isAuto,printRun,player"];
    for (let n = 1; n <= 40; n++) {
      rows.push(`base,${n},,false,,Player ${n}`);
      for (const rung of ["Gold", "Silver", "Red", "Blue", "Green"]) {
        rows.push(`base,${n},${rung},false,,Player ${n}`);
      }
    }
    fs.writeFileSync(csv, rows.join("\n") + "\n");
    const r = driver.gateStagedCsv(csv);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cartesian product, not a ladder/);
  });
});

describe("C: a Contenders ticket is a rung, not a card line", () => {
  it("admits Round 1 / Game 5 Ticket, which the source prices /199 and /5", () => {
    const r = driver.gateStagedCsv(TICKETS);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("still refuses a real card line in the parallel column", () => {
    // The guard keeps its teeth: a bare "<number> <name>" has no period word.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cardline-"));
    const csv = path.join(dir, "cardline.csv");
    fs.writeFileSync(csv, [
      "category,cardNumber,parallel,isAuto,printRun,player",
      "base,1,,false,,Caleb Williams",
      "base,2,27 Caleb Williams,false,,Bo Nix",
      "base,3,BD-121 Spencer Torkelson,false,,Drake Maye",
    ].join("\n") + "\n");
    const r = driver.gateStagedCsv(csv);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parallel is a card line/);
  });
});

describe("B: the verification asks for both keys the child may have written", () => {
  // ingest-checklist-csv-to-catalog resolves `m.setKey || normalizeSetKey(...)`,
  // so a manifest that STATES a key is honoured verbatim. The driver normalized
  // before querying, so it read a key the rows were never written under.
  // Exquisite is NOT in this list any more: #1747 made it its own product, so
  // `upper-deck-exquisite` is now a normalizeSetKey fixed point and there is no
  // second spelling to ask for. It has its own case below -- a ruling that
  // stops a key collapsing must SHRINK the candidate list, and that is the
  // outcome worth pinning.
  const cases: Array<[string, number, string]> = [
    ["2025/26 Topps Three Basketball", 2025, "topps"],
    ["2024 Panini Clearly Donruss Football", 2024, "panini-donruss"],
    ["2025 Panini Score-A-Treat Football", 2025, "panini-score"],
  ];

  for (const [setName, year, collapsed] of cases) {
    it(`asks for both the stated and the normalized key for ${setName}`, () => {
      const keys = driver.setKeyCandidates({ lane: "hobbymonitor", setName, year });
      // The RAW key first: it is the one the manifest states and the child writes.
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys).toContain(driver.setKeyFor({ lane: "hobbymonitor", setName, year }));
      // And the collapsed one, so a product whose manifest omitted a setKey is
      // still counted rather than reported wholly missing.
      expect(keys).toContain(collapsed);
      expect(keys[0]).not.toBe(collapsed);
    });
  }

  it("Exquisite needs only ONE key now that #1747 made it its own product", () => {
    // Before #1747 `upper-deck-exquisite -> upper-deck` and the driver counted
    // 44,840 Upper Deck rows against a 705-row product. The ruling makes the
    // stated key a fixed point, so the candidate list collapses to one -- and
    // the 705 rows the lane reported "missing" were always right there.
    const keys = driver.setKeyCandidates({
      lane: "hobbymonitor",
      setName: "2003/04 Upper Deck Exquisite Basketball",
      year: 2003,
    });
    expect(keys).toEqual(["upper-deck-exquisite"]);
    expect(driver.canonicalSetKey("upper-deck-exquisite")).toBe("upper-deck-exquisite");
  });

  it("never drops the stated key in favour of the alias", () => {
    // The regression: normalizing ALONE reported 2,105 of 2,482 Sapphire
    // identities missing while all 2,105 sat under the stated key.
    const keys = driver.setKeyCandidates({
      lane: "hobbymonitor",
      setName: "2025/26 Topps Chrome Update Series Basketball Sapphire",
      year: 2025,
    });
    expect(keys[0]).toBe("topps-chrome-update-series-basketball-sapphire");
  });

  it("returns a single key when the alias table has no opinion", () => {
    const keys = driver.setKeyCandidates({ lane: "hobbymonitor", setName: "2025/26 Topps Definitive Basketball", year: 2025 });
    expect(keys).toEqual(["topps-definitive"]);
  });
});

describe("A (fetcher side): staging without a manifest is refused, not noted", () => {
  const fetcher = path.join(__dirname, "..", "scripts", "fetchHobbyMonitorChecklist.cjs");

  it("the fetcher refuses to write a CSV it cannot attest", () => {
    // A CSV without its sidecar is a booby trap: it looks like a clean
    // acquisition and is then refused by the cartesian rule, blaming the
    // checklist for a flag we failed to write. It must fail loudly instead.
    const src = fs.readFileSync(fetcher, "utf8");
    expect(src).toMatch(/refusing to stage an unattested CSV/);
    // And it must leave nothing half-staged behind.
    expect(src).toMatch(/fs\.unlinkSync\(out\)/);
    // The old silent NOTE must be gone.
    expect(src).not.toMatch(/CSV written without one/);
  });
});
