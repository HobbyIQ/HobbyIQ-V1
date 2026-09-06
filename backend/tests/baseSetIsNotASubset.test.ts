/**
 * CF-BASE-SET-IS-NOT-A-SUBSET (2026-09-06, apply run 34027488624).
 *
 * The SCC recheck of 1957 Topps baseball (set-11614) read 417 checklist rows
 * and wrote 9. The banner said "child: subset collisions REFUSED 407".
 *
 * Measured read-only against prod, the product holds 3,861 rows:
 *
 *     baseballcardpedia            408      <- the identities
 *     baseballcardpedia-graded   3,373      <- their graded children
 *     sportscardchecklist-09-05      9      <- all the checklist landed
 *     everything else               71
 *
 * and every one of the 3,781 baseballcardpedia rows carries
 * `subsetName: "Base Set"`. The nine that DID land are the nine identities
 * with no incumbent at all (NNO1-NNO8 checklist cards, and #387).
 *
 * So the refusal was not protecting anything. The incumbents are the SAME
 * CARDS the checklist was bringing -- Mantle #95, Mays #10, Aaron #20 -- and
 * "Base Set" is not a subset at all. It is a PAGE-SECTION HEADING that
 * scrape-baseballcardpedia reads off the wiki nav; its own comment says so
 * ("BCP nests 'Base Set' under 'Checklist' (h1)"), and it maps that heading
 * to `category: "base"`. The label then rides into subsetName where it
 * asserts the OPPOSITE of a subset: "this row IS the base set".
 *
 * A checklist page for a base set states NO subset, and blank means unknown.
 * The clash test compared "unknown" against "Base Set", concluded two
 * different cards, and dropped the checklist row -- 407 times.
 *
 * THE FIX IS AT THE CLAIM, NOT AT THE SOURCE. Both sides here are `checklist`
 * authority (verified below), so no authority rule could have separated them
 * and "checklist beats non-checklist" would never have fired. What was wrong
 * was comparing raw subsetName strings instead of the subset each side
 * actually CLAIMS. claimedSubsetOf() folds structural base-section labels to
 * "no claim"; two rows that both claim nothing do not clash, and the newcomer
 * falls through to the authority merge -- where a same-card newcomer always
 * belonged, and where the incumbent's player is never overwritten.
 *
 * A real named subset is untouched: the #1741 refusal and the 2026-09-04
 * disambiguation ruling both still hold, pinned below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";

const require_ = createRequire(__filename);
const lib = join(__dirname, "..", "scripts", "lib", "subset-identity.cjs");
const ingest = join(__dirname, "..", "scripts", "ingest-checklist-csv-to-catalog.cjs");
const scraper = join(__dirname, "..", "scripts", "scrape-baseballcardpedia.cjs");

const S = require_(lib) as {
  isBaseSectionLabel: (v: unknown) => boolean;
  claimedSubsetOf: (v: unknown) => string;
};

// ── the vocabulary ───────────────────────────────────────────────────────────

describe('"Base Set" is a section heading, not a subset', () => {
  it("folds the structural labels to NO CLAIM", () => {
    for (const label of ["Base Set", "base set", "BASE SET", "Base", "Base Cards", "Checklist"]) {
      expect(S.isBaseSectionLabel(label)).toBe(true);
      expect(S.claimedSubsetOf(label)).toBe("");
    }
  });

  it("leaves a REAL named subset exactly as it is", () => {
    for (const real of ["Cards That Never Were", "Johnson Reprints", "Rookies", "Promos", "Inserts", "Bowmans Best Preview"]) {
      expect(S.isBaseSectionLabel(real)).toBe(false);
      expect(S.claimedSubsetOf(real)).toBe(real);
    }
  });

  it("blank stays blank — unknown is never invented", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(S.claimedSubsetOf(blank)).toBe("");
    }
  });

  it("the vocabulary is TINY and structural — a guessed one would merge real subsets", () => {
    const src = readFileSync(lib, "utf8");
    const m = /const BASE_SECTION_LABELS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m).toBeTruthy();
    const labels = (m as RegExpExecArray)[1].match(/"[^"]+"/g) ?? [];
    // Small enough to read in one glance. The harm of a broad list here is
    // silently folding two real subsets onto one address.
    expect(labels.length).toBeLessThanOrEqual(8);
    for (const l of labels) expect(l.toLowerCase()).toMatch(/base|checklist/);
  });

  it("and the scraper really is where the label comes from", () => {
    // If this ever stops being true, the fold is treating a real claim as
    // structural and this pin should bring someone back here.
    expect(readFileSync(scraper, "utf8")).toContain('BCP nests "Base Set" under "Checklist"');
  });
});

// ── why authority could not have fixed it ────────────────────────────────────

describe("both sides are checklist authority", () => {
  it("so no authority rule separates them, and none should", () => {
    expect(catalogAuthorityOf("baseballcardpedia")).toBe("checklist");
    expect(catalogAuthorityOf("baseballcardpedia-graded")).toBe("checklist");
    expect(catalogAuthorityOf("sportscardchecklist-2026-09-05")).toBe("checklist");
    // A rule shaped "checklist newcomer beats non-checklist incumbent" would
    // never have fired on this population, which is why the fix is at the
    // subset CLAIM instead.
    expect(catalogAuthorityOf("baseballcardpedia")).toBe(catalogAuthorityOf("sportscardchecklist-2026-09-05"));
  });
});

// ── the clash test ───────────────────────────────────────────────────────────

/** The shipped predicate, transcribed, so the cases are readable as data. */
const clashes = (storedSubset: unknown, pageSubset: unknown): "refuse" | "disambiguate" | "no-clash" => {
  const knownClaim = S.claimedSubsetOf(storedSubset);
  const productClaim = S.claimedSubsetOf(pageSubset);
  if (knownClaim && knownClaim !== (productClaim || null)) {
    return productClaim ? "disambiguate" : "refuse";
  }
  return "no-clash";
};

