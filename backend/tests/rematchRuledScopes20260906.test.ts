/**
 * THE THREE RULED SCOPES OF 2026-09-06 (Drew).
 *
 * Three subclasses of the GREAT REMATCH, each ruled separately, each
 * report-first, and each armed only by its own name. This file pins the
 * predicate branch by branch and reverts each leg one at a time -- a leg
 * nothing can revert alone is a leg nothing can prove.
 *
 * ── 1. GRADE-FROM-TITLE, AND THE RULING THE CORPUS REFUSED ─────────────────
 *
 * The scope was ASKED for as a re-key: "a sale stored on a RAW slug whose
 * title states a grader token belongs to the GRADED pool of the same
 * identity". There is no graded pool. CF-CARD-IDENTITY-VS-GRADE
 * (cardIdentityKey.service.ts, Drew 2026-08-19) rules that identity and grade
 * are different dimensions and grade is never read out of a slug by position;
 * `computeHobbyIqCardId` takes no grade argument and returns seven segments
 * plus an optional print run. A PSA 10 sale and a raw sale of one card derive
 * the SAME slug, deliberately.
 *
 * Measured read-only on the ruling's own headline example
 * (`hiq:baseball:2011:finest:94:base:no-auto`, Trout 2011 Finest #94): 39 rows
 * -- 13 raw averaging $80, 26 graded averaging $189, one partition, and
 * `filterByGrade` splits them at READ time. Rows there whose title names a
 * grader while their fields say raw: ZERO. The pool cited as damage is right.
 *
 * The real defect is the rows where that read-time split CANNOT happen:
 * 16,115 `hiq:` rows carry an EMPTY gradeCompany while their title states a
 * grader. `filterByGrade` reads a field-empty row as RAW, so a PSA 4 1933
 * Goudey Babe Ruth is counted as a raw sale. The repair is to stamp the two
 * fields at the row's existing address -- a FIELD BACKFILL, not a re-key.
 *
 * The three load-bearing refusals, each found in the measured sample:
 *   BCCG/BVG   separate LENIENT scales. "BGS BCCG 10" reads as BGS 10 through
 *              the strict reader; a BCCG 10 is roughly a PSA 8.
 *   SGC POOR N SGC's legacy 1-100 scale. "SGC POOR 10" is the BOTTOM of it.
 *              40 rows measured; a $90 Cy Williams and a $480 Jimmy Foxx.
 *              Stamping them SGC 10 puts the worst copies of vintage cards in
 *              the best pool.
 *   PSA 9.5    a grade PSA does not issue.
 *
 * ── 2. YEAR-FROM-TITLE-VINTAGE ─────────────────────────────────────────────
 *
 * #1890's finding promoted to a lane. The slug's year segment is the year the
 * card SOLD: `hiq:baseball:2015:topps:311:base:no-auto` holds a 1952 Topps
 * Mantle that sold for $54,000. Re-measured 2026-09-06 with #1890's own frame
 * (TOP 1200/slug year over 2015/2017/2019/2021/2024, vintage-capable setKeys
 * only): 3,199 in scope, 2,754 hits (86.1%), per-year 111/705/668/576/694
 * against #1890's 111/705/673/578/534.
 *
 * THE FRAME IS PART OF THE FINDING. A broad `tca-ebay` draw finds 1 in 300,
 * because the class is CONCENTRATED in vintage-capable setKeys and invisible
 * in a sample dominated by modern cards. Pinned below so a future measurement
 * that draws broadly and concludes "the class is gone" has something to fail
 * against.
 *
 * ── 3. SPORT-FROM-PRODUCT ──────────────────────────────────────────────────
 *
 * A card's sport is the PRODUCT's sport; the player's sport is a property of
 * the player. A 2024 Topps Series 2 "First Pitch" Victor Wembanyama is a
 * BASEBALL card, and `hiq:baseball:2024:topps:fp-1:base:no-auto` is
 * checklist-backed while the basketball address does not exist.
 *
 * TOPPS NOW IS THE CASE THAT KEPT THIS HONEST, and it is refused BY NAME.
 * Topps Now is genuinely multi-sport, so a 2024-25 Topps Now Wembanyama IS a
 * basketball card -- 57 of the 69 sport-mismatched "topps now" rows measured
 * are exactly that. The checklist gate does NOT catch it:
 * `hiq:baseball:2024:topps-now:7:...` IS backed while the basketball address
 * is not, so a rule trusting backing alone would move a real basketball card
 * onto a baseball row and cite a checklist while doing it.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");
const CLASSIFIER_SRC = readFileSync(new URL("../scripts/lib/rematch-classify.cjs", import.meta.url), "utf8");
const RUNNER_SRC = readFileSync(new URL("../scripts/rematch-sold-comps.cjs", import.meta.url), "utf8");

// ── the fact that reshaped scope 1 ──────────────────────────────────────────

describe("CF-CARD-IDENTITY-VS-GRADE — why GRADE-FROM-TITLE is a backfill", () => {
  it("the slug grammar carries NO grade segment, so a raw and a PSA 10 sale of one card share an address", () => {
    const base = {
      sport: "baseball", year: 2011, setKey: "Finest", cardNumber: "94",
      parallel: "Base", isAuto: false, printRun: null, playerName: "Mike Trout",
    };
    const raw = computeHobbyIqCardId(base);
    // The grade fields are not part of the component type at all; passing them
    // is what `deriveIdentity` does today and they are ignored.
    const graded = computeHobbyIqCardId({ ...base, gradeCompany: "PSA", gradeValue: 10 } as never);
    expect(graded).toBe(raw);
    expect(raw).toBe("hiq:baseball:2011:topps-finest:94:base:no-auto");
    // No grade tier anywhere in it. This is the whole reason the ruling's
    // "destination graded identity" does not exist.
    expect(raw).not.toMatch(/psa|bgs|sgc|cgc/i);
  });

  it("GRADE-FROM-TITLE is declared a FIELD-ONLY apply kind — it must never re-key", () => {
    expect([...K.FIELD_ONLY_APPLY_KINDS]).toContain(K.GRADE_FROM_TITLE);
    expect([...K.FIELD_ONLY_APPLY_KINDS]).not.toContain(K.YEAR_FROM_TITLE_VINTAGE);
    expect([...K.FIELD_ONLY_APPLY_KINDS]).not.toContain(K.SPORT_FROM_PRODUCT);
  });

  it("the apply path writes the grade fields WITHOUT relocateSoldComp, and verifies by read", () => {
    // The field-backfill branch must not go through the relocation helper --
    // that function moves a row between partitions and there is no move here.
    const branch = RUNNER_SRC.slice(
      RUNNER_SRC.indexOf("if (cand.kind === K.GRADE_FROM_TITLE) {"),
      RUNNER_SRC.indexOf("const target = cand.kind === K.BASE_EVICTION"),
    );
    expect(branch.length).toBeGreaterThan(200);
    expect(branch).not.toContain("relocateSoldComp");
    expect(branch).not.toContain("keep.cardId");
    // The #1850 read-back contract: the write is done when the value is there.
    expect(branch).toContain("read()");
    expect(branch).toContain("grade-stamp-not-visible-on-read-back");
  });
});

// ── scope 1: the predicate, branch by branch ────────────────────────────────

const gft = (title: string, over: Record<string, unknown> = {}) => K.gradeFromTitleEvidence({
  row: { id: "s1", title, cardId: "hiq:baseball:1933:goudey:53:base:no-auto" },
  stored: { gradeCompany: null, gradeValue: null, ...over },
  axes: { same: [], filled: [], dropped: [], changed: [] },
});

describe("GRADE-FROM-TITLE — each predicate branch", () => {
  it("HAPPY PATH: a grader token plus its numeral stamps the fields", () => {
    const r = gft("1933 R319 Goudey #53 Babe Ruth PSA VG-EX 4");
    expect(r.qualifies).toBe(true);
    expect(r.evidence.gradeCompany).toBe("PSA");
    expect(r.evidence.gradeValue).toBe(4);
  });

  it("the numeral is the one ADJACENT TO THE GRADER, not the first digit in the title", () => {
    // #1704's rule. The year and the card number both precede the grade.
    const r = gft("1958 Topps #150 Mickey Mantle PSA VG-EX 4");
    expect(r.qualifies).toBe(true);
    expect(r.evidence.gradeValue).toBe(4);
  });

  it("REFUSED: an adjective with no grader token never mints a grade (#1704)", () => {
    for (const t of [
      "1986 Fleer #57 Michael Jordan Gem Mint",
      "1990 Topps #1 Nolan Ryan NM-MT",
      "1952 Topps #311 Mickey Mantle VG-EX",
    ]) {
      const r = gft(t);
      expect(r.qualifies).toBe(false);
      expect(r.failed).toContain("title-names-no-grader");
    }
  });

  it("REFUSED: a card number of 10 is not a grade of 10", () => {
    // The defect #1704 named: a numeral that belongs to the card, not a slab.
    const r = gft("1990 Topps #10 Ken Griffey Jr Rookie");
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("title-names-no-grader");
  });

  it("REFUSED: two grader tokens describe two slabs, so no single grade is this row's", () => {
    const r = gft("Lot of 2 — PSA 9 and BGS 9.5 Michael Jordan rookies");
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("title-names-two-graders:PSA+BGS");
  });

  it("REFUSED: BCCG is a separate LENIENT scale and is never mapped to BGS", () => {
    // The real title from the sample. The strict reader skips "BCCG" as a
    // label word and returns BGS 10; a BCCG 10 is roughly a PSA 8.
    const r = gft("2011 Topps Heritage Minor League #44 Mike Trout Rookie Card BGS BCCG 10");
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("lenient-scale-not-mapped:BCCG");
  });

  it("REFUSED: BVG is Beckett's VINTAGE scale, likewise never mapped", () => {
    const r = gft("1952 Topps #311 Mickey Mantle BVG 5.5");
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("lenient-scale-not-mapped:BVG");
  });

  it("REFUSED: SGC's legacy 1-100 scale — 'SGC POOR 10' is the BOTTOM, not a ten", () => {
    // Measured: 40 such rows. $90 for a 1928 Tharp's Cy Williams, $480 for a
    // 1937 O-Pee-Chee Jimmy Foxx — poor-condition prices.
    for (const t of [
      "1928 F50 Tharp's Ice Cream #52 Cy Williams SGC POOR 10",
      "1937 V300 O-Pee-Chee #106 Jimmy Foxx SGC POOR 10",
    ]) {
      const r = gft(t);
      expect(r.qualifies).toBe(false);
      expect(r.failed.join(",")).toContain("low-condition-adjective-with-high-numeral");
    }
  });

  it("the low-adjective guard does NOT refuse an adjective that AGREES with a low numeral", () => {
    // "PSA VG-EX 4" is a real PSA 4 and must still stamp — the guard fires only
    // where a low adjective sits beside a HIGH numeral, which is the legacy
    // scale's signature.
    expect(gft("1933 R319 Goudey #53 Babe Ruth PSA VG-EX 4").qualifies).toBe(true);
    expect(gft("1933 R319 Goudey #181 Babe Ruth SGC POOR 1").qualifies).toBe(true);
  });

  it("REFUSED: a grade the scale does not issue — PSA has no 9.5", () => {
    const r = gft("2020 Topps #1 Some Player PSA 9.5");
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("grade-not-on-scale:PSA 9.5");
    // BGS DOES issue 9.5, so the same shape must pass for BGS.
    expect(gft("2020 Topps #1 Some Player BGS 9.5").qualifies).toBe(true);
  });

  it("PSA 1.5 is the one half-grade PSA issues, and it stamps", () => {
    const r = gft("1933 R319 Goudey #155 Joe Judge PSA FR 1.5");
    expect(r.qualifies).toBe(true);
    expect(r.evidence.gradeValue).toBe(1.5);
  });

  it("REFUSED: a row that ALREADY carries a grade is never re-stamped", () => {
    const r = gft("1933 R319 Goudey #53 Babe Ruth PSA VG-EX 4", { gradeCompany: "PSA", gradeValue: 5 });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("stored-grade-present");
  });

  it("REFUSED: any other axis moving takes the row out of this lane", () => {
    const r = K.gradeFromTitleEvidence({
      row: { id: "s1", title: "1933 R319 Goudey #53 Babe Ruth PSA VG-EX 4" },
      stored: { gradeCompany: null, gradeValue: null },
      axes: { same: [], filled: [], dropped: [], changed: ["setKey"] },
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("identity-axis-moved:setKey");
  });
});

describe("GRADE-FROM-TITLE — MUTATION CHECKS (each leg reverted alone)", () => {
  it("MUTATION: drop the lenient-scale refusal and the BCCG row becomes a BGS 10", () => {
    // Reverting G3 in isolation: the strict reader, unguarded, returns BGS 10
    // for a title that says BCCG. That is the write this leg exists to stop.
    expect(K.gradeFromTitleStrict("2011 Topps Heritage Minor League #44 Mike Trout Rookie Card BGS BCCG 10"))
      .toEqual({ gradeCompany: "BGS", gradeValue: 10 });
    // ...and WITH the leg, the evidence refuses.
    expect(gft("2011 Topps Heritage Minor League #44 Mike Trout Rookie Card BGS BCCG 10").qualifies).toBe(false);
    // The regex is exported so the revert is a one-line edit a reader can find.
    expect(K.LENIENT_SCALE_RE.test("BGS BCCG 10")).toBe(true);
    expect(K.LENIENT_SCALE_RE.test("PSA 10")).toBe(false);
  });

  it("MUTATION: drop the legacy-scale refusal and 'SGC POOR 10' becomes a gem ten", () => {
    expect(K.gradeFromTitleStrict("1928 F50 Tharp's Ice Cream #52 Cy Williams SGC POOR 10"))
      .toEqual({ gradeCompany: "SGC", gradeValue: 10 });
    expect(gft("1928 F50 Tharp's Ice Cream #52 Cy Williams SGC POOR 10").qualifies).toBe(false);
    expect(K.LOW_GRADE_ADJECTIVE_RE.test(" POOR 10")).toBe(true);
  });

  it("MUTATION: drop the two-token refusal and a lot title stamps one of its slabs", () => {
    // `graderTokensIn` is the leg. Without it the strict reader takes the
    // FIRST grader it sees and files a two-card lot as one graded sale.
    expect(K.graderTokensIn("Lot — PSA 9 and BGS 9.5")).toEqual(["PSA", "BGS"]);
    expect(K.gradeFromTitleStrict("Lot — PSA 9 and BGS 9.5")).toEqual({ gradeCompany: "PSA", gradeValue: 9 });
  });

  it("MUTATION: drop the on-scale check and PSA 9.5 becomes a stampable grade", () => {
    expect(K.gradeValueIsOnScale("PSA", 9.5)).toBe(false);
    expect(K.gradeValueIsOnScale("BGS", 9.5)).toBe(true);
    expect(K.gradeValueIsOnScale("PSA", 1.5)).toBe(true);
    expect(K.gradeValueIsOnScale("PSA", 0)).toBe(false);
    expect(K.gradeValueIsOnScale("PSA", 11)).toBe(false);
  });
});

describe("GRADE-FROM-TITLE — end to end through classifyRow", () => {
  const STORED = {
    sport: "baseball", cardYear: 1933, setKey: "goudey", cardNumber: "53",
    parallel: "Base", isAuto: false, printRun: null, gradeCompany: null, gradeValue: null,
  };
  const run = (title: string, over: Record<string, unknown> = {}) => K.classifyRow({
    row: { id: "s1", title, source: "tca-ebay", cardId: "hiq:baseball:1933:goudey:53:base:no-auto", ...over },
    stored: STORED,
    // The deriver carries the stored (empty) grade forward when its own looser
    // reader finds nothing — which is exactly how these rows reach AGREE.
    derived: { ...STORED },
    checklistBacked: true,
    storedSlug: "hiq:baseball:1933:goudey:53:base:no-auto",
  });

  it("HAPPY PATH: the row leaves AGREE as IMPROVE/GRADE-FROM-TITLE and is writable", () => {
    const res = run("1933 R319 Goudey #53 Babe Ruth PSA VG-EX 4");
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass).toBe(K.GRADE_FROM_TITLE);
    expect(res.writable).toBe(true);
    expect(res.derived.gradeCompany).toBe("PSA");
    expect(res.derived.gradeValue).toBe(4);
    expect(res.reasons.join(" ")).toContain("grade-from-title:RAW->PSA 4");
  });

  it("WITHOUT the subclass this row is AGREE — 'nothing to do', forever", () => {
    // The state before this PR: eight axes agree, so the row reports nothing
    // and filterByGrade goes on counting a PSA 4 Ruth as a raw sale.
    const res = run("1933 R319 Goudey #53 Babe Ruth no grade stated");
    expect(res.klass).toBe(K.AGREE);
    expect(res.writable).toBe(false);
  });

  it("a PROTECTED row is report-only even when it qualifies", () => {
    const res = run("1933 R319 Goudey #53 Babe Ruth PSA VG-EX 4", { source: "ebay-user-sale" });
    expect(res.subclass).toBe(K.GRADE_FROM_TITLE);
    expect(res.writable).toBe(false);
  });

  it("a near miss is NAMED, and a title with no grader stays silent", () => {
    const named = run("1933 Goudey #53 Babe Ruth BGS BCCG 10");
    expect(named.reasons.join(" ")).toContain("not-grade-from-title:");
    const silent = run("1933 R319 Goudey #53 Babe Ruth Rookie");
    expect(silent.reasons.join(" ")).not.toContain("not-grade-from-title");
  });
});

// ── scope 2: YEAR-FROM-TITLE-VINTAGE ────────────────────────────────────────

const MANTLE = "1952 Topps #311 Mickey Mantle Rookie Card";
const vint = (o: Record<string, unknown> = {}) => {
  const stored = {
    sport: "baseball", cardYear: 2015, setKey: "topps", cardNumber: "311",
    parallel: "Base", isAuto: false, printRun: null, gradeCompany: null, gradeValue: null,
    ...((o.storedOver as object) ?? {}),
  };
  return K.yearFromTitleVintageEvidence({
    row: { id: "s1", title: (o.title as string) ?? MANTLE },
    stored,
    derived: { ...stored, cardYear: (o.derivedYear as number) ?? 1952 },
    axes: { same: [], filled: [], dropped: [], changed: ["cardYear"], ...((o.axesOver as object) ?? {}) },
    storedSlug: (o.slug as string) ?? "hiq:baseball:2015:topps:311:base:no-auto",
    destBacked: o.destBacked === undefined ? true : o.destBacked,
  });
};

describe("YEAR-FROM-TITLE-VINTAGE — each predicate branch", () => {
  it("HAPPY PATH: the $54,000 Mantle moves from the sale year to 1952", () => {
    const r = vint();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.slugYear).toBe(2015);
    expect(r.evidence.titleYear).toBe(1952);
    expect(r.evidence.decade).toBe("1950s");
  });

  it("REFUSED: a slug year that is not modern was never a sale year", () => {
    const r = vint({ slug: "hiq:baseball:1952:topps:311:base:no-auto", storedOver: { cardYear: 1952 } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("slug-year-not-modern");
  });

  it("REFUSED: a title stating a modern year is a modern card", () => {
    const r = vint({ title: "2015 Topps #311 Some Player", derivedYear: 2015 });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toMatch(/title-year-not-vintage|title-states-no-year/);
  });

  it("REFUSED: a setKey the corpus does not carry pre-1990 cards for", () => {
    const r = vint({ storedOver: { setKey: "panini-prizm" } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("setkey-not-vintage-capable:panini-prizm");
  });

  it("REFUSED: the RETRO case — a 2023 Heritage card homaging 1954 IS a 2023 card", () => {
    // By setKey...
    const bySetKey = vint({ storedOver: { setKey: "heritage", cardYear: 2023 }, title: "2023 Topps Heritage 1954 design #1 Player" });
    expect(bySetKey.qualifies).toBe(false);
    expect(bySetKey.failed.join(",")).toMatch(/retro-product-setkey|setkey-not-vintage-capable/);
    // ...and independently by title word, on a vintage-capable setKey.
    const byWord = vint({ title: "2020 Topps Throwback Thursday #186 TBT 1970-'71 design" });
    expect(byWord.qualifies).toBe(false);
    expect(byWord.failed.join(",")).toContain("retro-title-word");
  });

  it("the real Throwback Thursday row measured in the corpus is refused", () => {
    // The single hit a broad 300-row tca-ebay draw produced, 2026-09-06. It is
    // a 2020 card referencing a 1970 design — the exclusion working.
    const r = vint({
      storedOver: { cardYear: 2020 },
      slug: "hiq:basketball:2020:topps:186:base:no-auto",
      title: "Tony Gwynn 2020 Topps Throwback Thursday #186 TBT 1970-'71 Basketball",
      derivedYear: 1970,
    });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("retro-title-word");
  });

  it("REFUSED: an unbacked destination is a PARK, never a move", () => {
    const unknown = vint({ destBacked: null });
    expect(unknown.qualifies).toBe(false);
    expect(unknown.failed).toContain("destination-backing-unknown");
    const unbacked = vint({ destBacked: false });
    expect(unbacked.qualifies).toBe(false);
    expect(unbacked.failed).toContain("destination-not-checklist-backed");
  });

  it("REFUSED: only the YEAR may move — any other axis is a rival reading", () => {
    const r = vint({ axesOver: { changed: ["cardYear", "cardNumber"] } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("identity-axis-moved:cardNumber");
  });

  it("the FIRST stated year is the issue year, not any year in the title", () => {
    expect(K.firstStatedYear("1952 Topps #311 Mickey Mantle sold 2015")).toBe(1952);
    expect(K.firstStatedYear("Mickey Mantle no year here")).toBe(null);
    expect(K.slugYearSegment("hiq:baseball:2015:topps:311:base:no-auto")).toBe(2015);
    expect(K.slugYearSegment("backstop:michael jordan|1986||")).toBe(null);
  });

  it("THE FRAME IS PART OF THE FINDING — the vocabulary is what concentrates the class", () => {
    // A broad draw finds 1 in 300 because it is dominated by modern setKeys;
    // restricted to vintage-capable keys the rate measured 86.1%. If this set
    // ever loses its vintage members the re-measurement silently collapses.
    for (const k of ["topps", "bowman", "fleer", "leaf", "goudey", "play-ball"]) {
      expect(K.VINTAGE_CAPABLE_SETKEYS.has(k)).toBe(true);
    }
    for (const k of ["panini-prizm", "topps-chrome", "panini-select"]) {
      expect(K.VINTAGE_CAPABLE_SETKEYS.has(k)).toBe(false);
    }
  });
});

describe("YEAR-FROM-TITLE-VINTAGE — #1890's verified sample must classify cleanly", () => {
  // #1890 shipped 930 entries (676 RELOCATE, 254 PARK) as a VERIFIED SAMPLE.
  // Two of its RELOCATE entries are driven here: with the ruling in place they
  // must qualify, which is what "the list becomes a lane" means.
  const LIST = "../data/pool-relocations/2026-09-06-vintage-under-sale-year-slugs.json";
  it("the list is still present and still report-only", () => {
    const doc = require_(LIST);
    expect(doc.entries.length).toBeGreaterThan(100);
    expect(String(doc.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  /** The title is quoted inside each entry's `evidence` prose. */
  const titleOf = (e: Record<string, unknown>) => {
    const m = String(e.evidence ?? "").match(/\| title: "([^"]+)"/);
    return m ? m[1] : "";
  };

  it("two RELOCATE entries from the list qualify under the ruled predicate", () => {
    const doc = require_(LIST);
    const relocs = (doc.entries as Array<Record<string, unknown>>)
      .filter((e) => String(e.evidence ?? "").startsWith("RELOCATE"))
      .slice(0, 2);
    expect(relocs.length).toBe(2);
    for (const e of relocs) {
      const from = String(e.fromCardId ?? "");
      const to = String(e.toCardId ?? "");
      const title = titleOf(e);
      expect(title).not.toBe("");
      const slugYear = K.slugYearSegment(from);
      const titleYear = K.firstStatedYear(title);
      // The two facts the ruling turns on, on real entries from the list.
      expect(slugYear).toBeGreaterThanOrEqual(2015);
      expect(titleYear).toBeLessThan(1990);
      // Only the year segment differs between source and destination — the
      // ruling's third clause, checked on the list's own arithmetic.
      expect(from.split(":").filter((_, i) => i !== 2).join(":"))
        .toBe(to.split(":").filter((_, i) => i !== 2).join(":"));
      expect(K.slugYearSegment(to)).toBe(titleYear);
      // The setKey must be one the derived vocabulary carries, or the lane
      // could never reach this row.
      expect(K.VINTAGE_CAPABLE_SETKEYS.has(from.split(":")[3])).toBe(true);
    }
  });

  it("the $54,000 Mantle — the row that made the case — qualifies end to end", () => {
    const doc = require_(LIST);
    const mantle = (doc.entries as Array<Record<string, unknown>>)
      .find((e) => Number(e.price) === 54000 && String(e.fromCardId).includes(":2015:topps:311:"));
    expect(mantle).toBeTruthy();
    const r = K.yearFromTitleVintageEvidence({
      row: { id: String(mantle!.id), title: titleOf(mantle!) },
      stored: {
        sport: "baseball", cardYear: 2015, setKey: "topps", cardNumber: "311",
        parallel: "Base", isAuto: false, printRun: null,
      },
      derived: {
        sport: "baseball", cardYear: 1952, setKey: "topps", cardNumber: "311",
        parallel: "Base", isAuto: false, printRun: null,
      },
      axes: { same: [], filled: [], dropped: [], changed: ["cardYear"] },
      storedSlug: String(mantle!.fromCardId),
      destBacked: true,
    });
    expect(r.qualifies).toBe(true);
    expect(r.evidence.titleYear).toBe(1952);
    expect(r.evidence.decade).toBe("1950s");
  });

  it("that same Mantle title is REFUSED by the grade lane — 'SGC EX/NM 80' is the legacy scale", () => {
    // "1952 Topps #311 Mickey Mantle SGC EX/NM 80". An 80 on SGC's old 1-100
    // scale is roughly a 6, and it is not a grade on any modern scale. The two
    // lanes are independent: this row's YEAR is repairable and its GRADE is
    // not, and neither verdict may leak into the other.
    const doc = require_(LIST);
    const mantle = (doc.entries as Array<Record<string, unknown>>)
      .find((e) => Number(e.price) === 54000 && String(e.fromCardId).includes(":2015:topps:311:"));
    const r = K.gradeFromTitleEvidence({
      row: { id: "m", title: titleOf(mantle!) },
      stored: { gradeCompany: null, gradeValue: null },
      axes: { same: [], filled: [], dropped: [], changed: [] },
    });
    expect(r.qualifies).toBe(false);
  });
});

