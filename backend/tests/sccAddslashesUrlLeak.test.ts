/**
 * THE ESCAPE WAS IN THE URL, NOT JUST THE NAME.
 *
 * #1846 landed the Atomic Refractor rung and the follow-up dispatch still could
 * not ingest it. The run reconciled
 *
 *   intended 2 = written 0 + failed 2
 *
 * for set-13670 and set-13671, because the manifest's own `sourceRef` carries a
 * literal backslash the source's PHP addslashes pass leaked into the URL:
 *
 *   https://www.sportscardchecklist.com/set-13671/1997-bowman\s-best-atomic-refractors-baseball-...
 *
 * WHY IT WAS INVISIBLE UNTIL IT WASN'T. The escape sits in the middle of the
 * slug, so the RUNG reader -- which matches the slug TAIL -- was unaffected and
 * kept returning "Atomic Refractor". The PARENT reader matches the slug HEAD
 * against PARENT_BRANDS, and `bowman\s-best` matches nothing there:
 *
 *   splitParentAndSubset("bowman\s-best-atomic-refractors") -> parentSetKey ""
 *
 * No parent claim means `parallelOfParent: false`, and a rung page has no base
 * cards of its own, so the driver's zero-base gate refuses the entire file. One
 * cause, three symptoms: the refusal, the missing parent, and the `setKey:
 * bowman` these rows carried (the brand walk fell through to the bare brand
 * because `bowman\s-best` never reached `bowmans-best`).
 *
 * NOT A 404, WHICH IS THE TRAP. Verified by fetch on 2026-09-06: the escaped
 * form, the apostrophe-dropped form and the hyphenated form ALL return HTTP 200,
 * because the server keys on `set-<id>` and ignores the slug. Anyone checking
 * "does the URL work?" would have concluded the URL was fine. The host was
 * always willing; OUR slug readers were not, and they are not lenient.
 *
 * BLAST RADIUS, measured on the manifest: 60 entries carry the backslash in both
 * `setName` and `sourceRef` -- 45 `Bowman\s` and 15 `Mcdonald\s`, spanning
 * baseball 1990s (45), hockey 2000s (11), basketball 1990s-2000s (4).
 *
 * THE APOSTROPHE IS DROPPED, NEVER HYPHENATED. `bowmans-best` is the spelling
 * the catalog rules and PARENT_BRANDS carries; `bowman-s-best` would look tidier
 * and match neither, leaving all three symptoms in a better costume. Pinned
 * below in both directions.
 *
 * Fixed at the cause in discoverSportsCardChecklistSets.cjs (so a re-crawl never
 * reintroduces it) AND defensively in fetchSportsCardChecklist.cjs (so the 60
 * entries already in the manifest heal on their next fetch, with no re-crawl).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCHER = path.join(HERE, "..", "scripts", "fetchSportsCardChecklist.cjs");
const DISCOVER = path.join(HERE, "..", "scripts", "discoverSportsCardChecklistSets.cjs");
const MANIFEST_PATH = path.join(HERE, "..", "data", "ingest-universe.json");

const {
  parseSetUrl,
  parallelFromSlug,
  parallelTailOf,
  splitParentAndSubset,
  canonicalSetUrl,
  canonicalSlug,
  unescapeAddslashes,
} = require_(FETCHER);

const discover = require_(DISCOVER);

const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const SCC = MANIFEST.entries.filter(
  (e: any) => (e.lane || e.source) === "sportscardchecklist",
);
const bySetId = (id: string) =>
  SCC.find((e: any) => String(e.id).includes(`/set-${id}/`));

/** The real, unmodified manifest URL for the Atomic Refractor rung page. */
const ATOMIC = bySetId("13671");
const REFRACTORS = bySetId("13670");
const BACKSLASH = String.fromCharCode(92);

// ── the defect is real and still in the manifest ─────────────────────────────

describe("the manifest really does carry the source's addslashes escape", () => {
  it("set-13671's sourceRef contains a literal backslash", () => {
    expect(ATOMIC, "set-13671 must be in the manifest").toBeTruthy();
    expect(ATOMIC.sourceRef).toContain(BACKSLASH);
    expect(ATOMIC.sourceRef).toContain(`bowman${BACKSLASH}s-best`);
  });

  it("60 entries are affected, in the NAME and the URL alike", () => {
    // The count is the point: this is not one stray row, it is every product on
    // this source whose name carries an apostrophe.
    const hit = SCC.filter(
      (e: any) =>
        String(e.setName || "").includes(BACKSLASH) ||
        String(e.sourceRef || "").includes(BACKSLASH),
    );
    expect(hit.length).toBe(60);
    expect(hit.every((e: any) => String(e.sourceRef).includes(BACKSLASH))).toBe(true);
    // Two products, both apostrophe names.
    const products = new Set(
      hit.map((e: any) => (String(e.setName).match(/Bowman|Mcdonald/i) || ["?"])[0].toLowerCase()),
    );
    expect([...products].sort()).toEqual(["bowman", "mcdonald"]);
  });
});

