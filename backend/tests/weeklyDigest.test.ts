// CF-WEEKLY-DIGEST (Drew, 2026-09-02) — the three pins.
//
//   1. FIXTURE RENDERS ALL SECTIONS. One user doc exercising movers,
//      signals, audit badges and market context produces a digest with
//      all four sections, and the rendered text + HTML carry every one.
//      Plus the doctrine pins that ride along: every number carries its
//      basis, and a speculative value is LABELED at the number.
//
//   2. MISSING-SECTION TOLERANCE. No signals → no signals section, and
//      NOTHING left behind in either renderer: no heading, no "none this
//      week", no empty list. Same for audit and market. And the
//      distinction the brief asked for: signals `null` (surface absent,
//      feature-detected) vs `[]` (surface present, quiet week) both omit
//      the section, but only the first says so in the footnotes.
//
//   3. IDEMPOTENT WEEKLY RUN. Re-running the same week produces the same
//      digest and no duplicate: the store's doc id is derived from
//      (userId, weekId), the second run upserts that same id, and a week
//      already delivered is not re-sent.

import { describe, it, expect, vi } from "vitest";
import {
  buildWeeklyDigest,
  isoWeekBounds,
  isoWeekId,
  portfolioSports,
  resolveHoldingValue,
  type DigestSignalCandidate,
  type DigestSportIndex,
  type WeeklyDigestInput,
} from "../src/services/portfolioiq/weeklyDigestBuild.service.js";
import {
  renderWeeklyDigestEmail,
  renderWeeklyDigestHtml,
  renderWeeklyDigestText,
} from "../src/services/portfolioiq/weeklyDigestRender.service.js";
import { weeklyDigestDocId } from "../src/services/portfolioiq/weeklyDigestStore.service.js";

const NOW = new Date("2026-09-06T12:00:00.000Z");   // a Sunday
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

function holding(over: Record<string, unknown>): any {
  return {
    id: "h-default",
    playerName: "Player",
    cardTitle: "A Card",
    quantity: 1,
    hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:bcp-1:base:noauto",
    ...over,
  };
}

/** The all-sections fixture. Deliberately mixed: an observed riser with a
 *  cost basis, an estimated (speculative) decliner, and an audit-flagged
 *  card — so one render exercises every label path. */
