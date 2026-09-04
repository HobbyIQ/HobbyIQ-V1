/**
 * THE TITLE CAN AGREE WITH THE SLUG -- and then there is nothing to evict.
 *
 * CF-A-SLUG-AND-ITS-TITLE-CAN-AGREE (2026-09-04, from the halted base-eviction
 * wave). BASE-EVICTION's third guard asks the finish VOCABULARY whether the
 * title names a finish. That vocabulary is built from the checklist corpus we
 * happen to hold, and a corpus is never complete. Measured on the 1,457 rows
 * the wave wrote before it was stopped, 12 rows were evicted whose titles
 * state the stored slug's parallel IN FULL:
 *
 *   $250.00  "2025 Topps Cosmic Chrome Joe Burrow Planetary Pursuit Mercury
 *             #PPM-JA Bills"   off  ...:ppm-ja:mercury:no-auto
 *   $255.00  "... Cam Skattebo Planetary Pursuit EARTH Rookie RC #PPEA-CS"
 *                              off  ...:ppea-cs:earth:no-auto
 *   $160.00  "Topps 2025 Cosmic Chrome Justin Jefferson Vikings Venus Insert"
 *                              off  ...:ppv-jj:venus:no-auto
 *   and five 2025 Score "Signatures" rows.
 *
 * None of mercury / earth / venus / signatures is in CORE_FINISH_TOKENS, so
 * titleNamesFinish said false, all four other fields agreed, and genuine
 * parallel sales moved onto the base pool -- one card, two pools, the very
 * split the GREAT REMATCH exists to end.
 *
 * The fix consults NO vocabulary. The slug is the claim, the title is the
 * witness; when the witness repeats the claim word for word they AGREE, and a
 * parallel the corpus has never seen defends itself. Disqualifying only: it
 * can keep a row where it is, never mint a parallel.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Identity = {
  sport?: string | null; cardYear?: number | null; setKey?: string | null;
  cardNumber?: string | null; parallel?: string | null; isAuto?: boolean | null;
  printRun?: number | null;
};
type Result = {
  klass: string; subclass?: string; writable: boolean; reasons: string[];
  evidence?: { titleEchoesSlugParallel?: string | null; storedSlugParallel: string | null };
};
type Classifier = {
  CONFLICT: string; BASE_EVICTION: string;
  titleEchoesSlugParallel: (title: string, slugParallel: string | null) => string | null;
  titleNamesFinish: (t: string, ctx?: { year?: number | null; setKey?: string | null }) => boolean;
  classifyRow: (i: Record<string, unknown>) => Result;
};
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as Classifier;

/** The real Joe Burrow row, as it sat in sold_comps before the wave moved it. */
const MERCURY_SLUG = "hiq:football:2025:topps:ppm-jb:mercury:no-auto";
const MERCURY_BASE = "hiq:football:2025:topps-cosmic-chrome:ppm-jb:base:no-auto";
const MERCURY_TITLE = "2025 Topps Cosmic Chrome Joe Burrow Planetary Pursuit Mercury #PPM-JB Bengals";

const stored: Identity = {
  sport: "football", cardYear: 2025, setKey: "topps-cosmic-chrome", cardNumber: "PPM-JB",
  // The defect's precondition: the row's own parallel field says Base, so
  // guards 2 and 5 both pass and only the title stands between the sale and
  // the base pool.
  parallel: "Base", isAuto: false, printRun: null,
};

const input = (over: Record<string, unknown> = {}) => ({
  row: { id: "sc-ppm-jb", cardId: MERCURY_SLUG, source: "cardhedge", title: MERCURY_TITLE },
  stored, derived: { ...stored }, checklistBacked: true,
  storedSlug: MERCURY_SLUG, baseDestSlug: MERCURY_BASE, baseDestBacked: true,
  ...over,
});

describe("the predicate is pure and needs no vocabulary", () => {
  it("matches the four parallels the corpus does not know", () => {
    expect(K.titleEchoesSlugParallel(MERCURY_TITLE, "mercury")).toBe("mercury");
    expect(K.titleEchoesSlugParallel("2025 Topps Cosmic Chrome Cam Skattebo Planetary Pursuit EARTH Rookie RC #PPEA-CS", "earth")).toBe("earth");
    expect(K.titleEchoesSlugParallel("Topps 2025 Cosmic Chrome Justin Jefferson Vikings Venus Insert #PPV-JJ", "venus")).toBe("venus");
    expect(K.titleEchoesSlugParallel("2025 Score - Rookies Derrick Harmon #81 Signatures (AU, RC)", "signatures")).toBe("signatures");
  });

  it("confirms the vocabulary genuinely misses them -- this is the gap, not a duplicate guard", () => {
    // If these ever become vocabulary words the guard above is redundant but
    // still correct; this pin documents WHY it was needed.
    expect(K.titleNamesFinish(MERCURY_TITLE, { year: 2025, setKey: "topps-cosmic-chrome" })).toBe(false);
  });

  it("requires EVERY significant word, so 'base-refractor' never disqualifies on 'base'", () => {
    // The Gonzalez/Cam Collier shape: a real eviction whose slug says
    // base-refractor and whose title says neither word. It must stay evictable.
    expect(K.titleEchoesSlugParallel("2023 Bowman Chrome Cam Collier 1st Bowman Rookie Auto CPA-CC", "base-refractor")).toBeNull();
    // One shared word out of two is not agreement.
    expect(K.titleEchoesSlugParallel("2023 Bowman Chrome Green Auto", "green-wave-refractor")).toBeNull();
  });

  it("ignores the generic parallels and sub-3-character noise", () => {
    expect(K.titleEchoesSlugParallel("1979 Topps Baseball #390 Base", "base")).toBeNull();
    expect(K.titleEchoesSlugParallel("anything at all", "")).toBeNull();
    expect(K.titleEchoesSlugParallel("anything at all", null)).toBeNull();
  });

  it("reads a hyphenated slug parallel against a title that spells it with spaces", () => {
    expect(K.titleEchoesSlugParallel("2025 Topps Chrome Pink Refractor #12", "pink-refractor")).toBe("pink-refractor");
  });
});

describe("MUTATION PIN -- the guard actually blocks the write", () => {
  it("the Joe Burrow row is NOT writable, and the refusal names the echo", () => {
    const r = K.classifyRow(input());
    // The whole point: $250 of genuine Mercury sale stays on the Mercury pool.
    expect(r.writable).toBe(false);
    expect(r.subclass).not.toBe(K.BASE_EVICTION);
    // The refusal NAMES the echo, so the census banner says why the row was
    // left alone rather than silently dropping it from the queue.
    expect(r.reasons).toContain("not-base-eviction:title-echoes-slug-parallel:mercury");
  });

  it("the same row with a title that does NOT echo the slug stays evictable", () => {
    // Removes ONLY the echoed word. If this flips to unwritable the guard is
    // over-broad and is eating legitimate evictions -- which is the failure
    // mode that matters, because an over-broad guard silently halts the
    // program rather than announcing itself.
    const terse = "2025 Topps Cosmic Chrome Joe Burrow #PPM-JB Bengals";
    expect(K.titleEchoesSlugParallel(terse, "mercury")).toBeNull();
    const r = K.classifyRow(input({ row: { id: "sc-ppm-jb", cardId: MERCURY_SLUG, source: "cardhedge", title: terse } }));
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.writable).toBe(true);
  });
});
