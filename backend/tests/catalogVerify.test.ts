// CF-CATALOG-VERIFY-OWN-POOL. Verify answers from OUR card_catalog and
// never calls a vendor. The behaviour that matters most here is the
// three-way outcome: true (we vouch), false (we cover it and disagree),
// null (we can't answer YET — and the miss has queued the fix).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

const { seedMock } = vi.hoisted(() => ({ seedMock: vi.fn() }));
vi.mock("../src/services/catalog/checklistSeedQueue.service", () => ({
  requestChecklistSeed: seedMock,
}));

import {
  verifyCardIdentity,
  __resetCatalogVerifyContainerForTests,
} from "../src/services/catalog/catalogVerify.service";

type Row = { id?: string; cardNumber?: string | null };

/** Route a query spec to canned rows by inspecting the SQL + params. */
function routeQueries(handlers: {
  playerRows?: (setKey: string) => Row[];
  setExists?: boolean;
}) {
  queryMock.mockImplementation((spec: any) => {
    const sql: string = spec.query ?? "";
    const params: Array<{ name: string; value: unknown }> = spec.parameters ?? [];
    const get = (n: string) => params.find((p) => p.name === n)?.value;

    if (sql.includes("c.playerSlug = @p")) {
      const rows = handlers.playerRows?.(String(get("@sk"))) ?? [];
      return { fetchAll: async () => ({ resources: rows }) };
    }
    if (sql.includes("TOP 1 VALUE 1")) {
      return {
        fetchAll: async () => ({ resources: handlers.setExists ? [1] : [] }),
      };
    }
    return { fetchAll: async () => ({ resources: [] }) };
  });
}

const TROUT = {
  playerName: "Mike Trout",
  cardYear: 2011,
  setName: "2011 Topps Update",
  cardNumber: "US175",
  sport: "baseball",
};

describe("verifyCardIdentity", () => {
  beforeEach(() => {
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=y;";
    queryMock.mockReset();
    seedMock.mockReset();
    seedMock.mockResolvedValue(true);
    __resetCatalogVerifyContainerForTests();
  });

  afterEach(() => {
    delete process.env.COSMOS_CONNECTION_STRING;
  });

  it("vouches for a card our catalog carries", async () => {
    routeQueries({
      playerRows: () => [
        { id: "hiq:baseball:2011:topps-update:us175:base:no-auto", cardNumber: "US175" },
      ],
    });

    const r = await verifyCardIdentity(TROUT);

    expect(r.verified).toBe(true);
    expect(r.reason).toBe("exact-cardnumber-match");
    expect(r.source).toBe("hobbyiq-catalog");
    expect(r.matchedSlug).toBe("hiq:baseball:2011:topps-update:us175:base:no-auto");
    // A hit is not a gap — nothing to seed.
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("matches case-insensitively on card number", async () => {
    routeQueries({ playerRows: () => [{ id: "slug", cardNumber: "us175" }] });
    const r = await verifyCardIdentity({ ...TROUT, cardNumber: " US175 " });
    expect(r.verified).toBe(true);
  });

  it("disagrees when we cover the player+set and the number isn't on it", async () => {
    routeQueries({
      playerRows: () => [
        { id: "a", cardNumber: "US175" },
        { id: "b", cardNumber: "US176" },
      ],
    });

    const r = await verifyCardIdentity({ ...TROUT, cardNumber: "US999" });

    expect(r.verified).toBe(false);
    expect(r.reason).toBe("no-cardnumber-match-in-set");
    expect(r.candidateNumbers).toEqual(["US175", "US176"]);
    // We have the checklist — a wrong number is a parse bug, not a gap.
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("falls back to the parent set in the product-family ladder", async () => {
    // topps-chrome-sapphire → parent topps-chrome
    routeQueries({
      playerRows: (setKey) =>
        setKey === "topps-chrome" ? [{ id: "parent-slug", cardNumber: "150" }] : [],
    });

    const r = await verifyCardIdentity({
      playerName: "Mike Trout",
      cardYear: 2023,
      setName: "2023 Topps Chrome Sapphire",
      cardNumber: "150",
      sport: "baseball",
    });

    expect(r.verified).toBe(true);
    expect(r.reason).toBe("family-cardnumber-match");
    expect(r.matchedSlug).toBe("parent-slug");
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("queues a seed when we hold the set but not the player", async () => {
    routeQueries({ playerRows: () => [], setExists: true });

    const r = await verifyCardIdentity(TROUT);

    expect(r.verified).toBeNull();
    expect(r.reason).toBe("player-not-in-set");
    expect(r.seedRequested).toBe(true);
    expect(seedMock).toHaveBeenCalledTimes(1);
    expect(seedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sport: "baseball",
        year: 2011,
        setKey: "topps-update",
        reason: "player-not-in-set",
        missingPlayer: "Mike Trout",
        missingCardNumber: "US175",
      }),
    );
  });

  it("queues a seed when the release is missing entirely", async () => {
    routeQueries({ playerRows: () => [], setExists: false });

    const r = await verifyCardIdentity(TROUT);

    expect(r.verified).toBeNull();
    expect(r.reason).toBe("set-not-in-catalog");
    expect(r.seedRequested).toBe(true);
    expect(seedMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "set-not-in-catalog" }),
    );
  });

  it("reports seedRequested:false when the queue declined the write", async () => {
    routeQueries({ playerRows: () => [], setExists: false });
    seedMock.mockResolvedValue(false);

    const r = await verifyCardIdentity(TROUT);

    expect(r.verified).toBeNull();
    expect(r.seedRequested).toBe(false);
  });

  it("returns null without touching Cosmos on incomplete input", async () => {
    routeQueries({});
    const r = await verifyCardIdentity({ ...TROUT, cardNumber: "" });

    expect(r.verified).toBeNull();
    expect(r.reason).toBe("insufficient-input");
    expect(queryMock).not.toHaveBeenCalled();
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("degrades to null when Cosmos is unreachable, never throws", async () => {
    delete process.env.COSMOS_CONNECTION_STRING;
    __resetCatalogVerifyContainerForTests();

    const r = await verifyCardIdentity(TROUT);

    expect(r.verified).toBeNull();
    expect(r.reason).toBe("catalog-unavailable");
  });

  it("degrades to a gap when the query itself fails", async () => {
    queryMock.mockImplementation(() => ({
      fetchAll: async () => {
        throw new Error("429 request rate is large");
      },
    }));

    // A failed read must not masquerade as "we disagree" — the only safe
    // reading is "can't answer", and that queues the checklist.
    const r = await verifyCardIdentity(TROUT);
    expect(r.verified).toBeNull();
    expect(r.reason).toBe("set-not-in-catalog");
  });
});
