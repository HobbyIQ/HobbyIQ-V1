/**
 * CF-IMPORT-RESOLVES-TO-CHECKLIST (D12-b, 2026-08-29).
 *
 * The whole-app audit found the spreadsheet import had no identity at all:
 * the resolver was a removal stub answering {cardId: null} for every row, a
 * round-trip cell became the holding's identity verbatim, a null cardId
 * skipped dedup, and nothing the commit wrote was ever priced.
 *
 * These pin the contract that replaces it:
 *   (a) a plain row resolves to the checklist and commits ONE identity
 *       (cardId = hobbyiqCardId = slug)
 *   (b) a match below the identity bar is a suggestion for review, never
 *       adopted — not at preview, not at commit
 *   (c) a non-hiq round-trip cell is a hint, not an identity
 *   (d) an hiq: slug the catalog does not hold is refused — at preview AND
 *       again at commit
 *   (e) two rows of the same card collide, resolved or not
 *
 * The catalog reads are mocked (an in-memory map); the resolver, bucket,
 * collision, commit and stamping logic under test is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { canonicalizeMock, cardNumberMock, getEntryMock } = vi.hoisted(() => ({
  canonicalizeMock: vi.fn(),
  cardNumberMock: vi.fn(),
  getEntryMock: vi.fn(),
}));

vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: canonicalizeMock, resolveCardNumberByPlayer: cardNumberMock };
});
vi.mock("../src/services/portfolioiq/cardCatalog.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, getCatalogEntry: getEntryMock };
});

import { buildComponents, type CatalogMatchInput } from "../src/services/catalog/catalogMatcher.service.js";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { parseHoldingsFile } from "../src/services/portfolioiq/import/fileParser.js";
import { resolveBatch, type ImportRowEnvelope } from "../src/services/portfolioiq/import/resolveBatch.js";
import { commitImport } from "../src/services/portfolioiq/import/importService.js";
import { detectCollision } from "../src/services/portfolioiq/import/collisionDetector.js";
import { readUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const SLUG = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50";

/** The catalog, as far as these tests are concerned. */
const CATALOG = new Map<string, Record<string, unknown>>();

function catalogRow(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: slug, cardId: slug, hobbyiqCardId: slug,
    sport: "baseball", year: 2026, setKey: "bowman-chrome", cardNumber: "CPA-MG",
    parallel: "Gold Refractor", parallelSlug: "gold-refractor", isAuto: true, printRun: 50,
    playerName: "Marconi German", playerSlug: "marconi-german", vendorIds: {},
    ...overrides,
  };
}

function csv(headers: string[], rows: unknown[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map((v) => String(v ?? "")).join(","))].join("\n") + "\n";
}

async function envelopesFor(text: string, existing: Record<string, PortfolioHolding> = {}): Promise<ImportRowEnvelope[]> {
  const parsed = parseHoldingsFile(text, "csv");
  return resolveBatch(parsed.rows, { isRoundTrip: parsed.isRoundTrip, existingHoldings: existing });
}

type StoredHolding = PortfolioHolding & Record<string, unknown>;
async function storedHolding(userId: string, holdingId: string): Promise<StoredHolding> {
  return (await readUserDoc(userId)).holdings[holdingId] as StoredHolding;
}

let seq = 0;
const freshUser = () => `import-d12b-${Date.now()}-${seq++}`;

beforeEach(() => {
  vi.clearAllMocks();
  CATALOG.clear();
  CATALOG.set(SLUG, catalogRow(SLUG));
  getEntryMock.mockImplementation(async (slug: string) => CATALOG.get(slug) ?? null);
  cardNumberMock.mockResolvedValue({ cardNumber: null, candidates: [] });
  // The real matcher's exact rung, over the in-memory catalog.
  canonicalizeMock.mockImplementation(async (input: CatalogMatchInput) => {
    const slug = computeHobbyIqCardId(buildComponents(input));
    return CATALOG.has(slug)
      ? { slug, found: true, confidence: 0.98, matchedBy: "exact", catalogId: slug }
      : { slug, found: false, confidence: 0.4, matchedBy: "not-found" };
  });
});

// ─── (a) ─────────────────────────────────────────────────────────────────

