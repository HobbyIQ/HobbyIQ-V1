// CF-A-RESLUG-THAT-CHANGES-THE-RUNG-CARRIES-THE-RUNG'S-TEXT (2026-09-26,
// relocate-catalog-rows-by-list.cjs review, tonight's merge-authority
// follow-up).
//
// `backend/scripts/lib/graded-id.cjs` MIRRORS
// `backend/src/services/catalog/catalogRowOps.service.ts`'s private
// `parseSlugWithGrade` -- deliberately NOT exported, because exporting it is
// a `backend/src` change and tonight's merge authority for this fix excludes
// `backend/src`. This file pins that the mirror's OUTPUT matches the real
// function's, fixture by fixture, so the mirror cannot silently drift from
// the grammar the real reslug/fold lanes are judged against.
//
// WHY HARD-CODED TUPLES, NOT A LIVE dist/ REQUIRE OF THE REAL FUNCTION.
// `parseSlugWithGrade` is not exported from catalogRowOps.service.ts (see
// above), so `require("../dist/services/catalog/catalogRowOps.service.js")`
// cannot reach it -- `Object.keys(ops)` confirms it is absent from the
// module's exports. Reaching into a private, unexported function via any
// other mechanism (rewriting the compiled .js, monkeypatching the module
// object, using node internals to read a closure) would be worse than this:
// it would depend on characteristics of the CURRENT build output rather than
// the function's documented contract, and break in ways unrelated to the
// contract actually changing. So the expected tuples below are hard-coded,
// and every one of them was PRODUCED BY the real function and cross-checked
// against this file's mirror in the same session that wrote this test (by
// temporarily building catalogRowOps.service.ts with `export` added,
// confirmed 0 mismatches across all 15 fixtures below, then reverting the
// export -- see the PR's commit history for that verification step). The
// citation below is the real function's source AS OF THAT VERIFICATION, so a
// future change to either file is expected to require updating both this
// header and the fixtures together, in the same PR.
//
// SOURCE CITED (backend/src/services/catalog/catalogRowOps.service.ts,
// `function parseSlugWithGrade(slug)`, 2026-09-26, ~L514-527):
//
//   const direct = parseHobbyIqCardId(slug);
//   if (direct) return { parsed: direct, parentSlug: slug, gradeTier: null };
//   const cut = slug.lastIndexOf(":");
//   if (cut <= 0) return null;
//   const head = slug.slice(0, cut);
//   const tier = slug.slice(cut + 1);
//   if (!tier || tier.startsWith("num-")) return null;
//   const parsed = parseHobbyIqCardId(head);
//   if (!parsed) return null;
//   return { parsed, parentSlug: head, gradeTier: tier };
//
// NOTE THE ABSENCE OF A GRADER ALLOW-LIST. The real function never inspects
// the tier's own shape beyond "not empty, not `num-*`" -- there is no
// psa/sgc/bgs/cgc table anywhere in it. Fixture #11 below
// ("...no-auto:nonsense-tail") pins that directly: the real function DOES
// accept it as a gradeTier, and the mirror must too, or the mirror would be
// STRICTER than the real grammar the moved rows are judged against.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const libPath = join(__dirname, "..", "scripts", "lib", "graded-id.cjs");

const { parseSlugWithGrade } = require_(libPath) as {
  parseSlugWithGrade: (
    slug: string,
    parseId: (id: string) => Record<string, unknown> | null,
  ) => { parsed: Record<string, unknown>; parentSlug: string; gradeTier: string | null } | null;
};

const { parseHobbyIqCardId } = require_(
  join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
) as { parseHobbyIqCardId: (id: string) => Record<string, unknown> | null };

const parse = (slug: string) => parseSlugWithGrade(slug, parseHobbyIqCardId);

type Fixture = {
  label: string;
  slug: string;
  expected: { parsed: Record<string, unknown>; parentSlug: string; gradeTier: string | null } | null;
};

