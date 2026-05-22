/**
 * parseCardQuery — coverage for Phase 2 defects #3a, #6, #8.
 *
 * Anchored on iOS displayLabel inputs from /search-list (CH format), which is
 * what reaches /price-by-id via computeEstimate's defensive parseCardQuery
 * fallback. Each test mirrors a locked demo card or close variant.
 */
import { describe, it, expect } from "vitest";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";

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
