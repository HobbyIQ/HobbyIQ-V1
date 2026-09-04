/**
 * G6 -- THE STORED IDENTITY'S OWN PARALLEL, STATED IN THE TITLE, IS A REFUSAL.
 *
 * A full scan of the 1,456 rows the halted base-eviction wave wrote (live
 * pool, 2026-09-04) found 12 DAMAGED rows: the sale title states the stored
 * slug's parallel IN FULL, and that word is simply absent from the
 * checklist-derived CORE_FINISH_TOKENS. mercury x5, signatures x5, earth,
 * venus -- Topps Cosmic Chrome's "Planetary Pursuit" and 2025 Score's
 * "Signatures". Worst: $250 Josh Allen Mercury, $255 Cam Skattebo Earth, $160
 * Justin Jefferson Venus. Each eviction moved a genuine parallel sale onto the
 * base pool: one card, two pools, the split the GREAT REMATCH exists to end.
 *
 * G6 consults NO vocabulary. The stored identity is the claim, the title is
 * the witness, and when the witness repeats the claim the two AGREE and there
 * is nothing to evict -- so a parallel the corpus has never heard of defends
 * itself. Disqualifying only: it can keep a row where it is, never mint one.
 *
 * The three properties this file exists to hold down:
 *
 *   1. all 12 real titles refuse, by fixture, with the phrase named
 *   2. it reads BOTH halves of the stored identity -- slug segment AND the
 *      `parallel` field -- so a row defends itself from whichever half still
 *      remembers the parallel
 *   3. it stays "every significant word", not "any token". Measured on the
 *      same 1,456 rows, any-token adds 11 FALSE refusals off
 *      `rookie-autographs-*` slugs whose titles merely say "Rookie" -- real
 *      base sales an over-broad guard would strand on parallel slugs forever.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as any;

/**
 * THE FIXTURE IS THE FINDING. All 12 DAMAGED rows, with the slug they were
 * evicted OFF, the title as it sits in the pool, and the sale price -- so a
 * regression here is legible as the dollars it puts back on a wrong pool.
 */
/**
 * `slug` is the ORIGIN slug the eviction moved the row off, exactly as
 * `rekeyedFrom[0].cardId` records it. `setKey` is the PRODUCT the row is
 * classified under -- the destination's, and the derivation's. The two differ
 * on every Cosmic Chrome row here (`topps` vs `topps-cosmic-chrome`) because
 * whichever writer minted the original slug read the product wrong, and that
 * difference is load-bearing: the finish VOCABULARY is looked up per product,
 * so which setKey you ask under decides whether guard 3 speaks at all.
 * Measured on the real rows under their real setKeys, guard 3 is silent on
 * all 12 and G6 is the only thing standing between them and the base pool.
 */