// ── the fix, on the real URL ─────────────────────────────────────────────────

describe("the escaped URL now parses to the canonical slug", () => {
  it("parseSetUrl strips the escape from `rest`", () => {
    const p = parseSetUrl(ATOMIC.sourceRef);
    expect(p).toBeTruthy();
    expect(p.rest).toBe("bowmans-best-atomic-refractors");
    expect(p.rest).not.toContain(BACKSLASH);
  });

  it("the raw slug is kept, so an escaped source stays auditable", () => {
    const p = parseSetUrl(ATOMIC.sourceRef);
    expect(p.restRaw).toBe(`bowman${BACKSLASH}s-best-atomic-refractors`);
    expect(p.restRaw).toContain(BACKSLASH);
  });

  it("THE SYMPTOM THAT COST THE RUN: the parent product is found again", () => {
    const p = parseSetUrl(ATOMIC.sourceRef);
    const parent = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
    expect(parent.parentSetKey).toBe("bowmans-best");
  });

  it("...so parallelOfParent is true and the zero-base gate admits the rung", () => {
    for (const entry of [ATOMIC, REFRACTORS]) {
      const p = parseSetUrl(entry.sourceRef);
      const parallel = parallelFromSlug(p.rest);
      const parent = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
      expect(parallel, `${entry.setName} must name a rung`).toBeTruthy();
      expect(Boolean(parallel && parent.parentSetKey)).toBe(true);
    }
  });

  it("the rung names are unchanged -- the tail reader never saw the escape", () => {
    expect(parallelFromSlug(parseSetUrl(ATOMIC.sourceRef).rest)).toBe("Atomic Refractor");
    expect(parallelFromSlug(parseSetUrl(REFRACTORS.sourceRef).rest)).toBe("Refractor");
  });

  it("the setKey written is bowmans-best, not the bare brand", () => {
    // `effectiveSetKey = parentSplit.parentSetKey || setKey`, and the driver
    // passes `bowman`. The parent claim is what overrides it.
    const p = parseSetUrl(ATOMIC.sourceRef);
    const parent = splitParentAndSubset(p.rest, parallelTailOf(p.rest));
    expect(parent.parentSetKey || "bowman").toBe("bowmans-best");
  });
});

describe("the fetched URL is the canonical spelling", () => {
  it("canonicalSetUrl rebuilds set-13671 with the apostrophe dropped", () => {
    expect(canonicalSetUrl(ATOMIC.sourceRef)).toBe(
      "https://www.sportscardchecklist.com/set-13671/1997-bowmans-best-atomic-refractors-baseball-trading-card-checklist",
    );
  });

  it("set-13670 likewise, and neither keeps a backslash", () => {
    expect(canonicalSetUrl(REFRACTORS.sourceRef)).toBe(
      "https://www.sportscardchecklist.com/set-13670/1997-bowmans-best-refractors-baseball-trading-card-checklist",
    );
    for (const e of [ATOMIC, REFRACTORS]) {
      expect(canonicalSetUrl(e.sourceRef)).not.toContain(BACKSLASH);
    }
  });

  it("the set id is never rewritten -- it is what the server keys on", () => {
    expect(canonicalSetUrl(ATOMIC.sourceRef)).toContain("/set-13671/");
  });

  it("a clean URL is returned unchanged", () => {
    const clean =
      "https://www.sportscardchecklist.com/set-11959/1972-topps-football-trading-card-checklist";
    expect(canonicalSetUrl(clean)).toBe(clean);
    expect(parseSetUrl(clean).rest).toBe("topps");
  });

  it("a split-season URL keeps its season", () => {
    const u =
      "https://www.sportscardchecklist.com/set-70577/2005-06-upper-deck-mcdonald\\s-hockey-trading-card-checklist";
    expect(canonicalSetUrl(u)).toBe(
      "https://www.sportscardchecklist.com/set-70577/2005-06-upper-deck-mcdonalds-hockey-trading-card-checklist",
    );
    expect(parseSetUrl(u).seasonLabel).toBe("2005-06");
  });
});