function fullFixture(): WeeklyDigestInput {
  const holdings = [
    holding({
      id: "h-riser",
      playerName: "Paul Skenes",
      cardTitle: "2023 Bowman Chrome Gold Refractor Auto PSA 10",
      fairMarketValue: 1180,
      purchasePrice: 900,
      hobbyiqCardId: "hiq:baseball:2023:bowman-chrome:cpa-ps:gold-refractor:auto",
    }),
    holding({
      id: "h-faller",
      playerName: "Wyatt Langford",
      cardTitle: "2024 Topps Chrome Refractor",
      // No fairMarketValue → estimatedValue is the number → SPECULATIVE.
      estimatedValue: 62,
      purchasePrice: 80,
      hobbyiqCardId: "hiq:baseball:2024:topps-chrome:150:refractor:noauto",
    }),
    holding({
      id: "h-flagged",
      playerName: "Eric Hartman",
      cardTitle: "2024 Bowman Chrome Red Ink Auto",
      fairMarketValue: 340,
      purchasePrice: 2325,
      auditFlag: {
        reason: "BASIS-IDENTITY: cross-product",
        at: ago(1),
        invariant: "BASIS-IDENTITY",
      },
      hobbyiqCardId: "hiq:basketball:2024:bowman-chrome:cpa-eha:red-ink:auto",
    }),
  ];

  const signals: DigestSignalCandidate[] = [
    {
      holdingId: "h-riser",
      player: "Paul Skenes",
      cardTitle: "2023 Bowman Chrome Gold Refractor Auto PSA 10",
      graderTier: "PSA 10",
      currentMarketValue: 1180,
      purchasePrice: 900,
      unrealizedGainUsd: 280,
      velocityPerWeek: 6,
      velocityBaseline: 2,
      velocityMultiple: 3,
      playerMomentum: 1.22,
      playerDirection: "up",
      reason: "velocity 3.0x, momentum +22%",
      urgencyScore: 7.4,
    },
    {
      holdingId: "h-faller",
      player: "Wyatt Langford",
      cardTitle: "2024 Topps Chrome Refractor",
      currentMarketValue: 62,
      purchasePrice: 80,
      unrealizedGainUsd: -18,
      velocityPerWeek: 3,
      velocityBaseline: 1.4,
      velocityMultiple: 2.14,
      playerMomentum: 1.12,
      playerDirection: "up",
      reason: "velocity 2.1x, momentum +12%",
      urgencyScore: 2.4,
    },
  ];

  const sportIndexes: DigestSportIndex[] = [
    { sport: "baseball", latestLevel: 112.4, weekAgoLevel: 108.0, changePct: 4.1, basketSize: 100, asOf: "2026-09-05" },
    { sport: "basketball", latestLevel: 96.2, weekAgoLevel: 99.1, changePct: -2.9, basketSize: 100, asOf: "2026-09-05" },
    { sport: "hockey", latestLevel: 103.0, weekAgoLevel: 102.5, changePct: 0.5, basketSize: 90, asOf: "2026-09-05" },
  ];

  return {
    userId: "user-a",
    ...isoWeekBounds(NOW),
    holdings,
    // CF-A-MOVER-NEEDS-CORROBORATION (2026-09-03): a MOVER is a move
    // bracketed by exact-pool reads at BOTH ends. The fixture's trails are
    // stamped accordingly, so this fixture still exercises the movers path;
    // the uncorroborated shapes get their own pins below.
    priceHistoryByHolding: {
      "h-riser": [
        { at: ago(9), value: 940, rungLabel: "exact-pool-projection" },
        { at: ago(6), value: 1010, rungLabel: "exact-pool-projection" },
        { at: ago(2), value: 1180, rungLabel: "exact-pool-projection" },
      ],
      "h-faller": [
        { at: ago(6), value: 78, rungLabel: "exact-pool-last-sale" },
        { at: ago(1), value: 62, rungLabel: "exact-pool-last-sale" },
      ],
      "h-flagged": [
        { at: ago(6), value: 300, rungLabel: "exact-pool-leading-edge" },
        { at: ago(1), value: 340, rungLabel: "exact-pool-leading-edge" },
      ],
    },
    signals,
    sportIndexes,
    now: NOW,
  };
}

// ── PIN 1 ───────────────────────────────────────────────────────────