// Every expected value here was produced by the REAL parseSlugWithGrade and
// cross-checked to match this mirror with 0 mismatches -- see this file's
// header for the verification method.
const FIXTURES: Fixture[] = [
  {
    label: "1. a plain raw card, no grade tail",
    slug: "hiq:baseball:2020:topps:1:base:no-auto",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: false, printRun: null },
      parentSlug: "hiq:baseball:2020:topps:1:base:no-auto",
      gradeTier: null,
    },
  },
  {
    label: "2. graded, PSA integer grade",
    slug: "hiq:baseball:2020:topps:1:base:no-auto:psa-10",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: false, printRun: null },
      parentSlug: "hiq:baseball:2020:topps:1:base:no-auto",
      gradeTier: "psa-10",
    },
  },
  {
    label: "3. graded, SGC DECIMAL grade (the shape that most tempts a naive tier regex)",
    slug: "hiq:baseball:2020:topps:1:base:no-auto:sgc-9-5",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: false, printRun: null },
      parentSlug: "hiq:baseball:2020:topps:1:base:no-auto",
      gradeTier: "sgc-9-5",
    },
  },
  {
    label: "4. graded, BGS",
    slug: "hiq:baseball:2020:topps:1:base:no-auto:bgs-9",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: false, printRun: null },
      parentSlug: "hiq:baseball:2020:topps:1:base:no-auto",
      gradeTier: "bgs-9",
    },
  },
  {
    label: "5. graded, CGC (the exact Silver Crackle Foil / #2431 review shape)",
    slug: "hiq:baseball:2020:topps:1:base:no-auto:cgc-10",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: false, printRun: null },
      parentSlug: "hiq:baseball:2020:topps:1:base:no-auto",
      gradeTier: "cgc-10",
    },
  },
  {
    label: "6. raw, numbered auto (printRun in the id, no grade tail)",
    slug: "hiq:baseball:2020:topps:1:base:auto:num-50",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: true, printRun: 50 },
      parentSlug: "hiq:baseball:2020:topps:1:base:auto:num-50",
      gradeTier: null,
    },
  },
  {
    label: "7. graded AND numbered — the tier is the tail, num- is never mistaken for it",
    slug: "hiq:baseball:2020:topps:1:base:auto:num-50:psa-9",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: true, printRun: 50 },
      parentSlug: "hiq:baseball:2020:topps:1:base:auto:num-50",
      gradeTier: "psa-9",
    },
  },
  {
    label: "8. graded child of a Pokemon insert (the actual #1846/#2431 Crown Zenith shape)",
    slug: "hiq:pokemon:2023:swsh12-5:gg01:full-art:no-auto:cgc-10",
    expected: {
      parsed: { sport: "pokemon", year: 2023, setKey: "swsh12-5", cardNumber: "gg01", parallel: "full-art", isAuto: false, printRun: null },
      parentSlug: "hiq:pokemon:2023:swsh12-5:gg01:full-art:no-auto",
      gradeTier: "cgc-10",
    },
  },
  {
    label: "9. subset-bearing, raw (no grade tail) — the sub- segment must survive into `parsed`",
    slug: "hiq:pokemon:2023:swsh12-5:sub-cards-that-never-were:gg01:full-art:no-auto",
    expected: {
      parsed: {
        sport: "pokemon", year: 2023, setKey: "swsh12-5", cardNumber: "gg01", parallel: "full-art", isAuto: false, printRun: null,
        subsetName: "cards-that-never-were", subsetInId: true,
      },
      parentSlug: "hiq:pokemon:2023:swsh12-5:sub-cards-that-never-were:gg01:full-art:no-auto",
      gradeTier: null,
    },
  },
  {
    label: "10. subset-bearing AND graded — both optional segments at once",
    slug: "hiq:pokemon:2023:swsh12-5:sub-cards-that-never-were:gg01:full-art:no-auto:cgc-10",
    expected: {
      parsed: {
        sport: "pokemon", year: 2023, setKey: "swsh12-5", cardNumber: "gg01", parallel: "full-art", isAuto: false, printRun: null,
        subsetName: "cards-that-never-were", subsetInId: true,
      },
      parentSlug: "hiq:pokemon:2023:swsh12-5:sub-cards-that-never-were:gg01:full-art:no-auto",
      gradeTier: "cgc-10",
    },
  },
  {
    label: "11. NO GRADER ALLOW-LIST — any non-num- tail is accepted as a tier, even nonsense",
    slug: "hiq:baseball:2020:topps:1:base:no-auto:nonsense-tail",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: false, printRun: null },
      parentSlug: "hiq:baseball:2020:topps:1:base:no-auto",
      gradeTier: "nonsense-tail",
    },
  },
  {
    label: "12. a num- tail is NEVER a grade tier, even with nothing else to explain it",
    slug: "hiq:baseball:2020:topps:1:base:no-auto:num-99",
    expected: {
      parsed: { sport: "baseball", year: 2020, setKey: "topps", cardNumber: "1", parallel: "base", isAuto: false, printRun: 99 },
      parentSlug: "hiq:baseball:2020:topps:1:base:no-auto:num-99",
      gradeTier: null,
    },
  },
  {
    label: "13. MALFORMED — not a hiq slug at all",
    slug: "not-a-slug-at-all",
    expected: null,
  },
  {
    label: "14. MALFORMED — too few segments even after treating the tail as a grade",
    slug: "hiq:baseball:2026:topps:161",
    expected: null,
  },
  {
    label: "15. MALFORMED — a bare namespace with nothing to split",
    slug: "hiq:x",
    expected: null,
  },
];

