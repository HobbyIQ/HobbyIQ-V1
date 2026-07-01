/**
 * parseCardQuery — coverage for Phase 2 defects #3a, #6, #8.
 *
 * Anchored on iOS displayLabel inputs from /search-list (CH format), which is
 * what reaches /price-by-id via computeEstimate's defensive parseCardQuery
 * fallback. Each test mirrors a locked demo card or close variant.
 */
import { describe, it, expect } from "vitest";
import { parseCardQuery, isCompVariantMatch } from "../src/services/compiq/cardQueryParser.js";

describe("parseCardQuery — Phase 2 defect #3a (Bowman Draft Chrome SET_PATTERN)", () => {
  it("matches 'Bowman Draft Chrome' before 'Bowman Draft'", () => {
    const parsed = parseCardQuery("2024 Bowman Draft Chrome Caleb Bonemer");
    expect(parsed.set).toBe("Bowman Draft Chrome");
    expect(parsed.brand).toBe("Bowman");
  });

  it("matches 'Bowman Chrome Draft' (legacy word order) still", () => {
    const parsed = parseCardQuery("2024 Bowman Chrome Draft Caleb Bonemer");
    expect(parsed.set).toBe("Bowman Chrome Draft");
  });

  it("falls back to 'Bowman Draft' when no Chrome present", () => {
    const parsed = parseCardQuery("2024 Bowman Draft Caleb Bonemer");
    expect(parsed.set).toBe("Bowman Draft");
  });

  it("matches 'Bowman Chrome' (flagship) when neither Draft variant present", () => {
    const parsed = parseCardQuery("2011 Bowman Chrome Mike Trout");
    expect(parsed.set).toBe("Bowman Chrome");
  });
});

describe("parseCardQuery — Phase 2 defect #6 (sport-suffix stopwords)", () => {
  it("strips 'Baseball' from playerName", () => {
    const parsed = parseCardQuery("2011 Topps Update Baseball Mike Trout US175 Base");
    expect(parsed.playerName).toBe("Mike Trout");
  });

  it("strips 'Football' from playerName", () => {
    const parsed = parseCardQuery("Tom Brady 2000 Topps Football");
    expect(parsed.playerName).toBe("Tom Brady");
  });

  it("strips 'Basketball' from playerName", () => {
    const parsed = parseCardQuery("LeBron James 2003 Topps Basketball");
    expect(parsed.playerName).toBe("Lebron James");
  });

  it("strips 'Hockey' from playerName", () => {
    const parsed = parseCardQuery("Wayne Gretzky 1979 Topps Hockey");
    expect(parsed.playerName).toBe("Wayne Gretzky");
  });

  it("strips 'Soccer' from playerName", () => {
    const parsed = parseCardQuery("Lionel Messi 2020 Topps Chrome Soccer");
    expect(parsed.playerName).toBe("Lionel Messi");
  });
});

describe("parseCardQuery — Phase 2 defect #8 (cardNumber regex expansion)", () => {
  it("captures US175 (unhyphenated Topps Update format)", () => {
    const parsed = parseCardQuery("2011 Topps Update Mike Trout US175 Base");
    expect(parsed.cardNumber).toBe("US175");
  });

  it("captures USC35 (unhyphenated Topps Chrome Update format)", () => {
    const parsed = parseCardQuery("2022 Topps Chrome Update Bobby Witt Jr USC35 Base");
    expect(parsed.cardNumber).toBe("USC35");
  });

  it("captures CPA-CBO (letter-letter hyphenated Bowman Draft Auto format)", () => {
    const parsed = parseCardQuery("2024 Bowman Draft Caleb Bonemer #CPA-CBO Auto");
    expect(parsed.cardNumber).toBe("CPA-CBO");
  });

  it("captures C24-CBO (mixed letter-digit hyphenated)", () => {
    const parsed = parseCardQuery("Bowman Draft Caleb Bonemer C24-CBO /250");
    expect(parsed.cardNumber).toBe("C24-CBO");
  });

  it("preserves existing BD-31 capture (no regression)", () => {
    const parsed = parseCardQuery("2024 Bowman Draft Caleb Bonemer BD-31");
    expect(parsed.cardNumber).toBe("BD-31");
  });

  it("preserves existing #BD-31 capture (no regression)", () => {
    const parsed = parseCardQuery("2024 Bowman Draft Caleb Bonemer #BD-31");
    expect(parsed.cardNumber).toBe("BD-31");
  });

  it("captures US99 and produces clean Aaron Judge playerName", () => {
    const parsed = parseCardQuery("2017 Topps Update Baseball Aaron Judge US99 Base");
    expect(parsed.cardNumber).toBe("US99");
    expect(parsed.playerName).toBe("Aaron Judge");
    expect(parsed.year).toBe(2017);
    expect(parsed.set).toBe("Topps Update");
  });

  it("captures US285 and produces clean Shohei Ohtani playerName", () => {
    const parsed = parseCardQuery("2018 Topps Update Baseball Shohei Ohtani US285 Base");
    expect(parsed.cardNumber).toBe("US285");
    expect(parsed.playerName).toBe("Shohei Ohtani");
  });
});

