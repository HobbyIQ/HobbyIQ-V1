// CF-A-GRADE-IS-A-GRADER-TOKEN-PLUS-A-NUMERAL (Drew, 2026-09-04).
//
// #1691 taught the census CLASSIFIER to refuse a grade the title cannot
// support (gradeFromTitleStrict). It did not touch the WRITER, so every
// ingest kept minting the rows the census kept refusing. This suite pins the
// writer to the same contract, and pins the two readers to each other.
//
// The contract:
//   - a grade requires an explicit GRADER TOKEN, and the numeral is the one
//     that FOLLOWS it (skipping slab-label words: GRADED / GEM / MINT / MT);
//   - "#N" is a CARD NUMBER, never a grade;
//   - a raw condition adjective with no grader (VG, EX, NM, VG-EX, EX-MT,
//     NM-MT) describes an UNGRADED card;
//   - ABSENT BEATS WRONG -- no readable grade returns null, which means
//     "raw / leave the stored grade alone", never a licence to guess.

import { describe, it, expect } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  parseGradeFromTitle,
  parseGradeLabel,
} from "../src/services/portfolioiq/gradeParser.js";
import { ingestGradeFromTitle } from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

const GRADER = /\b(PSA|BGS|BVG|SGC|CGC|CSG|HGA|TAG|ISA|GMA|KSA)\b/i;

describe("CF-A-GRADE-IS-A-GRADER-TOKEN-PLUS-A-NUMERAL: the reported defects", () => {
  // Every title below was reported as producing a WRONG grade. Each is
  // pinned with the result the contract requires.
  const defects: Array<[string]> = [
    // "#N" is a card number. The adjective licensed the inference and the
    // any-number fallback then supplied the CARD NUMBER as the value.
    ["#5 San Francisco"],
    ["#8 HOF"],
    ["#1 DRAFT PICKS"],
    ["Mickey Mantle #5 NM"],
    ["Ted Williams #8 EX"],
    ["Nolan Ryan #1 VG"],
    ["1955 Topps Mickey Mantle #2 EX-MT"],
    ["Roberto Clemente NM-MT #9"],
    ["Hank Aaron MINT #3"],
    ["Willie Mays GOOD #2"],
    ["Babe Ruth POOR #1"],
    ["1971 Topps #5 Munson NM"],
    // A raw condition adjective, with no grader anywhere. These are
    // ungraded vintage cards described in the vocabulary vintage sellers use.
    ["VG-VGEX"],
    ["VG-EX"],
    ["NM"],
    // No grader token at all -- "Gem Mint 10" on a raw row.
    ["Gem Mint 10"],
    ["Card GEM MINT 10 no grader"],
    // The title SAYS raw and was still read as PSA 8.
    ["Raw ungraded NM-MT 8 vintage"],
  ];

  it.each(defects)("%s -> no grade (raw)", (title) => {
    expect(parseGradeFromTitle(title)).toBeNull();
  });

  it("the WRONG-NUMERAL case reads the numeral adjacent to the grader", () => {
    // "PSA GRADED EX-MT 6" was read as PSA 9. EX-MT 6 is PSA 6.
    expect(parseGradeFromTitle("PSA GRADED EX-MT 6")).toEqual({
      gradeCompany: "PSA",
      gradeValue: 6,
    });
  });

  it("the defect is REAL on the old label reader -- this suite is not vacuous", () => {
    // A pin that cannot fail proves nothing. parseGradeLabel is retained for
    // SLAB LABELS, where its descriptor vernacular is correct; on a TITLE it
    // is exactly the reader that produced the damage, and it still does.
    // If this ever stops being true the defect population is gone and this
    // whole suite should be re-derived rather than quietly kept green.
    expect(parseGradeLabel("Mickey Mantle #5 NM")).toEqual({
      gradeCompany: "PSA",
      gradeValue: 5,
    });
    expect(parseGradeLabel("Nolan Ryan #1 VG")).toEqual({
      gradeCompany: "PSA",
      gradeValue: 1,
    });
  });
});