describe("(a) a plain row resolves to the checklist and commits one identity", () => {
  const SHEET = csv(
    ["Player", "Year", "Brand", "Card #", "Variant", "Serial", "Auto", "Paid"],
    [["Marconi German", 2026, "Bowman Chrome", "CPA-MG", "Gold Refractor", "/50", "TRUE", 120]],
  );

  it("resolves through the internal catalog, source 'import', with the print run split out of the serial", async () => {
    const [env] = await envelopesFor(SHEET);
    expect(env!.bucket).toBe("resolved-clean");
    expect(env!.cardId).toBe(SLUG);
    expect(env!.payload.cardId).toBe(SLUG);
    expect(env!.payload.hobbyiqCardId).toBe(SLUG);
    expect(env!.resolution).toMatchObject({ found: true, confidence: 0.98, matchedBy: "exact", printRun: 50, sport: "baseball" });
    expect(env!.identityHint).toBeNull();

    expect(canonicalizeMock).toHaveBeenCalledTimes(1);
    expect(canonicalizeMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "import",
      sport: "baseball",
      year: 2026,
      setName: "Bowman Chrome",
      cardNumber: "CPA-MG",
      parallel: "Gold Refractor",
      isAuto: true,
      printRun: 50,
      player: "Marconi German",
    }));
    // Not a round-trip row: no point read at preview.
    expect(getEntryMock).not.toHaveBeenCalled();
  });

  it("a row with no card number asks the catalog by player — the same lookup the eBay import uses", async () => {
    cardNumberMock.mockResolvedValue({ cardNumber: "CPA-MG", candidates: ["CPA-MG"] });
    const [env] = await envelopesFor(csv(
      ["Player", "Year", "Brand", "Variant", "Serial", "Auto"],
      [["Marconi German", 2026, "Bowman Chrome", "Gold Refractor", "/50", "TRUE"]],
    ));
    expect(cardNumberMock).toHaveBeenCalledWith(expect.objectContaining({ year: 2026, setKey: "Bowman Chrome", player: "Marconi German", isAuto: true }));
    expect(env!.bucket).toBe("resolved-clean");
    expect(env!.cardId).toBe(SLUG);
  });

  it("several card numbers for the player → ambiguous, never a guess", async () => {
    cardNumberMock.mockResolvedValue({ cardNumber: null, candidates: ["CPA-MG", "BCP-12"] });
    const [env] = await envelopesFor(csv(["Player", "Year", "Brand"], [["Marconi German", 2026, "Bowman Chrome"]]));
    expect(env!.bucket).toBe("ambiguous");
    expect(env!.cardId).toBeNull();
    expect(env!.message).toContain("CPA-MG, BCP-12");
    expect(canonicalizeMock).not.toHaveBeenCalled();
  });

  it("commit writes cardId = hobbyiqCardId = slug and stamps the resolution", async () => {
    const userId = freshUser();
    const envelopes = await envelopesFor(SHEET);

    const result = await commitImport(userId, { idempotencyToken: `a-${userId}`, envelopes }, "investor");
    expect(result.totals).toMatchObject({ added: 1, failed: 0 });
    const hid = result.outcomes[0]!.holdingId!;
    expect(result.outcomes[0]!.hobbyiqCardId).toBe(SLUG);
    // The persist site checked the slug against the catalog again.
    expect(getEntryMock).toHaveBeenCalledWith(SLUG);

    const holding = await storedHolding(userId, hid);
    expect(holding.cardId).toBe(SLUG);
    expect(holding.hobbyiqCardId).toBe(SLUG);
    expect(holding.catalogVerifiedSlug).toBe(SLUG);
    expect(holding.printRun).toBe(50);
    expect(holding.catalogMatchConfidence).toBe(0.98);
    expect(holding.catalogMatchedBy).toBe("exact");
    expect(holding.catalogVerifiedSource).toBe("hobbyiq-catalog");
    expect(holding.identityVerified).toBe(true);
    expect(holding.identityVerifiedBy).toMatchObject({ source: "spreadsheet-import", candidateId: SLUG });
    expect(holding.needsReview).toBe(false);
    expect(holding.purchasePrice).toBe(120);
    expect(holding.sport).toBeUndefined();
  });

  it("a row committed WITHOUT an identity is flagged for review with the reason on it", async () => {
    const userId = freshUser();
    const [env] = await envelopesFor(csv(
      ["Player", "Year", "Brand", "Card #"],
      [["Nobody Special", 2026, "Bowman Chrome", "CPA-NS"]],
    ));
    expect(env!.bucket).toBe("unresolved");
    const result = await commitImport(
      userId,
      { idempotencyToken: `a4-${userId}`, envelopes: [env!], actions: { [env!.rowNumber]: "commit" } },
      "investor",
    );
    expect(result.totals.added).toBe(1);
    expect(result.outcomes[0]!.hobbyiqCardId).toBeNull();
    const holding = await storedHolding(userId, result.outcomes[0]!.holdingId!);
    expect(holding.cardId).toBeNull();
    expect(holding.hobbyiqCardId).toBeNull();
    expect(holding.catalogMatchedBy).toBe("not-found");
    expect(holding.catalogMatchSlug).toBeNull();
    expect(holding.needsReview).toBe(true);
    expect(holding.reviewReason).toContain("could not identify this card");
  });
});

