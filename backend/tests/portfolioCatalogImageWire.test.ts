// CF-INVENTORY-CATALOG-IMAGE (2026-07-05) — pins the wire contract for
// catalogImageUrl on /api/portfolio holdings. iOS
// (CompatibilityShims.swift InventoryCard init) tries these key aliases
// in order; this pins the primary camelCase alias so iOS wires up on
// deploy without a client change.

import { describe, it, expect } from "vitest";
import {
  composeHoldingWireShape,
  composePortfolioListResponse,
} from "../src/services/portfolioiq/responseAssembly.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function makeHolding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h1",
    playerName: "Roldy Brito",
    cardYear: 2026,
    product: "Bowman Chrome",
    cardTitle: "2026 Bowman Blue X-Fractor Auto CPA-RB",
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    ...overrides,
  } as PortfolioHolding;
}

describe("CF-INVENTORY-CATALOG-IMAGE — /api/portfolio catalogImageUrl wire", () => {
  it("emits catalogImageUrl when the holding has cardId AND resolver map has an entry", async () => {
    const holding = makeHolding({ cardId: "ch-brito-blue-xfractor" });
    const map = new Map<string, string>([
      [
        "ch-brito-blue-xfractor",
        "https://hobbyiq3.azurewebsites.net/api/compiq/card-image-proxy?u=https%3A%2F%2Fcdn.bubble.io%2Fbrito.jpg",
      ],
    ]);
    const wire = composeHoldingWireShape(holding, map);
    expect(wire.catalogImageUrl).toBe(
      "https://hobbyiq3.azurewebsites.net/api/compiq/card-image-proxy?u=https%3A%2F%2Fcdn.bubble.io%2Fbrito.jpg",
    );
  });

  it("OMITS catalogImageUrl entirely when the holding has no cardId (unmatched / legacy)", async () => {
    const holding = makeHolding({ cardId: null });
    const map = new Map<string, string>([
      ["something-else", "https://example.com/other.jpg"],
    ]);
    const wire = composeHoldingWireShape(holding, map);
    expect("catalogImageUrl" in wire).toBe(false);
  });

  it("OMITS catalogImageUrl when the holding has cardId but the resolver map has no entry (cold meta cache)", async () => {
    const holding = makeHolding({ cardId: "ch-cold-meta" });
    const map = new Map<string, string>();
    const wire = composeHoldingWireShape(holding, map);
    expect("catalogImageUrl" in wire).toBe(false);
  });

  it("byte-identical wire shape when no map is passed (pre-CF caller compatibility)", async () => {
    const holding = makeHolding({ cardId: "ch-brito-blue-xfractor" });
    const wire = composeHoldingWireShape(holding);
    expect("catalogImageUrl" in wire).toBe(false);
  });

  it("composePortfolioListResponse threads the resolver map through to every entry", async () => {
    const items = [
      makeHolding({ id: "h1", cardId: "ch-a" }),
      makeHolding({ id: "h2", cardId: "ch-b" }),
      makeHolding({ id: "h3", cardId: null }),
    ];
    const map = new Map<string, string>([
      ["ch-a", "https://cdn.example/a.jpg"],
      ["ch-b", "https://cdn.example/b.jpg"],
    ]);
    const wires = composePortfolioListResponse(items, map);
    expect(wires).toHaveLength(3);
    expect(wires[0].catalogImageUrl).toBe("https://cdn.example/a.jpg");
    expect(wires[1].catalogImageUrl).toBe("https://cdn.example/b.jpg");
    expect("catalogImageUrl" in wires[2]).toBe(false);
  });
});