describe("a grade IS read when the title actually states one", () => {
  const good: Array<[string, string, number]> = [
    ["PSA 10 2024 Topps Chrome #1 Ohtani", "PSA", 10],
    ["2018 Bowman Chrome #1 Ohtani BGS 9.5", "BGS", 9.5],
    ["2025 BOWMAN DRAFT PSA 7", "PSA", 7],
    ["MICHAEL JORDAN 1986 FLEER STICKER #8 ROOKIE PSA MINT 9", "PSA", 9],
    ["2025 Topps Chrome #100 PSA GEM MT 10", "PSA", 10],
    ["1993 Fleer #7 BGS MINT 9", "BGS", 9],
    ["Michael Jordan 1986 Fleer Sticker #8 Rookie PSA NM-MT 8", "PSA", 8],
    ["2025 Bowman Baseball Shohei Ohtani #17, SGC Grade 10 GEM MINT!", "SGC", 10],
    ["2025 Bowman Chrome Meteoric Rise Nick Kurtz #MR-7 (RC) TAG 10", "TAG", 10],
  ];
  it.each(good)("%s -> %s %s", (title, company, value) => {
    expect(parseGradeFromTitle(title)).toMatchObject({
      gradeCompany: company,
      gradeValue: value,
    });
  });

  it("CF-THE-GRADER-WITH-THE-NUMBER-WINS survives: the second grader is not the slab", () => {
    // A title may name more than one grader; the one carrying the numeral is
    // the holder. Taking the FIRST token reads null on a stated grade.
    expect(parseGradeFromTitle("1968 TOPPS #230 PETE ROSE SGC 6 Bright! Not PSA or BVG"))
      .toEqual({ gradeCompany: "SGC", gradeValue: 6 });
    expect(parseGradeFromTitle("2021 Panini Chronicles Elite PSA  #29 Isaac Paredes RC Rookie SGC  10 Gem Mint"))
      .toEqual({ gradeCompany: "SGC", gradeValue: 10 });
    expect(parseGradeFromTitle("Shohei Ohtani 2018 Topps #700 Rookie BGS 9.5 w/2x10 subs PSA Regrade?"))
      .toEqual({ gradeCompany: "BGS", gradeValue: 9.5 });
  });

  it("CF-AUTHENTIC-BUCKET survives: authenticated-but-ungraded is still an answer", () => {
    expect(parseGradeFromTitle("1953 Bowman Color #59 Mickey Mantle CGC AUTH"))
      .toEqual({ gradeCompany: "CGC", gradeValue: 0, isAuthentic: true });
  });

  it("CF-PRISTINE-IS-A-PRODUCT-NOT-A-GRADE survives by construction", () => {
    // The product word cannot mint a grade when no grader is named -- the
    // contract needs no special case for it.
    expect(parseGradeFromTitle("2024 Topps Pristine Baseball #131 Base")).toBeNull();
    expect(parseGradeFromTitle("2024 Topps Pristine Baseball #5 Base")).toBeNull();
  });

  it("a qualifier is read from AFTER the numeral, not from a word before it", () => {
    expect(parseGradeFromTitle("1986 Fleer Sticker Basketball #8 Michael Jordan RC PSA 8 (ST)"))
      .toEqual({ gradeCompany: "PSA", gradeValue: 8, qualifier: "ST" });
    // "Best Of 2024" made the old reader stamp qualifier OF on a clean PSA 10.
    expect(parseGradeFromTitle("2024 Bowman Best Of 2024 Auto Leo De Vries Rookie Auto - PSA 10"))
      .toEqual({ gradeCompany: "PSA", gradeValue: 10 });
  });
});