// ── the apostrophe is dropped, not hyphenated ────────────────────────────────

describe("the apostrophe is DROPPED, because that is what the catalog spells", () => {
  it("bowman\\s-best -> bowmans-best, never bowman-s-best", () => {
    expect(canonicalSlug(`bowman${BACKSLASH}s-best`)).toBe("bowmans-best");
    expect(canonicalSlug(`bowman${BACKSLASH}s-best`)).not.toBe("bowman-s-best");
  });

  it("the hyphenated spelling would NOT have fixed the parent lookup", () => {
    // The counter-case, stated as the failure it would have left behind: a
    // tidier slug that still matches no brand is the same bug in a new costume.
    const hyphenated = "bowman-s-best-atomic-refractors";
    expect(splitParentAndSubset(hyphenated, parallelTailOf(hyphenated)).parentSetKey)
      .not.toBe("bowmans-best");
    // ...whereas the spelling we chose does.
    expect(splitParentAndSubset("bowmans-best-atomic-refractors",
      parallelTailOf("bowmans-best-atomic-refractors")).parentSetKey).toBe("bowmans-best");
  });

  it("all three addslashes escapes are undone", () => {
    expect(unescapeAddslashes(`a${BACKSLASH}'b`)).toBe("a'b");
    expect(unescapeAddslashes(`a${BACKSLASH}"b`)).toBe('a"b');
    expect(unescapeAddslashes(`a${BACKSLASH}${BACKSLASH}b`)).toBe(`a${BACKSLASH}b`);
  });

  it("an unescaped apostrophe is dropped too", () => {
    expect(canonicalSlug("bowman's-best")).toBe("bowmans-best");
  });
});

// ── the cause is fixed at discovery as well ──────────────────────────────────

describe("discovery never mints an escaped entry again", () => {
  it("classify() returns a canonical slug and a canonical URL", () => {
    const c = discover.classify(
      `https://www.sportscardchecklist.com/set-13671/1997-bowman${BACKSLASH}s-best-atomic-refractors-baseball-trading-card-checklist`,
    );
    expect(c, "the 1997 baseball bowman cell must classify this").toBeTruthy();
    expect(c.rest).toBe("bowmans-best-atomic-refractors");
    expect(c.url).not.toContain(BACKSLASH);
    expect(c.url).toBe(
      "https://www.sportscardchecklist.com/set-13671/1997-bowmans-best-atomic-refractors-baseball-trading-card-checklist",
    );
  });

  it("the sitemap's own spelling is preserved for audit", () => {
    const raw = `https://www.sportscardchecklist.com/set-13671/1997-bowman${BACKSLASH}s-best-atomic-refractors-baseball-trading-card-checklist`;
    expect(discover.classify(raw).sourceUrlRaw).toBe(raw);
  });

  it("the derived set NAME is clean, so TITLES matches what a human types", () => {
    const c = discover.classify(
      `https://www.sportscardchecklist.com/set-13671/1997-bowman${BACKSLASH}s-best-atomic-refractors-baseball-trading-card-checklist`,
    );
    const name = discover.setNameFrom(c.season, c.rest, c.sport);
    expect(name).toBe("1997 Bowmans Best Atomic Refractors Baseball");
    expect(name).not.toContain(BACKSLASH);
  });

  it("the brand pattern still accepts BOTH source spellings", () => {
    // The source may keep serving the escape; discovery must keep finding it.
    const re = discover.BRAND_RE["bowmans-best"];
    expect(re.test(`bowman${BACKSLASH}s-best-refractors`)).toBe(true);
    expect(re.test("bowmans-best-refractors")).toBe(true);
    expect(re.test("bowman's-best-refractors")).toBe(true);
  });
});

// ── mutation reds ────────────────────────────────────────────────────────────

