// D13 (2026-08-29) — alert gates prove delivery. The cost-basis digest's
// send result was discarded three times over (import .catch, send
// .catch, outer catch), `{delivered:false, devLogged:true}` never read,
// recipient a literal with no override. Pins:
//   - recipient: OPS_ALERT_EMAIL wins; fallback is a real address (never printed)
//   - delivered → cost_basis_digest_delivered with counts
//   - ACS unconfigured (devLogged) / provider failure / throw / no module →
//     cost_basis_digest_not_delivered with a reason
//   - the reprice site calls sendDivergenceDigest and no longer calls
//     sendEmail directly (structural pin — the swallow cannot return)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveDigestRecipient,
  sendDivergenceDigest,
  buildDivergenceDigestContent,
} from "../src/services/portfolioiq/divergenceDigestSend.js";

const divergence = {
  userId: "user-a",
  holdingId: "h1",
  cardTitle: "Hartman Gold Refractor Auto PSA 9",
  playerName: "Eric Hartman",
  slug: "hiq:baseball:2024:bowman-chrome:cpa-eha:gold-refractor:auto",
  costBasis: 2325,
  fmv: 339,
  gainLossPct: -0.854,
  fmvMethod: "unified-market-value",
  fmvBasisNote: null,
  fmvCompCount: 12,
  fmvRung: "exact-pool",
  observedAt: "2026-08-29T00:00:00Z",
};
const bound = {
  source: "reprice",
  playerName: "Paul Skenes",
  rate: 0.05,
  weeksSinceSale: 30,
  rawMultiplier: 4.2,
  bounded: 3.0,
  direction: "capped-ceiling" as const,
  observedAt: "2026-08-29T00:00:00Z",
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const events = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls
  .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
  .filter((x): x is Record<string, unknown> => !!x && typeof x.event === "string");

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  delete process.env.OPS_ALERT_EMAIL;
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.OPS_ALERT_EMAIL; });

describe("resolveDigestRecipient", () => {
  it("OPS_ALERT_EMAIL (trimmed) overrides the literal", () => {
    process.env.OPS_ALERT_EMAIL = "  ops@example.test  ";
    expect(resolveDigestRecipient()).toBe("ops@example.test");
  });
  it("blank OPS_ALERT_EMAIL falls back to a real address (asserted, never printed)", () => {
    process.env.OPS_ALERT_EMAIL = "   ";
    const r = resolveDigestRecipient();
    expect(r).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/i);
    expect(r).not.toBe("ops@example.test");
  });
});