// ─── (b) ─────────────────────────────────────────────────────────────────

describe("(b) a match below the identity bar is a suggestion for review, never an identity", () => {
  const BLUE = "hiq:baseball:2026:bowman-chrome:cpa-mg:blue-refractor:auto:num-150";
  const SHEET = csv(
    ["Player", "Year", "Brand", "Card #", "Variant", "Auto"],
    [["Marconi German", 2026, "Bowman Chrome", "CPA-MG", "Blue", "TRUE"]],
  );

  beforeEach(() => {
    CATALOG.set(BLUE, catalogRow(BLUE, { parallel: "Blue Refractor", parallelSlug: "blue-refractor", printRun: 150 }));
    canonicalizeMock.mockResolvedValue({ slug: BLUE, found: true, confidence: 0.72, matchedBy: "fuzzy-parallel", catalogId: BLUE });
  });

  it("stays `unresolved` with the suggestion carried on the envelope, cardId null, default action skip", async () => {
    const userId = freshUser();
    const [env] = await envelopesFor(SHEET);
    expect(env!.bucket).toBe("unresolved");
    expect(env!.cardId).toBeNull();
    expect(env!.payload.cardId).toBeNull();
    expect(env!.resolution).toMatchObject({ slug: BLUE, found: true, confidence: 0.72, matchedBy: "fuzzy-parallel" });
    expect(env!.message).toContain(BLUE);
    expect(env!.message).toContain("72%");
    expect(env!.message).toContain("not adopted");

    const skipped = await commitImport(userId, { idempotencyToken: `b1-${userId}`, envelopes: [env!] }, "investor");
    expect(skipped.totals).toMatchObject({ added: 0, skipped: 1 });
  });

  it("committed anyway: added WITHOUT identity, the suggestion parked on catalogMatchSlug for the in-app confirm", async () => {
    const userId = freshUser();
    const [env] = await envelopesFor(SHEET);
    const result = await commitImport(
      userId,
      { idempotencyToken: `b2-${userId}`, envelopes: [env!], actions: { [env!.rowNumber]: "commit" } },
      "investor",
    );
    expect(result.totals.added).toBe(1);
    expect(result.outcomes[0]!.hobbyiqCardId).toBeNull();
    const holding = await storedHolding(userId, result.outcomes[0]!.holdingId!);
    expect(holding.cardId).toBeNull();
    expect(holding.hobbyiqCardId).toBeNull();
    expect(holding.identityVerified).toBeUndefined();
    // The wire's proposedIdentity reads exactly these.
    expect(holding.catalogMatchSlug).toBe(BLUE);
    expect(holding.catalogMatchConfidence).toBe(0.72);
    expect(holding.catalogMatchedBy).toBe("fuzzy-parallel");
    expect(holding.needsReview).toBe(true);
    expect(holding.reviewReason).toContain(BLUE);
    expect(holding.reviewReason).toContain("72%");
  });

  it("exactly at the bar resolves; a hair under does not", async () => {
    canonicalizeMock.mockResolvedValue({ slug: BLUE, found: true, confidence: 0.9, matchedBy: "long-form", catalogId: BLUE });
    expect((await envelopesFor(SHEET))[0]!.bucket).toBe("resolved-clean");
    canonicalizeMock.mockResolvedValue({ slug: BLUE, found: true, confidence: 0.89, matchedBy: "long-form", catalogId: BLUE });
    expect((await envelopesFor(SHEET))[0]!.bucket).toBe("unresolved");
  });

  it("a match that cleared the bar but was not exact is pinned, not marked verified", async () => {
    canonicalizeMock.mockResolvedValue({ slug: BLUE, found: true, confidence: 0.9, matchedBy: "long-form", catalogId: BLUE });
    const userId = freshUser();
    const envelopes = await envelopesFor(SHEET);
    const result = await commitImport(userId, { idempotencyToken: `b4-${userId}`, envelopes }, "investor");
    const holding = await storedHolding(userId, result.outcomes[0]!.holdingId!);
    expect(holding.cardId).toBe(BLUE);
    expect(holding.hobbyiqCardId).toBe(BLUE);
    expect(holding.printRun).toBe(150);
    expect(holding.identityVerified).toBeUndefined();
  });
});