const DAMAGED: Array<{ price: number; slug: string; title: string; phrase: string; setKey: string }> = [
  { price: 255, phrase: "earth", slug: "hiq:football:2025:topps:ppea-cs:earth:no-auto", setKey: "topps-cosmic-chrome",
    title: "2025 Topps Cosmic Chrome Cam Skattebo Planetary Pursuit EARTH Rookie RC #PPEA-CS" },
  { price: 250, phrase: "mercury", slug: "hiq:football:2025:topps:ppm-ja:mercury:no-auto", setKey: "topps-cosmic-chrome",
    title: "2025 Topps Cosmic Chrome Josh Allen Planetary Pursuit Mercury #PPM-JA Bills" },
  { price: 168.5, phrase: "mercury", slug: "hiq:football:2025:topps:ppm-jb:mercury:no-auto", setKey: "topps-cosmic-chrome",
    title: "2025 Topps Cosmic Chrome Joe Burrow Planetary Pursuit Mercury #PPM-JB Bengals" },
  { price: 160, phrase: "venus", slug: "hiq:football:2025:topps:ppv-jj:venus:no-auto", setKey: "topps-cosmic-chrome",
    title: "Topps 2025 Cosmic Chrome Justin Jefferson Vikings Venus Insert #PPV-JJ" },
  { price: 130.5, phrase: "mercury", slug: "hiq:football:2025:topps:ppm-sb:mercury:no-auto", setKey: "topps-cosmic-chrome",
    title: "2025 Topps Cosmic Chrome - Saquon Barkley #PPM-SB - Planetary Pursuit Mercury" },
  { price: 128.5, phrase: "mercury", slug: "hiq:football:2025:topps:ppm-sb:mercury:no-auto", setKey: "topps-cosmic-chrome",
    title: "2025 Topps Cosmic Chrome Saquon Barkley Planetary Pursuit Mercury #PPM-SB Eagles" },
  { price: 123.5, phrase: "mercury", slug: "hiq:football:2025:topps:ppm-ee:mercury:no-auto", setKey: "topps-cosmic-chrome",
    title: "2025 Topps Cosmic Chrome Emeka Egbuka Planetary Pursuit Rookie Mercury #PPM-EE" },
  { price: 8.5, phrase: "signatures", slug: "hiq:football:2025:score:250:signatures:no-auto", setKey: "score",
    title: "2025 Score - KaVontae Turpin #250 Signatures (AU)" },
  { price: 4.15, phrase: "signatures", slug: "hiq:football:2025:score:76:signatures:no-auto", setKey: "score",
    title: "2025 Score - Rookies Andres Borregales #76 Signatures (AU, RC)" },
  { price: 3.36, phrase: "signatures", slug: "hiq:football:2025:score:268:signatures:no-auto", setKey: "score",
    title: "2025 Score - Coby Bryant #268 Signatures (AU)" },
  { price: 2.25, phrase: "signatures", slug: "hiq:football:2025:score:81:signatures:no-auto", setKey: "score",
    title: "2025 Score - Rookies Derrick Harmon #81 Signatures (AU, RC)" },
  { price: 1.99, phrase: "signatures", slug: "hiq:football:2025:score:70:signatures:no-auto", setKey: "score",
    title: "2025 Score - Rookies Armand Membou #70 Signatures (AU, RC)" },
];


describe("the 12 DAMAGED rows -- the fixture IS the finding", () => {
  it.each(DAMAGED)("$$$price $phrase -- $title", ({ slug, title, phrase, setKey }) => {
    const g6 = K.storedParallelStatedInTitle({
      title, storedSlug: slug,
      // The precondition of the defect: the row's own parallel FIELD says
      // Base, so guards 2 and 5 both pass and only the title stands between
      // this sale and the base pool.
      stored: { parallel: "Base" }, setKey,
    });
    expect(g6).not.toBeNull();
    expect(g6.phrase).toBe(phrase);
    expect(g6.from).toBe("slug");
  });

  it("the vocabulary genuinely misses every one of them -- this is the gap, not a duplicate guard", () => {
    // If any of these later becomes a vocabulary word, G6 is redundant for
    // that row but still correct. This pin documents WHY it was needed at all.
    const missed = DAMAGED.filter(
      (d) => !K.titleNamesFinish(d.title, { year: 2025, setKey: d.setKey }),
    );
    expect(missed.length).toBe(DAMAGED.length);
  });

  it("every one of them is refused by the FULL eviction evidence, not only the predicate", () => {
    for (const d of DAMAGED) {
      const stored = {
        sport: "football", cardYear: 2025, setKey: d.setKey,
        cardNumber: "X", parallel: "Base", isAuto: false, printRun: null,
      };
      const be = K.baseEvictionEvidence({
        row: { id: "x", cardId: d.slug, source: "cardhedge", title: d.title },
        stored, derived: { ...stored }, storedSlug: d.slug,
        baseDestSlug: d.slug.replace(`:${d.phrase}:`, ":base:"), baseDestBacked: true,
      });
      expect(be.qualifies, d.title).toBe(false);
      // All 12 are slug-half refusals, so they carry #1711's name.
      expect(be.failed).toContain(`title-echoes-slug-parallel:${d.phrase}`);
      // The evidence travels WITH the row, so the refusal is auditable from
      // the document alone rather than from a verdict.
      expect(be.evidence.storedParallelStatedInTitle).toEqual({ phrase: d.phrase, from: "slug" });
    }
  });
});

