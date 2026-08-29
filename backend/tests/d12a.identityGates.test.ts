// CF-ONE-PIN-GATE-FOR-BOTH-FIELDS (2026-08-29, checklist D12a).
//
// addHolding adopted a catalog match as hobbyiqCardId AND cardId at any
// confidence when nothing was pinned; updateHolding gated cardId at 0.9 but
// wrote hobbyiqCardId ungated — and priceFromOurPool prices off hobbyiqCardId
// alone. Now one gate (ADD_SLUG_OVERRIDE_MIN_CONFIDENCE, 0.9) pins both
// fields on both paths; below it the match is recorded as a proposal
// (catalogMatchSlug / catalogMatchConfidence / catalogMatchedBy — what the
// wire's proposedIdentity surfaces and /accept-identity consumes), not as
// identity.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const matcher = vi.hoisted(() => ({ canonicalize: vi.fn(), catalogSlugIfExists: vi.fn() }));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: matcher.canonicalize, catalogSlugIfExists: matcher.catalogSlugIfExists };
});
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, recordSoldComp: vi.fn(async () => ({ written: false, reason: "error" })) };
});

import app from "../src/app";
import { readUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";

const PIN = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150";
const FUZZY = "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto";
const EXACT = "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto:num-150";

const identity = {
  playerName: "Theo Gillen",
  cardYear: 2024,
  product: "Bowman Chrome",
  cardTitle: "2024 Bowman Chrome Theo Gillen Blue Refractor Auto /150",
  cardNumber: "CPA-TG",
  parallel: "Blue Refractor",
  isAuto: true,
};

const fuzzy = { slug: FUZZY, found: true, confidence: 0.72, matchedBy: "fuzzy-parallel" };
const exact = { slug: EXACT, found: true, confidence: 0.98, matchedBy: "exact" };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  matcher.canonicalize.mockReset();
  matcher.catalogSlugIfExists.mockReset().mockImplementation(async (slug: string) => slug);
});
afterEach(() => vi.unstubAllGlobals());

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const response = await request(app).post("/api/auth/signin").send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  return { sessionId: response.body.sessionId as string, userId: response.body.user?.userId as string };
}

async function add(sessionId: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send({ id, ...identity, quantity: 1, purchasePrice: 100, totalCostBasis: 100, ...extra });
  expect(res.status).toBe(201);
}

async function patch(sessionId: string, id: string, body: Record<string, unknown>): Promise<void> {
  const res = await request(app).patch(`/api/portfolio/holdings/${id}`).set("x-session-id", sessionId).send(body);
  expect(res.status).toBeLessThan(300);
}

async function stored(userId: string, id: string): Promise<Record<string, unknown>> {
  const doc = await readUserDoc(userId);
  const key = Object.keys(doc.holdings).find((k) => k.toLowerCase() === id.toLowerCase());
  expect(key).toBeTruthy();
  return doc.holdings[key as string] as unknown as Record<string, unknown>;
}

describe("addHolding — one gate for both fields", () => {
  it("a 0.72 fuzzy-parallel match with nothing pinned is a PROPOSAL: neither hobbyiqCardId nor cardId adopts it", async () => {
    const { sessionId, userId } = await signIn();
    matcher.canonicalize.mockResolvedValue(fuzzy);
    await add(sessionId, "d12a-gate-add-fuzzy");
    const h = await stored(userId, "d12a-gate-add-fuzzy");
    // Mutation check: the pre-fix add wrote hobbyiqCardId = cardId = FUZZY here.
    expect(h.hobbyiqCardId).not.toBe(FUZZY);
    expect(h.cardId).not.toBe(FUZZY);
    expect(h.catalogMatchSlug).toBe(FUZZY);
    expect(h.catalogMatchConfidence).toBe(0.72);
    expect(h.catalogMatchedBy).toBe("fuzzy-parallel");
  });

  it("a 0.98 exact match pins BOTH fields, and the holding says the catalog chose", async () => {
    const { sessionId, userId } = await signIn();
    matcher.canonicalize.mockResolvedValue(exact);
    await add(sessionId, "d12a-gate-add-exact");
    const h = await stored(userId, "d12a-gate-add-exact");
    expect(h.hobbyiqCardId).toBe(EXACT);
    expect(h.cardId).toBe(EXACT);
    expect(h.hobbyiqCardIdSource).toBe("catalog");
    expect(h.catalogMatchSlug).toBe(EXACT);
  });
});

describe("updateHolding — the same gate", () => {
  it("editing a note with a 0.72 match parked writes neither field from the match", async () => {
    const { sessionId, userId } = await signIn();
    matcher.canonicalize.mockResolvedValue(exact);
    await add(sessionId, "d12a-gate-upd-fuzzy");
    matcher.canonicalize.mockResolvedValue(fuzzy);
    await patch(sessionId, "d12a-gate-upd-fuzzy", { notes: "raw, sharp corners" });
    const h = await stored(userId, "d12a-gate-upd-fuzzy");
    // Mutation check: the pre-fix update wrote hobbyiqCardId = FUZZY ungated.
    expect(h.hobbyiqCardId).not.toBe(FUZZY);
    expect(h.cardId).toBe(EXACT);
    expect(h.catalogMatchSlug).toBe(FUZZY);
    expect(h.notes).toBe("raw, sharp corners");
  });

  it("a 0.98 match on update rebinds both fields together", async () => {
    const { sessionId, userId } = await signIn();
    matcher.canonicalize.mockResolvedValue(fuzzy);
    await add(sessionId, "d12a-gate-upd-exact", { hobbyiqCardId: PIN, cardId: PIN });
    matcher.canonicalize.mockResolvedValue(exact);
    await patch(sessionId, "d12a-gate-upd-exact", { parallel: "Blue Refractor" });
    const h = await stored(userId, "d12a-gate-upd-exact");
    expect(h.hobbyiqCardId).toBe(EXACT);
    expect(h.cardId).toBe(EXACT);
    expect(h.hobbyiqCardIdSource).toBe("catalog");
  });
});