// ── scope 3: SPORT-FROM-PRODUCT ─────────────────────────────────────────────

const sfp = (o: Record<string, unknown> = {}) => {
  const stored = {
    sport: (o.storedSport as string) ?? "basketball", cardYear: 2024, setKey: (o.setKey as string) ?? "topps",
    cardNumber: "FP-1", parallel: "Base", isAuto: false, printRun: null,
    gradeCompany: null, gradeValue: null,
  };
  return K.sportFromProductEvidence({
    row: { id: "s1", title: (o.title as string) ?? "2024 Topps Victor Wembanyama First Pitch #FP-1 Yankees" },
    stored,
    derived: { ...stored, sport: (o.derivedSport as string) ?? "baseball" },
    axes: { same: [], filled: [], dropped: [], changed: ["sport"], ...((o.axesOver as object) ?? {}) },
    productSport: o.productSport === undefined ? "baseball" : o.productSport,
    destBacked: o.destBacked === undefined ? true : o.destBacked,
  });
};

describe("SPORT-FROM-PRODUCT — each predicate branch", () => {
  it("HAPPY PATH: a First Pitch Wembanyama is a BASEBALL card", () => {
    const r = sfp();
    expect(r.qualifies).toBe(true);
    expect(r.evidence.pair).toBe("basketball->baseball");
  });

  it("REFUSED BY NAME: Topps Now is genuinely multi-sport", () => {
    // The case the checklist gate cannot catch: the baseball address IS backed
    // while the basketball one is not, so backing alone would move a real
    // basketball card onto a baseball checklist row.
    const r = sfp({ setKey: "topps-now", title: "Victor Wembanyama 2024-25 Topps Now #7 50 Point Game", destBacked: true });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("multi-sport-product:topps-now");
  });

  it("REFUSED: a product whose sport cannot be read — never guessed from the player", () => {
    const r = sfp({ productSport: null });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("product-sport-unreadable");
  });

  it("REFUSED: a stored 'sport' that is a vendor artifact is a different defect", () => {
    // `sight` (cardsight) and `hedge` (cardhedge) bleed into the sport field.
    for (const s of ["sight", "hedge", "unknown"]) {
      const r = sfp({ storedSport: s });
      expect(r.qualifies).toBe(false);
      expect(r.failed.join(",")).toContain("stored-sport-is-not-a-sport");
    }
  });

  it("REFUSED: an unbacked destination, exactly as every other moving subclass", () => {
    expect(sfp({ destBacked: false }).failed).toContain("destination-not-checklist-backed");
    expect(sfp({ destBacked: null }).failed).toContain("destination-backing-unknown");
  });

  it("REFUSED: only the SPORT may move", () => {
    const r = sfp({ axesOver: { changed: ["sport", "cardNumber"] } });
    expect(r.qualifies).toBe(false);
    expect(r.failed.join(",")).toContain("identity-axis-moved:cardNumber");
  });

  it("a row whose sport already agrees is not this subclass", () => {
    const r = sfp({ storedSport: "baseball" });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("sport-already-agrees");
  });

  it("the NON-SPORT Topps class (#1885) stays PARKED — no checklist rows exist there", () => {
    // Drew: the parked 654 are NOT this scope. A parked row has no backed
    // destination, so the ordinary gate holds it without a special case.
    const r = sfp({ storedSport: "non-sport", productSport: "baseball", destBacked: false });
    expect(r.qualifies).toBe(false);
    expect(r.failed).toContain("destination-not-checklist-backed");
  });
});

