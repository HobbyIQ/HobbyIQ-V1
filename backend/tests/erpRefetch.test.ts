// CF-PR-E-REFETCH-FANOUT (2026-06-17): top-level POST /api/portfolio/erp/refetch.
//
// iOS posts to /erp/refetch from a single "Refetch Finances" button — no
// per-entry id. Backend previously only had POST /erp/unreconciled/:id/refetch
// → wire-path mismatch → 404 on every iOS refetch press. This file covers the
// new fan-out:
//   1. No unreconciled entries → 200 with updated=0 and a no-op message.
//   2. N unreconciled entries → each one's refetchRequestedAt set to a fresh
//      timestamp; reconciled entries left untouched.
//   3. Mix of reconciled + unreconciled → only unreconciled get annotated.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getUserBySession: vi.fn(async () => currentUser) };
});

import {
  readUserDoc as realReadUserDoc,
  writeUserDoc as realWriteUserDoc,
} from "../src/services/portfolioiq/portfolioStore.service.js";

async function seedUserDoc(userId: string, mutate: (doc: any) => void): Promise<void> {
  const doc = await realReadUserDoc(userId);
  mutate(doc);
  await realWriteUserDoc(userId, doc as any);
}

function makeUser(plan: string) {
  return { userId: `u-${plan}`, email: `${plan}@t`, plan, createdAt: "2026-01-01T00:00:00Z" };
}

let app: any;
beforeAll(async () => { app = (await import("../src/app")).default; });

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = null;
  await seedUserDoc("u-pro_seller", (doc) => {
    doc.holdings = {};
    doc.ledger = [];
    doc.trades = undefined;
  });
});

// Helper: a minimal eBay ledger entry shape that's either unreconciled
// (fees null) or reconciled (fees populated + needsReconciliation=false).
function ebayEntry(opts: { id: string; reconciled?: boolean }): any {
  const reconciled = opts.reconciled === true;
  return {
    id: opts.id,
    userId: "u-pro_seller",
    holdingId: `h-${opts.id}`,
    playerName: "Player",
    cardTitle: "Card",
    quantitySold: 1,
    unitSalePrice: 100,
    grossProceeds: 100,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: reconciled ? 87 : 0,
    costBasisSold: 40,
    realizedProfitLoss: reconciled ? 47 : 0,
    realizedProfitLossPct: reconciled ? 117.5 : 0,
    soldAt: "2026-05-15T00:00:00Z",
    source: "ebay",
    paymentMethod: "ebay_managed",
    finalValueFee: reconciled ? 10 : null,
    paymentProcessingFee: reconciled ? 3 : null,
    promotedListingFee: reconciled ? 0 : null,
    adFee: reconciled ? 0 : null,
    otherFees: reconciled ? 0 : null,
    netPayout: reconciled ? 87 : null,
    actualShippingCost: reconciled ? 0 : null,
    feeSource: reconciled ? "ebay_finances" : undefined,
    needsReconciliation: !reconciled,
    userCostsProvidedAt: reconciled ? "2026-05-16T00:00:00Z" : undefined,
    reconciledVia: reconciled ? "ebay_finances" : undefined,
  };
}

describe("POST /api/portfolio/erp/refetch (CF-PR-E-REFETCH-FANOUT)", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("no unreconciled entries → 200 with updated=0 and a no-op message", async () => {
    // Empty ledger (default state).
    const r = await request(app)
      .post("/api/portfolio/erp/refetch")
      .set("x-session-id", "s")
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.updated).toBe(0);
    expect(r.body.message).toMatch(/no unreconciled/i);
  });

  it("N unreconciled entries → each one's refetchRequestedAt set; updated=N; message names the count", async () => {
    const beforeMs = Date.now();
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push(ebayEntry({ id: "L-a" }));
      doc.ledger.push(ebayEntry({ id: "L-b" }));
      doc.ledger.push(ebayEntry({ id: "L-c" }));
    });
    const r = await request(app)
      .post("/api/portfolio/erp/refetch")
      .set("x-session-id", "s")
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.updated).toBe(3);
    expect(r.body.message).toMatch(/3 entries/);

    // Persisted state — every unreconciled entry got a fresh refetchRequestedAt.
    const doc = await realReadUserDoc("u-pro_seller");
    for (const id of ["L-a", "L-b", "L-c"]) {
      const e = doc.ledger.find((x: any) => x.id === id)!;
      expect(e.refetchRequestedAt).toBeTruthy();
      const t = new Date(e.refetchRequestedAt!).getTime();
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(beforeMs);
    }
  });

  it("mix of reconciled + unreconciled → only unreconciled annotated; reconciled rows untouched", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push(ebayEntry({ id: "L-unrec-1" }));
      doc.ledger.push(ebayEntry({ id: "L-rec-1", reconciled: true }));
      doc.ledger.push(ebayEntry({ id: "L-unrec-2" }));
      doc.ledger.push(ebayEntry({ id: "L-rec-2", reconciled: true }));
    });
    const r = await request(app)
      .post("/api/portfolio/erp/refetch")
      .set("x-session-id", "s")
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(2);

    const doc = await realReadUserDoc("u-pro_seller");
    const byId: Record<string, any> = {};
    for (const e of doc.ledger) byId[e.id] = e;

    // Unreconciled rows: refetchRequestedAt populated.
    expect(byId["L-unrec-1"].refetchRequestedAt).toBeTruthy();
    expect(byId["L-unrec-2"].refetchRequestedAt).toBeTruthy();
    // Reconciled rows: refetchRequestedAt left untouched (still undefined).
    expect(byId["L-rec-1"].refetchRequestedAt).toBeUndefined();
    expect(byId["L-rec-2"].refetchRequestedAt).toBeUndefined();
    // And reconciled-ness preserved.
    expect(byId["L-rec-1"].needsReconciliation).toBe(false);
    expect(byId["L-rec-2"].needsReconciliation).toBe(false);
    expect(byId["L-unrec-1"].needsReconciliation).toBe(true);
    expect(byId["L-unrec-2"].needsReconciliation).toBe(true);
  });
});
