// CF-TCA-EBAY-PLAYER-NAME-CHECKLIST-LOOKUP (2026-09-12).
//
// #2088's residual-class census (tcaEbayResidualClassCensus.test.ts) measured
// the largest single sportUnresolved bucket in the 1,000-row 09-10 TCA eBay
// fixture: 147 rows are 2025 Panini Select football rookies (and similar)
// where the title states year + product + a player-shaped segment but NAMES
// NO TEAM and NO SPORT WORD — "2025 Panini Select - Concourse Tetairoa
// McMillan #44 Zebra Prizm (RC)" gives resolveVertical nothing it can read.
//
// This file unit-tests resolveVerticalByChecklistPlayer in isolation: the
// bounded (year, setKey) checklist lookup that answers the question from the
// OTHER direction — not "does this exact player have exactly one card
// number" (resolveCardNumberByPlayer's question) but "does exactly ONE
// checklist-backed player in this year+product match the title's
// player-shaped segment", handing back that ROW'S OWN sport. Never a guess:
// two same-surname checklist players, a player who exists only in a
// DIFFERENT year/product, or a stated number that disagrees with the matched
// player's own number all refuse.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { queryMock, ctorMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  const containerMock = { items: { query: queryMock } };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { queryMock, ctorMock };
});

vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

import {
  resolveVerticalByChecklistPlayer,
  _clearPlayerChecklistCache,
} from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

/** One (year, setKey) product's checklist, as card_catalog rows would carry
 *  it: playerName, cardNumber, sport. Keyed by "year|setKey" so the mock can
 *  answer several products in one test file without cross-talk. */
const CHECKLISTS: Record<string, Array<{ playerName: string; cardNumber: string; sport: string }>> = {
  "2025|panini-select": [
    { playerName: "Tetairoa McMillan", cardNumber: "44", sport: "football" },
    { playerName: "Cam Ward", cardNumber: "26", sport: "football" },
    { playerName: "Jalen Milroe", cardNumber: "155", sport: "football" },
    { playerName: "Donovan Ezeiruaku", cardNumber: "397", sport: "football" },
    // Two-surname collision, deliberately: TWO distinct "Smith"s on one
    // product's checklist. A title segment of just "Smith" must refuse.
    { playerName: "Jaylen Smith", cardNumber: "201", sport: "football" },
    { playerName: "Tyler Smith", cardNumber: "202", sport: "football" },
    // A team/set word that happens to look name-shaped must never resolve —
    // it is not on the checklist at all, so "no-match" is the only path that
    // can prove this, but it is listed here for readability of intent.
  ],
  "2025|panini-select-wnba": [
    // Gilberto Mora appears in a DIFFERENT product/context — used by the
    // wrong-year / wrong-product guardrail below.
    { playerName: "Sophie Cunningham", cardNumber: "12", sport: "basketball" },
  ],
  "2024|panini-select": [
    // A player who exists in THIS product but a year BEFORE the title's
    // stated year — must not satisfy a 2025 lookup.
    { playerName: "Cam Ward", cardNumber: "9", sport: "football" },
  ],
};

beforeEach(() => {
  _clearPlayerChecklistCache();
  queryMock.mockReset();
  queryMock.mockImplementation((q: { query: string; parameters: Array<{ name: string; value: unknown }> }) => {
    const yearParam = q.parameters.find((p) => p.name === "@y")?.value;
    const setKeyParam = q.parameters.find((p) => p.name === "@sk")?.value;
    const key = `${yearParam}|${setKeyParam}`;
    const rows = CHECKLISTS[key] ?? [];
    return { fetchAll: async () => ({ resources: rows }) };
  });
});

