/**
 * RULING R29 (Drew, 2026-09-13): "when ingesting, we need to make decisions
 * that correctly put it to the card set. I don't want to make a rule, but I
 * want this to be correct to match correctly."
 *
 * These tests pin the resolver's DECISION, not its plumbing, so the catalog is
 * a fake built from rows actually read out of card_catalog on 2026-09-13. Every
 * fixture row below is a real read, quoted in the module header, and the fake
 * answers the same query shape the real container does. A live-Cosmos test
 * would be slower, flaky, and would stop pinning anything the day someone
 * re-scrapes a checklist -- these pin the RULE.
 */
import { describe, it, expect } from "vitest";
import {
  resolveProductByChecklist,
  candidateProducts,
  newResolveCache,
  normalizePlayerForCompare,
} from "../src/services/catalog/resolveProductByChecklist.js";
import { inferSetKeyFromTitle, parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey, slugify, stripYearAndSport } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { extractYearFromTitle } from "../src/services/portfolioiq/slugRederivation.service.js";

interface Row { year: number; setKey: string; cardNumber: string; playerName: string | null; source: string | null }

/** Rows read read-only from card_catalog on 2026-09-13. */
const ROWS: Row[] = [
  // The flagship-swallow class. The specialization names the player from a
  // transcribed checklist; the flagship holds a bccp parallel stub with none.
  { year: 2025, setKey: "topps-allen-ginter", cardNumber: "234", playerName: "Alec Bohm", source: "checklistcenter-2026-08-30" },
  { year: 2025, setKey: "topps", cardNumber: "234", playerName: null, source: "bccp" },
  { year: 2024, setKey: "bowmans-best", cardNumber: "B24-GW", playerName: "George Wolkow", source: "checklistcenter-2026-08-29" },
  { year: 2024, setKey: "bowman", cardNumber: "B24-GW", playerName: null, source: "bccp" },
  { year: 2024, setKey: "panini-prizm-wnba", cardNumber: "5", playerName: "Betnijah Laney-Hamilton", source: "checklistinsider-2026-08-27" },
  { year: 2024, setKey: "panini-prizm", cardNumber: "5", playerName: "Deandre Ayton", source: "checklistinsider-2026-08-11" },
  // The alias class: donruss-optic holds the card from a checklist; the
  // panini-optic key holds only our own ingest-auto-seed mis-parses.
  { year: 2024, setKey: "donruss-optic", cardNumber: "201", playerName: "Precious Achiuwa", source: "checklistinsider-2026-08-27" },
  { year: 2024, setKey: "panini-optic", cardNumber: "201", playerName: "Caleb Williams Rated", source: "ingest-auto-seed" },
  // The sibling class (#2064). CPA-MG is listed under BOTH keys for the SAME
  // player; CPA-AC only under bowman-chrome.
  { year: 2026, setKey: "bowman", cardNumber: "CPA-MG", playerName: "Marconi German", source: "checklistcenter-2026-08-29" },
  { year: 2026, setKey: "bowman-chrome", cardNumber: "CPA-MG", playerName: "Marconi German", source: "checklist" },
  { year: 2026, setKey: "bowman-chrome", cardNumber: "CPA-AC", playerName: "Argenis Cayama", source: "checklistinsider-2026-08-27" },
  // A number that exists for a DIFFERENT player -- the near-miss refusal.
  { year: 2026, setKey: "bowman", cardNumber: "CPA-AG", playerName: "Adrian Gil", source: "checklistcenter-2026-08-29" },
  // A BARE COLOUR/THEME WORD IS A PARALLEL, NOT A PRODUCT. Both rows read
  // read-only on 2026-09-13, and both products carry the word as a parallel of
  // their own: topps-museum-collection has "Sapphire" and "Pink Sapphire"
  // parallels in 2023 AND 2024; panini-donruss has 40+ "Optic *" parallels in
  // 2025 and 2026 ("Optic", "Optic Orange Velocity", "Optic Circles", ...)
  // while donruss-optic holds ZERO 2026 rows.
  { year: 2024, setKey: "topps-museum-collection", cardNumber: "84", playerName: "Kirby Puckett", source: "checklistcenter-2026-08-29" },
  { year: 2024, setKey: "topps-chrome-sapphire", cardNumber: "84", playerName: "Mario Williams", source: "checklistinsider-2026-08-27" },
  { year: 2026, setKey: "panini-donruss", cardNumber: "26", playerName: "Gil Hodges", source: "checklistinsider-2026-08-27" },
];