describe("parseCardQuery — combined Phase 2 fixes (5/5 demo cards via iOS displayLabel)", () => {
  // These mirror the locked demo card iOS displayLabel shapes from the
  // CACHE_WARM_TARGETS table. After Phase 2 fixes, each parse should produce
  // a clean {playerName, year, set, cardNumber} so the cache key aligns with
  // warming entries.

  it("Mike Trout 2011 Topps Update US175", () => {
    const parsed = parseCardQuery("2011 Topps Update Baseball Mike Trout US175 Base");
    expect(parsed.playerName).toBe("Mike Trout");
    expect(parsed.year).toBe(2011);
    expect(parsed.set).toBe("Topps Update");
    expect(parsed.cardNumber).toBe("US175");
  });

  it("Shohei Ohtani 2018 Topps Update US285", () => {
    const parsed = parseCardQuery("2018 Topps Update Baseball Shohei Ohtani US285 Base");
    expect(parsed.playerName).toBe("Shohei Ohtani");
    expect(parsed.year).toBe(2018);
    expect(parsed.set).toBe("Topps Update");
    expect(parsed.cardNumber).toBe("US285");
  });

  it("Aaron Judge 2017 Topps Update US99", () => {
    const parsed = parseCardQuery("2017 Topps Update Baseball Aaron Judge US99 Base");
    expect(parsed.playerName).toBe("Aaron Judge");
    expect(parsed.year).toBe(2017);
    expect(parsed.set).toBe("Topps Update");
    expect(parsed.cardNumber).toBe("US99");
  });

  it("Bobby Witt Jr 2022 Topps Chrome Update USC35", () => {
    const parsed = parseCardQuery("2022 Topps Chrome Update Baseball Bobby Witt Jr USC35 Base");
    expect(parsed.playerName).toBe("Bobby Witt Jr");
    expect(parsed.year).toBe(2022);
    expect(parsed.set).toBe("Topps Chrome Update");
    expect(parsed.cardNumber).toBe("USC35");
  });

  it("Caleb Bonemer 2024 Bowman Draft Chrome CPA-CBO Auto", () => {
    const parsed = parseCardQuery("2024 Bowman Draft Chrome Baseball Caleb Bonemer CPA-CBO Base Auto");
    expect(parsed.playerName).toBe("Caleb Bonemer");
    expect(parsed.year).toBe(2024);
    expect(parsed.set).toBe("Bowman Draft Chrome");
    expect(parsed.cardNumber).toBe("CPA-CBO");
    expect(parsed.isAuto).toBe(true);
  });
});

describe("isCompVariantMatch — defect #4 (AUTO regex coverage for Autographs / (AU,)", () => {
  // Defect #4: prior regex /\bauto(graph(ed)?)?\b/ missed "Autographs" (plural
  // — trailing 's' breaks the word boundary). AUTO_PREFIX_RE prior terminator
  // '[- ]' missed "(AU, RC)" format (comma after prefix). Both forms appear
  // in real Cardsight title strings.

  const autoParsed = parseCardQuery("Mike Trout 2024 Bowman Chrome Auto");
  const baseParsed = parseCardQuery("Mike Trout 2024 Bowman Chrome");

  it("matches 'Autographs' (plural — e.g. 'Chrome Prospect Autographs' subset)", () => {
    const r = isCompVariantMatch("2024 Bowman Chrome Prospect Autographs CPA-MT Mike Trout", autoParsed);
    expect(r.match).toBe(true);
  });

  it("matches 'autos' (colloquial plural)", () => {
    const r = isCompVariantMatch("2024 Bowman Chrome Mike Trout autos", autoParsed);
    expect(r.match).toBe(true);
  });

  it("matches '(AU, RC)' format — prefix followed by comma", () => {
    const r = isCompVariantMatch("2024 Bowman Chrome Mike Trout (AU, RC)", autoParsed);
    expect(r.match).toBe(true);
  });

  it("matches '(AU)' format — prefix followed by close-paren", () => {
    const r = isCompVariantMatch("2024 Bowman Chrome Mike Trout (AU)", autoParsed);
    expect(r.match).toBe(true);
  });

  it("preserves existing 'auto' / 'autograph' / 'autographed' matches (no regression)", () => {
    expect(isCompVariantMatch("Mike Trout 2024 Bowman Chrome auto", autoParsed).match).toBe(true);
    expect(isCompVariantMatch("Mike Trout 2024 Bowman Chrome autograph", autoParsed).match).toBe(true);
    expect(isCompVariantMatch("Mike Trout 2024 Bowman Chrome autographed", autoParsed).match).toBe(true);
  });

  it("preserves CPA-/BPA- prefix matches (no regression)", () => {
    // Use parsed objects whose playerName matches the title so the downstream
    // PLAYER check doesn't interfere with the AUTO_PREFIX_RE assertion.
    const bonemerAuto = parseCardQuery("Caleb Bonemer 2024 Bowman Draft Chrome Auto");
    expect(isCompVariantMatch("2024 BDC CPA-CBO Caleb Bonemer", bonemerAuto).match).toBe(true);
    const troutAuto = parseCardQuery("Mike Trout 2024 Bowman Auto");
    expect(isCompVariantMatch("2024 Bowman BPA-MT Mike Trout", troutAuto).match).toBe(true);
  });

  it("still rejects auto-bearing comp when user query is not auto (no false negative)", () => {
    // base query, auto comp -> comp_has_unwanted_auto
    const r = isCompVariantMatch("Mike Trout 2024 Bowman Chrome Autographs", baseParsed);
    expect(r.match).toBe(false);
    expect(r.reason).toBe("comp_has_unwanted_auto");
  });

  it("still rejects base comp when user query is auto (no false positive)", () => {
    const r = isCompVariantMatch("Mike Trout 2024 Bowman Chrome Base", autoParsed);
    expect(r.match).toBe(false);
    expect(r.reason).toBe("comp_missing_auto");
  });
});