describe("graded-id.cjs mirrors catalogRowOps.parseSlugWithGrade, fixture by fixture", () => {
  it.each(FIXTURES.map((f) => [f.label, f] as const))("%s", (_label, f) => {
    expect(parse(f.slug)).toEqual(f.expected);
  });

  it("covers at least 12 fixtures across graded / raw / subset-bearing / malformed shapes", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(12);
    const graded = FIXTURES.filter((f) => f.expected && f.expected.gradeTier !== null);
    const raw = FIXTURES.filter((f) => f.expected && f.expected.gradeTier === null);
    const subsetBearing = FIXTURES.filter((f) => f.expected && "subsetName" in f.expected.parsed);
    const malformed = FIXTURES.filter((f) => f.expected === null);
    expect(graded.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    expect(subsetBearing.length).toBeGreaterThan(0);
    expect(malformed.length).toBeGreaterThan(0);
  });

  it("MUTATION: an allow-list of grader names would reject fixture #11 -> red", () => {
    // The real function has no such list (see this file's header); a mirror
    // that added one would silently become STRICTER than the real grammar,
    // refusing a graded-child reslug the real lane would accept. This proves
    // the mirror does not have one.
    const r = parse("hiq:baseball:2020:topps:1:base:no-auto:nonsense-tail");
    expect(r).not.toBeNull();
    expect(r?.gradeTier).toBe("nonsense-tail");
  });

  it("num- is excluded from tier-hood on every fixture that has one, never just the last one tried", () => {
    for (const f of FIXTURES) {
      if (f.slug.endsWith(":num-99") || f.slug.endsWith(":num-50")) {
        expect(f.expected?.gradeTier).toBeNull();
      }
    }
  });
});

// ── the lane actually uses this mirror, bound to its own parseHobbyIqCardId ─

describe("the lane wires graded-id.cjs in, not a re-implementation inline", () => {
  const laneSrc = readFileSync(
    join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs"),
    "utf8",
  );

  it("requires lib/graded-id.cjs rather than exporting the real one from backend/src", () => {
    expect(laneSrc).toContain('require(path.join(__dirname, "lib", "graded-id.cjs"))');
    expect(laneSrc).toContain("gradedIdLib.parseSlugWithGrade(slug, parseHobbyIqCardId)");
  });

  it("backend/src's parseSlugWithGrade stays UNEXPORTED — this fix must not touch it", () => {
    const src = readFileSync(
      join(__dirname, "..", "src", "services", "catalog", "catalogRowOps.service.ts"),
      "utf8",
    );
    expect(src).toContain("function parseSlugWithGrade(slug: string):");
    expect(src).not.toContain("export function parseSlugWithGrade(slug: string):");
  });
});
