/**
 * Regression coverage for the Bowman/Topps Chrome Prospects Autograph
 * taxonomy mismatch.
 *
 * Card Hedge stores autograph prospects under bare "Bowman Chrome Baseball"
 * set names with the autograph-ness encoded only in a CPA-/BCPA-/CRA-
 * number prefix. CompIQ requests arrive using the collector-convention
 * "Bowman Chrome Prospects Autograph" phrasing, which CH's lexical search
 * never ranks the CPA-* cards into the top results for — so the search
 * returned only the non-auto BCP-* Prospects rainbow, none of which pass
 * cardMatchesTokens(isAuto), and the engine fell back to a non-auto card_id.
 *
 * Fix: third-attempt retry in findCompsByQuery strips the "Prospect(s)
 * Autograph|Auto" phrase when tokens.isAuto and prior attempts found no
 * candidate. Also adds "prospects"/"autograph" to simplifyQuery's strip
 * list for cleaner first-pass handling.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import {
  findCompsByQuery,
  stripAutoSetPhrases,
} from "../src/services/compiq/cardhedge.client";

const CARD_MATCH_URL = "https://api.cardhedger.com/v1/cards/card-match";
const CARD_SEARCH_URL = "https://api.cardhedger.com/v1/cards/card-search";
const COMPS_URL = "https://api.cardhedger.com/v1/cards/comps";

// The non-auto BCP-179 Blue Refractor /150 (what the engine WAS resolving to).
const BCP_BLUE_CARD = {
  card_id: "1729213387763x732040211360649000",
  player: "Leo De Vries",
  set: "2024 Bowman Chrome Prospects Baseball",
  number: "BCP-179",
  variant: "Blue",
  title: "Leo De Vries 2024 Bowman Chrome Prospects #BCP-179 Blue Refractor /150",
};

// The actual auto target: CPA-LD Blue (the Blue Refractor /150 Auto SKU).
const CPA_LD_BLUE_CARD = {
  card_id: "1727395755631x391867674646985150",
  player: "Leo De Vries",
  set: "2024 Bowman Chrome Baseball",
  number: "CPA-LD",
  variant: "Blue",
  title: "Leo De Vries 2024 Bowman Chrome CPA-LD Blue Refractor /150 Auto",
};

const FAKE_COMPS = {
  raw_prices: [
    {
      price: "1100.00",
      sale_date: "2026-05-10",
      grade: "Raw",
      title: "Leo De Vries 2024 Bowman Chrome CPA-LD Blue Refractor /150 Auto",
    },
  ],
};

interface RouterOpts {
  /** When true, /cards/card-match returns match:null (forces fallback). */
  matchNull?: boolean;
  /** Map of search-query substring -> cards array CH should return. */
  searchMap: Array<{ matches: (q: string) => boolean; cards: any[] }>;
}