function withMutant(file: string, from: string, to: string, tag: string, fn: (m: any) => void) {
  const original = fs.readFileSync(file, "utf8");
  expect(original, `the mutation target must exist verbatim: ${from}`).toContain(from);
  const mutated = original.replace(from, to);
  expect(mutated).not.toBe(original);
  const tmp = path.join(path.dirname(file), `.mutated-${tag}-${process.pid}.cjs`);
  try {
    fs.writeFileSync(tmp, mutated);
    fn(require_(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

describe("the pin fails against a parser that keeps the escape", () => {
  it("stop canonicalising `rest` -> the parent lookup fails exactly as it did", () => {
    withMutant(
      FETCHER,
      "    rest: canonicalSlug(m[4]),",
      "    rest: m[4],",
      "rest",
      (m) => {
        const p = m.parseSetUrl(ATOMIC.sourceRef);
        expect(p.rest).toContain(BACKSLASH);
        // THE ORIGINAL FAILURE, reproduced: no parent, so no parallelOfParent,
        // so the zero-base gate refuses and the entry reconciles as failed.
        const parent = m.splitParentAndSubset(p.rest, m.parallelTailOf(p.rest));
        expect(parent.parentSetKey).toBe("");
        expect(Boolean(m.parallelFromSlug(p.rest) && parent.parentSetKey)).toBe(false);

        // ...and the shipped parser disagrees with the mutant on exactly this.
        const shipped = parseSetUrl(ATOMIC.sourceRef);
        expect(splitParentAndSubset(shipped.rest, parallelTailOf(shipped.rest)).parentSetKey)
          .toBe("bowmans-best");
      },
    );
  });

  it("turn the escape into a separator -> the parent lookup STILL fails", () => {
    // Proves the choice of spelling is load-bearing, not cosmetic.
    //
    // The mutation has to target the UNESCAPE, not the apostrophe strip: on the
    // escaped form `bowman\s-best` there is no literal apostrophe left by the
    // time the strip runs -- `\s` has already become `s` -- so changing the
    // strip's replacement is a no-op here. What the tidier-looking alternative
    // would actually have been is replacing the escape sequence with a hyphen,
    // which is the spelling `bowman-s-best` this rule deliberately rejects.
    withMutant(
      FETCHER,
      'return String(s ?? "").replace(/\\\\(.)/g, "$1");',
      'return String(s ?? "").replace(/\\\\(.)/g, "-$1");',
      "hyphen",
      (m) => {
        const p = m.parseSetUrl(ATOMIC.sourceRef);
        expect(p.rest).toBe("bowman-s-best-atomic-refractors");
        // The tidier slug matches no brand either -- same three symptoms.
        expect(m.splitParentAndSubset(p.rest, m.parallelTailOf(p.rest)).parentSetKey)
          .not.toBe("bowmans-best");
        // ...while the shipped spelling does find the product.
        const shipped = parseSetUrl(ATOMIC.sourceRef);
        expect(splitParentAndSubset(shipped.rest, parallelTailOf(shipped.rest)).parentSetKey)
          .toBe("bowmans-best");
      },
    );
  });

  it("the apostrophe strip is what handles an UNESCAPED source", () => {
    // The other half of canonicalSlug, pinned on the input it actually serves:
    // a source that stops escaping would send `bowman's-best`, and the strip is
    // what keeps that landing on the same canonical slug.
    expect(canonicalSlug("bowman's-best-atomic-refractors"))
      .toBe("bowmans-best-atomic-refractors");
    withMutant(
      FETCHER,
      `return unescapeAddslashes(rest).replace(/${"'"}/g, "");`,
      `return unescapeAddslashes(rest).replace(/${"'"}/g, "-");`,
      "apos",
      (m) => {
        expect(m.canonicalSlug("bowman's-best-atomic-refractors"))
          .toBe("bowman-s-best-atomic-refractors");
        expect(m.splitParentAndSubset("bowman-s-best-atomic-refractors",
          m.parallelTailOf("bowman-s-best-atomic-refractors")).parentSetKey)
          .not.toBe("bowmans-best");
      },
    );
  });

  it("stop canonicalising at DISCOVERY -> a re-crawl reintroduces all 60", () => {
    withMutant(
      DISCOVER,
      // Anchored to classify()'s own comment: `const rest = canonicalSlug(m[4])`
      // appears TWICE in this file (canonicalSetUrl has the other), and a bare
      // string replace takes the first -- which would mutate the URL builder and
      // leave classify() untouched, i.e. a mutation that proves nothing.
      "  // nothing downstream has to remember to.\n  const rest = canonicalSlug(m[4]);",
      "  // nothing downstream has to remember to.\n  const rest = m[4];",
      "discover",
      (m) => {
        const c = m.classify(
          `https://www.sportscardchecklist.com/set-13671/1997-bowman${BACKSLASH}s-best-atomic-refractors-baseball-trading-card-checklist`,
        );
        expect(c.rest).toContain(BACKSLASH);
        expect(m.setNameFrom(c.season, c.rest, c.sport)).toContain(BACKSLASH);
        // The shipped discovery emits neither.
        expect(discover.classify(
          `https://www.sportscardchecklist.com/set-13671/1997-bowman${BACKSLASH}s-best-atomic-refractors-baseball-trading-card-checklist`,
        ).rest).not.toContain(BACKSLASH);
      },
    );
  });
});
