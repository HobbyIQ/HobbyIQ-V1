// CF-A-MINTED-SLUG-NEVER-REPLACES-A-PIN + CF-A-DERIVED-SLUG-IS-ADOPTED-ONLY-
// FROM-THE-CATALOG + CF-A-SUPPLIED-SLUG-MUST-BE-A-CATALOG-ROW
// (2026-08-29, checklist D12a §2 / §3).
//
// withDerivedSlug recomputed hobbyiqCardId from free text on EVERY write,
// with no catalog read, and OVERWROTE the pinned one — before the catalog was
// even asked. And updateHolding wrote a body-supplied hobbyiqCardId as given.
// Now: a pinned slug is kept; a derived slug fills only an ABSENT one, and
// only when the catalog holds it (the id or its un-numbered twin — the
// catalog's form is written); a supplied slug is accepted only when it names
// a catalog row. Nothing mints an identity.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const matcher = vi.hoisted(() => ({ canonicalize: vi.fn(), catalogSlugIfExists: vi.fn() }));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: matcher.canonicalize, catalogSlugIfExists: matcher.catalogSlugIfExists };
});
const pool = vi.hoisted(() => ({
  recordSoldComp: vi.fn(async () => ({ written: true, id: "row-1", deduped: false, hobbyiqCardId: null })),
}));
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, recordSoldComp: pool.recordSoldComp };
});

