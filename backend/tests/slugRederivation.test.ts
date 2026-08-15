// CF-SLUG-REDERIVATION (Drew, 2026-08-14).
//
// The load-bearing property is the ONLY-IMPROVE rule: a row that
// already passes the guard must come back "ok-untouched" — not
// re-derived, not second-guessed against its title. Demoting a good
// slug is worse than leaving a bad one, because the bad ones are
// countable and the demotions are not.

import { describe, it, expect } from "vitest";
import {
  rederiveRow,
  extractYearFromTitle,
} from "../src/services/portfolioiq/slugRederivation.service.js";

describe("extractYearFromTitle", () => {
  it("pulls the card year out of a title", () => {
    expect(extractYearFromTitle("1978 Kellogg's 3-D Super Stars Baseball #8")).toBe(1978);
    expect(extractYearFromTitle("2026 Bowman Chrome Prospect CPA-EHA")).toBe(2026);
  });

  it("takes the leading year of a season-spanning product", () => {
    // Hockey/basketball are routinely labelled this way; the leading
    // year is the catalog year.
    expect(extractYearFromTitle("2024-25 Upper Deck Macklin Celebrini")).toBe(2024);
    expect(extractYearFromTitle("1987 88 O PEE CHEE PATRICK ROY")).toBe(1987);
  });

  it("does not mistake print runs or card numbers for years", () => {
    expect(extractYearFromTitle("Gold Refractor /150 no year here")).toBeNull();
    expect(extractYearFromTitle("Card #1978")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractYearFromTitle("")).toBeNull();
    expect(extractYearFromTitle(null)).toBeNull();
  });
});

describe("rederiveRow — only-improve rule", () => {
  it("leaves a row that already passes the guard completely alone", () => {
    const r = rederiveRow({
      sport: "baseball", cardYear: 2025, setName: "bowman-chrome",
      cardNumber: "CPA-EHA", parallel: "Blue Refractor", isAuto: true,
      title: "2025 Bowman Chrome Blue Refractor Eric Hartman CPA-EHA Auto",
    });
    expect(r.action).toBe("ok-untouched");
    expect(r.hobbyiqCardId).toBeUndefined();
  });

  it("does NOT re-derive a passing row even when the title disagrees", () => {
    // The title says Topps, the fields say Bowman Chrome. We keep the
    // fields. Second-guessing a passing slug is how good data gets
    // demoted, and the title is the weaker signal.
    const r = rederiveRow({
      sport: "baseball", cardYear: 2025, setName: "bowman-chrome",
      cardNumber: "42", parallel: "Base", isAuto: false,
      title: "2025 Topps Series One #42 Base",
    });
    expect(r.action).toBe("ok-untouched");
  });
});

describe("rederiveRow — Phase 3 sport vocabulary", () => {
  it("normalizes a stored non-canonical sport without touching identity", () => {
    const r = rederiveRow({
      sport: "ice hockey", cardYear: 2024, setName: "upper-deck",
      cardNumber: "P37", parallel: "Base", isAuto: false,
      title: "Macklin Celebrini UD Portraits P37 2024-25 Upper Deck",
    });
    expect(r.action).toBe("sport-normalized");
    expect(r.sport).toBe("hockey");
    expect(r.hobbyiqCardId).toContain("hiq:hockey:2024:upper-deck:p37:");
  });

  it("normalizes the other observed spellings", () => {
    for (const [raw, want] of [["non-sports", "non-sport"], ["nascar", "racing"], ["NFL", "football"]]) {
      const r = rederiveRow({
        sport: raw, cardYear: 2020, setName: "topps", cardNumber: "1",
        parallel: "Base", isAuto: false, title: "2020 Topps #1",
      });
      expect(r.action).toBe("sport-normalized");
      expect(r.sport).toBe(want);
    }
  });
});

describe("rederiveRow — Phase 2 repair", () => {
  it("repairs the real Rich Gossage row from its title", () => {
    // Live row: sport=hockey on a baseball card, cardYear 197 truncated
    // from 1978, setName="bowman" a caller-side default. Current slug:
    //   hiq:hockey:197:bowman:8:base:no-auto
    const r = rederiveRow({
      hobbyiqCardId: "hiq:hockey:197:bowman:8:base:no-auto",
      sport: "hockey", cardYear: 197, setName: "bowman", cardNumber: "8",
      parallel: "Base", isAuto: false,
      title: "1978 Kellogg's 3-D Super Stars Baseball #8",
    });
    // The title says Kellogg's, which is not in the setKey vocabulary,
    // so inferSetKeyFromTitle falls back to its "Bowman" default. That
    // default is a guess and would produce a confident wrong slug, so
    // the row is deliberately left unkeyed rather than half-fixed.
    expect(r.action).toBe("unrecoverable");
    expect(r.reasons).toContain("rederived:setkey-bowman-default-unsupported");
    expect(r.hobbyiqCardId).toBeUndefined();
  });

  it("no longer reads 'Super Stars Baseball' as hockey", () => {
    // Root cause: inferSportFromTitle had no baseball keyword check, so
    // the title fell through to team-name matching where the NHL
    // alternation contains "stars" (Dallas Stars).
    const r = rederiveRow({
      sport: "hockey", cardYear: 197, setName: "bowman", cardNumber: "8",
      parallel: "Base", isAuto: false,
      title: "1978 Bowman Super Stars Baseball #8",
    });
    expect(r.action).toBe("rederived");
    expect(r.sport).toBe("baseball");
    expect(r.cardYear).toBe(1978);
    expect(r.hobbyiqCardId).toContain("hiq:baseball:1978:");
  });

  it("leaves a row unkeyed when the title cannot rescue it", () => {
    // Absent beats wrong — same doctrine as the Phase 1 guard.
    const r = rederiveRow({
      sport: "hockey", cardYear: 197, setName: "bowman", cardNumber: "8",
      parallel: "Base", isAuto: false, title: "",
    });
    expect(r.action).toBe("unrecoverable");
    expect(r.hobbyiqCardId).toBeUndefined();
    expect(r.reasons).toContain("no-title");
  });

  it("does not invent a baseball row from an unreadable title", () => {
    // inferSportFromTitle defaults its fallback to "baseball"; passing an
    // empty fallback is what stops a junk title minting a baseball slug.
    const r = rederiveRow({
      sport: "football, baseball", cardYear: 197, setName: "", cardNumber: "",
      parallel: "Base", isAuto: false, title: "lot of 5 cards see photos",
    });
    expect(r.action).toBe("unrecoverable");
    expect(r.hobbyiqCardId).toBeUndefined();
  });

  it("reports why a re-derivation failed, prefixed so it is distinguishable", () => {
    const r = rederiveRow({
      sport: "", cardYear: null, setName: "", cardNumber: "",
      parallel: "Base", isAuto: false, title: "no identity here at all",
    });
    expect(r.action).toBe("unrecoverable");
    expect((r.reasons || []).some((x) => x.startsWith("rederived:"))).toBe(true);
  });
});