describe("ONE implementation: the writer and the census classifier agree", () => {
  // #1691's gradeFromTitleStrict is the READER that refuses these rows;
  // parseGradeFromTitle is the WRITER that must stop creating them. A drift
  // between the two puts the census back to refusing rows the ingest mints,
  // which is the exact state this change exists to end.
  const K = require_(
    path.join(backend, "scripts", "lib", "rematch-classify.cjs"),
  ) as { gradeFromTitleStrict: (t: string) => { gradeCompany: string; gradeValue: number } | null };

  const corpus = require_(
    path.join(backend, "tests", "fixtures", "gradeParserStrictCorpus200.json"),
  ) as Array<{ title: string; old: unknown; strict: unknown }>;

  it("the corpus is 200 real pool titles", () => {
    expect(corpus.length).toBe(200);
  });

  it("writer and classifier read every corpus title the same way", () => {
    const drift: string[] = [];
    for (const { title } of corpus) {
      const writer = parseGradeFromTitle(title);
      const reader = K.gradeFromTitleStrict(title);
      // The classifier has no Authentic bucket and no qualifier field -- it
      // only ever answers (company, value). Compare on that shared shape.
      const w = writer && !writer.isAuthentic
        ? `${writer.gradeCompany}|${writer.gradeValue}` : null;
      const r = reader ? `${reader.gradeCompany}|${reader.gradeValue}` : null;
      // BVG canonicalizes to BGS on the writer; the classifier reports the
      // token verbatim. That is a deliberate difference, not drift.
      const norm = (s: string | null) => (s ?? "").replace(/^BVG\|/, "BGS|");
      if (norm(w) !== norm(r)) drift.push(`${title} :: writer=${w} reader=${r}`);
    }
    expect(drift).toEqual([]);
  });

  it("the strict reader never INVENTS a grade the old reader did not find", () => {
    // Every title where the strict reader reads a grade must be a title that
    // STATES one -- i.e. it names a grader.
    for (const { title } of corpus) {
      if (parseGradeFromTitle(title)) expect(title).toMatch(GRADER);
    }
  });

  it("every refusal is a title with no grader token, or no numeral beside one", () => {
    const refused = corpus.filter(
      (c) => c.old !== null && parseGradeFromTitle(c.title) === null,
    );
    // The measured corpus carries a real refusal population -- a fixture where
    // nothing is refused would make this suite vacuous.
    expect(refused.length).toBeGreaterThan(20);
    for (const { title } of refused) {
      const g = title.match(GRADER);
      if (!g || g.index === undefined) continue; // no grader -- trivially correct
      const after = title.slice(g.index + g[0].length);
      expect(after).not.toMatch(/^[\s.:-]*(10(?:\.0)?|[1-9](?:\.5|\.0)?)(?!\d)/i);
    }
  });
});

describe("the WRITE PATH uses this function -- a fix nothing calls is not a fix", () => {
  it("ingestGradeFromTitle is exactly parseGradeFromTitle's answer", () => {
    for (const t of [
      "Mickey Mantle #5 NM",
      "PSA GRADED EX-MT 6",
      "2018 Bowman Chrome #1 Ohtani BGS 9.5",
      "1953 Bowman Color #59 Mickey Mantle CGC AUTH",
      "VG-EX",
    ]) {
      const g = parseGradeFromTitle(t);
      expect(ingestGradeFromTitle(t)).toEqual({
        gradeCompany: g?.gradeCompany ?? null,
        gradeValue: g?.gradeValue ?? null,
        gradeQualifier: g?.qualifier ?? null,
        isAuthentic: g?.isAuthentic === true ? true : null,
      });
    }
  });

  it("no title-bearing caller still routes to the label reader", () => {
    // parseGradeLabel is retained for SLAB LABELS only. A title caller that
    // drifts back to it silently reopens the whole defect, so the boundary is
    // asserted on the shipped source rather than described in a comment.
    const fs = require_("node:fs") as typeof import("node:fs");
    const files = [
      "src/services/portfolioiq/persistVendorSalesToPool.service.ts",
      "src/services/portfolioiq/autoTriageJob.service.ts",
      "src/services/portfolioiq/dataCleanJob.service.ts",
      "src/services/portfolioiq/imageVerifyJob.service.ts",
      "src/services/buyeriq/listingGradeMatch.ts",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(backend, f), "utf8");
      const calls = src.match(/parseGradeLabel\s*\(/g) ?? [];
      expect(calls, `${f} calls the label reader on a title`).toEqual([]);
    }
  });
});
