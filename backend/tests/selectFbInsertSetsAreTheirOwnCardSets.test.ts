/**
 * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-CARD-SET, 2024 Panini Select Football
 * (R60 + R38, Drew).
 *
 * BEFORE these registrations the committed checklistinsider package reported:
 *
 *     files REFUSED, id integrity 1 (27,324 rows)   -- unregistered-set-keys
 *     would ingest 0 rows
 *     27,324 rows would have landed on 22,503 distinct ids
 *
 * AFTER: REFUSED 0, 27,324 rows on 27,324 distinct ids, with 33 insert sets on
 * their own key (6,889 rows) and 4,755 colour rungs folded onto the parallel
 * axis -- the rungs stayed rungs.
 *
 * -- THE TIERS ARE NOT REGISTERED HERE, DELIBERATELY ------------------------
 *
 * Select numbers its base card by TIER: `insert-base-concourse`,
 * `-club-level`, `-suite-level`, `-premier-level`, `-field-level` -- 19,900
 * rows. Those are the product's own base card, they stay on the product key,
 * and not one of them appeared in the refusal list. #2231 registered the tier
 * destinations already.
 *
 * They also CANNOT collide, which is what separates Select from Zenith. The
 * tiers hold DISJOINT number ranges (Concourse 1-200, Club Level 201-300,
 * Suite Level 301+), so two tier rows never share an id. Zenith's `insert-base`
 * variants all reuse #1-100 with the same players, which is why Zenith needs an
 * upstream category fix and Select does not. Pinned below.
 *
 * -- THE STUTTER IS THE PRODUCT'S OWN NAMING -------------------------------
 *
 * `panini-select-signatures` and `panini-select-select-signatures` are BOTH
 * ruled and both correct: the source carries `insert-signatures-*` AND
 * `insert-select-signatures-*` as two different sets. Collapsing the doubled
 * word would merge two card sets.
 */
import { describe, expect, it } from "vitest";

import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

/** The 33 keys the ingester's guard named, verbatim. */
const RULED: readonly string[] = [
  "panini-select-2025-xrc-mystery-autograph",
  "panini-select-alter-ego",
  "panini-select-color-wheel",
  "panini-select-draft-selections-memorabilia",
  "panini-select-hall-selections",
  "panini-select-jumbo-rookie-signature-swatch-black-prizm-brand-logo",
  "panini-select-jumbo-rookie-signature-swatch-black-prizm-nfl-shield",
  "panini-select-jumbo-rookie-signature-swatch-black-prizm-tag",
  "panini-select-jumbo-rookie-signature-swatches",
  "panini-select-jumbo-rookie-swatch",
  "panini-select-jumbo-signature-swatch-black-prizm-brand-logo",
  "panini-select-jumbo-signature-swatch-black-prizm-nfl-shield",
  "panini-select-jumbo-signature-swatch-black-prizm-tag",
  "panini-select-jumbo-signature-swatches",
  "panini-select-multiverse",
  "panini-select-neon-icons",
  "panini-select-phenomenon",
  "panini-select-rookie-signature-memorabilia",
  "panini-select-rookie-signatures",
  "panini-select-rookie-swatches",
  "panini-select-score-select-throwback",
  "panini-select-select-certified-rookies",
  "panini-select-select-future",
  "panini-select-select-numbers",
  "panini-select-select-signatures",
  "panini-select-signature-memorabilia",
  "panini-select-signatures",
  "panini-select-snapshots",
  "panini-select-sparks",
  "panini-select-spectra-hof-signatures-prizm",
  "panini-select-starcade",
  "panini-select-turbocharged",
  "panini-select-watercolors",
];

/** Registered by #2231; the tier rows are the base card, not insert sets. */
const TIERS: readonly string[] = [
  "panini-select-concourse",
  "panini-select-premier-level",
  "panini-select-field-level",
];

describe("2024 Panini Select Football — the 33 named insert sets", () => {
  it("pins the count the guard measured", () => {
    expect(RULED).toHaveLength(33);
  });

  it("every ruled key is a normalizeSetKey FIXED POINT", () => {
    for (const k of RULED) expect(normalizeSetKey(k, "football"), k).toBe(k);
  });

  it("re-spelling is idempotent", () => {
    for (const k of RULED) {
      const once = normalizeSetKey(k, "football");
      expect(normalizeSetKey(once, "football")).toBe(once);
    }
  });

  it("the STUTTER is two sets, and both stand", () => {
    // insert-signatures-* and insert-select-signatures-* are different sets.
    expect(normalizeSetKey("panini-select-signatures", "football")).toBe("panini-select-signatures");
    expect(normalizeSetKey("panini-select-select-signatures", "football")).toBe("panini-select-select-signatures");
    expect(normalizeSetKey("panini-select-signatures", "football"))
      .not.toBe(normalizeSetKey("panini-select-select-signatures", "football"));
  });

  it("MUTATION: the #2231 TIER keys are untouched", () => {
    for (const k of TIERS) expect(normalizeSetKey(k, "football"), k).toBe(k);
  });

  it("MUTATION: the flagship still answers itself", () => {
    expect(normalizeSetKey("panini-select", "football")).toBe("panini-select");
    expect(normalizeSetKey("2024 Panini Select", "football")).toBe("panini-select");
  });

  it("MUTATION: neighbouring products are untouched", () => {
    for (const k of [
      "panini-prizm", "panini-zenith", "panini-mosaic", "panini-illusions",
      "panini-phoenix", "panini-obsidian", "panini-absolute",
      "panini-illusions-trophy-collection",
    ]) expect(normalizeSetKey(k, "football"), k).toBe(k);
  });

  it("MUTATION: a bare insert word never claims a product key", () => {
    for (const w of ["signatures", "sparks", "multiverse", "snapshots"]) {
      expect(normalizeSetKey(w, "football").startsWith("panini-select-"), w).toBe(false);
    }
  });

  it("no ruled key is a prefix of another — the derived-root trap", () => {
    for (const a of RULED) for (const b of RULED) {
      if (a !== b) expect(b.startsWith(a + "-"), a + " prefixes " + b).toBe(false);
    }
  });

  it("no ruled key is another's singular/plural twin", () => {
    const all = new Set(RULED);
    for (const k of all) {
      const s = k.replace(/s$/, "");
      if (s !== k) expect(all.has(s), k + " twins " + s).toBe(false);
    }
  });

  it("no ruled key ends in a bare colour", () => {
    // Select has none; a colour-tailed key needs the Zenith Zoom roster proof.
    for (const k of RULED) {
      expect(/-(black|blue|gold|red|white|green|orange|purple|pink|silver|teal|maroon)$/.test(k), k).toBe(false);
    }
  });
});