describe("sendDivergenceDigest — the result is read", () => {
  it("delivered → cost_basis_digest_delivered with users + rows", async () => {
    const sendEmail = vi.fn(async () => ({ delivered: true, messageId: "m1" }));
    const r = await sendDivergenceDigest({ userId: "user-a", hits: [bound], divergenceHits: [divergence] }, { sendEmail });
    expect(r).toEqual({ delivered: true, reason: null, users: 1, rows: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const ev = events(logSpy).find((e) => e.event === "cost_basis_digest_delivered");
    expect(ev).toMatchObject({ users: 1, rows: 2, divergences: 1, boundHits: 1 });
    expect(events(warnSpy)).toHaveLength(0);
  });

  it("ACS unconfigured (devLogged) → NOT delivered, reason acs-unconfigured, warn event", async () => {
    const sendEmail = vi.fn(async () => ({ delivered: false, devLogged: true }));
    const r = await sendDivergenceDigest({ userId: "user-a", hits: [], divergenceHits: [divergence] }, { sendEmail });
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe("acs-unconfigured");
    const ev = events(warnSpy).find((e) => e.event === "cost_basis_digest_not_delivered");
    expect(ev).toMatchObject({ reason: "acs-unconfigured", users: 1, rows: 1 });
  });

  it("provider failure → reason is the provider error string", async () => {
    const sendEmail = vi.fn(async () => ({ delivered: false, error: "email-provider-failed" }));
    const r = await sendDivergenceDigest({ userId: "user-a", hits: [], divergenceHits: [divergence] }, { sendEmail });
    expect(r).toMatchObject({ delivered: false, reason: "email-provider-failed" });
    expect(events(warnSpy).find((e) => e.event === "cost_basis_digest_not_delivered")).toBeTruthy();
  });

  it("send throws → never propagates; reason send-threw", async () => {
    const sendEmail = vi.fn(async () => { throw new Error("boom"); });
    const r = await sendDivergenceDigest({ userId: "user-a", hits: [bound], divergenceHits: [] }, { sendEmail });
    expect(r).toMatchObject({ delivered: false, reason: "send-threw", rows: 1 });
    expect(events(warnSpy).find((e) => e.event === "cost_basis_digest_not_delivered")).toBeTruthy();
  });

  it("email module unavailable (null) → reason email-module-unavailable", async () => {
    const r = await sendDivergenceDigest({ userId: "user-a", hits: [], divergenceHits: [divergence] }, { sendEmail: null });
    expect(r).toMatchObject({ delivered: false, reason: "email-module-unavailable" });
  });

  it("nothing to send → no email, no event", async () => {
    const sendEmail = vi.fn(async () => ({ delivered: true }));
    const r = await sendDivergenceDigest({ userId: "user-a", hits: [], divergenceHits: [] }, { sendEmail });
    expect(r.delivered).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(events(warnSpy)).toHaveLength(0);
  });

  it("users counts distinct userIds across the drained hits", async () => {
    const sendEmail = vi.fn(async () => ({ delivered: true }));
    const r = await sendDivergenceDigest({
      userId: "user-a", hits: [],
      divergenceHits: [divergence, { ...divergence, userId: "user-b", holdingId: "h2" }],
    }, { sendEmail });
    expect(r.users).toBe(2);
    expect(r.rows).toBe(2);
  });

  it("never logs the recipient address", async () => {
    process.env.OPS_ALERT_EMAIL = "ops@example.test";
    const sendEmail = vi.fn(async () => ({ delivered: false, devLogged: true }));
    await sendDivergenceDigest({ userId: "user-a", hits: [], divergenceHits: [divergence] }, { sendEmail });
    const all = [...warnSpy.mock.calls, ...logSpy.mock.calls].map((c) => String(c[0])).join("\n");
    expect(all).not.toContain("ops@example.test");
    expect(all).not.toMatch(/@justtheboysandcards/);
  });
});

describe("digest content", () => {
  it("sorts divergences by |pct| and labels the rung", () => {
    const c = buildDivergenceDigestContent({
      userId: "user-a", hits: [],
      divergenceHits: [{ ...divergence, gainLossPct: 0.5, holdingId: "small" }, divergence],
    });
    expect(c.subject).toContain("2 pricing divergences");
    expect(c.plainText.indexOf("-85.4%")).toBeLessThan(c.plainText.indexOf("+50.0%"));
    expect(c.plainText).toContain("[exact-pool]");
  });
});

describe("structural pin — the reprice site cannot swallow the result again", () => {
  const store = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "portfolioiq", "portfolioStore.service.ts"), "utf8",
  );
  it("repriceHoldingsForUser calls sendDivergenceDigest", () => {
    expect(store).toContain("sendDivergenceDigest({ userId, hits, divergenceHits })");
  });
  it("and no longer imports emailService or calls sendEmail directly", () => {
    expect(store).not.toMatch(/import\("\.\.\/emailService\.js"\)/);
    expect(store).not.toMatch(/\bsendEmail\(/);
    expect(store).not.toMatch(/telemetry already logged/);
  });
  it("the recipient literal lives only in divergenceDigestSend.ts", () => {
    expect(store).not.toMatch(/@justtheboysandcards\.com/);
  });
});
