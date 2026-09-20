// #2337 / R67 follow-on (2026-09-19): 2024 PANINI ILLUSIONS FOOTBALL (Beckett
// S3 source) + 2024 PANINI MOSAIC FOOTBALL -- TWENTY NAMED INSERT SETS.
//
// A named insert set is its own product key; a mere finish/colour suffix
// ("-Prizm", "-Mosaic" on an already-registered sibling) is NOT a key -- the
// finish rides the parallel field, or in this batch's two spelling-artefact
// cases (Mosaic's Center Stage / Overdrive), is simply stripped in the
// converter (#2337), never registered a second time.
//
// Every key below cleared the SAME bar as every prior R60/R67 registration in
// this file: run through the converter's own production classifier
// (`classifySections`), each landed `role: own-cards` -- no fold candidate
// found, meaning its numbers are not a clean subset of any anchor already on
// the file. See productSetKeys.ts's own registration comments for the full
// per-key row counts and source-sheet provenance.
import { describe, it, expect } from "vitest";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const ILLUSIONS_INSERTS = ["mystique", "instant-impact"];

const MOSAIC_INSERTS = [
  "in-focus-signatures", "notoriety", "capital-gains-mosaic", "moments-in-time",
  "showtime-signatures", "epic-performers", "touchdown-masters", "splash-mosaic",
  "carbon-copy", "storm-mosaic", "kaleidoscopic", "micro-mosaic", "money",
  "signatures-highlights", "gridiron-greats", "pinnacle-inscriptions",
  "franchise-numbers", "super-bowl-signatures",
];

// The two Mosaic keys that strip to an ALREADY-registered sibling
// (panini-mosaic-center-stage, panini-mosaic-overdrive, both registered in
// the pre-existing basketball-era block) -- fixed as a converter spelling
// correction in #2337, never registered here under the -mosaic spelling.
const MOSAIC_FOLD_ARTEFACTS = ["center-stage-mosaic", "overdrive-mosaic"];

describe("2024 Panini Illusions Football (Beckett S3) — two more named insert sets", () => {
  it("registers both", () => {
    const missing = ILLUSIONS_INSERTS.filter((sub) => !isProductSetKey(`panini-illusions-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT", () => {
    const collapsed = ILLUSIONS_INSERTS
      .map((sub) => `panini-illusions-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-illusions", () => {
    for (const sub of ILLUSIONS_INSERTS) {
      const key = `panini-illusions-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-illusions`).toBe("panini-illusions");
    }
  });

  it("does not touch the 28 checklistinsider-sourced Illusions keys already registered", () => {
    // Sample a few of the pre-existing registrations (R60/R67) to confirm
    // this PR's additions did not disturb them.
    for (const sub of ["trophy-collection", "illusionists", "deja-vu", "clutch-signatures"]) {
      expect(isProductSetKey(`panini-illusions-${sub}`), sub).toBe(true);
    }
  });
});

describe("2024 Panini Mosaic Football — eighteen named insert sets", () => {
  it("registers all eighteen", () => {
    expect(MOSAIC_INSERTS.length).toBe(18);
    const missing = MOSAIC_INSERTS.filter((sub) => !isProductSetKey(`panini-mosaic-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT", () => {
    const collapsed = MOSAIC_INSERTS
      .map((sub) => `panini-mosaic-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-mosaic", () => {
    for (const sub of MOSAIC_INSERTS) {
      const key = `panini-mosaic-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-mosaic`).toBe("panini-mosaic");
    }
  });

  it("does NOT register the two fold-artefact spellings — they fold in the converter (#2337), not here", () => {
    for (const sub of MOSAIC_FOLD_ARTEFACTS) {
      expect(isProductSetKey(`panini-mosaic-${sub}`), `${sub} must stay unregistered`).toBe(false);
    }
  });

  it("the fold-artefact spellings DO resolve to their already-registered bare sibling", () => {
    expect(normalizeSetKey("panini-mosaic-center-stage-mosaic")).toBe("panini-mosaic-center-stage");
    expect(normalizeSetKey("panini-mosaic-overdrive-mosaic")).toBe("panini-mosaic-overdrive");
    expect(isProductSetKey("panini-mosaic-center-stage")).toBe(true);
    expect(isProductSetKey("panini-mosaic-overdrive")).toBe(true);
  });

  it("does not touch the pre-existing basketball-era Mosaic registrations", () => {
    for (const sub of ["center-stage", "overdrive", "bang", "jam-masters"]) {
      expect(isProductSetKey(`panini-mosaic-${sub}`), sub).toBe(true);
    }
  });
});