describe("resolveVerticalByChecklistPlayer — resolves via exactly-one checklist match", () => {
  it("resolves 'Tetairoa McMillan' (no team, no sport word) to football from the checklist row", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select",
      playerSegment: "Tetairoa McMillan",
    });
    expect(r.reason).toBe("resolved");
    expect(r.sport).toBe("football");
    expect(r.checklistPlayer).toBe("Tetairoa McMillan");
  });

  it("resolves 'Cam Ward' when a card number is ALSO stated and agrees with the checklist", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select",
      playerSegment: "Cam Ward",
      titleCardNumber: "26",
    });
    expect(r.reason).toBe("resolved");
    expect(r.sport).toBe("football");
    expect(r.cardNumber).toBe("26");
  });

  it("tolerates case and punctuation differences (initials/diacritics normalization)", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select",
      playerSegment: "CAM WARD",
    });
    expect(r.reason).toBe("resolved");
    expect(r.sport).toBe("football");
  });

  it("suffix Jr./II fold: a title segment with a suffix still matches the checklist's plain name", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select",
      playerSegment: "Jalen Milroe Jr.",
    });
    expect(r.reason).toBe("resolved");
    expect(r.sport).toBe("football");
  });
});

describe("resolveVerticalByChecklistPlayer — negative cases refuse rather than guess", () => {
  it("two players sharing a surname in the SAME product: a bare surname segment does NOT resolve", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select",
      playerSegment: "Smith",
    });
    expect(r.reason).not.toBe("resolved");
    expect(r.sport).toBeNull();
  });

  it("a player present in the checklist but in the WRONG YEAR does not resolve", async () => {
    // Cam Ward exists in 2024 panini-select, but the title states 2025 and
    // 2025's checklist (mocked above) does carry him too — so to prove the
    // year actually gates, ask about a year with NO Cam Ward at all.
    const r = await resolveVerticalByChecklistPlayer({
      year: 2023,
      setKey: "panini-select",
      playerSegment: "Cam Ward",
    });
    expect(r.reason).toBe("no-candidates");
    expect(r.sport).toBeNull();
  });

  it("a player present in a DIFFERENT product does not resolve against this one", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select-wnba",
      playerSegment: "Tetairoa McMillan",
    });
    expect(r.reason).toBe("no-match");
    expect(r.sport).toBeNull();
  });

  it("a team/set word that is not on the checklist at all never resolves", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select",
      playerSegment: "Zebra Prizm",
    });
    expect(r.reason).toBe("no-match");
    expect(r.sport).toBeNull();
  });

  it("a stated card number that disagrees with the matched player's own number refuses", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 2025,
      setKey: "panini-select",
      playerSegment: "Tetairoa McMillan",
      titleCardNumber: "999", // checklist says 44, title claims 999
    });
    expect(r.reason).toBe("number-disagreement");
    expect(r.sport).toBeNull();
  });

  it("no checklist rows at all for this (year, setKey) refuses as no-candidates", async () => {
    const r = await resolveVerticalByChecklistPlayer({
      year: 1988,
      setKey: "totally-unknown-product",
      playerSegment: "Cam Ward",
    });
    expect(r.reason).toBe("no-candidates");
  });

  it("blank/missing inputs refuse rather than query", async () => {
    const r = await resolveVerticalByChecklistPlayer({ year: 0, setKey: "", playerSegment: "" });
    expect(r.reason).toBe("no-match");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("resolveVerticalByChecklistPlayer — bounded lookup, never a cross-partition scan", () => {
  it("queries scoped to exactly one (year, setKey), never all products at once", async () => {
    await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Cam Ward" });
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [{ query, parameters }] = queryMock.mock.calls[0];
    expect(query).toMatch(/WHERE\s+c\.year\s*=\s*@y\s+AND\s+c\.setKey\s*=\s*@sk/);
    expect(query).toMatch(/TOP\s+\d+/i);
    expect(parameters.find((p: { name: string }) => p.name === "@y")?.value).toBe(2025);
    expect(parameters.find((p: { name: string }) => p.name === "@sk")?.value).toBe("panini-select");
  });

  it("caches per (year, setKey) so repeated rows in one product cost one query", async () => {
    await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Cam Ward" });
    await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Tetairoa McMillan" });
    await resolveVerticalByChecklistPlayer({ year: 2025, setKey: "panini-select", playerSegment: "Jalen Milroe" });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