/**
 * CF-CARDQUERY-PARSER-PARALLEL-EXPANSION (2026-07-01).
 *
 * Pre-fix: App Insights probe found 5 distinct product/parallel tokens
 * (Sapphire, Transcendent, X-Fractor, Raywave, Lava) leaking into the
 * extracted playerName in 10.9% of parsed queries. Worst case:
 * "2025 Bowman Draft Sapphire Ethan Conrad" → playerName="Sapphire
 * Ethan Conrad" → CH bridge fails → fallback aggregation prices a
 * real card at $9 when the underlying weekly average was $62.50.
 *
 * Each test below pins one of the observed contaminations. Positive
 * assertions: the parallel is captured AND the player name is clean.
 */
describe("parseCardQuery — CF-CARDQUERY-PARSER-PARALLEL-EXPANSION", () => {
  it("captures Sapphire as parallel; player name clean", () => {
    const p = parseCardQuery("2025 Bowman Draft Sapphire Ethan Conrad");
    expect(p.parallel).toBe("Sapphire");
    expect(p.playerName).toBe("Ethan Conrad");
  });

  it("captures X-Fractor (hyphenated); player name clean", () => {
    const p = parseCardQuery("2024 Bowman Draft Chrome X-Fractor Auto Caden Bodine");
    expect(p.parallel).toBe("X-Fractor");
    expect(p.playerName).toBe("Caden Bodine");
  });

  it("captures Xfractor (no-hyphen variant); player name clean", () => {
    const p = parseCardQuery("2024 Bowman Draft Chrome Xfractor Auto Caden Bodine");
    expect(p.parallel).toBe("X-Fractor");
    expect(p.playerName).toBe("Caden Bodine");
  });

  it("captures Blue Raywave (color+parallel first); player name clean", () => {
    const p = parseCardQuery("2024 Bowman Chrome Blue Raywave Auto Leo De Vries PSA 10");
    expect(p.parallel).toBe("Blue Raywave");
    expect(p.playerName).toBe("Leo De Vries");
  });

  it("captures bare Raywave (no color prefix); player name clean", () => {
    const p = parseCardQuery("2024 Bowman Chrome Raywave Leo De Vries");
    expect(p.parallel).toBe("Raywave");
    expect(p.playerName).toBe("Leo De Vries");
  });

  it("captures Transcendent as parallel; player name clean", () => {
    const p = parseCardQuery("2025 Topps Transcendent Auto Shohei Ohtani");
    expect(p.parallel).toBe("Transcendent");
    expect(p.playerName).toBe("Shohei Ohtani");
  });

  it("captures Red Lava (color+parallel first); player name clean", () => {
    const p = parseCardQuery("2025 Bowman Draft Chrome Red Lava Auto Josiah Hartshorn PSA 9");
    expect(p.parallel).toBe("Red Lava");
    expect(p.playerName).toBe("Josiah Hartshorn");
  });

  it("captures bare Lava (no color prefix); player name clean", () => {
    const p = parseCardQuery("2025 Bowman Draft Chrome Lava Auto Josiah Hartshorn");
    expect(p.parallel).toBe("Lava");
    expect(p.playerName).toBe("Josiah Hartshorn");
  });

  // Regression pins — make sure the new patterns don't cannibalize existing
  // parallel matches. Blue/Red/etc. bare colors must still work when no
  // Raywave/Lava keyword follows.
  it("plain Blue still parses as Blue (not Blue Raywave)", () => {
    const p = parseCardQuery("2024 Bowman Chrome Blue Auto Josh Hammond");
    expect(p.parallel).toBe("Blue");
    expect(p.playerName).toBe("Josh Hammond");
  });

  it("Red Refractor still parses as Red Refractor (not Red Lava)", () => {
    const p = parseCardQuery("2024 Bowman Chrome Red Refractor Auto Player");
    expect(p.parallel).toBe("Red Refractor");
  });
});