describe("the clash test compares CLAIMS, not raw strings", () => {
  it('THE 407: stored "Base Set" vs a base page stating nothing -> NO CLASH', () => {
    expect(clashes("Base Set", "")).toBe("no-clash");
    expect(clashes("Base Set", null)).toBe("no-clash");
    expect(clashes("Checklist", "")).toBe("no-clash");
  });

  it("a REAL subset vs an unknown one still REFUSES — #1741 survives", () => {
    // Blank is unknown and is never invented; minting the unknown side without
    // a segment would put it back on the ambiguous plain id.
    expect(clashes("Cards That Never Were", "")).toBe("refuse");
    expect(clashes("Johnson Reprints", null)).toBe("refuse");
  });

  it("two REAL subsets still DISAMBIGUATE — the 2026-09-04 ruling survives", () => {
    expect(clashes("Johnson Reprints", "Cards That Never Were")).toBe("disambiguate");
  });

  it("checklist vs checklist naming the SAME real subset -> no clash, merge decides", () => {
    expect(clashes("Cards That Never Were", "Cards That Never Were")).toBe("no-clash");
  });

  it('a real subset vs "Base Set" is a clash the REAL side wins the claim on', () => {
    // Stored is structural (no claim), incoming names one: nothing to refuse,
    // the newcomer simply carries its subset.
    expect(clashes("Base Set", "Rookies")).toBe("no-clash");
    // And the mirror: stored names a real subset, page is a base page.
    expect(clashes("Rookies", "Base Set")).toBe("refuse");
  });

  it("MUTATION: compare raw subsetName again -> the 407 come back -> red", () => {
    const rawClashes = (stored: unknown, page: unknown): boolean =>
      Boolean(stored) && stored !== (page || null);
    // The mutant refuses the 1957 population...
    expect(rawClashes("Base Set", "")).toBe(true);
    // ...where the shipped rule lets it through.
    expect(clashes("Base Set", "")).toBe("no-clash");
    // and both still agree on a genuinely different subset
    expect(rawClashes("Cards That Never Were", "")).toBe(true);
    expect(clashes("Cards That Never Were", "")).toBe("refuse");
  });
});

// ── the fix is wired at the cause ────────────────────────────────────────────

describe("the ingest child uses the claim, everywhere it used the raw field", () => {
  const src = readFileSync(ingest, "utf8");

  it("imports claimedSubsetOf and tests on it", () => {
    expect(src).toContain('require(path.join(__dirname, "lib", "subset-identity.cjs"))');
    expect(src).toContain("const knownClaim = claimedSubsetOf(known && known.subsetName);");
    expect(src).toContain("const productClaim = claimedSubsetOf(product.subsetName);");
    expect(src).toContain("if (known && knownClaim && knownClaim !== (productClaim || null)) {");
    expect(src).toContain("if (!productClaim) {");
  });

  it("no longer branches on the raw subsetName strings", () => {
    expect(src).not.toContain("if (known && known.subsetName && known.subsetName !== (product.subsetName || null)) {");
    expect(src).not.toContain("if (!product.subsetName) {\n              subsetCollision++;");
  });

  it("and a structural label can never become an id segment or a moved row's identity", () => {
    // Both re-mints and the incumbent move take the CLAIM, so "Base Set" can
    // never appear as `:sub-base-set:` nor be written onto a moved row.
    expect(src).toContain("subsetName: productClaim, subsetInId: true,");
    expect(src).toContain("subsetName: knownClaim, subsetInId: true,");
    expect(src).toContain("{ subsetName: knownClaim, subsetInId: true },");
  });

  it("the #1741 counter and the disambiguation path both still exist", () => {
    expect(src).toContain("subsetCollision++");
    expect(src).toContain("subsetDisambiguated++");
  });
});

// ── what happens to the newcomer once it is not refused ──────────────────────

describe("a same-card newcomer lands through the authority merge", () => {
  it("equal authority means the incumbent keeps every field that ASSERTS something", () => {
    const svc = readFileSync(
      join(__dirname, "..", "src", "services", "portfolioiq", "cardCatalog.service.ts"),
      "utf8",
    );
    // The losing branch keeps player, parallel, printRun and source, and only
    // backfills index fields the existing row LACKS. So letting the checklist
    // row through cannot change Mantle's name on #95 — which is the whole
    // reason this is safe to stop refusing.
    expect(svc).toContain("The losing branch keeps the existing row wholesale");
    expect(svc).toMatch(/for \(const f of \["searchText", "searchTokens", "displayName", "setName", "cardYear"\]/);
    expect(svc).toContain("never overwrite, so a");
  });

  it("A FOLD NEVER CHANGES THE PLAYER — #1838's rule is upstream of this change", () => {
    const ops = readFileSync(
      join(__dirname, "..", "src", "services", "catalog", "catalogRowOps.service.ts"),
      "utf8",
    );
    expect(ops).toContain("SAME CLASS. Now a different player is a contradiction, not a tiebreak.");
    expect(ops).toContain("arbitratePlayer");
  });
});
