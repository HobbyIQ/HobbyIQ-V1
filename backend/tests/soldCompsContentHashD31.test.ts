/**
 * THE ' Refractor' STRIP IN THE contentHash -- the blocker before any APPLY.
 *
 * `computeContentHash` normalized the parallel by stripping a trailing
 * " Refractor"/" Refractors". That was safe under the rule that a colour and
 * its colour-refractor sibling were one card. D31 RETRACTED that rule: there
 * is no colour/finish vocabulary rule, the catalog resolver decides per card,
 * and Topps Finest #197 lists `Uncommon` AND `Uncommon Refractor` as two of
 * roughly 600 real card pairs Drew named.
 *
 * With the strip in place a $40 `Blue` sale and a $900 `Blue Refractor` sale
 * on one cardId hash IDENTICALLY. `recordSoldComp`'s pre-write dedup reads
 * "same contentHash in this partition" as "the same sale", so the loser of
 * that comparison is never written -- a genuine sale swallowed at ingest, and
 * both cards' FMV wrong. The D30 fold makes it far more likely by moving both
 * rows into ONE partition.
 *
 * TRANSITION SAFETY is the other half. Stored rows carry hashes computed WITH
 * the strip. If the dedup looked up only the new hash, then on the day this
 * ships every re-emit of an already-stored `Blue Refractor` sale would miss
 * its own stored row and be written AGAIN -- the fix would resurrect the
 * duplicates it exists to prevent. So the LOOKUP asks for both forms while the
 * pool is mixed; the WRITE only ever stores the new one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeContentHash,
  legacyContentHash,
  contentHashesForLookup,
} from "../src/services/portfolioiq/soldCompsStore.service.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sale = (parallel: string) => ({
  cardId: "hiq:baseball:2024:topps-finest:197:base:no-auto",
  parallel,
  isAuto: false,
  gradeCompany: null,
  gradeValue: null,
  price: 40,
  soldAt: "2026-08-30T12:00:00Z",
});

describe("a colour and its colour-refractor sibling are TWO sales", () => {
  it("`Uncommon` and `Uncommon Refractor` no longer collide (Drew's 600 Finest cards)", () => {
    expect(computeContentHash(sale("Uncommon"))).not.toBe(computeContentHash(sale("Uncommon Refractor")));
  });

  it("`Blue` and `Blue Refractor` no longer collide", () => {
    expect(computeContentHash(sale("Blue"))).not.toBe(computeContentHash(sale("Blue Refractor")));
  });

  it("THE BUG WAS REAL: the legacy hash DID collide them (mutation check)", () => {
    // If this ever stops failing to differ, the legacy form has been changed
    // and the transition lookup below is no longer describing the stored pool.
    expect(legacyContentHash(sale("Blue"))).toBe(legacyContentHash(sale("Blue Refractor")));
    expect(legacyContentHash(sale("Uncommon"))).toBe(legacyContentHash(sale("Uncommon Refractors")));
  });

  it("the hash still ignores real noise: case, padding and repeated spaces", () => {
    expect(computeContentHash(sale("  BLUE   Refractor "))).toBe(computeContentHash(sale("blue refractor")));
  });

  it("a plain `Refractor` parallel is not emptied to the base card", () => {
    // Under the strip, "Refractor" normalized to "" and hashed as the base
    // card's own sale.
    expect(computeContentHash(sale("Refractor"))).not.toBe(computeContentHash(sale("")));
  });
});

describe("the transition lookup sees rows stored under EITHER form", () => {
  it("a refractor parallel is looked up under both the new and the legacy hash", () => {
    const forms = contentHashesForLookup(sale("Blue Refractor"));
    expect(forms).toHaveLength(2);
    expect(forms[0]).toBe(computeContentHash(sale("Blue Refractor")));
    expect(forms).toContain(legacyContentHash(sale("Blue Refractor")));
  });

  it("a parallel the strip never touched is ONE lookup, exactly as before", () => {
    // The two forms differ only for a parallel ending in refractor/refractors,
    // so for almost every sale in the pool this is unchanged behaviour.
    expect(contentHashesForLookup(sale("Blue"))).toHaveLength(1);
    expect(contentHashesForLookup(sale("Gold Vinyl"))).toHaveLength(1);
    expect(contentHashesForLookup(sale("base"))).toHaveLength(1);
  });

  it("the NEW form is always first -- it is the one a write stores", () => {
    expect(contentHashesForLookup(sale("Blue Refractor"))[0]).toBe(computeContentHash(sale("Blue Refractor")));
  });

  it("a stored legacy `Blue Refractor` row is still FOUND, so the fix cannot resurrect duplicates", () => {
    const storedHash = legacyContentHash(sale("Blue Refractor"));
    expect(contentHashesForLookup(sale("Blue Refractor"))).toContain(storedHash);
  });

  it("but a stored legacy `Blue` row is NOT claimed by a `Blue Refractor` write", () => {
    // The whole point: the transition must not re-create the conflation it is
    // removing. `Blue`'s legacy hash equals `Blue Refractor`'s legacy hash, so
    // this is the one place the dual lookup could reintroduce the bug --
    // it does not, because a `Blue` write looks up only the new form.
    expect(contentHashesForLookup(sale("Blue"))).not.toContain(computeContentHash(sale("Blue Refractor")));
  });
});

describe("the store WRITES the new form and LOOKS UP both", () => {
  const source = fs.readFileSync(
    path.join(backend, "src", "services", "portfolioiq", "soldCompsStore.service.ts"),
    "utf8",
  );

  it("the pre-write dedup query asks for every lookup form", () => {
    expect(source).toMatch(/ARRAY_CONTAINS\(@h, c\.contentHash\)/);
    expect(source).toMatch(/value: contentHashLookup/);
  });

  it("the strip is GONE from the hash input", () => {
    const fn = source.slice(source.indexOf("function normalizeParallelForHash"), source.indexOf("function legacyNormalizeParallelForHash"));
    expect(fn).not.toMatch(/refractors\?\$/);
  });

  it("the legacy normalization survives ONLY as the legacy helper", () => {
    const legacy = source.slice(source.indexOf("function legacyNormalizeParallelForHash"));
    expect(legacy.slice(0, 300)).toMatch(/refractors\?\$/);
  });
});

describe("relocate-sold-comp mirrors the store, or the fold writes an unfindable hash", () => {
  const lib = fs.readFileSync(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"), "utf8");

  it("the script lib strips nothing in its live hash either", () => {
    const fn = lib.slice(lib.indexOf("function contentHashOf"), lib.indexOf("function legacyContentHashOf"));
    expect(fn).not.toMatch(/refractors\?\$/);
  });

  it("and the two implementations agree on a refractor sale", async () => {
    const mod = await import(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs").replace(/\\/g, "/"));
    const rel = (mod.default ?? mod) as { contentHashOf: (r: unknown) => string };
    const s = sale("Blue Refractor");
    expect(rel.contentHashOf(s)).toBe(computeContentHash(s));
  });
});