describe("PIN 1 — the fixture renders all sections", () => {
  const digest = buildWeeklyDigest(fullFixture());

  it("names every section, in render order", () => {
    expect(digest.sections).toEqual(["movers", "signals", "audit", "market"]);
    expect(digest.movers).toBeDefined();
    expect(digest.signals).toBeDefined();
    expect(digest.audit).toBeDefined();
    expect(digest.market).toBeDefined();
  });

  it("puts real rows in each section", () => {
    expect(digest.movers!.gainers.length).toBeGreaterThan(0);
    expect(digest.movers!.decliners.length).toBeGreaterThan(0);
    expect(digest.signals!.sell.length).toBeGreaterThan(0);
    expect(digest.signals!.watch.length).toBeGreaterThan(0);
    expect(digest.audit!.total).toBe(1);
    expect(digest.market!.rows.length).toBeGreaterThan(0);
  });

  it("shows only the sports the user actually holds", () => {
    // The fixture holds baseball + basketball. Hockey has an index row
    // and must NOT appear.
    const sports = digest.market!.rows.map((r) => r.sport).sort();
    expect(sports).toEqual(["baseball", "basketball"]);
  });

  it("EVERY mover carries a basis naming both dated observations", () => {
    for (const m of [...digest.movers!.gainers, ...digest.movers!.decliners]) {
      expect(m.basisNote.length).toBeGreaterThan(20);
      expect(m.fromValue).not.toBeNull();
      expect(m.fromAt).not.toBeNull();
      expect(m.toAt).not.toBeNull();
      // The two ends of the move both appear as dollars in the prose.
      expect(m.basisNote).toContain("$");
      expect(m.basisNote).toMatch(/→/);
    }
  });

  it("EVERY signal and audit row carries a basis", () => {
    for (const s of [...digest.signals!.sell, ...digest.signals!.watch]) {
      expect(s.basisNote).toMatch(/a week/);
      expect(s.basisNote.length).toBeGreaterThan(20);
    }
    for (const a of digest.audit!.items) {
      expect(a.basisNote).toContain("provisional");
      expect(a.invariant).toBe("BASIS-IDENTITY");
    }
  });

  it("labels speculative values AT the number, in both renderers", () => {
    const faller = digest.movers!.decliners.find((m) => m.holdingId === "h-faller")!;
    expect(faller.valueBasis).toBe("estimated");
    expect(faller.speculative).toBe(true);

    const text = renderWeeklyDigestText(digest);
    const html = renderWeeklyDigestHtml(digest);
    // "(estimated)" sits next to the value in the row, not only in a
    // footnote at the bottom.
    expect(text).toMatch(/Now \$62 \(estimated\)/);
    expect(html).toContain("now $62 (estimated)");
  });

  it("an audit-flagged holding reads 'under review' and STILL shows its value", () => {
    const flagged = digest.movers!.gainers.find((m) => m.holdingId === "h-flagged")!;
    expect(flagged.valueBasis).toBe("under-review");
    expect(flagged.value).toBe(340);          // published, never blanked
    const text = renderWeeklyDigestText(digest);
    expect(text).toContain("$340 (under review)");
  });

  it("the portfolio total says how much of itself is speculative", () => {
    expect(digest.summary.speculativeHoldings).toBe(2);   // estimated + under-review
    expect(digest.summary.portfolioValueBasis).toMatch(/estimates and are labeled as such/);
  });

  it("both rendered bodies contain every section's heading", () => {
    const { plainText, html, subject } = renderWeeklyDigestEmail(digest);
    for (const body of [plainText, html.toLowerCase()]) {
      expect(body.toLowerCase()).toContain("what went up");
      expect(body.toLowerCase()).toContain("what came down");
      expect(body.toLowerCase()).toContain("good week to sell");
      expect(body.toLowerCase()).toContain("worth watching");
      expect(body.toLowerCase()).toContain("under review");
      expect(body.toLowerCase()).toContain("the wider market");
    }
    expect(subject).toMatch(/Your week in cards/);
  });

  it("speaks collector, not engine", () => {
    const text = renderWeeklyDigestText(digest);
    // Jargon that must never reach a collector's inbox.
    for (const banned of ["velocityMultiple", "urgencyScore", "movePct", "valuationStatus", "auditFlag", "hobbyiqCardId"]) {
      expect(text).not.toContain(banned);
    }
    expect(text).toMatch(/Selling about 6 a week right now against a normal 2/);
  });
});

// ── PIN 2 ───────────────────────────────────────────────────────────