// ─── (c) ─────────────────────────────────────────────────────────────────

describe("(c) a non-hiq round-trip cell is a hint, not an identity", () => {
  it("the vendor id in the cardId cell is carried as identityHint; the row resolves from its fields", async () => {
    const envelopes = await envelopesFor(csv(
      ["holdingId", "cardId", "playerName", "cardYear", "product", "cardNumber", "parallel", "isAuto"],
      [["", "abc12345", "Marconi German", 2026, "Bowman Chrome", "CPA-MG", "Gold Refractor /50", "TRUE"]],
    ));
    const env = envelopes[0]!;
    expect(env.lane).toBe("new");
    expect(env.bucket).toBe("resolved-clean");
    expect(env.cardId).toBe(SLUG);
    expect(env.payload.cardId).toBe(SLUG);
    expect(env.identityHint).toBe("abc12345");
    // A vendor id is never looked up as a slug, and never passed to the resolver as one.
    expect(getEntryMock).not.toHaveBeenCalled();
    expect(canonicalizeMock).toHaveBeenCalledWith(expect.objectContaining({ cardNumber: "CPA-MG", printRun: 50, parallel: "Gold Refractor" }));
  });

  it("commit refuses an envelope whose cardId is not a canonical hiq: slug", async () => {
    const userId = freshUser();
    const forged: ImportRowEnvelope = {
      rowNumber: 2, lane: "new", bucket: "resolved-clean", cardId: "abc12345",
      payload: { cardId: "abc12345", playerName: "Marconi German", cardYear: 2026, product: "Bowman Chrome" },
      parseFlags: [], message: "stale client envelope",
    };
    const result = await commitImport(userId, { idempotencyToken: `c-${userId}`, envelopes: [forged] }, "investor");
    expect(result.totals).toMatchObject({ added: 0, failed: 1 });
    expect(result.outcomes[0]!.reason).toContain("not a canonical hiq: slug");
    expect(Object.keys((await readUserDoc(userId)).holdings)).toHaveLength(0);
  });
});

// ─── (d) ─────────────────────────────────────────────────────────────────

describe("(d) a round-trip hiq: slug the catalog does not hold is refused as identity", () => {
  const GHOST = "hiq:baseball:2026:bowman-chrome:cpa-zz:gold-refractor:auto:num-50";

  it("point-reads the slug, finds nothing, and does not adopt it", async () => {
    const [env] = await envelopesFor(csv(
      ["cardId", "playerName", "cardYear", "product", "cardNumber", "parallel"],
      [[GHOST, "Nobody Special", 2026, "Bowman Chrome", "CPA-ZZ", "Gold Refractor /50"]],
    ));
    expect(getEntryMock).toHaveBeenCalledWith(GHOST);
    expect(env!.bucket).toBe("unresolved");
    expect(env!.cardId).toBeNull();
    expect(env!.payload.cardId).toBeNull();
    expect(env!.identityHint).toBe(GHOST);
    expect(env!.resolution?.rejectedRoundTrip).toBe(GHOST);
    expect(env!.message).toContain("names no catalog row");
  });

  it("the row's own fields decide when they resolve — the catalog's slug wins over the cell's", async () => {
    const [env] = await envelopesFor(csv(
      ["cardId", "playerName", "cardYear", "product", "cardNumber", "parallel", "isAuto"],
      [[GHOST, "Marconi German", 2026, "Bowman Chrome", "CPA-MG", "Gold Refractor /50", "TRUE"]],
    ));
    expect(env!.bucket).toBe("resolved-clean");
    expect(env!.cardId).toBe(SLUG);
    expect(env!.resolution?.rejectedRoundTrip).toBe(GHOST);
  });

  it("an hiq: slug the catalog holds is the identity — matchedBy round-trip, no field resolution", async () => {
    const [env] = await envelopesFor(csv(
      ["cardId", "playerName", "cardYear", "product"],
      [[SLUG, "Marconi German", 2026, "Bowman Chrome"]],
    ));
    expect(env!.bucket).toBe("resolved-clean");
    expect(env!.cardId).toBe(SLUG);
    expect(env!.identityHint).toBeNull();
    expect(env!.resolution).toMatchObject({ matchedBy: "round-trip", confidence: 1, printRun: 50 });
    expect(canonicalizeMock).not.toHaveBeenCalled();
  });

  it("a slug the catalog held at preview but not at commit is refused at commit — the persist site checks again", async () => {
    const userId = freshUser();
    const envelopes = await envelopesFor(csv(["cardId", "playerName", "cardYear", "product"], [[SLUG, "Marconi German", 2026, "Bowman Chrome"]]));
    expect(envelopes[0]!.cardId).toBe(SLUG);
    CATALOG.delete(SLUG); // retired between preview and commit
    const result = await commitImport(userId, { idempotencyToken: `d4-${userId}`, envelopes }, "investor");
    expect(result.totals).toMatchObject({ added: 0, failed: 1 });
    expect(result.outcomes[0]!.reason).toContain("names no catalog row");
    expect(Object.keys((await readUserDoc(userId)).holdings)).toHaveLength(0);
  });
});