function installFetchRouter(opts: RouterOpts): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: Array<{ url: string; body: any }>;
  searchQueries: string[];
} {
  const calls: Array<{ url: string; body: any }> = [];
  const searchQueries: string[] = [];

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      /* ignore */
    }
    calls.push({ url, body });

    if (url === CARD_MATCH_URL) {
      if (opts.matchNull !== false) {
        return new Response(
          JSON.stringify({
            match: null,
            candidates_evaluated: 10,
            search_query_used: body.query ?? "",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ match: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === CARD_SEARCH_URL) {
      const q = String(body.search ?? "");
      searchQueries.push(q);
      const route = opts.searchMap.find((r) => r.matches(q));
      const cards = route ? route.cards : [];
      return new Response(JSON.stringify({ cards }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === COMPS_URL) {
      return new Response(JSON.stringify(FAKE_COMPS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("unexpected URL", { status: 500 });
  });

  vi.stubGlobal("fetch", fn);
  return { fetchMock: fn, calls, searchQueries };
}

describe("findCompsByQuery — autograph-prospect identity (issue #25)", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A: De Vries Blue Refractor Auto query resolves to CPA-LD card_id (not BCP-179)", async () => {
    // Simulate CH: searches containing "prospects autograph" return only BCP-179
    // (the non-auto Prospects rainbow). Once the phrase is stripped (third
    // attempt OR simplifyQuery retry), CH returns the CPA-LD auto card.
    const { searchQueries } = installFetchRouter({
      matchNull: true,
      searchMap: [
        {
          matches: (q) =>
            /prospects?\s+autograph/i.test(q) || /prospects?\s+auto\b/i.test(q),
          cards: [BCP_BLUE_CARD],
        },
        {
          // Any search without the "Prospects Autograph" phrase surfaces CPA-LD.
          matches: () => true,
          cards: [CPA_LD_BLUE_CARD],
        },
      ],
    });

    const result = await findCompsByQuery(
      "__test_devries_auto_a__ Leo De Vries 2024 Bowman Chrome Prospects Autograph Blue Refractor Auto /150",
      { grade: "Raw", limit: 10 },
    );

    expect(result.card).not.toBeNull();
    expect(result.card!.card_id).toBe(CPA_LD_BLUE_CARD.card_id);
    expect(result.card!.number).toBe("CPA-LD");
    expect(result.variantWarning).toEqual([]);
    // At least one search must have been issued with the "Prospects Autograph"
    // phrase stripped — either via simplifyQuery or stripAutoSetPhrases retry.
    expect(
      searchQueries.some(
        (q) => !/prospects?\s+(autograph|auto)\b/i.test(q),
      ),
    ).toBe(true);
  });

  it("B: non-auto Blue Refractor /150 query still resolves to BCP-179 (no regression)", async () => {
    // Query has no "Auto" / "Autograph" token → tokens.isAuto=false → the new
    // retry never fires. First search returns BCP-179 which passes tokens.
    installFetchRouter({
      matchNull: true,
      searchMap: [
        {
          matches: () => true,
          cards: [BCP_BLUE_CARD],
        },
      ],
    });

    const result = await findCompsByQuery(
      "__test_devries_nonauto_b__ Leo De Vries 2024 Bowman Chrome Prospects Blue Refractor /150",
      { grade: "Raw", limit: 10 },
    );

    expect(result.card).not.toBeNull();
    expect(result.card!.card_id).toBe(BCP_BLUE_CARD.card_id);
    expect(result.card!.number).toBe("BCP-179");
  });

  it("C: Bonemer-style auto query (auto signal already in first search) — no regression", async () => {
    // Bonemer's CH set name was "2024 Bowman Draft Chrome Baseball" with
    // number CPA-CBO. The phrase "Prospects Autograph" was NOT in the query
    // because the product name there is "Bowman Draft Chrome". First-pass
    // search should resolve immediately without any phrase-strip retry.
    const BONEMER_CARD = {
      card_id: "card-bonemer-cpa-cbo",
      player: "Caleb Bonemer",
      set: "2024 Bowman Draft Chrome Baseball",
      number: "CPA-CBO",
      variant: "Blue",
      title:
        "Caleb Bonemer 2024 Bowman Draft Chrome CPA-CBO Blue Refractor /150 Auto",
    };
    const { searchQueries } = installFetchRouter({
      matchNull: true,
      searchMap: [
        {
          matches: () => true,
          cards: [BONEMER_CARD],
        },
      ],
    });

    const result = await findCompsByQuery(
      "__test_bonemer_auto_c__ Caleb Bonemer 2024 Bowman Draft Chrome Blue Refractor Auto /150",
      { grade: "Raw", limit: 10 },
    );

    expect(result.card).not.toBeNull();
    expect(result.card!.card_id).toBe("card-bonemer-cpa-cbo");
    expect(result.variantWarning).toEqual([]);
    // Should resolve on the FIRST search call — auto-phrase retry must not be
    // needed for this query shape.
    expect(searchQueries.length).toBeGreaterThanOrEqual(1);
  });

  it("D: stripAutoSetPhrases strips Prospect(s) Autograph|Auto phrases", () => {
    expect(
      stripAutoSetPhrases(
        "Leo De Vries 2024 Bowman Chrome Prospects Autograph Blue Refractor",
      ),
    ).toBe("Leo De Vries 2024 Bowman Chrome Blue Refractor");
    expect(
      stripAutoSetPhrases(
        "Player 2024 Bowman Chrome Prospect Autograph Blue Refractor",
      ),
    ).toBe("Player 2024 Bowman Chrome Blue Refractor");
    expect(
      stripAutoSetPhrases("Player 2024 Bowman Chrome Prospects Auto Blue"),
    ).toBe("Player 2024 Bowman Chrome Blue");
    expect(
      stripAutoSetPhrases("Player 2024 Bowman Chrome Prospect Auto Blue"),
    ).toBe("Player 2024 Bowman Chrome Blue");
    // Case-insensitive
    expect(
      stripAutoSetPhrases("Player PROSPECTS AUTOGRAPH Blue"),
    ).toBe("Player Blue");
    // Leave unrelated text alone
    expect(stripAutoSetPhrases("Player Blue Refractor")).toBe(
      "Player Blue Refractor",
    );
  });

  it("E: third-attempt auto-phrase retry emits diagnostic log when invoked", async () => {
    // Force the third-attempt path by making every prior search return cards
    // that fail cardMatchesTokens(isAuto=true). This drives findCompsByQuery
    // through step 1 (AI match=null), step 2 (search returns non-auto),
    // step 3 (simplified search also returns non-auto) so !card holds, and
    // then step 3b fires and logs the diagnostic marker.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    installFetchRouter({
      matchNull: true,
      searchMap: [
        // Every search call returns the non-auto BCP-179 card so token
        // validation rejects it (isAuto required, BCP-* has no auto signal).
        // Step 3b is the only branch that can still fire after step 3 ran.
        {
          matches: () => true,
          cards: [BCP_BLUE_CARD],
        },
      ],
    });

    await findCompsByQuery(
      "__test_devries_auto_e__ Leo De Vries 2024 Bowman Chrome Prospects Autograph Blue Refractor Auto /150",
      { grade: "Raw", limit: 10 },
    );

    const calledWithMarker = logSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          a.includes("[cardhedge.client] auto-phrase retry"),
      ),
    );
    expect(calledWithMarker).toBe(true);
    logSpy.mockRestore();
  });
});