describe("PIN 2 — missing-section tolerance", () => {
  it("no signals surface (null) → section omitted cleanly, and said in the footnotes", () => {
    const digest = buildWeeklyDigest({ ...fullFixture(), signals: null });
    expect(digest.sections).not.toContain("signals");
    expect(digest.signals).toBeUndefined();
    expect(digest.footnotes.some((f) => /not available/i.test(f))).toBe(true);

    const text = renderWeeklyDigestText(digest);
    const html = renderWeeklyDigestHtml(digest);
    for (const body of [text.toLowerCase(), html.toLowerCase()]) {
      expect(body).not.toContain("good week to sell");
      expect(body).not.toContain("worth watching");
    }
    // And the sections that DID render are untouched.
    expect(text.toLowerCase()).toContain("what went up");
  });

  it("surface present but quiet ([]) → also omitted, WITHOUT the outage footnote", () => {
    const digest = buildWeeklyDigest({ ...fullFixture(), signals: [] });
    expect(digest.sections).not.toContain("signals");
    expect(digest.signals).toBeUndefined();
    // A quiet week must not read like a broken one.
    expect(digest.footnotes.some((f) => /not available/i.test(f))).toBe(false);
  });

  it("no audit flags → no audit section and no stub anywhere", () => {
    const input = fullFixture();
    const holdings = input.holdings.map((h) => ({ ...h, auditFlag: null })) as any;
    const digest = buildWeeklyDigest({ ...input, holdings });
    expect(digest.sections).not.toContain("audit");
    expect(digest.audit).toBeUndefined();
    const text = renderWeeklyDigestText(digest).toLowerCase();
    expect(text).not.toContain("under review");
  });

  it("no market surface (null) → no market section", () => {
    const digest = buildWeeklyDigest({ ...fullFixture(), sportIndexes: null });
    expect(digest.sections).not.toContain("market");
    expect(digest.market).toBeUndefined();
    expect(renderWeeklyDigestText(digest).toLowerCase()).not.toContain("the wider market");
  });

  it("EVERY section missing at once still renders a coherent digest", () => {
    const digest = buildWeeklyDigest({
      userId: "user-empty",
      ...isoWeekBounds(NOW),
      holdings: [],
      priceHistoryByHolding: {},
      signals: null,
      sportIndexes: null,
      now: NOW,
    });
    expect(digest.sections).toEqual([]);
    const text = renderWeeklyDigestText(digest);
    const html = renderWeeklyDigestHtml(digest);
    expect(text).toContain("Nothing in your collection yet");
    expect(html).toContain("Nothing in your collection yet");
    // No orphan headings anywhere.
    for (const heading of ["WHAT WENT UP", "GOOD WEEK TO SELL", "UNDER REVIEW", "THE WIDER MARKET"]) {
      expect(text).not.toContain(heading);
    }
    expect(() => renderWeeklyDigestEmail(digest)).not.toThrow();
  });

  it("a holding with no price trail is not reported as a 0% mover", () => {
    const digest = buildWeeklyDigest({
      ...fullFixture(),
      priceHistoryByHolding: { "h-riser": [{ at: ago(2), value: 1180 }] },
    });
    expect(digest.sections).not.toContain("movers");
    // It still counts as a holding they own.
    expect(digest.summary.holdings).toBe(3);
  });
});

// ── PIN 3 ───────────────────────────────────────────────────────────