/** A card_catalog stand-in answering the two query shapes the resolver uses. */
function fakeContainer(rows: Row[] = ROWS) {
  return {
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: unknown }> }) {
        const p = Object.fromEntries(spec.parameters.map((x) => [x.name, x.value]));
        const byCard = spec.query.includes("c.cardNumber = @n");
        const hits = rows.filter(
          (r) => r.year === p["@y"] && r.setKey === p["@s"] && (!byCard || r.cardNumber === p["@n"]),
        );
        return { fetchAll: async () => ({ resources: hits.map((r) => ({ playerName: r.playerName, source: r.source })) }) };
      },
    },
  } as never;
}

const ctx = () => ({ container: fakeContainer(), cache: newResolveCache() });

describe("R29: the checklist decides the product", () => {
  it("a flagship does not swallow a specialization the checklist names", async () => {
    // "2025 Topps Allen & Ginter Baseball #234" -- the ampersand defeats the
    // product rule and inferSetKeyFromTitle answers the bare flagship `topps`.
    const r = await resolveProductByChecklist(
      { productText: "topps-allen-ginter-234-base", year: 2025, cardNumber: "234", player: "Alec Bohm" },
      ctx(),
    );
    expect(r.setKey).toBe("topps-allen-ginter");
    expect(r.verdict).toBe("resolved");
    // The flagship was a genuine candidate and the CHECKLIST ruled it out --
    // not this function's ordering.
    expect(r.candidates).toContain("topps");
    expect(r.holders).toEqual(["topps-allen-ginter"]);
  });

  it("a bccp parallel stub with no player is not a checklist holding", async () => {
    // The same card with NO player stated. `topps` still has a row at #234, so
    // a resolver that asked "does a row exist" would tie here. It must not:
    // the stub carries no playerName, so only the specialization holds it.
    const r = await resolveProductByChecklist(
      { productText: "topps-allen-ginter-234-base", year: 2025, cardNumber: "234", player: null },
      ctx(),
    );
    expect(r.setKey).toBe("topps-allen-ginter");
    expect(r.holders).toEqual(["topps-allen-ginter"]);
  });

  it("an apostrophe does not cost a product its identity", async () => {
    // "2024 Bowman's Best #B24-GW" -> the parser answers `bowman`.
    const r = await resolveProductByChecklist(
      { productText: "bowmans-best-b24-gw-base", year: 2024, cardNumber: "B24-GW", player: null },
      ctx(),
    );
    expect(r.setKey).toBe("bowmans-best");
    expect(r.verdict).toBe("resolved");
  });

  it("a qualifier the parser drops is restored by the checklist", async () => {
    const r = await resolveProductByChecklist(
      { productText: "panini-prizm-wnba-5-base", year: 2024, cardNumber: "5", player: "Betnijah Laney-Hamilton" },
      ctx(),
    );
    expect(r.setKey).toBe("panini-prizm-wnba");
  });

  describe("the alias falls out of the checklist, not a table", () => {
    it("Panini Optic resolves to donruss-optic", async () => {
      const r = await resolveProductByChecklist(
        { productText: "panini-optic-201-base", year: 2024, cardNumber: "201", player: null },
        ctx(),
      );
      expect(r.setKey).toBe("donruss-optic");
    });

    it("Donruss Optic resolves to the same product", async () => {
      const r = await resolveProductByChecklist(
        { productText: "donruss-optic-201-base", year: 2024, cardNumber: "201", player: null },
        ctx(),
      );
      expect(r.setKey).toBe("donruss-optic");
    });

    it("the self-derived panini-optic rows never win", async () => {
      // `panini-optic` HAS a row at 2024 #201 -- ingest-auto-seed, player
      // "Caleb Williams Rated", which is one of our own mis-parses. It is not
      // a checklist, so it cannot decide a product.
      const r = await resolveProductByChecklist(
        { productText: "panini-optic-201-base", year: 2024, cardNumber: "201", player: null },
        ctx(),
      );
      expect(r.holders).not.toContain("panini-optic");
    });
  });

  describe("siblings: number+player+year must agree, never number alone", () => {
    it("a title naming the wrong sibling still finds the card", async () => {
      // "2026 Bowman #CPA-AC" -- bowman does not list CPA-AC at all; the card
      // is Argenis Cayama's in bowman-chrome.
      const r = await resolveProductByChecklist(
        { productText: "bowman-cpa-ac-auto", year: 2026, cardNumber: "CPA-AC", player: null },
        ctx(),
      );
      expect(r.setKey).toBe("bowman-chrome");
      expect(r.candidates).toContain("bowman-chrome");
    });

    it("a tie both siblings hold defers to the #2064 ruling, not the title", async () => {
      // BOTH keys list CPA-MG for Marconi German, so neither the checklist nor
      // the player breaks the tie and the title says "Bowman Chrome". Drew
      // ruled CPA-MG is a 2026 BOWMAN card.
      const r = await resolveProductByChecklist(
        { productText: "bowman-chrome-cpa-mg-auto", year: 2026, cardNumber: "CPA-MG", player: null },
        ctx(),
      );
      expect(r.setKey).toBe("bowman");
      expect(r.reason).toBe("sibling-checklist-override");
    });

    it("the number being present for a DIFFERENT player is a refusal", async () => {
      // CPA-AG is Adrian Gil's in bowman. A title naming someone else at that
      // number must not be moved onto his card.
      const r = await resolveProductByChecklist(
        { productText: "bowman-cpa-ag-auto", year: 2026, cardNumber: "CPA-AG", player: "Angeibel Gomez" },
        ctx(),
      );
      expect(r.setKey).toBeNull();
      expect(r.verdict).toBe("unknown");
      expect(r.reason).toMatch(/^number-present-different-player:bowman:Adrian Gil$/);
    });
  });

  describe("no match is an answer, and it is never a guess", () => {
    it("a product with no checklist is an acquisition item, not a verdict", async () => {
      const r = await resolveProductByChecklist(
        { productText: "panini-hoops-279", year: 2023, cardNumber: "279", player: null },
        ctx(),
      );
      expect(r.setKey).toBeNull();
      expect(r.verdict).toBe("no-checklist");
      expect(r.reason).toBe("acquisition-queue");
      // The candidate list IS the queue.
      expect(r.candidates).toContain("nba-hoops");
    });

    it("a card absent from a product we DO hold is a refusal, not a fallback", async () => {
      const r = await resolveProductByChecklist(
        { productText: "topps-allen-ginter-999", year: 2025, cardNumber: "999", player: null },
        ctx(),
      );
      expect(r.setKey).toBeNull();
      expect(r.verdict).toBe("unknown");
      expect(r.reason).toBe("card-not-in-any-candidate-checklist");
    });

    it("a title naming no registered product invents nothing", async () => {
      const r = await resolveProductByChecklist(
        { productText: "zubatron-galactic-99-base", year: 2024, cardNumber: "99", player: null },
        ctx(),
      );
      expect(r.setKey).toBeNull();
      expect(r.verdict).toBe("insufficient-evidence");
      expect(r.candidates).toEqual([]);
    });

    it("a missing card number cannot be asked the question", async () => {
      const r = await resolveProductByChecklist(
        { productText: "topps-allen-ginter", year: 2025, cardNumber: null, player: null },
        ctx(),
      );
      expect(r.verdict).toBe("insufficient-evidence");
      expect(r.reason).toBe("no-card-number");
    });

    it("an unreachable catalog refuses rather than guessing", async () => {
      const r = await resolveProductByChecklist(
        { productText: "topps-allen-ginter-234", year: 2025, cardNumber: "234", player: null },
        { container: null },
      );
      expect(r.setKey).toBeNull();
      expect(r.reason).toBe("no-catalog");
    });
  });

  describe("the resolver may not commit the defect it fixes", () => {
    // MEASURED on the census CONFLICT sample: before this guard the resolver
    // moved 10 rows `topps-triple-threads -> topps` and 5 rows
    // `topps-match-attax-uefa -> topps`, because neither product's title
    // spelling generates a candidate and the flagship's huge checklist then
    // answers for it. CF-PRODUCT-FAMILY-COLLAPSE-IS-FORBIDDEN.
    it("refuses to fold an unregistered specialization up to its flagship", async () => {
      // `topps-triple-threads` is not in the registry at all, so the title
      // generates only `topps` as a candidate -- whose huge checklist holds a
      // row at almost any number. That is how the flagship came to answer for
      // 10 census rows it was never named by.
      const rows: Row[] = [
        { year: 2024, setKey: "topps", cardNumber: "172", playerName: "Shohei Ohtani", source: "baseballcardpedia-ladders-2026-08-28" },
      ];
      const r = await resolveProductByChecklist(
        {
          productText: "topps-triple-threads-baseball-172-aquamarine",
          year: 2024,
          cardNumber: "172",
          player: null,
          parsedSetKey: "topps-triple-threads",
        },
        { container: fakeContainer(rows), cache: newResolveCache() },
      );
      expect(r.setKey).toBeNull();
      expect(r.verdict).toBe("unknown");
      expect(r.reason).toBe("refused-fold-up:topps");
    });

    it("refuses to fold a REGISTERED specialization up to its flagship", async () => {
      // The flagship really does hold this card from a real checklist, so
      // nothing but the ancestry guard stops the fold. `topps-chrome-sapphire`
      // is registered with parent `topps-chrome`, and the title names only the
      // parent's words -- the shape that moved 2 census rows to
      // `topps-museum-collection`.
      const rows: Row[] = [
        { year: 2023, setKey: "topps-chrome", cardNumber: "7", playerName: "Corbin Carroll", source: "checklistcenter-2026-08-30" },
      ];
      const r = await resolveProductByChecklist(
        {
          productText: "topps-chrome-7-refractor",
          year: 2023,
          cardNumber: "7",
          player: "Corbin Carroll",
          parsedSetKey: "topps-chrome-sapphire",
        },
        { container: fakeContainer(rows), cache: newResolveCache() },
      );
      expect(r.setKey).toBeNull();
      expect(r.verdict).toBe("unknown");
      expect(r.reason).toBe("refused-fold-up:topps-chrome");
    });

    it("still makes the sibling correction, which is not a fold-up", async () => {
      // `bowman` is not an ANCESTOR of `bowman-chrome` -- they are siblings --
      // so the #2064 ruling still lands.
      const r = await resolveProductByChecklist(
        {
          productText: "bowman-chrome-cpa-mg-auto",
          year: 2026,
          cardNumber: "CPA-MG",
          player: null,
          parsedSetKey: "bowman-chrome",
        },
        ctx(),
      );
      expect(r.setKey).toBe("bowman");
    });

    it("still makes the specialization correction the ruling is FOR", async () => {
      const r = await resolveProductByChecklist(
        {
          productText: "topps-allen-ginter-234-base",
          year: 2025,
          cardNumber: "234",
          player: "Alec Bohm",
          parsedSetKey: "topps",
        },
        ctx(),
      );
      expect(r.setKey).toBe("topps-allen-ginter");
    });
  });

  describe("a bare colour or theme word is a PARALLEL, not a product", () => {
    /*
     * BOTH OF THESE WERE DISCLOSED AS POSSIBLE REGRESSIONS IN #2116 AND RAN TO
     * GROUND AS CORRECTIONS. The parser mints a product out of a bare word the
     * title uses as a parallel name -- the same bare-word catch-all class
     * #2096 fixed for Pokemon -- and the checklist is what tells the two apart.
     * Measured read-only 2026-09-13; the fixture rows above are those reads.
     */
    it("Museum Collection Sapphire is Museum Collection, not Topps Chrome Sapphire", async () => {
      // "2024 Topps Museum Collection Baseball #84 Sapphire" -> the parser
      // answers `topps-chrome-sapphire`, a product the title never names, and
      // drops "Sapphire" (it reports parallel "Base"). The two products name
      // DIFFERENT PLAYERS at #84 -- Kirby Puckett vs Mario Williams -- so the
      // parser was pooling this sale onto another person's card.
      const r = await resolveProductByChecklist(
        {
          productText: "topps-museum-collection-baseball-84-sapphire",
          year: 2024,
          cardNumber: "84",
          player: null,
          parsedSetKey: "topps-chrome-sapphire",
        },
        ctx(),
      );
      expect(r.setKey).toBe("topps-museum-collection");
      // And it is NOT blocked as a fold-up: topps-chrome-sapphire's ancestry is
      // [itself, topps-chrome, topps] and the answer is none of those. (Live,
      // the flagship also held #84 and this came back `resolved-by-title`;
      // whether the tie-break runs depends on the flagship's rows, so the
      // PRODUCT is what is pinned here, not the path taken to it.)
      expect(r.setKey).not.toBe("topps-chrome-sapphire");
    });

    it("Panini Donruss Optic is Panini Donruss when donruss-optic does not hold the card", async () => {
      // "2026 Panini Donruss Baseball #26 Optic" -- `donruss-optic` holds ZERO
      // 2026 rows, while panini-donruss #26 is Gil Hodges with parallels named
      // "Optic Orange Velocity". "Optic" is the parallel here, not the product.
      const r = await resolveProductByChecklist(
        {
          productText: "panini-donruss-baseball-26-optic",
          year: 2026,
          cardNumber: "26",
          player: null,
          parsedSetKey: "donruss-optic",
        },
        ctx(),
      );
      expect(r.setKey).toBe("panini-donruss");
      expect(r.holders).toEqual(["panini-donruss"]);
    });

    it("a title that really does name Donruss Optic still resolves there", async () => {
      // The guard against over-correcting: the 2024 Optic card IS at
      // donruss-optic, and this must keep resolving to it.
      const r = await resolveProductByChecklist(
        { productText: "donruss-optic-201-base", year: 2024, cardNumber: "201", player: null, parsedSetKey: "donruss-optic" },
        ctx(),
      );
      expect(r.setKey).toBe("donruss-optic");
    });
  });

  describe("candidate generation states the products, never invents them", () => {
    it("includes the flagship so the checklist can rule it out", () => {
      const c = candidateProducts("topps-allen-ginter-234-base", 2025);
      expect(c).toContain("topps-allen-ginter");
      expect(c).toContain("topps");
      // Most specific first, so a tie-break reads in the right order.
      expect(c.indexOf("topps-allen-ginter")).toBeLessThan(c.indexOf("topps"));
    });

    it("does not offer a product the title never names", () => {
      expect(candidateProducts("topps-allen-ginter-234-base", 2025)).not.toContain("bowman");
    });

    it("reaches a product through its registered alias spelling", () => {
      expect(candidateProducts("panini-optic-201", 2024)).toContain("donruss-optic");
    });
  });

  describe("player comparison", () => {
    it("a suffix is not a different person", () => {
      expect(normalizePlayerForCompare("Ronald Acuna Jr.")).toBe("ronald acuna");
    });
    it("punctuation is not a different person", () => {
      expect(normalizePlayerForCompare("Betnijah Laney-Hamilton")).toBe("betnijah laney hamilton");
    });
  });

  describe("END TO END: the punctuation that costs a product its identity", () => {
    /*
     * THE DEFECT THIS RULING EXISTS FOR, DRIVEN FROM THE REAL TITLE.
     *
     * The tests above hand the resolver an already-normalized productText. These
     * start at the eBay title and run the WHOLE path -- parseListingIdentity,
     * inferSetKeyFromTitle, normalizeSetKey, then the resolver -- because the
     * defect lives in the seam between them and a test that skips the parser
     * would keep passing while the bug returned.
     *
     * The mechanism is punctuation, and it is worth pinning both sides of it:
     * "Allen and Ginter" parses correctly TODAY and "Allen & Ginter" does not;
     * "Bowman Best" reaches `bowman` and "Bowman-apostrophe-s Best" reaches
     * `bowman` too, while the bare "Bowmans Best" reaches `unknown`. Three
     * spellings of one product, three different answers, none of them right.
     */
    const e2e = async (title: string, player: string | null) => {
      const parsed = parseListingIdentity(title, undefined, {} as never);
      const year = extractYearFromTitle(title);
      const cardNumber = parsed.cardNumber ?? "";
      const parsedSetKey = normalizeSetKey(inferSetKeyFromTitle(title, cardNumber));
      const res = await resolveProductByChecklist(
        { productText: stripYearAndSport(slugify(title)), year, cardNumber, player, parsedSetKey },
        ctx(),
      );
      return { parsedSetKey, cardNumber, year, resolved: res.setKey, verdict: res.verdict };
    };

    it("an ampersand: Topps Allen & Ginter is not Topps", async () => {
      const r = await e2e("2025 Topps Allen & Ginter Baseball #234 Base", "Alec Bohm");
      // The parser's answer is the flagship -- this is the bug, pinned.
      expect(r.parsedSetKey).toBe("topps");
      // The checklist restores the product.
      expect(r.resolved).toBe("topps-allen-ginter");
    });

    it("the same product written without the ampersand already parsed correctly", async () => {
      // Proof the mechanism is the punctuation and nothing else.
      const r = await e2e("2025 Topps Allen and Ginter Baseball #234 Base", "Alec Bohm");
      expect(r.parsedSetKey).toBe("topps-allen-ginter");
      expect(r.resolved).toBe("topps-allen-ginter");
    });

    it("an apostrophe: Bowman's Best is not Bowman", async () => {
      const r = await e2e("2024 Bowman's Best Baseball #B24-GW Base", "George Wolkow");
      // The apostrophe defeats the product rule: the parser answers the
      // flagship. (For the record, ALL THREE spellings are wrong in different
      // ways -- "Bowmans Best" reaches `unknown` and "Bowman Best" also reaches
      // `bowman`.)
      expect(r.parsedSetKey).toBe("bowman");
      // A SECOND, INDEPENDENT DEFECT IS IN THE WAY, and this test records it
      // rather than hiding it behind a pass. parseListingIdentity truncates the
      // card number "B24-GW" to "B24" -- visible in the census too, where
      // "2024 Bowman's Best #B24-GW" derived `bowman:B24`. The resolver is
      // asked about a card that does not exist, so it correctly REFUSES. That
      // refusal is the right behaviour on the evidence it was given (absent
      // beats wrong); the product cannot be recovered until the number is.
      expect(r.cardNumber).toBe("B24");
      expect(r.resolved).toBeNull();
      expect(r.verdict).toBe("unknown");
    });

    it("...and with the card number the title actually states, the product resolves", async () => {
      // The SAME title, differing only in that the card number is read whole.
      // This is what the fix to the number parser will unlock, and it pins that
      // the resolver half of the pair is already correct.
      const res = await resolveProductByChecklist(
        {
          productText: "bowmans-best-baseball-b24-gw-base",
          year: 2024,
          cardNumber: "B24-GW",
          player: "George Wolkow",
          parsedSetKey: "bowman",
        },
        ctx(),
      );
      expect(res.setKey).toBe("bowmans-best");
    });

    it("a qualifier the parser drops: Panini Prizm WNBA is not Panini Prizm", async () => {
      const r = await e2e("2024 Panini Prizm WNBA Basketball #5 Base", "Betnijah Laney-Hamilton");
      expect(r.parsedSetKey).toBe("panini-prizm");
      expect(r.resolved).toBe("panini-prizm-wnba");
    });

    it("the flagship keeps its own cards", async () => {
      // The correction must not run the other way: a title that really does
      // name the flagship, at a number the flagship really holds, stays put.
      const rows: Row[] = [
        { year: 2025, setKey: "topps", cardNumber: "1", playerName: "Shohei Ohtani", source: "checklistcenter-2026-08-30" },
      ];
      const parsed = parseListingIdentity("2025 Topps Baseball #1 Base", undefined, {} as never);
      const res = await resolveProductByChecklist(
        {
          productText: "topps-baseball-1-base",
          year: 2025,
          cardNumber: parsed.cardNumber ?? "1",
          player: "Shohei Ohtani",
          parsedSetKey: "topps",
        },
        { container: fakeContainer(rows), cache: newResolveCache() },
      );
      expect(res.setKey).toBe("topps");
    });
  });

  it("asks each distinct question once", async () => {
    const cache = newResolveCache();
    const container = fakeContainer();
    let calls = 0;
    const counting = {
      items: {
        query(spec: never) { calls++; return (container as never as { items: { query: (s: never) => unknown } }).items.query(spec); },
      },
    } as never;
    const ev = { productText: "topps-allen-ginter-234-base", year: 2025, cardNumber: "234", player: null };
    await resolveProductByChecklist(ev, { container: counting, cache });
    const first = calls;
    await resolveProductByChecklist(ev, { container: counting, cache });
    expect(calls).toBe(first);
  });
});
