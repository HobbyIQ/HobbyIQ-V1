// CF-REFERRAL-LOOP (Drew, 2026-07-26). Pins the free-month referral
// service — code generation, redemption gates, activation cron.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  getOrCreateReferralCode,
  findCodeOwner,
  redeemReferralCode,
  getReferrerStats,
  recordRefereeSubscribed,
  grantMaturedReferralCredits,
  _setContainersForTests,
} from "../src/services/subscriptions/referralCode.service.js";

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async create(doc: any) {
        const pk = doc.referrerUserId ?? doc.code;
        const key = `${pk}::${doc.id}`;
        if (store.has(key)) {
          const err: any = new Error("conflict");
          err.code = 409; err.statusCode = 409;
          throw err;
        }
        store.set(key, doc);
        return { resource: doc };
      },
      async upsert(doc: any) {
        const pk = doc.referrerUserId ?? doc.code;
        store.set(`${pk}::${doc.id}`, doc);
        return { resource: doc };
      },
      query(spec: { query: string; parameters?: Array<{ name: string; value: any }> }) {
        const params = new Map<string, any>();
        for (const p of spec.parameters ?? []) params.set(p.name, p.value);
        return {
          async fetchAll() {
            const q = spec.query.toLowerCase();
            let rows = Array.from(store.values());
            if (q.includes("c.userid = @u")) {
              rows = rows.filter((r) => r.userId === params.get("@u"));
            } else if (q.includes("c.refereeuserid = @r") && q.includes("c.status = 'pending'")) {
              rows = rows.filter((r) => r.refereeUserId === params.get("@r") && r.status === "pending");
            } else if (q.includes("c.refereeuserid = @r")) {
              rows = rows.filter((r) => r.refereeUserId === params.get("@r"));
            } else if (q.includes("c.referreruserid = @u")) {
              rows = rows.filter((r) => r.referrerUserId === params.get("@u"));
            } else if (q.includes("c.status = 'pending'") && q.includes("cutoff")) {
              const cutoff = params.get("@cutoff");
              rows = rows.filter((r) =>
                r.status === "pending" &&
                r.refereeSubscribedAt !== null &&
                r.refereeSubscribedAt <= cutoff
              );
            }
            return { resources: rows };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const key = `${pk}::${id}`;
          if (!store.has(key)) {
            const err: any = new Error("not found");
            err.code = 404; err.statusCode = 404;
            throw err;
          }
          return { resource: store.get(key) as T };
        },
      };
    },
  } as unknown as Container;
  return { container, store };
}

let refs: Map<string, any>;
let codes: Map<string, any>;
beforeEach(() => {
  const r = fakeContainer();
  const c = fakeContainer();
  refs = r.store;
  codes = c.store;
  _setContainersForTests(r.container, c.container);
});
afterEach(() => {
  _setContainersForTests(null, null);
});

describe("getOrCreateReferralCode", () => {
  it("creates a fresh code on first call for a user", async () => {
    const code = await getOrCreateReferralCode("user-1");
    expect(code).not.toBeNull();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(codes.size).toBe(1);
  });

  it("is idempotent — same user gets same code back on repeat calls", async () => {
    const a = await getOrCreateReferralCode("user-1");
    const b = await getOrCreateReferralCode("user-1");
    expect(a).toBe(b);
    expect(codes.size).toBe(1);
  });

  it("different users get different codes", async () => {
    const a = await getOrCreateReferralCode("user-1");
    const b = await getOrCreateReferralCode("user-2");
    expect(a).not.toBe(b);
  });

  it("returns null on missing userId", async () => {
    expect(await getOrCreateReferralCode("")).toBeNull();
  });
});

describe("findCodeOwner", () => {
  it("returns owner userId on point-read hit", async () => {
    await getOrCreateReferralCode("user-42");
    const [code] = Array.from(codes.values()).map((c) => c.code);
    expect(await findCodeOwner(code)).toBe("user-42");
  });

  it("returns null on unknown code (404)", async () => {
    expect(await findCodeOwner("NOTREAL1")).toBeNull();
  });
});

describe("redeemReferralCode", () => {
  it("successfully redeems a valid code from a different user", async () => {
    await getOrCreateReferralCode("referrer-1");
    const [code] = Array.from(codes.values()).map((c) => c.code);
    const r = await redeemReferralCode({ code, refereeUserId: "referee-1" });
    expect(r.status).toBe("redeemed");
    expect(r.referrerUserId).toBe("referrer-1");
    expect(refs.size).toBe(1);
  });

  it("rejects self-redemption", async () => {
    await getOrCreateReferralCode("user-1");
    const [code] = Array.from(codes.values()).map((c) => c.code);
    const r = await redeemReferralCode({ code, refereeUserId: "user-1" });
    expect(r.status).toBe("self-redemption");
    expect(refs.size).toBe(0);
  });

  it("rejects unknown code", async () => {
    const r = await redeemReferralCode({ code: "NOTREAL1", refereeUserId: "referee-1" });
    expect(r.status).toBe("code-not-found");
  });

  it("rejects duplicate redemption from same referee", async () => {
    await getOrCreateReferralCode("referrer-1");
    const [code1] = Array.from(codes.values()).map((c) => c.code);
    await redeemReferralCode({ code: code1, refereeUserId: "referee-1" });
    await getOrCreateReferralCode("referrer-2");
    const codes2 = Array.from(codes.values()).map((c) => c.code);
    const code2 = codes2.find((c) => c !== code1)!;
    const r = await redeemReferralCode({ code: code2, refereeUserId: "referee-1" });
    expect(r.status).toBe("already-redeemed");
  });
});

describe("getReferrerStats", () => {
  it("returns zero counts for new referrer", async () => {
    const stats = await getReferrerStats("user-1");
    expect(stats.totalReferrals).toBe(0);
    expect(stats.pendingReferrals).toBe(0);
    expect(stats.grantedCredits).toBe(0);
    expect(stats.code).not.toBeNull();
  });

  it("counts pending referrals separately from granted", async () => {
    await getOrCreateReferralCode("referrer-1");
    const [code] = Array.from(codes.values()).map((c) => c.code);
    await redeemReferralCode({ code, refereeUserId: "referee-1" });
    const stats = await getReferrerStats("referrer-1");
    expect(stats.totalReferrals).toBe(1);
    expect(stats.pendingReferrals).toBe(1);
    expect(stats.grantedCredits).toBe(0);
  });
});

describe("recordRefereeSubscribed + grantMaturedReferralCredits", () => {
  it("marks referee subscribed then grants after 30-day maturity", async () => {
    await getOrCreateReferralCode("referrer-1");
    const [code] = Array.from(codes.values()).map((c) => c.code);
    await redeemReferralCode({ code, refereeUserId: "referee-1" });

    // Mark subscribed (simulates webhook)
    const marked = await recordRefereeSubscribed("referee-1");
    expect(marked).toBe(true);
    const doc = Array.from(refs.values())[0];
    expect(doc.refereeSubscribedAt).not.toBeNull();
    expect(doc.status).toBe("pending");

    // Time hasn't matured — grant should not fire
    const first = await grantMaturedReferralCredits();
    expect(first.granted).toBe(0);

    // Manually age the doc past 30 days
    doc.refereeSubscribedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    refs.set(Array.from(refs.keys())[0], doc);

    const second = await grantMaturedReferralCredits();
    expect(second.granted).toBe(1);
    const doc2 = Array.from(refs.values())[0];
    expect(doc2.status).toBe("granted");
    expect(doc2.refereeActivatedAt).not.toBeNull();
    expect(doc2.creditGrantedAt).not.toBeNull();
  });
});