describe("PIN 3 — idempotent weekly run", () => {
  it("the same week built twice is byte-identical", () => {
    const a = buildWeeklyDigest(fullFixture());
    const b = buildWeeklyDigest(fullFixture());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the store doc id is derived from (userId, weekId) — a re-run upserts, never appends", () => {
    const a = buildWeeklyDigest(fullFixture());
    const b = buildWeeklyDigest(fullFixture());
    expect(weeklyDigestDocId(a.userId, a.weekId)).toBe(weeklyDigestDocId(b.userId, b.weekId));
    expect(weeklyDigestDocId("user-a", "2026-W36")).toBe("user-a::2026-W36");
  });

  it("every day of one ISO week maps to the SAME weekId and the same bounds", () => {
    // Mon 2026-08-31 … Sun 2026-09-06 is one ISO week.
    const days = [
      "2026-08-31", "2026-09-01", "2026-09-02",
      "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06",
    ].map((d) => isoWeekBounds(new Date(`${d}T09:00:00Z`)));
    const ids = new Set(days.map((d) => d.weekId));
    expect(ids.size).toBe(1);
    expect(days[0].weekStart).toBe("2026-08-31");
    expect(days[0].weekEnd).toBe("2026-09-06");
    // The next Monday is a DIFFERENT week — the key actually rolls.
    expect(isoWeekId(new Date("2026-09-07T09:00:00Z"))).not.toBe(days[0].weekId);
  });

  it("a run over an already-delivered week persists but sends nothing", async () => {
    const store = await import("../src/services/portfolioiq/weeklyDigestStore.service.js");
    const upserts: string[] = [];
    const sends: string[] = [];

    // Minimal in-memory Cosmos stand-in: one doc, already delivered.
    const docs = new Map<string, any>();
    docs.set("user-a::2026-W36", {
      id: "user-a::2026-W36",
      userId: "user-a",
      weekId: "2026-W36",
      docType: "weekly_digest",
      digest: { weekId: "2026-W36" },
      computedAt: ago(7),
      deliveredAt: ago(7),          // ← already mailed
      deliveryChannel: "email",
      ttl: 1,
    });
    store._setContainerForTesting({
      item: (id: string) => ({
        read: async () => ({ resource: docs.get(id) ?? undefined }),
      }),
      items: {
        upsert: async (d: any) => { upserts.push(d.id); docs.set(d.id, d); return { resource: d }; },
        query: () => ({ hasMoreResults: () => false, fetchNext: async () => ({ resources: [] }) }),
      },
    } as any);

    const { runWeeklyDigestJob } = await import(
      "../src/services/portfolioiq/weeklyDigestJob.service.js"
    );
    const portfolioStore = await import("../src/services/portfolioiq/portfolioStore.service.js");
    const fixture = fullFixture();
    vi.spyOn(portfolioStore, "listAllPortfolioUserIds").mockResolvedValue(["user-a"]);
    vi.spyOn(portfolioStore, "readUserDoc").mockResolvedValue({
      id: "user-a",
      userId: "user-a",
      holdings: Object.fromEntries(fixture.holdings.map((h) => [h.id, h])),
      priceHistoryByHolding: fixture.priceHistoryByHolding,
      ledger: [],
      alerts: [],
      recommendationFeedback: [],
    } as any);
    process.env.ACS_EMAIL_CONNECTION_STRING = "endpoint=https://test/;accesskey=x";
    process.env.EMAIL_FROM_ADDRESS = "DoNotReply@test.invalid";

    const summary = await runWeeklyDigestJob(
      { weekId: "2026-W36", now: NOW },
      {
        sendEmail: async (input) => { sends.push(input.subject); return { delivered: true }; },
        loadSignals: async () => fixture.signals,
        loadSportIndexes: async () => fixture.sportIndexes,
        resolveEmail: async () => "someone@test.invalid",
      },
    );

    expect(summary.digestsBuilt).toBe(1);
    expect(summary.digestsPersisted).toBe(1);        // rebuilt + re-persisted
    expect(summary.skipped.alreadyDelivered).toBe(1);
    expect(summary.emailsSent).toBe(0);              // NOT re-sent
    expect(sends).toHaveLength(0);
    // The re-persist wrote the SAME id — no second row for the week.
    expect(new Set(upserts)).toEqual(new Set(["user-a::2026-W36"]));

    store._setContainerForTesting(null);
    vi.restoreAllMocks();
    delete process.env.ACS_EMAIL_CONNECTION_STRING;
    delete process.env.EMAIL_FROM_ADDRESS;
  });

  it("a first run for the week DOES send, and marks delivery", async () => {
    const store = await import("../src/services/portfolioiq/weeklyDigestStore.service.js");
    const docs = new Map<string, any>();
    const sends: string[] = [];
    store._setContainerForTesting({
      item: (id: string) => ({ read: async () => ({ resource: docs.get(id) ?? undefined }) }),
      items: {
        upsert: async (d: any) => { docs.set(d.id, d); return { resource: d }; },
        query: () => ({ hasMoreResults: () => false, fetchNext: async () => ({ resources: [] }) }),
      },
    } as any);

    const { runWeeklyDigestJob } = await import(
      "../src/services/portfolioiq/weeklyDigestJob.service.js"
    );
    const portfolioStore = await import("../src/services/portfolioiq/portfolioStore.service.js");
    const fixture = fullFixture();
    vi.spyOn(portfolioStore, "listAllPortfolioUserIds").mockResolvedValue(["user-a"]);
    vi.spyOn(portfolioStore, "readUserDoc").mockResolvedValue({
      id: "user-a",
      userId: "user-a",
      holdings: Object.fromEntries(fixture.holdings.map((h) => [h.id, h])),
      priceHistoryByHolding: fixture.priceHistoryByHolding,
      ledger: [],
      alerts: [],
      recommendationFeedback: [],
    } as any);
    process.env.ACS_EMAIL_CONNECTION_STRING = "endpoint=https://test/;accesskey=x";
    process.env.EMAIL_FROM_ADDRESS = "DoNotReply@test.invalid";

    const summary = await runWeeklyDigestJob(
      { weekId: "2026-W36", now: NOW },
      {
        sendEmail: async (input) => { sends.push(input.subject); return { delivered: true }; },
        loadSignals: async () => fixture.signals,
        loadSportIndexes: async () => fixture.sportIndexes,
        resolveEmail: async () => "someone@test.invalid",
      },
    );

    expect(summary.emailsSent).toBe(1);
    expect(sends[0]).toMatch(/Your week in cards/);
    expect(docs.get("user-a::2026-W36")?.deliveredAt).toBeTruthy();

    store._setContainerForTesting(null);
    vi.restoreAllMocks();
    delete process.env.ACS_EMAIL_CONNECTION_STRING;
    delete process.env.EMAIL_FROM_ADDRESS;
  });

  it("no email infra → the digest is still BUILT and PERSISTED (the in-app floor)", async () => {
    const store = await import("../src/services/portfolioiq/weeklyDigestStore.service.js");
    const docs = new Map<string, any>();
    store._setContainerForTesting({
      item: (id: string) => ({ read: async () => ({ resource: docs.get(id) ?? undefined }) }),
      items: {
        upsert: async (d: any) => { docs.set(d.id, d); return { resource: d }; },
        query: () => ({ hasMoreResults: () => false, fetchNext: async () => ({ resources: [] }) }),
      },
    } as any);

    const { runWeeklyDigestJob } = await import(
      "../src/services/portfolioiq/weeklyDigestJob.service.js"
    );
    const portfolioStore = await import("../src/services/portfolioiq/portfolioStore.service.js");
    const fixture = fullFixture();
    vi.spyOn(portfolioStore, "listAllPortfolioUserIds").mockResolvedValue(["user-a"]);
    vi.spyOn(portfolioStore, "readUserDoc").mockResolvedValue({
      id: "user-a",
      userId: "user-a",
      holdings: Object.fromEntries(fixture.holdings.map((h) => [h.id, h])),
      priceHistoryByHolding: fixture.priceHistoryByHolding,
      ledger: [],
      alerts: [],
      recommendationFeedback: [],
    } as any);
    delete process.env.ACS_EMAIL_CONNECTION_STRING;
    delete process.env.EMAIL_FROM_ADDRESS;

    const summary = await runWeeklyDigestJob(
      { weekId: "2026-W36", now: NOW },
      { sendEmail: null, loadSignals: async () => fixture.signals, loadSportIndexes: async () => fixture.sportIndexes },
    );

    expect(summary.emailConfigured).toBe(false);
    expect(summary.digestsPersisted).toBe(1);
    expect(summary.emailsSent).toBe(0);
    expect(summary.skipped.emailNotConfigured).toBe(1);
    // The digest a user can open in-app exists regardless.
    expect(docs.get("user-a::2026-W36")?.digest?.sections?.length).toBeGreaterThan(0);
    expect(docs.get("user-a::2026-W36")?.deliveryReason).toBe("acs-unconfigured");

    store._setContainerForTesting(null);
    vi.restoreAllMocks();
  });
});