// ── the scope machinery ─────────────────────────────────────────────────────

describe("the three scopes are armed only BY NAME", () => {
  it.each([
    ["grade-from-title", "GRADE_FROM_TITLE"],
    ["year-from-title-vintage", "YEAR_FROM_TITLE_VINTAGE"],
    ["sport-from-product", "SPORT_FROM_PRODUCT"],
  ])("scope %j arms exactly %s", (scope, key) => {
    const parsed = K.parseApplyScope(scope);
    expect(parsed.ok).toBe(true);
    expect([...parsed.classes]).toEqual([K[key]]);
  });

  it("an unrecognised scope still refuses, and NAMES the new options", () => {
    const parsed = K.parseApplyScope("refractor");
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain("grade-from-title");
    expect(parsed.reason).toContain("year-from-title-vintage");
    expect(parsed.reason).toContain("sport-from-product");
  });

  it("applyKindOf reads the SUBCLASS first, so scope=improve never arms the new scopes", () => {
    for (const sub of [K.GRADE_FROM_TITLE, K.YEAR_FROM_TITLE_VINTAGE, K.SPORT_FROM_PRODUCT]) {
      const res = { klass: K.IMPROVE, subclass: sub, writable: true };
      expect(K.applyKindOf(res)).toBe(sub);
      expect(K.writableUnderScope(res, K.parseApplyScope("improve").classes)).toBe(false);
      expect(K.writableUnderScope(res, K.parseApplyScope("both").classes)).toBe(false);
      // ...and armed by its own name.
      expect(K.writableUnderScope(res, K.parseApplyScope(
        sub === K.GRADE_FROM_TITLE ? "grade-from-title"
          : sub === K.YEAR_FROM_TITLE_VINTAGE ? "year-from-title-vintage" : "sport-from-product",
      ).classes)).toBe(true);
    }
  });

  it("an ordinary IMPROVE row is still armed by scope=improve — nothing regressed", () => {
    const res = { klass: K.IMPROVE, writable: true };
    expect(K.applyKindOf(res)).toBe(K.IMPROVE);
    expect(K.writableUnderScope(res, K.parseApplyScope("improve").classes)).toBe(true);
  });

  it("NO NEW WORKFLOW INPUT: the scopes ride the existing `scope` input", () => {
    const wf = readFileSync(new URL("../../.github/workflows/backfill-runner.yml", import.meta.url), "utf8");
    const inputs = wf.slice(wf.indexOf("workflow_dispatch:"), wf.indexOf("jobs:"));
    // GitHub caps workflow_dispatch at 25 inputs; the classifier's own note
    // says 24 are used. A new input here would be the 25th and would also be
    // a second place a dispatcher has to learn about.
    expect(inputs).not.toContain("grade_from_title");
    expect(inputs).not.toContain("ruled_scope");
    expect(inputs).toContain("scope:");
  });
});