describe("it reads BOTH halves of the stored identity", () => {
  it("the slug segment alone is enough", () => {
    const g6 = K.storedParallelStatedInTitle({
      title: "2025 Topps Chrome Pink Refractor #12 Aaron Judge",
      storedSlug: "hiq:baseball:2025:topps-chrome:12:pink-refractor:no-auto",
      stored: { parallel: "Base" }, setKey: "topps-chrome",
    });
    expect(g6).toEqual({ phrase: "pink-refractor", from: "slug" });
  });

  it("the stored `parallel` FIELD alone is enough -- the half #1711 could not see", () => {
    // A slug that says base, a field that says Red Wave, a title that says
    // Red Wave. The identity remembers the parallel in the half the slug lost.
    const g6 = K.storedParallelStatedInTitle({
      title: "2025 Panini Prizm Football #99 Red Wave",
      storedSlug: "hiq:football:2025:panini-prizm:99:base:no-auto",
      stored: { parallel: "Red Wave" }, setKey: "panini-prizm",
    });
    expect(g6).toEqual({ phrase: "red wave", from: "field" });
  });

  it("hyphen- and case-insensitive on both sides", () => {
    for (const slugSpelling of ["pink-refractor", "PINK-REFRACTOR"]) {
      for (const titleSpelling of ["Pink Refractor", "PINK REFRACTOR", "pink refractor"]) {
        const g6 = K.storedParallelStatedInTitle({
          title: `2025 Topps Chrome ${titleSpelling} #12`,
          storedSlug: `hiq:baseball:2025:topps-chrome:12:${slugSpelling}:no-auto`,
          stored: { parallel: null }, setKey: "topps-chrome",
        });
        expect(g6?.phrase, `${slugSpelling} / ${titleSpelling}`).toBe("pink-refractor");
      }
    }
  });
});