// ── Supporting doctrine ─────────────────────────────────────────────

describe("value basis resolution", () => {
  it("an audit flag outranks the valuation class — comp-anchored or not", () => {
    expect(resolveHoldingValue(holding({ fairMarketValue: 100 }))).toEqual({ value: 100, basis: "observed" });
    expect(resolveHoldingValue(holding({ estimatedValue: 100 }))).toEqual({ value: 100, basis: "estimated" });
    expect(
      resolveHoldingValue(holding({ fairMarketValue: 100, auditFlag: { invariant: "RUNG-HONESTY", reason: "x", at: ago(1) } })),
    ).toEqual({ value: 100, basis: "under-review" });
    expect(resolveHoldingValue(holding({}))).toEqual({ value: null, basis: "unpriced" });
  });
});

describe("sport derivation", () => {
  it("reads the sport out of the canonical slug, and tolerates its absence", () => {
    const sports = portfolioSports([
      holding({ hobbyiqCardId: "hiq:baseball:2024:bowman-chrome:bcp-1:base:noauto" }),
      holding({ hobbyiqCardId: "hiq:hockey:2024:upper-deck:1:base:noauto" }),
      holding({ hobbyiqCardId: null }),
      holding({ hobbyiqCardId: "not-a-slug" }),
    ] as any);
    expect([...sports].sort()).toEqual(["baseball", "hockey"]);
  });
});

