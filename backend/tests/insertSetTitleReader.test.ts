/**
 * R66/R67/R70 (Drew, 2026-09-19). Pins `insertSetTitleReader.ts`'s READER
 * half -- which titles are recognised as naming an insert of their own
 * product, which are refused, and what registered-key composition each
 * recognised name resolves to.
 *
 * THE DEFECT THIS CLOSES. A sale whose title names a NAMED INSERT SET of its
 * own product ("2024 Panini Zenith - Z Marquee Drake Maye #3") derives to the
 * BASE card of that number -- another player's card. Measured on the
 * 20,840-row R32 export: 1,775 titles name a known insert of their own
 * product, ~97% lose the name entirely.
 *
 * TWO CORPORA ARE USED, DELIBERATELY. A small SYNTHETIC fixture
 * (`tests/fixtures/insertSetTitleReader/synthetic-corpus.json`, loaded via
 * the `INSERT_SET_CORPUS_OVERRIDE` test seam) pins the matching/guard LOGIC
 * against inputs this file controls completely -- including shapes the real
 * corpus does not currently carry, so a guard can be pinned before the corpus
 * happens to need it. The REAL shipped corpus
 * (`data/checklist-parallel-names.json`) is used wherever the test needs
 * `registeredKey` to resolve, because that answer depends on the real,
 * separately-maintained `catalog/productSetKeys.ts` table, which the fixture
 * cannot stand in for. Every real-corpus assertion here was verified directly
 * against the committed corpus and table before being pinned (see the R32
 * export measurement in the PR body for the full methodology).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import {
  insertSetNamedInTitle,
  _resetInsertSetTitleReaderIndex,
} from "../src/services/portfolioiq/insertSetTitleReader";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "insertSetTitleReader", "synthetic-corpus.json");

function useFixtureCorpus(): void {
  process.env.INSERT_SET_CORPUS_OVERRIDE = FIXTURE_PATH;
  _resetInsertSetTitleReaderIndex();
}
function useRealCorpus(): void {
  delete process.env.INSERT_SET_CORPUS_OVERRIDE;
  _resetInsertSetTitleReaderIndex();
}

afterEach(() => {
  useRealCorpus();
});

// ---------------------------------------------------------------------------
// SYNTHETIC-FIXTURE TESTS: the matching/guard logic, fully controlled.
// ---------------------------------------------------------------------------

describe("R66 -- a real insert name of the title's OWN product is recognised", () => {
  beforeEach(useFixtureCorpus);

  it("matches the bare root", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Zenith - Z Marquee Drake Maye #3 (RC)",
      sport: "football", year: 2024, setKey: "panini-zenith-fixture",
    });
    expect(res).toHaveLength(1);
    expect(res[0].root).toBe("z marquee");
    expect(res[0].matchedName).toBe("z marquee");
  });

  it("longest match wins: a coloured child beats the bare root", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Zenith - Z Marquee Gold Drake Maye #3 (RC)",
      sport: "football", year: 2024, setKey: "panini-zenith-fixture",
    });
    expect(res).toHaveLength(1);
    expect(res[0].matchedName).toBe("z marquee gold");
  });

  it("R67: the registered-key composition tries the matched name's own token prefixes", () => {
    // No product in the fixture is registered in the real productSetKeys.ts
    // table, so this always parks (registeredKey null) -- the shape under
    // test is WHICH name is reported, not the registration lookup itself.
    const res = insertSetNamedInTitle({
      title: "2024 Panini Zenith - Z Marquee Drake Maye #3 (RC)",
      sport: "football", year: 2024, setKey: "panini-zenith-fixture",
    });
    expect(res[0].registeredKey).toBeNull();
  });

  it("absent beats wrong: no insert vocabulary for this product means no match, no withhold", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Certified 2 Something Else #9",
      sport: "football", year: 2024, setKey: "no-such-product-fixture",
    });
    expect(res).toEqual([]);
  });

  it("nothing named in the title returns empty, even with a rich insert vocabulary present", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Zenith Drake Maye #3 (RC) Base Silver",
      sport: "football", year: 2024, setKey: "panini-zenith-fixture",
    });
    expect(res).toEqual([]);
  });
});

describe("R66 over-reach guard -- the product's own name is not an insert of itself", () => {
  beforeEach(useFixtureCorpus);

  it("a root built ENTIRELY of the product's own setKey words never matches", () => {
    const res = insertSetNamedInTitle({
      title: "2025 Panini Certified #1 Marvin Harrison Jr. Mirror #/399",
      sport: "football", year: 2025, setKey: "panini-certified-fixture",
    });
    // "Certified" is refused (product-word root); "Mirror" is refused
    // separately, by the parallel-collision guard below.
    expect(res).toEqual([]);
  });

  it("a root that merely CONTAINS a product word still matches -- it carries meaning of its own", () => {
    const res = insertSetNamedInTitle({
      title: "2025 Panini Certified - Select Certified Marvin Harrison Jr #1",
      sport: "football", year: 2025, setKey: "panini-certified-fixture",
    });
    expect(res).toHaveLength(1);
    expect(res[0].root).toBe("select certified");
  });
});

describe("parallel-collision guard -- a finish family riding the base card is not an insert", () => {
  beforeEach(useFixtureCorpus);

  it("a bare single-word colour also listed EXACTLY in parallels[] is never read as an insert", () => {
    // "Mirror" itself is a bare single-word insert root AND an EXACT plain
    // parallel name of the same product (Panini Certified's real shape) -- a
    // finish family, not a proper-noun insert set.
    const res = insertSetNamedInTitle({
      title: "2025 Panini Certified #1 Marvin Harrison Jr. Mirror #/99",
      sport: "football", year: 2025, setKey: "panini-certified-fixture",
    });
    expect(res).toEqual([]);
  });

  it("a MULTI-WORD root is NOT refused merely because a coloured sibling also sits in parallels[]", () => {
    // The over-generalised form of this guard (any parallel starting with
    // "<root> ") was tried and measured wrong: it refused the REAL,
    // registered `panini-illusions-trophy-collection` insert, because that
    // product's checklist source ALSO scrapes "Trophy Collection Blue"/
    // "...Gold" into `parallels[]` -- a corpus-building artifact of that
    // source page, not evidence "Trophy Collection" is a generic finish
    // family the way "Mirror" is. This fixture reproduces that exact shape:
    // "Trophy Collection Blue"/"Gold" sit in BOTH `insertSets[]` (as children
    // of the "Trophy Collection" root) and `parallels[]` (verbatim), and the
    // bare root must still match.
    const res = insertSetNamedInTitle({
      title: "2025 Panini Certified #1 Marvin Harrison Jr. Trophy Collection #/99",
      sport: "football", year: 2025, setKey: "panini-certified-fixture",
    });
    expect(res).toHaveLength(1);
    expect(res[0].root).toBe("trophy collection");
  });
});

describe("generic-single-word-root guard -- a card attribute is never sufficient alone", () => {
  beforeEach(useFixtureCorpus);

  it("a bare 'Rookie' root never matches on its own", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Select Basketball Rookie Card #23",
      sport: "basketball", year: 2024, setKey: "panini-select-fixture",
    });
    expect(res).toEqual([]);
  });

  it("a MULTI-WORD child of the generic root still matches, standing for itself", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Select Rookie Penmanship Silver #23",
      sport: "basketball", year: 2024, setKey: "panini-select-fixture",
    });
    expect(res).toHaveLength(1);
    expect(res[0].matchedName).toBe("rookie penmanship");
    // The effective identity is the CHILD's own name, never the generic
    // "rookie" root -- composing a registered key from "rookie" would ask
    // for the wrong candidate (indistinguishable from "Rookie Signatures").
    expect(res[0].root).toBe("rookie penmanship");
  });

  it("a DIFFERENT real multi-word root sharing the generic word is untouched by the guard", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Select Rookie Phenom Jerseys Gold #23",
      sport: "basketball", year: 2024, setKey: "panini-select-fixture",
    });
    expect(res).toHaveLength(1);
    // Longest match wins over the shorter sibling "Rookie Phenom Jerseys".
    expect(res[0].matchedName).toBe("rookie phenom jerseys gold");
  });
});

describe("player-span guard -- a matched root fully inside the resolved player name never fires", () => {
  beforeEach(useFixtureCorpus);

  it("'Young Guns' does not fire on a sale of a player named Young", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Upper Deck Young Guns #201 Trae Young RC",
      sport: "hockey", year: 2024, setKey: "upper-deck-fixture",
      playerName: "Young",
    });
    expect(res).toEqual([]);
  });

  it("the SAME title with no resolved player name still matches -- the writer did not know the player", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Upper Deck Young Guns #201 Trae Young RC",
      sport: "hockey", year: 2024, setKey: "upper-deck-fixture",
    });
    expect(res).toHaveLength(1);
    expect(res[0].root).toBe("young guns");
  });

  it("'Young Guns' still matches beside an UNRELATED player -- only a full subset match is excluded", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Upper Deck Young Guns #55 Connor Bedard RC",
      sport: "hockey", year: 2024, setKey: "upper-deck-fixture",
      playerName: "Connor Bedard",
    });
    expect(res).toHaveLength(1);
    expect(res[0].root).toBe("young guns");
  });

  it("ANY shared word refuses the match, not only a full subset -- 'Young Guns Rookie Tribute' also collides", () => {
    // Deliberately broader than "the candidate's words are a SUBSET of the
    // player's": the rule is OVERLAP, so a longer insert name sharing just
    // one word with the player's surname is refused too. This is the
    // disqualifying direction (absent beats wrong) -- a missed real insert
    // name is recoverable, a player-name collision minting the wrong product
    // key is not.
    const res = insertSetNamedInTitle({
      title: "2024 Upper Deck Young Guns Rookie Tribute #201 Trae Young RC",
      sport: "hockey", year: 2024, setKey: "upper-deck-fixture",
      playerName: "Young",
    });
    expect(res).toEqual([]);
  });
});

describe("R70 -- two inserts named in one title parks, never guesses", () => {
  beforeEach(useFixtureCorpus);

  it("two DIFFERENT products' own inserts named in one title -- both reported, caller decides to park", () => {
    // Same insert name ("Downtown") registered separately for two different
    // (sport, year, setKey) fixtures -- exercised one product at a time, as
    // production always calls it (one sale has exactly one context).
    const football = insertSetNamedInTitle({
      title: "Downtown", sport: "football", year: 2024, setKey: "two-products-a-fixture",
    });
    const basketball = insertSetNamedInTitle({
      title: "Downtown", sport: "basketball", year: 2024, setKey: "two-products-b-fixture",
    });
    expect(football).toHaveLength(1);
    expect(basketball).toHaveLength(1);
    // Neither call ever sees the other product's insert -- scoping, restated.
  });

  it("cross-root subsumption: a name that is a token-run SUFFIX of a longer match is dropped, not reported twice", () => {
    // "Downtown Duos Gold" (child of the "Downtown" root) fully contains
    // "Downtown Duo" as... no -- these are deliberately DIFFERENT strings in
    // the fixture (Duo vs Duos) so this exercises the real shape found in the
    // shipped corpus: a bare root match ("downtown") and a longer child match
    // ("downtown duos gold") on the SAME root collapse via the per-root
    // longest-match pass, never via the cross-root pass. See the real-corpus
    // section below for the genuine cross-root case (Score's "Hot Rookies
        // Artist's Proof" vs "Rookies Artist's Proof").
    const res = insertSetNamedInTitle({
      title: "2024 Some Product Downtown Duos Gold #6",
      sport: "football", year: 2024, setKey: "two-products-a-fixture",
    });
    expect(res).toHaveLength(1);
    expect(res[0].matchedName).toBe("downtown duos gold");
  });
});

// ---------------------------------------------------------------------------
// REAL-CORPUS INTEGRATION TESTS: registered-key composition, and the traps
// the R32 export measurement actually found. Each of these was verified
// directly against the committed `data/checklist-parallel-names.json` and
// `src/services/catalog/productSetKeys.ts` before being pinned here.
// ---------------------------------------------------------------------------

describe("R67 -- a recognised insert composes to its registered product key (real corpus)", () => {
  it("Panini Mosaic 'Give and Go' resolves to its registered key", () => {
    const res = insertSetNamedInTitle({
      title: "2024-25 Panini Mosaic - Give and Go Stephon Castle #6 Green Mosaic Prizm (RC)",
      sport: "basketball", year: 2024, setKey: "panini-mosaic",
    });
    expect(res).toHaveLength(1);
    expect(res[0].registeredKey).toBe("panini-mosaic-give-and-go");
  });

  it("Panini Illusions 'Trophy Collection' (a coloured child) resolves to its registered key", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Illusions - Rome Odunze #14 Trophy Collection Light Blue /249 (RC)",
      sport: "football", year: 2024, setKey: "panini-illusions",
    });
    expect(res).toHaveLength(1);
    expect(res[0].registeredKey).toBe("panini-illusions-trophy-collection");
  });

  it("R67 key composition tries the matched name's OWN token prefixes before the corpus root: Donruss Optic 'Downtown Duos Gold' resolves to the DUOS key, not bare Downtown", () => {
    // football|2024|donruss-optic's corpus root is literally "downtown" and
    // groups "Downtown!"/"Downtown Duos ..."/"Downtown Legends ..." under it
    // -- three separately registered product keys. Composing the candidate
    // key from the corpus's OWN root field alone would send this title to
    // the bare Downtown key, a DIFFERENT real card set. Found measuring this
    // module against the R32 export.
    const res = insertSetNamedInTitle({
      title: "2024 Panini Donruss Optic Downtown Duos Gold Justin Herbert #6",
      sport: "football", year: 2024, setKey: "donruss-optic",
    });
    expect(res).toHaveLength(1);
    expect(res[0].registeredKey).toBe("donruss-optic-downtown-duos");
  });

  it("Donruss Optic 'Uptowns' (football 2024) resolves to its registered key", () => {
    // The corpus previously listed only coloured children of "Uptowns"
    // ("Uptowns Gold", "Uptowns White Pandora", "Uptowns White Sparkle") and
    // no bare root, so a bare "Uptowns" title matched nothing (absent beats
    // wrong) -- the same coverage-gap shape Illusions/Zenith had. The corpus
    // has since gained a bare "Uptowns" root (children now include plain
    // "Uptowns"), and `donruss-optic-uptowns` is registered
    // (`catalog/productSetKeys.ts`), so this now resolves.
    const res = insertSetNamedInTitle({
      title: "2024 Panini Donruss Optic - Uptowns Blake Corum #14 (RC)",
      sport: "football", year: 2024, setKey: "donruss-optic",
    });
    expect(res).toHaveLength(1);
    expect(res[0].registeredKey).toBe("donruss-optic-uptowns");
  });
});

describe("R70 park reason -- named with no registered key, real corpus", () => {
  it("Panini Prizm 'Kaleidoscopic' is a real, NOW-registered insert (Wave-1 follow-on, 2026-09-19) -- resolves, no longer parks", () => {
    // Was the park-path example until this PR registered
    // panini-prizm-kaleidoscopic for real (2024-25 Panini Prizm Basketball's
    // own "Kaleidoscopic" insert, 300 rows, own #1-30 roster, never a base
    // parallel value in that file's own parallel column -- see
    // productSetKeys.ts's own registration comment). The same defect class
    // #2342 hit registering panini-mosaic-kaleidoscopic: "a real word the
    // reader finds with no registered key" is a fact about the shipped
    // corpus at a moment in time, not an invariant, and correctly stops
    // being true the moment the key is registered. See
    // insertSetReviewAdversarialTitles.test.ts for the synthetic-fixture
    // replacement of the "still parks" example this test used to be.
    const res = insertSetNamedInTitle({
      title: "2024-25 Panini Prizm - Kaleidoscopic Victor Wembanyama #20 Fast Break Prizm",
      sport: "basketball", year: 2024, setKey: "panini-prizm",
    });
    expect(res).toHaveLength(1);
    expect(res[0].root).toBe("kaleidoscopic");
    expect(res[0].registeredKey).toBe("panini-prizm-kaleidoscopic");
  });

  it("a bare YEAR is never read as an insert name (corpus noise guard)", () => {
    // basketball|2024|panini-totally-certified's corpus carries a root
    // literally spelled "2024" (a year-badge checklist section header, not a
    // proper noun) with real children ("2024 Mirror Blue"). Matching the bare
    // root would catch every title of that year. Found measuring this module
    // against the R32 export (37 rows on this one product alone).
    const res = insertSetNamedInTitle({
      title: "2024 Panini Totally Certified #6 Some Player Base",
      sport: "basketball", year: 2024, setKey: "panini-totally-certified",
    });
    expect(res).toEqual([]);
  });

  it("a bare 'Rookie' root does not park every rookie-card sale (the false-positive class this guard closes)", () => {
    // Measured before this guard: 162 (panini-select) + 115 (panini-photogenic)
    // + 104 (panini-prizm) rows out of the 20,840-row export parked on the
    // word "Rookie" alone, more than any genuine insert root -- every one an
    // ordinary rookie-card sale, not a naming of a real insert set.
    const res = insertSetNamedInTitle({
      title: "2024 Panini Select Basketball #23 Rookie Base Silver",
      sport: "basketball", year: 2024, setKey: "panini-select",
    });
    expect(res).toEqual([]);
  });
});

describe("R70 two-inserts-named -- real corpus traps", () => {
  it("two genuinely distinct real insert names in one title: both reported, neither chosen", () => {
    const res = insertSetNamedInTitle({
      title: "2025 Panini Prizm - Prizmatic Talisman Kristian Campbell #1 Red Pulsar /399",
      sport: "baseball", year: 2025, setKey: "panini-prizm",
    });
    expect(res.map((m) => m.root).sort()).toEqual(["prizmatic", "talisman"]);
  });

  it("cross-root subsumption on the real corpus: 'Hot Rookies Artist's Proof' is ONE insert, not two", () => {
    // Score's plain "Rookies" root is generic (its children stand for
    // themselves, per the guard above) and separately carries a child
    // "Rookies Artist's Proof"; Score's OWN DIFFERENT "Hot Rookies" root also
    // carries a child "Hot Rookies Artist's Proof". Before the cross-root
    // subsumption fix, this title reported BOTH as distinct inserts and
    // R70 would have parked it as "two inserts named" -- wrong, since the
    // title states one insert's full name, which happens to contain the
    // other root's child as a trailing token run.
    const res = insertSetNamedInTitle({
      title: "2025 Score Hot Rookies Artist's Proof 1 Cam Ward Rookie 15/35 - Raw",
      sport: "football", year: 2025, setKey: "score",
    });
    expect(res).toHaveLength(1);
    expect(res[0].matchedName).toBe("hot rookies artist s proof");
  });

  it("'Rookies in Motion' is ONE insert, not 'In-Motion' plus itself (cross-root subsumption)", () => {
    const res = insertSetNamedInTitle({
      title: "2025 Panini Photogenic #1 Travis Hunter Rookies In Motion - Raw",
      sport: "football", year: 2025, setKey: "panini-photogenic",
    });
    expect(res).toHaveLength(1);
    expect(res[0].matchedName).toBe("rookies in motion");
  });
});

describe("R66 scoping -- an insert of ANOTHER product or sport never matches (real corpus)", () => {
  it("one sport's insert vocabulary does not answer for another sport's card", () => {
    const res = insertSetNamedInTitle({
      title: "2024 Panini Mosaic Stained Glass #1 Someone",
      sport: "football", year: 2024, setKey: "panini-select",
    });
    expect(res).toEqual([]);
  });

  it("Zenith's coverage gap has closed: 'Z Marquee' now recognises and resolves", () => {
    // Zenith's corpus insertSets were ABSENT when this module was first built
    // (2026-09-19 measurement); the reader correctly left Zenith titles alone
    // rather than withholding them on unknown vocabulary. The corpus has
    // since gained Zenith's insertSets (including "Z Marquee") and
    // `panini-zenith-z-marquee` is now registered, so this resolves. Kept as
    // a regression pin for the coverage-gap shape, updated to the current
    // (better) reality rather than left asserting a since-closed gap.
    const res = insertSetNamedInTitle({
      title: "2024 Panini Zenith - Z Marquee Drake Maye #3 (RC)",
      sport: "football", year: 2024, setKey: "panini-zenith",
    });
    expect(res).toHaveLength(1);
    expect(res[0].registeredKey).toBe("panini-zenith-z-marquee");
  });

  it("a product with genuinely no insert vocabulary at all behaves as today -- no match, no withhold", () => {
    // 1984 Topps baseball: predates every named-insert era; the corpus
    // carries zero insertSets for it. R66 must leave such titles alone rather
    // than withholding them: unknown vocabulary is not evidence of an insert.
    const res = insertSetNamedInTitle({
      title: "1984 Topps Baseball #1 Someone",
      sport: "baseball", year: 1984, setKey: "topps",
    });
    expect(res).toEqual([]);
  });
});

describe("robustness -- absent/malformed inputs never throw and never match", () => {
  it("no sport, no setKey, no year, no title -> empty, no throw", () => {
    expect(insertSetNamedInTitle({ title: null, sport: null, year: null, setKey: null })).toEqual([]);
    expect(insertSetNamedInTitle({ title: "", sport: "", year: NaN, setKey: "" })).toEqual([]);
    expect(insertSetNamedInTitle({ title: "2024 Panini Mosaic #1", sport: "football", year: undefined, setKey: "panini-mosaic" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R70 PARK MECHANISM: `parkSoldCompDoc` writes the stamp the writers apply.
//
// NOTE (review fix, 2026-09-19): the two tests that USED to sit here --
// asserting `exactPoolReader.ts` / `soldCompsGradeReader.ts` do NOT filter
// `identityUnverified` -- were REMOVED, not merely rewritten. F2, a
// SEPARATE PR by another author, closes exactly that gap (the FMV readers
// will start excluding `identityUnverified` rows), and those two tests
// pinned the CURRENT, about-to-change behaviour byte-for-byte -- keeping
// them here would turn F2's own PR red the moment it lands, for a query
// shape this PR does not own and must not gate. The finding itself (parked
// !== excluded from FMV, today) is preserved in prose on
// `twinAddressRule.ts`'s `isParked` header (F6 fix, same review) rather than
// as an executable pin in this file.
describe("R70 park mechanism -- parkSoldCompDoc writes the stamp", () => {
  it("stamps identityUnverified + reason + detail on the doc, matching guardSoldCompDoc's own park shape", async () => {
    const { parkSoldCompDoc } = await import("../src/services/portfolioiq/splitIdentityWriteGuard");
    const doc: Record<string, unknown> = {
      id: "x", cardId: "hiq:football:2024:donruss-optic:6:base:no-auto", hobbyiqCardId: "hiq:football:2024:donruss-optic:6:base:no-auto",
    };
    parkSoldCompDoc(doc, "insert-named-no-key", "title names insert \"paragon\" of panini-phoenix, which has no registered product key", "test:insert-set-title-reader");
    expect(doc.identityUnverified).toBe(true);
    expect(doc.identityUnverifiedReason).toBe("insert-named-no-key");
    expect(typeof doc.identityUnverifiedDetail).toBe("string");
    expect(doc.identityUnverifiedBy).toBe("test:insert-set-title-reader");
    expect(typeof doc.identityUnverifiedAt).toBe("string");
  });

  it("two-inserts-named stamps the same shape", async () => {
    const { parkSoldCompDoc } = await import("../src/services/portfolioiq/splitIdentityWriteGuard");
    const doc: Record<string, unknown> = { id: "x", cardId: "c", hobbyiqCardId: "h" };
    parkSoldCompDoc(doc, "two-inserts-named", "title names 2 distinct insert sets", "test:insert-set-title-reader");
    expect(doc.identityUnverified).toBe(true);
    expect(doc.identityUnverifiedReason).toBe("two-inserts-named");
  });
});

// ---------------------------------------------------------------------------
// UN-PARK: what clears identityUnverified once a title's insert gets a
// registered key later? FINDING (2026-09-19): NOTHING does, for ANY park
// reason, old or new. Confirmed by source inspection (required follow-up,
// not optional):
//
//   - No writer, script, or service anywhere sets identityUnverified to
//     false/undefined, or deletes it (`grep -rn "identityUnverified.*=.*
//     false|identityUnverified.*undefined|delete.*identityUnverified" src/
//     scripts/` returns zero results).
//   - `scripts/relocate-pool-rows-by-list.cjs` (the only generic sold_comps
//     relocation lane) builds its target document via `stripSystem(doc0)`
//     (scripts/lib/relocate-sold-comp.cjs:74-76), which strips ONLY Cosmos
//     system fields (_rid/_self/_etag/_attachments/_ts). identityUnverified
//     and its siblings ride along UNCHANGED to the new address.
//   - `relocateSoldComp` (scripts/lib/relocate-sold-comp.cjs:285) DOES
//     re-run the split-identity guard on the target (`guardFn(keep, ...)`,
//     line ~297) -- but that call is `decideSplitIdentity`-shaped: it only
//     ever answers "malformed-key" (refuse the move) or lets the write
//     through. It has no way to know an insert this PR parked is now
//     registered, and it never clears a PRE-EXISTING identityUnverified
//     stamp already sitting on the row being moved.
//
// So today: once a row parks with insert-named-no-key, registering the key
// in catalog/productSetKeys.ts does NOT retroactively un-park any
// ALREADY-STORED row. A future sale of the same card, ingested AFTER the key
// is registered, re-keys correctly (this PR's own pre-step reads the
// registration live, every call). Only a NEW ingest benefits automatically;
// the STORED park is permanent until a dedicated repair script (a) rewrites
// cardId/hobbyiqCardId to the newly-registered key's address AND (b) clears
// identityUnverified/identityUnverifiedReason/identityUnverifiedDetail/
// identityUnverifiedAt/identityUnverifiedBy explicitly -- which nothing in
// the repo does today, for any reason. This is exactly the "stored-row
// repair" follow-up already flagged as out of scope for this PR; the un-park
// half of that follow-up specifically needs a NEW clearing step, not reuse
// of the existing relocation lane as-is.
describe("un-park -- confirms nothing clears identityUnverified today (documented, not fixed here)", () => {
  it("parkSoldCompDoc has no inverse in this module, and none exists elsewhere in the repo (see file header)", async () => {
    const mod = await import("../src/services/portfolioiq/splitIdentityWriteGuard");
    const exported = Object.keys(mod);
    // If an "unpark"/"clearIdentityUnverified"-shaped export is ever added,
    // this test should be extended to exercise it -- its absence today is
    // the finding, not an oversight in this test.
    expect(exported.some((k) => /unpark|clearIdentity/i.test(k))).toBe(false);
  });
});