import app from "../src/app";
import { readUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";
import { fillDerivedSlugFromCatalog, deriveHoldingSlug, hasPinnedSlug } from "../src/services/portfolioiq/holdingSlug.service.js";
import { pickCatalogRow } from "../src/services/catalog/catalogIdentityResolver.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const VENDOR_ID = "1606922959335x293409091214639100";
const PIN = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150";
const FUZZY = "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto";
const NOWHERE = "hiq:baseball:2024:bowman-chrome:cpa-tg:purple-refractor:auto";

// The text says Bowman Chrome /150, so the free-text derivation lands on a
// bowman-chrome:...:num-150 slug — never on PIN's bowman-draft.
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

/** The catalog holds exactly `known`; the answer is the REAL resolver rule over
 *  it (catalogIdentityResolver.pickCatalogRow): the id itself, else its twin in
 *  either direction, else null — CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30). */
function catalogHolds(...known: string[]): void {
  matcher.catalogSlugIfExists.mockImplementation(async (slug: string) => pickCatalogRow(slug, known).id);
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  matcher.canonicalize.mockReset().mockResolvedValue(fuzzy);
  matcher.catalogSlugIfExists.mockReset();
  catalogHolds(PIN);
  pool.recordSoldComp.mockClear();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

function events(spy: ReturnType<typeof vi.spyOn>, name: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
    .filter((e): e is Record<string, unknown> => !!e && e.event === name);
}

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

describe("fillDerivedSlugFromCatalog — fills, never replaces, never mints", () => {
  it("keeps a pinned hiq: slug even when the text derives a different one", async () => {
    const h = { id: "h", ...identity, hobbyiqCardId: PIN } as unknown as PortfolioHolding;
    const derived = deriveHoldingSlug(h);
    expect(derived).toBeTruthy();
    expect(derived).not.toBe(PIN);
    catalogHolds(PIN, derived as string);
    // Mutation check: the pre-fix recompute-and-overwrite returned `derived` here.
    expect((await fillDerivedSlugFromCatalog(h)).hobbyiqCardId).toBe(PIN);
    expect(hasPinnedSlug(h)).toBe(true);
    expect(matcher.catalogSlugIfExists).not.toHaveBeenCalled();
  });

  it("fills an absent slug from the text when the catalog holds it, and says the slug was derived", async () => {
    const h = { id: "h", ...identity } as unknown as PortfolioHolding;
    const derived = deriveHoldingSlug(h) as string;
    catalogHolds(derived);
    const out = await fillDerivedSlugFromCatalog(h);
    expect(out.hobbyiqCardId).toBe(derived);
    expect(out.hobbyiqCardIdSource).toBe("derived");
  });

  it("leaves the slug UNSET when the catalog does not hold the derived one — a minted slug is not an identity", async () => {
    const h = { id: "h", ...identity } as unknown as PortfolioHolding;
    catalogHolds(/* nothing */);
    const out = await fillDerivedSlugFromCatalog(h, { source: "test" });
    // Mutation check: the pre-fix fill wrote the derived slug unconditionally.
    expect(out).toBe(h);
    expect(out.hobbyiqCardId).toBeUndefined();
    expect(events(logSpy, "derived_slug_not_in_catalog")).toHaveLength(1);
  });

  it("writes the catalog's form when only the un-numbered twin is a row", async () => {
    const h = { id: "h", ...identity } as unknown as PortfolioHolding;
    const derived = deriveHoldingSlug(h) as string;
    expect(derived).toMatch(/:num-150$/);
    const twin = derived.replace(/:num-150$/, "");
    catalogHolds(twin);
    expect((await fillDerivedSlugFromCatalog(h)).hobbyiqCardId).toBe(twin);
  });

  it("fails closed when the catalog read throws", async () => {
    const h = { id: "h", ...identity } as unknown as PortfolioHolding;
    matcher.catalogSlugIfExists.mockRejectedValue(new Error("cosmos down"));
    expect((await fillDerivedSlugFromCatalog(h)).hobbyiqCardId).toBeUndefined();
  });

  it("leaves a holding it cannot derive for untouched", async () => {
    const h = { id: "h", playerName: "Theo Gillen" } as unknown as PortfolioHolding;
    expect(await fillDerivedSlugFromCatalog(h)).toBe(h);
    expect(matcher.catalogSlugIfExists).not.toHaveBeenCalled();
  });
});

describe("addHolding — the catalog is asked first; the derivation fills only what is still absent", () => {
  it("a slug the caller pinned survives both the free-text derivation and a below-gate match", async () => {
    const { sessionId, userId } = await signIn();
    await add(sessionId, "d12a-fill-add-pinned", { hobbyiqCardId: PIN });
    const h = await stored(userId, "d12a-fill-add-pinned");
    // Mutation check: the pre-fix add ran withDerivedSlug FIRST, replacing PIN
    // with the bowman-chrome derivation before the catalog was consulted.
    expect(h.hobbyiqCardId).toBe(PIN);
    expect(h.hobbyiqCardIdSource).toBe("pinned");
    expect(h.catalogMatchSlug).toBe(FUZZY);
  });

  it("with nothing pinned and the catalog not holding the derived slug, the holding has NO slug — and its eBay purchase is withheld", async () => {
    const { sessionId, userId } = await signIn();
    catalogHolds(/* nothing */);
    await add(sessionId, "d12a-fill-add-none", {
      cardId: VENDOR_ID, purchaseSource: "ebay", purchasePrice: 650, totalCostBasis: 650, purchaseDate: "2026-08-01",
    });
    const h = await stored(userId, "d12a-fill-add-none");
    expect(h.hobbyiqCardId ?? null).toBeNull();
    expect(h.cardId).toBe(VENDOR_ID);
    await new Promise((r) => setTimeout(r, 80));
    const purchases = pool.recordSoldComp.mock.calls
      .map((c) => c[0] as unknown as Record<string, unknown>)
      .filter((w) => w.source === "ebay-user-purchase");
    expect(purchases).toEqual([]);
    expect(events(warnSpy, "user_comp_withheld_no_identity").map((e) => e.source))
      .toContain("portfolioStore.emitUserEbayPurchaseComp");
  });

  it("with nothing pinned and the catalog holding the derived slug, the derivation fills it", async () => {
    const { sessionId, userId } = await signIn();
    const derived = deriveHoldingSlug({ id: "x", ...identity } as unknown as PortfolioHolding) as string;
    catalogHolds(derived);
    await add(sessionId, "d12a-fill-add-derived");
    const h = await stored(userId, "d12a-fill-add-derived");
    expect(h.hobbyiqCardId).toBe(derived);
    expect(h.hobbyiqCardIdSource).toBe("derived");
  });

  it("a supplied hobbyiqCardId the catalog does not hold is rejected, and logged", async () => {
    const { sessionId, userId } = await signIn();
    catalogHolds(/* nothing */);
    await add(sessionId, "d12a-fill-add-rejected", { hobbyiqCardId: NOWHERE });
    const h = await stored(userId, "d12a-fill-add-rejected");
    expect(h.hobbyiqCardId ?? null).toBeNull();
    expect(events(warnSpy, "holding_slug_rejected_not_in_catalog")).toMatchObject([{ suppliedSlug: NOWHERE, keptSlug: null }]);
  });
});

describe("updateHolding — a pin is kept; a supplied slug must be a catalog row", () => {
  it("editing a note with a 0.72 match parked does not move a pinned hobbyiqCardId", async () => {
    const { sessionId, userId } = await signIn();
    await add(sessionId, "d12a-fill-upd-note", { hobbyiqCardId: PIN, cardId: PIN });
    await patch(sessionId, "d12a-fill-upd-note", { notes: "raw, sharp corners" });
    const h = await stored(userId, "d12a-fill-upd-note");
    // Mutation check: the pre-fix update recomputed hobbyiqCardId from the
    // text on every write (bowman-chrome), replacing PIN.
    expect(h.hobbyiqCardId).toBe(PIN);
    expect(h.cardId).toBe(PIN);
    expect(h.notes).toBe("raw, sharp corners");
  });

  it("a supplied hobbyiqCardId that is not a catalog row is refused; the stored one stands", async () => {
    const { sessionId, userId } = await signIn();
    await add(sessionId, "d12a-fill-upd-refused", { hobbyiqCardId: PIN });
    await patch(sessionId, "d12a-fill-upd-refused", { hobbyiqCardId: NOWHERE });
    const h = await stored(userId, "d12a-fill-upd-refused");
    // Mutation check: the pre-fix update wrote the body's hobbyiqCardId as given.
    expect(h.hobbyiqCardId).toBe(PIN);
    expect(events(warnSpy, "holding_slug_rejected_not_in_catalog")).toMatchObject([{ suppliedSlug: NOWHERE, keptSlug: PIN }]);
  });

  it("a supplied hobbyiqCardId that IS a catalog row is adopted as a pin", async () => {
    const { sessionId, userId } = await signIn();
    await add(sessionId, "d12a-fill-upd-accepted", { hobbyiqCardId: PIN });
    catalogHolds(PIN, NOWHERE);
    await patch(sessionId, "d12a-fill-upd-accepted", { hobbyiqCardId: NOWHERE });
    const h = await stored(userId, "d12a-fill-upd-accepted");
    expect(h.hobbyiqCardId).toBe(NOWHERE);
    expect(h.hobbyiqCardIdSource).toBe("pinned");
  });

  it("a supplied value that is not an hiq: slug at all is refused", async () => {
    const { sessionId, userId } = await signIn();
    await add(sessionId, "d12a-fill-upd-vendor", { hobbyiqCardId: PIN });
    await patch(sessionId, "d12a-fill-upd-vendor", { hobbyiqCardId: VENDOR_ID });
    const h = await stored(userId, "d12a-fill-upd-vendor");
    expect(h.hobbyiqCardId).toBe(PIN);
    expect(matcher.catalogSlugIfExists).not.toHaveBeenCalledWith(VENDOR_ID);
  });
});

// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3 — Max Williams
// 2025 Bowman Draft CPA-MWI Refractor auto). The card page's URL id was the
// UN-numbered slug; the catalog's only row is …:num-499. A supplied un-numbered
// slug was REJECTED as "not in catalog" and the same slug was written as cardId
// with no gate at all — a holding pinned to an id with zero pool rows. Now both
// fields resolve to the one row; two numbered twins resolve to nothing.
const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const MWI_499 = `${MWI}:num-499`;
const MWI_250 = `${MWI}:num-250`;
const williams = {
  playerName: "Max Williams",
  cardYear: 2025,
  product: "Bowman Draft",
  cardTitle: "2025 Bowman Draft Max Williams Refractor Auto",   // no "/499" in the title
  cardNumber: "CPA-MWI",
  parallel: "Refractor",
  isAuto: true,
};

describe("an un-numbered slug whose only catalog row is its numbered twin", () => {
  it("addHolding writes …:num-499 as hobbyiqCardId (pinned) and normalizes an hiq cardId to the same row", async () => {
    const { sessionId, userId } = await signIn();
    catalogHolds(MWI_499);
    await add(sessionId, "twin-add", { ...williams, hobbyiqCardId: MWI, cardId: MWI });
    const h = await stored(userId, "twin-add");
    // Mutation check: before, the supplied slug was rejected (null) and cardId written as given.
    expect(h.hobbyiqCardId).toBe(MWI_499);
    expect(h.hobbyiqCardIdSource).toBe("pinned");
    expect(h.cardId).toBe(MWI_499);
    expect(events(logSpy, "holding_slug_resolved_to_catalog_row")).toMatchObject([{ suppliedSlug: MWI, writtenSlug: MWI_499 }]);
    expect(events(logSpy, "holding_cardid_resolved_to_catalog_row")).toMatchObject([{ previousCardId: MWI, cardId: MWI_499 }]);
    expect(events(warnSpy, "holding_slug_rejected_not_in_catalog")).toEqual([]);
  });

  it("two numbered twins: the supplied slug is refused (no guess); the hiq cardId is kept as given and logged", async () => {
    const { sessionId, userId } = await signIn();
    catalogHolds(MWI_499, MWI_250);
    await add(sessionId, "twin-add-ambiguous", { ...williams, hobbyiqCardId: MWI, cardId: MWI });
    const h = await stored(userId, "twin-add-ambiguous");
    expect(h.hobbyiqCardId ?? null).toBeNull();
    expect(h.cardId).toBe(MWI);
    expect(events(warnSpy, "holding_slug_rejected_not_in_catalog")).toMatchObject([{ suppliedSlug: MWI, keptSlug: null }]);
    expect(events(warnSpy, "holding_cardid_not_a_catalog_row")).toMatchObject([{ cardId: MWI }]);
  });

  it("a vendor cardId is not an hiq slug and is untouched", async () => {
    const { sessionId, userId } = await signIn();
    catalogHolds(MWI_499);
    await add(sessionId, "twin-add-vendor", { ...williams, hobbyiqCardId: MWI, cardId: VENDOR_ID });
    const h = await stored(userId, "twin-add-vendor");
    expect(h.hobbyiqCardId).toBe(MWI_499);
    expect(h.cardId).toBe(VENDOR_ID);
    expect(events(logSpy, "holding_cardid_resolved_to_catalog_row")).toEqual([]);
    expect(events(warnSpy, "holding_cardid_not_a_catalog_row")).toEqual([]);
  });

  it("fillDerivedSlugFromCatalog adopts the twin (source derived) when the title omits /499", async () => {
    const h = { id: "h", ...williams } as unknown as PortfolioHolding;
    const derived = deriveHoldingSlug(h) as string;
    expect(derived).toBeTruthy();
    expect(derived).not.toMatch(/:num-/);
    catalogHolds(`${derived}:num-499`);
    const out = await fillDerivedSlugFromCatalog(h);
    // Mutation check: before, derived_slug_not_in_catalog and no slug.
    expect(out.hobbyiqCardId).toBe(`${derived}:num-499`);
    expect(out.hobbyiqCardIdSource).toBe("derived");
  });

  it("updateHolding: a cardId in the body is normalized to the row; a body without one leaves cardId alone", async () => {
    const { sessionId, userId } = await signIn();
    catalogHolds(PIN, MWI_499);
    await add(sessionId, "twin-upd", { hobbyiqCardId: PIN, cardId: PIN });
    await patch(sessionId, "twin-upd", { cardId: MWI });
    expect((await stored(userId, "twin-upd")).cardId).toBe(MWI_499);
    await patch(sessionId, "twin-upd", { notes: "no identity in this body" });
    const h = await stored(userId, "twin-upd");
    expect(h.cardId).toBe(MWI_499);
    expect(h.hobbyiqCardId).toBe(PIN);
    expect(h.notes).toBe("no identity in this body");
  });
});
