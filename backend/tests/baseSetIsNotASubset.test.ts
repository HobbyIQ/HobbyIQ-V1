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
import { mergeCatalogEntries } from "../src/services/portfolioiq/cardCatalog.service.js";

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

  // CF-INSERTS-IS-NOT-A-SUBSET-NAME (Drew, 2026-09-06). "Inserts" used to be
  // pinned HERE, in the real-subset list, and #1893 measured what that cost:
  // eight SP Authentic insert pages refused entirely against bcp rows carrying
  // the literal section word. It is the same kind of label as "Base Set" --
  // the bcp scraper's `leaf` when a page lists cards under one undifferentiated
  // heading -- so it folds the same way.
  it("folds the INSERT section headings too", () => {
    for (const label of ["Inserts", "inserts", "INSERTS", "Insert", "Insert Sets", "Inserts and Parallels"]) {
      expect(S.isBaseSectionLabel(label)).toBe(true);
      expect(S.claimedSubsetOf(label)).toBe("");
    }
  });

  it("leaves a REAL named subset exactly as it is", () => {
    // Including the eight insert sets #1893 named: their pages state a real
    // subset, and a real subset is a claim that still clashes and still
    // disambiguates. Folding the section word must not fold these.
    for (const real of [
      "Cards That Never Were", "Johnson Reprints", "Rookies", "Promos", "Bowmans Best Preview",
      "Sheer Dominance", "Sheer Dominance Titanium", "Home Run Chronicles", "HRC Die Cuts",
      "Epic Figures", "Reflections", "300th HR Redemption", "Game Jersey 5x7",
      "Rookie Stars", "Row 2",
    ]) {
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
    const m = /const SECTION_HEADING_LABELS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m).toBeTruthy();
    const labels = (m as RegExpExecArray)[1].match(/"[^"]+"/g) ?? [];
    // Still small enough to read in one glance. The cap is raised from 8 to 13
    // for exactly the five insert-section spellings #1894 folds and no more --
    // the harm of a broad list here is silently folding two REAL subsets onto
    // one address, so growth has to be argued for one label at a time.
    expect(labels.length).toBeLessThanOrEqual(13);
    // Every entry names a STRUCTURAL SECTION of a page: the base print, or the
    // undifferentiated insert section. A label matching neither stem is a
    // subset NAME and does not belong here.
    for (const l of labels) expect(l.toLowerCase()).toMatch(/base|checklist|insert/);
  });

  it("every folded label is a heading the bcp scraper can actually emit", () => {
    // The fold is only justified because these strings arrive as page-section
    // headings rather than subset names. The scraper's classifier is where
    // that happens, so the two must agree: a label with no branch producing it
    // is a guess.
    const scr = readFileSync(scraper, "utf8");
    expect(scr).toContain('category = "base"');
    expect(scr).toContain("category = `insert-${slugify(leaf)}`");
    // The leaf IS the subset the row carries, which is how a bare section
    // heading becomes a subsetName at all.
    expect(scr).toContain("const leaf = breadcrumb[breadcrumb.length - 1]");
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

  it('THE 186: stored "Inserts" vs an insert page stating nothing -> NO CLASH', () => {
    // #1893's population: 56 (1998) + 130 (1999) baseballcardpedia rows on
    // 1998/1999 sp-authentic carry subsetName "Inserts" and occupy the SD, HR,
    // E and R numbers the eight SCC insert pages stage. Every staged row was
    // refused. With the fold they are two rows claiming nothing, so the merge
    // decides -- which is where a same-card newcomer belongs.
    expect(clashes("Inserts", "")).toBe("no-clash");
    expect(clashes("Inserts", null)).toBe("no-clash");
    expect(clashes("Insert Sets", "")).toBe("no-clash");
  });

  it("a bare section heading vs a REAL insert name -> the real name simply carries", () => {
    // The SCC pages DO state their subset. Stored claims nothing, incoming
    // names one: nothing to refuse, and the newcomer keeps its subset.
    expect(clashes("Inserts", "Sheer Dominance")).toBe("no-clash");
    expect(clashes("Inserts", "Home Run Chronicles")).toBe("no-clash");
  });

  it("but TWO REAL insert names still disambiguate — the fold is not a merge-everything", () => {
    expect(clashes("Sheer Dominance", "Sheer Dominance Titanium")).toBe("disambiguate");
    expect(clashes("Home Run Chronicles", "HRC Die Cuts")).toBe("disambiguate");
  });

  it("and a REAL insert name vs unknown still REFUSES", () => {
    // The doctrine Drew kept explicitly: a real named subset still refuses
    // against unknown. Folding the section word does not weaken this.
    expect(clashes("Sheer Dominance", "")).toBe("refuse");
    expect(clashes("Epic Figures", null)).toBe("refuse");
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

  it("MUTATION: drop \"Inserts\" from the fold -> the 186 refuse again -> red", () => {
    // The mutant is the shipped code with one label removed. If this ever
    // passes, the fold has been reverted and #1893's eight pages are refused
    // once more.
    const withoutInserts = (stored: string, page: unknown): "refuse" | "no-clash" => {
      const knownClaim = stored.toLowerCase() === "inserts" ? stored : S.claimedSubsetOf(stored);
      const productClaim = S.claimedSubsetOf(page);
      return knownClaim && knownClaim !== (productClaim || null) ? "refuse" : "no-clash";
    };
    expect(withoutInserts("Inserts", "")).toBe("refuse");
    expect(clashes("Inserts", "")).toBe("no-clash");
    // and the mutant is indistinguishable on a REAL subset, which is why the
    // pin has to name this label specifically.
    expect(withoutInserts("Sheer Dominance", "")).toBe("refuse");
    expect(clashes("Sheer Dominance", "")).toBe("refuse");
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

// ── the damaged incumbents, and who wins the addressing fields ───────────────

/**
 * CF-INSERTS-IS-NOT-A-SUBSET-NAME, the third question (#1894).
 *
 * Folding "Inserts" stops the refusal, which means these rows now MEET in the
 * merge instead of one being dropped at the door. So: what happens to the
 * damaged bcp rows?
 *
 * MEASURED READ-ONLY against prod card_catalog, 1998 sp-authentic, the
 * "Inserts" population is 57 rows and 13 of them are parse damage from the
 * undifferentiated section:
 *
 *   cardNumber "Gary"     playerName "Sheffield 5 X 7 JSY 125"
 *   cardNumber "Greg"     playerName "Maddux 5 X 7 JSY 125"
 *   cardNumber "Gold"     playerName "(serial-numbered to 2000 copies)"
 *   cardNumber "Titanium" playerName "(serial-numbered to 100 copies)"
 *
 * TWO FACTS DECIDE THE ANSWER, and both were measured rather than assumed:
 *
 *  1. Those damaged rows are NOT incumbents on the addresses the checklist is
 *     bringing. Each sits at its OWN slug built from its own broken number --
 *     `hiq:baseball:1998:sp-authentic:gary:base:no-auto` -- while the SCC page
 *     stages SD1..SD40. They never meet, so no merge can propagate "Gary" onto
 *     a checklist card. They are junk rows to be retired by a separate lane,
 *     not a hazard of this fold.
 *
 *  2. Where the rows DO meet -- the well-formed SD/HR/E/R numbers -- the
 *     checklist newcomer WINS outright. Both sides are `checklist` authority
 *     (rank 3), so the tie breaks on confidence, and the measured values are
 *     not equal: every baseballcardpedia row carries NO confidence field at
 *     all, while the SCC rows carry 0.95. `confidenceOf` reads a missing
 *     confidence as 0 (CF-NO-CONFIDENCE-IS-NOT-HIGH-CONFIDENCE), so
 *     0.95 > 0 and the incoming row replaces the stored one wholesale.
 *
 * So the checklist row wins the addressing fields, and no change to the merge
 * is required. This pin drives the REAL mergeCatalogEntries over the measured
 * shapes, so if that ever stops being true -- a bcp re-ingest that starts
 * stamping a confidence, say -- it goes red here rather than silently keeping
 * a malformed card number.
 */
describe("the checklist row wins the addressing fields over a damaged bcp incumbent", () => {
  const now = "2026-09-06T00:00:00.000Z";

  /** A stored baseballcardpedia row, exactly as measured: no confidence. */
  const bcpRow = (over: Record<string, unknown> = {}) => ({
    id: "hiq:baseball:1998:sp-authentic:sd7:base:no-auto",
    cardId: "hiq:baseball:1998:sp-authentic:sd7:base:no-auto",
    sport: "baseball", year: 1998, setKey: "sp-authentic",
    cardNumber: "SD7", playerName: "Raul Mondesi",
    parallel: null, printRun: null, isAuto: false,
    subsetName: "Inserts", source: "baseballcardpedia",
    ...over,
  }) as never;

  /** The incoming sportscardchecklist row: confidence 0.95, no subset stated. */
  const sccRow = (over: Record<string, unknown> = {}) => ({
    id: "hiq:baseball:1998:sp-authentic:sd7:base:no-auto",
    cardId: "hiq:baseball:1998:sp-authentic:sd7:base:no-auto",
    sport: "baseball", year: 1998, setKey: "sp-authentic",
    cardNumber: "SD7", playerName: "Raul Mondesi",
    parallel: null, printRun: null, isAuto: false,
    source: "sportscardchecklist-2026-09-06", confidence: 0.95,
    ...over,
  }) as never;

  it("both sides are checklist authority, so the tie breaks on confidence", () => {
    expect(catalogAuthorityOf("baseballcardpedia")).toBe("checklist");
    expect(catalogAuthorityOf("sportscardchecklist-2026-09-06")).toBe("checklist");
  });

  it("a MISSING confidence is 0, not high — so 0.95 wins", () => {
    const { winnerIsIncoming } = mergeCatalogEntries(sccRow(), bcpRow(), now);
    expect(winnerIsIncoming).toBe(true);
  });

  it("MALFORMED incumbent number + WELL-FORMED newcomer -> the NEWCOMER's number", () => {
    // The pin Drew asked for. Even in the hypothetical where a damaged row DID
    // occupy the address, the checklist row carries the number.
    const { merged, winnerIsIncoming } = mergeCatalogEntries(
      sccRow({ cardNumber: "SD7", playerName: "Raul Mondesi" }),
      bcpRow({ cardNumber: "Gary", playerName: "Sheffield 5 X 7 JSY 125" }),
      now,
    );
    expect(winnerIsIncoming).toBe(true);
    expect(merged.cardNumber).toBe("SD7");
    expect(merged.playerName).toBe("Raul Mondesi");
    expect(merged.source).toBe("sportscardchecklist-2026-09-06");
  });

  it("the damaged rows do not sit on the addresses the checklist brings", () => {
    // Measured: each damaged row's slug is built from its own broken number,
    // so it is never the incumbent for an SD/HR/E/R card. Transcribed as the
    // fact it is, so a reader does not have to re-run the probe.
    const damaged = "hiq:baseball:1998:sp-authentic:gary:base:no-auto";
    const staged = "hiq:baseball:1998:sp-authentic:sd7:base:no-auto";
    expect(damaged).not.toBe(staged);
  });

  it("MUTATION: read a missing confidence as high -> the damaged row keeps the address -> red", () => {
    // The failure this pin exists to catch: if `confidenceOf` ever treated an
    // absent field as anything but 0, the bcp row would win the tie and
    // "Gary" would stand.
    const asHigh = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 1);
    expect(0.95 > asHigh(undefined)).toBe(false);
    // ...where the shipped rule lets the checklist row win.
    expect(mergeCatalogEntries(sccRow(), bcpRow(), now).winnerIsIncoming).toBe(true);
  });
});

// ── how the eight actually re-open ───────────────────────────────────────

/**
 * THE BUMP IS NECESSARY AND NOT SUFFICIENT, and the dispatch has to know it.
 *
 * MEASURED READ-ONLY in crawl_state, lane `sportscardchecklist`, all eight of
 * #1893's entries:
 *
 *     status=failed  attempts=3  converterVersion=3   (x8)
 *
 * They are NOT `refused`. #1893 shipped the REFUSED_STATUS verdict but has not
 * run against these entries since, so they still carry the `failed` the three
 * pre-#1893 attempts left behind.
 *
 * That distinction decides the dispatch. The v4 bump re-opens TERMINAL
 * verdicts via staleByConverter -- and `failed` is not terminal. It is gated
 * by a SEPARATE line that the bump deliberately does not touch:
 *
 *     if (prior && !RECHECK && prior.status === "failed" && (prior.attempts || 0) >= 3) continue;
 *
 * "the bump re-opens terminal verdicts, never the retry budget". So a plain
 * pending-only dispatch after this merge would walk straight past all eight
 * and report nothing intended -- the exact #1878 failure mode one gate over.
 *
 * SCOPE=recheck clears both gates, which is why the dispatch names it.
 */
describe("the eight are `failed` at the ceiling, so the dispatch needs SCOPE=recheck", () => {
  const driver = readFileSync(
    join(__dirname, "..", "scripts", "ingest-universe-driver.cjs"),
    "utf8",
  );

  it("the failed ceiling is gated by RECHECK, not by the converter version", () => {
    expect(driver).toContain(
      'if (prior && !RECHECK && prior.status === "failed" && (prior.attempts || 0) >= 3) continue;',
    );
  });

  it("and the converter bump only re-opens TERMINAL verdicts", () => {
    // Both halves matter: the bump is what makes a re-attempt LAND differently,
    // and recheck is what makes the re-attempt HAPPEN at all.
    expect(driver).toContain("if (!staleByConverter(prior)) continue;");
    expect(driver).toContain('const RECHECK = String(process.env.SCOPE || "").toLowerCase() === "recheck";');
  });

  it("`failed` is not one of the terminal statuses the bump can re-open", () => {
    const m = /const TERMINAL_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(driver);
    expect(m).toBeTruthy();
    expect((m as RegExpExecArray)[1]).not.toContain('"failed"');
  });
});