// ─── (e) ─────────────────────────────────────────────────────────────────

describe("(e) two rows of the same card collide, resolved or not", () => {
  const ROW = ["Nobody Special", 2026, "Bowman Chrome", "CPA-NS", "Base"];

  it("within one sheet: the second unresolved row is a duplicate of the first", async () => {
    const envelopes = await envelopesFor(csv(["Player", "Year", "Brand", "Card #", "Variant"], [ROW, ROW]));
    expect(envelopes.map((e) => e.bucket)).toEqual(["unresolved", "unresolved"]);
    expect(envelopes[0]!.collision).toBeUndefined();
    expect(envelopes[1]!.collision).toMatchObject({ collides: true, duplicateOfRowNumbers: [2], defaultAction: "skip", keyedBy: "title" });
    expect(envelopes[1]!.message).toContain("Duplicate of row 2");
  });

  it("against the portfolio: an identical unresolved holding collides on the title tuple", async () => {
    const existing = {
      "h-existing": {
        id: "h-existing", cardId: null, playerName: "Nobody Special", cardYear: 2026,
        product: "Bowman Chrome", cardNumber: "CPA-NS", parallel: "Base",
      } as unknown as PortfolioHolding,
    };
    const [env] = await envelopesFor(csv(["Player", "Year", "Brand", "Card #", "Variant"], [ROW]), existing);
    expect(env!.bucket).toBe("unresolved");
    expect(env!.collision).toMatchObject({ collides: true, existingHoldingIds: ["h-existing"], keyedBy: "title" });
  });

  it("detectCollision never null-skips: no slug + a different title is simply no match", () => {
    const r = detectCollision(
      { cardId: null, holdingId: null, parallel: "Base", gradeCompany: null, gradeValue: null, serialNumber: null,
        playerName: "Someone Else", cardYear: 2026, product: "Bowman Chrome", cardNumber: "CPA-SE" },
      { "h1": { id: "h1", cardId: null, playerName: "Nobody Special", cardYear: 2026, product: "Bowman Chrome", cardNumber: "CPA-NS", parallel: "Base" } as unknown as PortfolioHolding },
    );
    expect(r.collides).toBe(false);
    expect(r.reason).not.toContain("no collision check possible");
  });

  it("two identical RESOLVED rows in one sheet: the second becomes resolved-collision on the slug key", async () => {
    const row = ["Marconi German", 2026, "Bowman Chrome", "CPA-MG", "Gold Refractor", "/50", "TRUE"];
    const envelopes = await envelopesFor(csv(["Player", "Year", "Brand", "Card #", "Variant", "Serial", "Auto"], [row, row]));
    expect(envelopes.map((e) => e.bucket)).toEqual(["resolved-clean", "resolved-collision"]);
    expect(envelopes[1]!.collision).toMatchObject({ duplicateOfRowNumbers: [2], keyedBy: "slug" });
  });

  it("a resolved row collides with a legacy holding that carries the slug on hobbyiqCardId under a vendor cardId", async () => {
    const existing = {
      "legacy": { id: "legacy", cardId: "1675907831540x1", hobbyiqCardId: SLUG, parallel: "Gold Refractor", serialNumber: "/50" } as unknown as PortfolioHolding,
    };
    const [env] = await envelopesFor(csv(
      ["Player", "Year", "Brand", "Card #", "Variant", "Serial", "Auto"],
      [["Marconi German", 2026, "Bowman Chrome", "CPA-MG", "Gold Refractor", "/50", "TRUE"]],
    ), existing);
    expect(env!.bucket).toBe("resolved-collision");
    expect(env!.collision).toMatchObject({ existingHoldingIds: ["legacy"], keyedBy: "slug", defaultAction: "skip" });
  });
});