// ── PIN 4 ───────────────────────────────────────────────────────────
//
// CF-A-MOVER-NEEDS-CORROBORATION (Drew, 2026-09-03).
//
// The movers section reported repricing-engine artifacts as market moves.
// The gate meant to stop that read `(valuationStatus ?? "observed") !==
// "estimated"` — and a MISSING status defaults to observed, so on the live
// container (23,936 trail points, 52 with a valuationStatus, 0 with a rung)
// it passed 99.8% of points. Every scheduled-reprice write read as a sale:
// Michael Harris "up 9433.9%" ($1.18 -> $63.75 between two reprice writes),
// Shaq $199.99 -> $695.28 in one step, Chipper Jones $2.49 -> $374.83.
//
// The rule is the price-alerts one (#1659): a move is a MARKET move only
// when BOTH endpoints are exact-pool reads. These pins hold that line.

describe("PIN 4 — a mover needs corroboration at both ends", () => {
  const base = () => ({
    userId: "user-corroboration",
    ...isoWeekBounds(NOW),
    holdings: [
      holding({
        id: "h-harris",
        playerName: "Michael Harris",
        cardTitle: "2022 Bowman Chrome Auto",
        fairMarketValue: 63.75,
        purchasePrice: 20,
      }),
    ],
    signals: [] as DigestSignalCandidate[],
    sportIndexes: [] as DigestSportIndex[],
    now: NOW,
  });

  it("UNTAGGED trail yields ZERO movers — the Harris shape, verbatim", () => {
    // The exact live shape: two reprice writes, neither carrying a rung.
    const digest = buildWeeklyDigest({
      ...base(),
      priceHistoryByHolding: {
        "h-harris": [
          { at: ago(5), value: 1.18 },
          { at: ago(1), value: 63.75 },
        ],
      },
    } as WeeklyDigestInput);

    expect(digest.movers).toBeUndefined();
    expect(digest.sections).not.toContain("movers");

    // And the 9433.9% never reaches a reader as a move — not in the
    // headline, not under a movers heading, in either renderer.
    const text = renderWeeklyDigestText(digest);
    const html = renderWeeklyDigestHtml(digest);
    expect(digest.headline).not.toMatch(/9433/);
    expect(text).not.toContain("WHAT WENT UP");
    expect(html).not.toContain("What went up");
    expect(text).not.toMatch(/9433/);
    expect(html).not.toMatch(/9433/);
  });

  it("an untagged change is RELABELED, and never claims sales it does not have", () => {
    const digest = buildWeeklyDigest({
      ...base(),
      priceHistoryByHolding: {
        "h-harris": [
          { at: ago(5), value: 1.18 },
          { at: ago(1), value: 63.75 },
        ],
      },
    } as WeeklyDigestInput);

    expect(digest.sections).toContain("reestimated");
    const row = digest.reestimated!.items[0];
    expect(row.corroborated).toBe(false);
    expect(row.anchorRung).toBeNull();
    expect(row.latestRung).toBeNull();

    // The old note asserted a basis the numbers did not have. It must not
    // claim readings-as-sales, nor "projected next sale from its comps".
    expect(row.basisNote).toMatch(/not a sale/i);
    expect(row.basisNote).not.toMatch(/readings this week/);
    expect(row.basisNote).not.toMatch(/projected next sale from its comps/);

    const text = renderWeeklyDigestText(digest);
    expect(text).toContain("RE-ESTIMATED THIS WEEK — NOT A MARKET MOVE");
    // The honest heading is present; the movers heading is not.
    expect(text).not.toContain("WHAT WENT UP");
    // A signed percentage IS the market-move claim; the re-estimate row
    // shows the two values instead.
    expect(text).not.toMatch(/\+9433\.9%/);
  });

  it("EXACT-POOL at both ends yields a real mover", () => {
    const digest = buildWeeklyDigest({
      ...base(),
      priceHistoryByHolding: {
        "h-harris": [
          { at: ago(5), value: 50, rungLabel: "exact-pool-projection" },
          { at: ago(1), value: 63.75, rungLabel: "exact-pool-last-sale" },
        ],
      },
    } as WeeklyDigestInput);

    expect(digest.sections).toContain("movers");
    const m = digest.movers!.gainers.find((g) => g.holdingId === "h-harris")!;
    expect(m).toBeDefined();
    expect(m.corroborated).toBe(true);
    expect(m.movePct).toBeCloseTo(27.5, 1);
    expect(digest.sections).not.toContain("reestimated");
    expect(renderWeeklyDigestText(digest)).toContain("WHAT WENT UP");
  });

  it("ONE end estimated / non-exact is EXCLUDED from movers and relabeled", () => {
    // A real sale on one end and a fallback re-anchor on the other is an
    // engine artifact wearing one real number. It is not a mover.
    const digest = buildWeeklyDigest({
      ...base(),
      priceHistoryByHolding: {
        "h-harris": [
          { at: ago(5), value: 50, rungLabel: "exact-pool-projection" },
          { at: ago(1), value: 63.75, rungLabel: "player-index-projection" },
        ],
      },
    } as WeeklyDigestInput);

    expect(digest.movers).toBeUndefined();
    expect(digest.sections).toContain("reestimated");
    const row = digest.reestimated!.items[0];
    expect(row.corroborated).toBe(false);
    expect(row.anchorRung).toBe("exact-pool-projection");
    expect(row.latestRung).toBe("player-index-projection");
    // The note NAMES the rung that broke corroboration.
    expect(row.basisNote).toMatch(/wider market/);
  });

  it("no holding qualifies → the digest SAYS so, and invents no movers", () => {
    const digest = buildWeeklyDigest({
      ...base(),
      priceHistoryByHolding: {
        "h-harris": [
          { at: ago(5), value: 1.18 },
          { at: ago(1), value: 63.75 },
        ],
      },
    } as WeeklyDigestInput);

    expect(digest.movers).toBeUndefined();
    // Not "quiet week" — values DID change; the headline must not claim
    // nothing happened, nor claim a market move happened.
    expect(digest.headline).toMatch(/No confirmed sales moved/);
    expect(digest.headline).toMatch(/not the market/);
    expect(digest.headline).not.toMatch(/led your week/);
  });

  it("MUTATION: defaulting a missing rung to exact-pool resurrects the artifact", () => {
    // Guard the guard. If isCorroborated ever reads an absent rungLabel as
    // exact-pool (the `?? "observed"` mistake, one field over), the untagged
    // Harris trail becomes a 9433.9% mover again. This asserts the two
    // fixtures land on OPPOSITE sides of the gate, so a default that
    // collapses them fails here.
    const untagged = buildWeeklyDigest({
      ...base(),
      priceHistoryByHolding: {
        "h-harris": [{ at: ago(5), value: 1.18 }, { at: ago(1), value: 63.75 }],
      },
    } as WeeklyDigestInput);
    const tagged = buildWeeklyDigest({
      ...base(),
      priceHistoryByHolding: {
        "h-harris": [
          { at: ago(5), value: 1.18, rungLabel: "exact-pool-projection" },
          { at: ago(1), value: 63.75, rungLabel: "exact-pool-projection" },
        ],
      },
    } as WeeklyDigestInput);

    expect(untagged.sections).not.toContain("movers");
    expect(tagged.sections).toContain("movers");
    expect(tagged.movers!.gainers[0].movePct).toBeCloseTo(5302.54, 0);
  });
});