describe("the reconcile covers every apply kind", () => {
  it("APPLY_KINDS is ONE list, and the reconcile walks it", () => {
    // A kind missing from the reconcile is a kind that can write without
    // balancing — which is what everyWriteJobReconciles exists to prevent.
    // It used to be `[K.IMPROVE, K.BASE_EVICTION]` at four call sites.
    expect(RUNNER_SRC).toContain("const APPLY_KINDS = [");
    expect(RUNNER_SRC.split("for (const kind of APPLY_KINDS)").length - 1).toBeGreaterThanOrEqual(3);
    expect(RUNNER_SRC).not.toContain("for (const kind of [K.IMPROVE, K.BASE_EVICTION])");
  });

  it("every ruled subclass reports its shape in the banner, not just a count", () => {
    for (const s of ["GRADE-FROM-TITLE", "YEAR-FROM-TITLE-VINTAGE", "SPORT-FROM-PRODUCT"]) {
      expect(RUNNER_SRC).toContain(s);
    }
    expect(RUNNER_SRC).toContain("by grader:");
    expect(RUNNER_SRC).toContain("by decade:");
    expect(RUNNER_SRC).toContain("by sport pair:");
  });

  it("the classifier documents WHY the ruling's re-key became a backfill", () => {
    // The measurement is the argument, and it must survive in the file a
    // future reader opens — not only in a PR body.
    expect(CLASSIFIER_SRC).toContain("CF-CARD-IDENTITY-VS-GRADE");
    expect(CLASSIFIER_SRC).toMatch(/filterByGrade/);
    expect(CLASSIFIER_SRC).toMatch(/16,115/);
  });
});