describe("EVERY significant word, never ANY token", () => {
  /**
   * The measurement this rule rests on, over all 1,456 marker-carrying rows:
   *   every-word  12 refusals -- exactly the 12 DAMAGED rows
   *   any-token   23 refusals -- those 12 plus 11 FALSE ones, every one a
   *               `rookie-autographs*` slug against a title saying "Rookie"
   * Those 11 are genuine base sales. An any-token rule strands them on a
   * parallel slug forever, and being disqualifying-only it would never
   * announce that it had.
   */
  const ROOKIE_FALSE_POSITIVES = [
    { slug: "hiq:football:2024:panini-prizm:301:rookie-autographs-black-finite-prizm:no-auto",
      title: "2024 Panini Prizm Caleb Williams RC Rookie #301 Bears", setKey: "panini-prizm" },
    { slug: "hiq:football:2024:panini-mosaic:312:rookie-autographs-mosaic:no-auto",
      title: "2024 Panini Mosaic Bo Nix RC Rookie #312 Broncos", setKey: "panini-mosaic" },
    { slug: "hiq:football:2025:panini-mosaic:362:rookies-autographs:no-auto",
      title: "2025 Panini Mosaic - Rookies Jaxson Dart #362 (RC)", setKey: "panini-mosaic" },
    { slug: "hiq:football:2025:panini-phoenix:194:rookie-autographs-black:no-auto",
      title: "2025 Panini Phoenix Cam Ward RC Rookie #194 Titans", setKey: "panini-phoenix" },
  ];

  it.each(ROOKIE_FALSE_POSITIVES)("a rookie-autographs slug is NOT refused by a title that only says Rookie: $title", ({ slug, title, setKey }) => {
    // "Rookie" is a player descriptor and `rookie-autographs` is an autograph
    // SUBSET, not a finish. `autographs` is absent from the title, so the
    // every-word rule correctly declines -- and the eviction stays available.
    expect(K.storedParallelStatedInTitle({ title, storedSlug: slug, stored: { parallel: "Base" }, setKey })).toBeNull();
  });

  it("MUTATION: an any-token rule would refuse all four of them", () => {
    // Reverting the rule to "any token" is the mutation this file exists to
    // catch. Implemented here so the comparison is executable rather than
    // asserted: the same tokens, the same titles, `some` instead of `every`.
    const anyToken = (title: string, slug: string, setKey: string) => {
      const claims = K.parallelTokensOfStoredIdentity({ storedSlug: slug, stored: { parallel: "Base" }, setKey });
      const hay = new Set(String(title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      return claims.some((c: any) => c.words.some((w: string) => hay.has(w)));
    };
    for (const r of ROOKIE_FALSE_POSITIVES) {
      expect(anyToken(r.title, r.slug, r.setKey), r.title).toBe(true);
    }
    // ...and it would still catch the 12, which is exactly why the extra
    // breadth looks free until you count what it costs.
    for (const d of DAMAGED) expect(anyToken(d.title, d.slug, d.setKey)).toBe(true);
  });

  it("one shared word out of two is never agreement", () => {
    expect(K.storedParallelStatedInTitle({
      title: "2023 Bowman Chrome Green Auto",
      storedSlug: "hiq:baseball:2023:bowman-chrome:1:green-wave-refractor:no-auto",
      stored: { parallel: null }, setKey: "bowman-chrome",
    })).toBeNull();
  });
});

describe("the product-name exclusion is kept", () => {
  it("a slug parallel made only of the product's own words matches nothing", () => {
    // `chrome` on topps-cosmic-chrome names the SET. A title that says
    // "Cosmic Chrome" is naming the product, not a finish, and must not
    // disqualify the eviction on that word.
    expect(K.storedParallelStatedInTitle({
      title: "2025 Topps Cosmic Chrome Joe Burrow #118",
      storedSlug: "hiq:football:2025:topps-cosmic-chrome:118:chrome:no-auto",
      stored: { parallel: null }, setKey: "topps-cosmic-chrome",
    })).toBeNull();
    expect(K.storedParallelStatedInTitle({
      title: "2024 Panini Prizm Ladd McConkey #365 RC Chargers",
      storedSlug: "hiq:football:2024:panini-prizm:365:prizm:no-auto",
      stored: { parallel: null }, setKey: "panini-prizm",
    })).toBeNull();
  });

  it("the same word on a DIFFERENT product is still a finish", () => {
    // Nothing in `topps` is called chrome, so "Chrome" on a plain Topps card
    // is either a finish or a mis-parse -- either way not evictable.
    expect(K.storedParallelStatedInTitle({
      title: "2024 Topps Chrome Edition Aaron Judge #150",
      storedSlug: "hiq:baseball:2024:topps:150:chrome:no-auto",
      stored: { parallel: null }, setKey: "topps",
    })).toEqual({ phrase: "chrome", from: "slug" });
  });
});

describe("a MALFORMED slug yields no parallel at all", () => {
  /**
   * 62 of the 1,456 rows came off `hiq:ant::hiq:football:2025:...`. Every
   * segment shifts by two, so the parallel POSITION holds the YEAR -- and a
   * title of course contains its own year. Reading it would be 62 spurious
   * refusals standing in front of 62 rows whose real inner parallel is `base`.
   */
  const MALFORMED = [
    { slug: "hiq:ant::hiq:baseball:2023:bowman-chrome:39:base:no-auto",
      title: "2023 Bowman Chrome Sapphire Edition #39 Pete Alonso", setKey: "bowman-chrome" },
    { slug: "hiq:ant::hiq:football:2025:topps:76:base:no-auto",
      title: "Topps 2025 Topps Chrome CeeDee Lamb #76", setKey: "topps" },
    { slug: "hiq:ant::hiq:football:2024:panini-prizm:362:base:no-auto",
      title: "2024 Panini Prizm KEON COLEMAN #362 Rookie RC Buffalo Bills", setKey: "panini-prizm" },
  ];

  it.each(MALFORMED)("$slug is not read by position", ({ slug, title, setKey }) => {
    expect(K.slugIsWellFormed(slug)).toBe(false);
    expect(K.storedParallelStatedInTitle({ title, storedSlug: slug, stored: { parallel: "Base" }, setKey })).toBeNull();
  });

  it("MUTATION: without the well-formedness check the year in the shifted segment echoes the title", () => {
    // The mutation is reading position 5 regardless of shape. Shown by
    // driving the OLD, slug-position-only predicate directly.
    for (const m of MALFORMED) {
      const shiftedSegment = m.slug.split(":")[5];
      expect(shiftedSegment).toMatch(/^\d{4}$/);
      expect(K.titleEchoesSlugParallel(m.title, shiftedSegment)).toBe(shiftedSegment);
    }
  });

  it("a well-formed slug still is read by position", () => {
    expect(K.slugIsWellFormed("hiq:football:2025:topps:ppm-ja:mercury:no-auto")).toBe(true);
    expect(K.slugIsWellFormed("hiq:football:2025:topps:ppm-ja:mercury:no-auto:num-99")).toBe(true);
    expect(K.slugIsWellFormed("hiq:football:2025:topps")).toBe(false);
    expect(K.slugIsWellFormed("cardhedge-12345")).toBe(false);
    expect(K.slugIsWellFormed("")).toBe(false);
  });
});

describe("generic parallels and noise contribute nothing", () => {
  it("`base` never carries a match on its own", () => {
    expect(K.storedParallelStatedInTitle({
      title: "1979 Topps Baseball #390 Base",
      storedSlug: "hiq:baseball:1979:topps:390:base:no-auto",
      stored: { parallel: "Base" }, setKey: "topps",
    })).toBeNull();
    // ...and `base-refractor` does not disqualify on the bare word `base`:
    // the Gonzalez/Cam Collier shape stays evictable.
    expect(K.storedParallelStatedInTitle({
      title: "2023 Bowman Chrome Cam Collier 1st Bowman Rookie Auto CPA-CC Base",
      storedSlug: "hiq:baseball:2023:bowman-chrome:cpa-cc:base-refractor:auto",
      stored: { parallel: "Base" }, setKey: "bowman-chrome",
    })).toBeNull();
  });

  it("an empty title, an empty slug and an empty field all yield null", () => {
    expect(K.storedParallelStatedInTitle({ title: "", storedSlug: "hiq:a:1:b:1:mercury:no-auto", stored: {}, setKey: "b" })).toBeNull();
    expect(K.storedParallelStatedInTitle({ title: "anything", storedSlug: "", stored: {}, setKey: "" })).toBeNull();
    expect(K.storedParallelStatedInTitle({ title: "anything", storedSlug: null, stored: { parallel: "" }, setKey: "" })).toBeNull();
  });
});

describe("MUTATION PIN -- the guard actually blocks the write", () => {
  const evictionInput = (title: string, slug: string, setKey: string) => {
    const stored = {
      sport: "football", cardYear: 2025, setKey,
      cardNumber: "PPM-JA", parallel: "Base", isAuto: false, printRun: null,
    };
    return {
      row: { id: "sc-ppm-ja", cardId: slug, source: "cardhedge", title },
      stored, derived: { ...stored }, checklistBacked: true,
      storedSlug: slug, baseDestSlug: `hiq:football:2025:${setKey}:ppm-ja:base:no-auto`, baseDestBacked: true,
    };
  };

  it("the $250 Josh Allen Mercury row is NOT writable, and the refusal names the phrase", () => {
    const r = K.classifyRow(evictionInput(DAMAGED[1].title, DAMAGED[1].slug, DAMAGED[1].setKey));
    expect(r.writable).toBe(false);
    expect(r.subclass).not.toBe(K.BASE_EVICTION);
    // ONE reason per refusal, named by which half of the identity spoke. The
    // failed-reason list is comma-joined into a single `not-base-eviction:`
    // string, so the slug half keeps #1711's exact wording rather than adding
    // a second name that would make the joined string match neither.
    expect(r.reasons).toContain("not-base-eviction:title-echoes-slug-parallel:mercury");
  });

  it("the same row with a title that does NOT state the parallel stays evictable", () => {
    // Removes ONLY the parallel word. If this flips to unwritable the guard is
    // over-broad and is eating legitimate evictions -- which is the failure
    // mode that matters, because an over-broad disqualifying guard halts the
    // program silently instead of announcing itself.
    const terse = "2025 Topps Cosmic Chrome Josh Allen #PPM-JA Bills";
    const r = K.classifyRow(evictionInput(terse, DAMAGED[1].slug, DAMAGED[1].setKey));
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(true);
  });

  it("no scope can write a G6-refused row", () => {
    const r = K.classifyRow(evictionInput(DAMAGED[1].title, DAMAGED[1].slug, DAMAGED[1].setKey));
    for (const sc of ["improve", "base-eviction", "both"]) {
      expect(K.writableUnderScope(r, K.parseApplyScope(sc).classes), sc).toBe(false);
    }
  });
});

describe("the two report-only slug-shape census subclasses", () => {
  /**
   * Counted on the 1,456 evicted rows' ORIGIN slugs, live pool 2026-09-04:
   *   malformed-double-prefix-slug        62
   *   num-slug-without-stored-printrun   244
   * Neither is a refusal and neither is a write. They exist so the shapes have
   * a NAME and a COUNT instead of being invisible to the census.
   */
  it("names the double-prefixed slug", () => {
    expect(K.slugShapeDefects({ slug: "hiq:ant::hiq:baseball:2023:bowman-chrome:39:base:no-auto", stored: {} }))
      .toContain(K.SLUG_SHAPE_DEFECTS.DOUBLE_PREFIX);
    expect(K.slugShapeDefects({ slug: "hiq:baseball:2023:bowman-chrome:39:base:no-auto", stored: {} }))
      .not.toContain(K.SLUG_SHAPE_DEFECTS.DOUBLE_PREFIX);
  });

  it("names a :num slug whose row stores no print run", () => {
    const slug = "hiq:baseball:2025:topps-chrome:150:gold-refractor:no-auto:num-50";
    expect(K.slugShapeDefects({ slug, stored: { printRun: null } })).toContain(K.SLUG_SHAPE_DEFECTS.NUM_WITHOUT_PRINTRUN);
    expect(K.slugShapeDefects({ slug, stored: { printRun: "" } })).toContain(K.SLUG_SHAPE_DEFECTS.NUM_WITHOUT_PRINTRUN);
    // A row that DOES store the print run is not this shape -- the two halves
    // of its identity agree.
    expect(K.slugShapeDefects({ slug, stored: { printRun: 50 } })).toEqual([]);
    // ...and a slug carrying no :num segment never is, whatever the field says.
    expect(K.slugShapeDefects({ slug: "hiq:baseball:2025:topps-chrome:150:base:no-auto", stored: { printRun: null } })).toEqual([]);
  });

  it("REPORT ONLY: neither shape changes the class or the writability", () => {
    // A row is classified on its identity. The shape of the key it arrived
    // under is reported beside that verdict and never folded into it.
    const stored = { sport: "baseball", cardYear: 2023, setKey: "bowman-chrome", cardNumber: "39", parallel: "Base", isAuto: false, printRun: null };
    const slug = "hiq:ant::hiq:baseball:2023:bowman-chrome:39:base:no-auto";
    const r = K.classifyRow({
      row: { id: "x", cardId: slug, source: "cardhedge", title: "2023 Bowman Chrome #39 Pete Alonso" },
      stored, derived: { ...stored, parallel: "Refractor" }, checklistBacked: true, storedSlug: slug,
    });
    expect(r.slugShapeDefects).toContain(K.SLUG_SHAPE_DEFECTS.DOUBLE_PREFIX);
    // The class is whatever the identity diff says; the shape did not vote.
    expect(r.reasons.some((x: string) => x.includes("malformed-double-prefix"))).toBe(false);
  });

  it("every classified row carries the field, empty for a well-formed slug", () => {
    const stored = { sport: "baseball", cardYear: 2023, setKey: "topps", cardNumber: "1", parallel: "Base", isAuto: false, printRun: null };
    const r = K.classifyRow({
      row: { id: "x", cardId: "hiq:baseball:2023:topps:1:base:no-auto", source: "cardhedge", title: "2023 Topps #1" },
      stored, derived: { ...stored }, checklistBacked: true, storedSlug: "hiq:baseball:2023:topps:1:base:no-auto",
    });
    expect(r.slugShapeDefects).toEqual([]);
  });
});
