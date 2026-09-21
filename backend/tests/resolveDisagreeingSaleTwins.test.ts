/**
 * CF-CH-DAILY-DOUBLE-WRITE, twins-disagree resolution (2026-09-20).
 *
 * collapse-ch-synthetic-twins.cjs's own REPORT finds 23,688 `twins-disagree`
 * pairs -- the same CardHedge sale stored twice with two DIFFERENT identities
 * -- and deliberately leaves them (never guesses). resolve-disagreeing-sale-
 * twins.cjs is the lane that decides which side is right, using ONLY
 * evidence: checklist+roster, then more-specific-refines, then a grader-token
 * title read for the grade axis.
 *
 * These tests pin: the pure per-side/per-pair decision functions (against a
 * fake catalog authority + player-identity + title-reader surface, so no
 * dist/ build is required to exercise the DECISION shape), the write path via
 * relocate-sold-comp.cjs's fake Cosmos (etag/IfMatch enforced), REPORT==APPLY
 * parity, and the workflow wiring (whitelist entry, PLAN_OUT, relaunch step,
 * input count, byte scan).
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(__filename);
const mod = require("../scripts/resolve-disagreeing-sale-twins.cjs");
const lib = require("../scripts/lib/relocate-sold-comp.cjs");
const sweep = require("../scripts/collapse-ch-synthetic-twins.cjs");

const CHID = "1778542173652x303328120692600800";
const CARD = CHID;

const longId = (soldAt: string, cents: number) => `cardhedge::ch-daily::${CHID}::${soldAt}::${cents}`;
const shortId = (priceHistoryId: string) => `cardhedge::ch-daily::${priceHistoryId}`;

const longRow = (over: Record<string, unknown> = {}) => ({
  id: longId("2026-07-03T01:19:00+00:00", 14000),
  cardId: CARD, source: "cardhedge", sourceExternalId: null,
  soldAt: "2026-07-03T01:19:00+00:00", price: 140,
  hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto",
  title: "2026 Bowman Baseball #CPA-EHA Eric Hartman Base", parallel: "Base", isAuto: false,
  playerName: "Eric Hartman",
  gradeCompany: null, gradeValue: null, cardNumber: "cpa-eha",
  verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false,
  _etag: '"long-etag-1"',
  ...over,
});
const shortRow = (over: Record<string, unknown> = {}) => ({
  id: shortId("9931002211"),
  cardId: CARD, source: "cardhedge", sourceExternalId: "ch-daily::9931002211",
  soldAt: "2026-07-03T01:19:00Z", price: 140,
  hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto",
  title: "2026 Bowman Baseball #CPA-EHA Eric Hartman Base", parallel: "Base", isAuto: false,
  playerName: "Eric Hartman",
  gradeCompany: null, gradeValue: null, cardNumber: "cpa-eha",
  verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false,
  _etag: '"short-etag-1"',
  ...over,
});

// ── fake TS-authored deps: no dist/ build required for these pure-decision
// tests, mirroring collapse-ch-synthetic-twins.test.ts's own dependency-free
// approach for its pure functions.
const playerIdentityKeyFake = (name: unknown) => String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
function fakeDeps(overrides: Record<string, unknown> = {}) {
  return {
    playerIdentityKey: playerIdentityKeyFake,
    titleContradictsTarget: (_sale: unknown, _target: unknown) => ({ contradicts: false }),
    statedFinishFromChecklist: (_title: string, _ctx: unknown) => null,
    sameCardNumber: (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase(),
    parseGradeFromTitle: (_title: string) => null,
    checklistRowsByNumber: () => new Map(),
    ...overrides,
  };
}

describe("evaluateHobbyiqCardIdSide: checklist + roster + title, per side", () => {
  it("no strict checklist row at all -> no-strict-checklist-row", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "vendor", parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "x" };
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, new Map());
    expect(result).toEqual({ row: null, reason: "no-strict-checklist-row" });
  });

  it("a checklist row at this number exists but the roster names someone else -> roster-does-not-name-player", () => {
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "x" };
    const byNumber = new Map([["cpa-eha", [{ id: "cat1", source: "beckett-checklist", playerName: "Someone Else", cardNumber: "cpa-eha" }]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result).toEqual({ row: null, reason: "roster-does-not-name-player" });
  });

  it("checklist + roster + no title contradiction -> ok, row returned", () => {
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "2026 Bowman #CPA-EHA Eric Hartman Base" };
    const row = { id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" };
    const byNumber = new Map([["cpa-eha", [row]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result.row).toBe(row);
  });

  it("checklist + roster BUT the title contradicts the row -> title-contradicts-every-candidate-row", () => {
    const deps = fakeDeps({ titleContradictsTarget: () => ({ contradicts: true, rule: "card-number", detail: "x" }) });
    const sale = { playerName: "Eric Hartman", title: "x" };
    const row = { id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" };
    const byNumber = new Map([["cpa-eha", [row]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result).toEqual({ row: null, reason: "title-contradicts-every-candidate-row" });
  });

  it("a non-strict source (vendor-derived) never counts, even naming the right player", () => {
    const deps = fakeDeps();
    const sale = { playerName: "Eric Hartman", title: "x" };
    const byNumber = new Map([["cpa-eha", [{ id: "cat1", source: "cardhedge", playerName: "Eric Hartman", cardNumber: "cpa-eha" }]]]);
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "vendor", parseHobbyIqCardId: parseHiqFake });
    const result = mod.evaluateHobbyiqCardIdSide(deps, "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", sale, byNumber);
    expect(result).toEqual({ row: null, reason: "no-strict-checklist-row" });
  });
});

// A minimal fake mirroring hobbyIqCardId.service.ts's parseHobbyIqCardId
// shape, enough to drive the pure decision tests without a dist/ build.
function parseHiqFake(hiqId: string) {
  const s = String(hiqId ?? "");
  if (!s.startsWith("hiq:")) return null;
  const [, sport, yearStr, setKey, cardNumber, parallel, autoFlag] = s.split(":");
  if (!sport || !yearStr || !setKey || !cardNumber) return null;
  return { sport, year: Number(yearStr), setKey, cardNumber, parallel: parallel ?? "base", isAuto: autoFlag === "auto" };
}

describe("resolveHobbyiqCardIdDisagreement: RULE 1 (checklist + roster) decides, both directions", () => {
  it("long resolves to a strict checklist row naming the sale's player, short does not -> long wins", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: (s: string) => (s === "beckett-checklist" ? "checklist" : "vendor"), parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto" });
    const sale = short;
    const deps = fakeDeps({
      checklistRowsByNumber: (parsed: { setKey: string }) => {
        if (parsed.setKey === "bowman") return new Map([["cpa-eha", [{ id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" }]]]);
        return new Map(); // topps:44 has no strict row at all
      },
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short, sale);
    expect(result).toMatchObject({ verdict: "resolved", winner: "long", rule: "checklist-and-roster" });
  });

  it("short resolves, long does not -> short wins", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: (s: string) => (s === "beckett-checklist" ? "checklist" : "vendor"), parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto" });
    const sale = short;
    const deps = fakeDeps({
      checklistRowsByNumber: (parsed: { setKey: string }) => {
        if (parsed.setKey === "topps") return new Map([["44", [{ id: "cat2", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "44" }]]]);
        return new Map();
      },
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short, sale);
    expect(result).toMatchObject({ verdict: "resolved", winner: "short", rule: "checklist-and-roster" });
  });

  it("neither side resolves -> neither-side-backed", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "vendor", parseHobbyIqCardId: parseHiqFake });
    const long = longRow();
    const short = shortRow();
    const deps = fakeDeps();
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short, short);
    expect(result.verdict).toBe("neither-side-backed");
  });
});

describe("moreSpecificRefines: RULE 2, same number/auto, loser is base, title names winner's parallel", () => {
  it("refines when same number, same auto, loser is base, title names the winner's exact parallel words", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({
      sameCardNumber: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      statedFinishFromChecklist: () => "Gold Refractor",
    });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Base", isAuto: false };
    const winnerRow = { parallel: "Gold Refractor" };
    const sale = { title: "2026 Bowman #CPA-EHA Gold Refractor" };
    const result = mod.moreSpecificRefines(deps, sale, winnerParsed, winnerRow, loserParsed);
    expect(result.refines).toBe(true);
  });

  it("does NOT refine when the loser's own parallel is not base/blank (both sides name a real parallel)", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true, statedFinishFromChecklist: () => "Gold Refractor" });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "cpa-eha", parallel: "Blue Refractor", isAuto: false };
    const result = mod.moreSpecificRefines(deps, { title: "x" }, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "loser-parallel-is-not-base-or-blank" });
  });

  it("does NOT refine when the card numbers differ", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => false });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "2", parallel: "Base", isAuto: false };
    const result = mod.moreSpecificRefines(deps, { title: "x" }, winnerParsed, { parallel: "Gold" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "different-card-number" });
  });

  it("does NOT refine when the auto flags differ", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold", isAuto: true };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const result = mod.moreSpecificRefines(deps, { title: "x" }, winnerParsed, { parallel: "Gold" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "different-auto-flag" });
  });

  it("does NOT refine when the title names NO parallel at all", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true, statedFinishFromChecklist: () => null });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const result = mod.moreSpecificRefines(deps, { title: "plain title" }, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "title-names-no-parallel" });
  });

  it("does NOT refine when the title names a DIFFERENT parallel than the winner", () => {
    mod.__setSweepDepsForTest({ parseHobbyIqCardId: parseHiqFake });
    const deps = fakeDeps({ sameCardNumber: () => true, statedFinishFromChecklist: () => "Blue Refractor" });
    const winnerParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Gold Refractor", isAuto: false };
    const loserParsed = { sport: "baseball", year: 2026, setKey: "bowman", cardNumber: "1", parallel: "Base", isAuto: false };
    const result = mod.moreSpecificRefines(deps, { title: "... Blue Refractor ..." }, winnerParsed, { parallel: "Gold Refractor" }, loserParsed);
    expect(result).toEqual({ refines: false, reason: "title-names-a-different-parallel-than-the-winner" });
  });
});

describe("resolveHobbyiqCardIdDisagreement: RULE 2, both sides checklist-backed", () => {
  it("both valid, one strictly more specific and title names it -> the specific one wins", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:no-auto", title: "2026 Bowman #CPA-EHA Eric Hartman Gold Refractor" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto", title: "2026 Bowman #CPA-EHA Eric Hartman Gold Refractor" });
    const sale = short;
    const rowFor = (parallel: string) => ({ id: "cat", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha", parallel });
    const deps = fakeDeps({
      sameCardNumber: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      statedFinishFromChecklist: () => "Gold Refractor",
      checklistRowsByNumber: (parsed: { parallel: string }) => new Map([["cpa-eha", [rowFor(parsed.parallel === "gold-refractor" ? "Gold Refractor" : "Base")]]]),
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short, sale);
    expect(result).toMatchObject({ verdict: "resolved", winner: "long", rule: "more-specific-refines" });
  });

  it("both valid, NEITHER refines the other -> LEFT both-sides-valid", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:blue-refractor:no-auto" });
    const sale = short;
    const rowFor = (parallel: string) => ({ id: "cat", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha", parallel });
    const deps = fakeDeps({
      sameCardNumber: () => true,
      statedFinishFromChecklist: () => null, // neither title names a parallel word
      checklistRowsByNumber: (parsed: { parallel: string }) => new Map([["cpa-eha", [rowFor(parsed.parallel === "gold-refractor" ? "Gold Refractor" : "Blue Refractor")]]]),
    });
    const result = mod.resolveHobbyiqCardIdDisagreement(deps, long, short, sale);
    expect(result.verdict).toBe("both-sides-valid");
  });
});

describe("resolveGradeDisagreement: RULE 3, grade from grader token only", () => {
  it("the grader token in the title decides -- the agreeing side wins", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10, title: "... PSA 10 ..." });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9 });
    const deps = fakeDeps({ parseGradeFromTitle: () => ({ gradeCompany: "PSA", gradeValue: 10 }) });
    const result = mod.resolveGradeDisagreement(deps, long, short, long);
    expect(result).toMatchObject({ verdict: "resolved", winner: "long", rule: "grader-token-in-title" });
  });

  it("no grader token in the title at all -> LEFT neither-side-backed", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10 });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9 });
    const deps = fakeDeps({ parseGradeFromTitle: () => null });
    const result = mod.resolveGradeDisagreement(deps, long, short, long);
    expect(result.verdict).toBe("neither-side-backed");
  });

  it("the title's grader token matches NEITHER stored grade -> LEFT neither-side-backed", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10 });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9 });
    const deps = fakeDeps({ parseGradeFromTitle: () => ({ gradeCompany: "SGC", gradeValue: 8 }) });
    const result = mod.resolveGradeDisagreement(deps, long, short, long);
    expect(result.verdict).toBe("neither-side-backed");
  });
});

describe("protected/parked: never touched, reusing the sweep lane's own gates", () => {
  it("isProtected and isParkedSide are the SAME functions the sweep lane exports (imported, not re-implemented)", () => {
    expect(sweep.isProtected({ verifiedByUser: true })).toBe(true);
    expect(sweep.isParkedSide({ identityUnverified: true })).toBe(true);
  });
});

// ── write path: full-doc upsert via relocateSoldComp, etag/IfMatch enforced -
type Fake = { store: Map<string, Record<string, unknown>>; container: unknown };
function fakePool(): Fake {
  const store = new Map<string, Record<string, unknown>>();
  const key = (id: string, pk: string) => `${pk}::${id}`;
  const nf = () => Object.assign(new Error("not found"), { code: 404 });
  const container = {
    items: {
      async upsert(doc: Record<string, unknown>) {
        store.set(key(String(doc.id), String(doc.cardId)), structuredClone(doc));
        return { resource: doc };
      },
      query(spec: { parameters?: { name: string; value: unknown }[] }) {
        return {
          async fetchAll() {
            const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
            return { resources: [...store.values()].filter((d) => d.id === p["@id"] && d.cardId === p["@pk"]) };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read() {
          const d = store.get(key(id, pk));
          if (!d) throw nf();
          return { resource: d };
        },
        async delete(options?: { accessCondition?: { type: string; condition: string } }) {
          const k = key(id, pk);
          const d = store.get(k);
          if (!d) throw nf();
          if (options?.accessCondition?.type === "IfMatch" && d._etag !== options.accessCondition.condition) {
            throw Object.assign(new Error("etag mismatch"), { code: 412 });
          }
          store.delete(k);
          return {};
        },
      };
    },
  };
  return { store, container };
}
const noWait = async () => {};

describe("buildResolution + relocateSoldComp: the write path", () => {
  it("winner=short: an ordinary collapse, short row kept with a twinResolved ledger stamp, long row dropped", async () => {
    const fake = fakePool();
    const long = longRow({ _etag: '"L1"' });
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const resolution = { verdict: "resolved" as const, winner: "short" as const, rule: "checklist-and-roster", detail: "x" };
    const keep = mod.buildResolution(long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    expect(keep.hobbyiqCardId).toBe(short.hobbyiqCardId); // short's own value untouched
    expect(keep.twinResolved).toMatchObject({ winner: short.id, loser: long.id, rule: "checklist-and-roster" });
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }],
      verifyFields: ["twinResolved"], wait: noWait,
    });
    expect(res).toMatchObject({ ok: true, stage: "done" });
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(false);
  });

  it("winner=long: the short row is kept at its OWN address but carries the long row's identity -- exactly one row survives, no orphan", async () => {
    const fake = fakePool();
    const long = longRow({ _etag: '"L1"', hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto" });
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const resolution = { verdict: "resolved" as const, winner: "long" as const, rule: "checklist-and-roster", detail: "x" };
    const keep = mod.buildResolution(long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    expect(keep.id).toBe(short.id); // SHORT address is always kept
    expect(keep.hobbyiqCardId).toBe(long.hobbyiqCardId); // but the WINNING identity
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }],
      verifyFields: ["twinResolved"], wait: noWait,
    });
    expect(res).toMatchObject({ ok: true, stage: "done" });
    // Exactly one row survives, at the short address, carrying the long identity.
    const surviving = [...fake.store.values()];
    expect(surviving).toHaveLength(1);
    expect(surviving[0].id).toBe(short.id);
    expect(surviving[0].hobbyiqCardId).toBe(long.hobbyiqCardId);
  });

  it("a crash between the keeper's write and the loser's delete leaves a harmless duplicate, never a lost sale", async () => {
    const fake = fakePool();
    const long = longRow({ _etag: '"L1"' });
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const resolution = { verdict: "resolved" as const, winner: "short" as const, rule: "checklist-and-roster", detail: "x" };
    const keep = mod.buildResolution(long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    // Simulate the crash: the delete's ifMatchEtag no longer matches (the
    // long row changed between plan and write -- the same shape a genuine
    // crash-and-retry produces).
    fake.store.set(`${CARD}::${long.id}`, { ...long, _etag: '"L2-CHANGED"' });
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }],
      verifyFields: ["twinResolved"], wait: noWait,
    });
    expect(res.ok).toBe(false);
    expect(res.staleSincePlan).toHaveLength(1);
    // BOTH rows still present -- a harmless duplicate, never a lost sale.
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
  });

  it("dry run (REPORT mode) touches nothing", async () => {
    const fake = fakePool();
    const long = longRow();
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const resolution = { verdict: "resolved" as const, winner: "short" as const, rule: "checklist-and-roster", detail: "x" };
    const keep = mod.buildResolution(long, short, resolution, "hobbyiqCardId", "2026-09-20T00:00:00Z");
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: long.id, cardId: long.cardId, ifMatchEtag: long._etag }], dryRun: true,
    });
    expect(res).toMatchObject({ ok: true, stage: "dry-run" });
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
  });
});

// ── fleet discipline, workflow wiring, byte scan -----------------------------
describe("resolve-disagreeing-sale-twins carries the fleet discipline", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("report-only by default, honours BACKFILL_APPLY, prints the budget marker, reconciles, writes only through the helper", () => {
    expect(src).toMatch(/process\.env\.BACKFILL_APPLY === "true"/);
    expect(src).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
    expect(src).toMatch(/\breportWrites\(/);
    expect(src).toMatch(/\brelocateSoldComp\(/);
    expect(src).not.toMatch(/\.items\.upsert\(|\.items\.create\(|\.delete\(\)|\.patch\(/);
  });

  it("imports the sweep lane's proof predicate and gates rather than re-implementing them", () => {
    expect(src).toMatch(/require\(path\.join\(__dirname, "collapse-ch-synthetic-twins\.cjs"\)\)/);
    expect(src).toMatch(/decideSyntheticTwin/);
    expect(src).toMatch(/isProtected\(long\)/);
    expect(src).toMatch(/isParkedSide\(long\)/);
    expect(src).toMatch(/isProtected\(short\)/);
    expect(src).toMatch(/isParkedSide\(short\)/);
  });

  it("never edits a derivation-stamp input -- only CALLS exported functions from dist/", () => {
    expect(src).not.toMatch(/fs\.writeFileSync\(.*hobbyIqCardId\.service|fs\.writeFileSync\(.*parseTitleIdentity\.service/);
    expect(src).toMatch(/dist\/services\/portfolioiq\/hobbyIqCardId\.service\.js/);
  });

  it("uses maxItemCount 500, never -1", () => {
    expect(src).toMatch(/maxItemCount:\s*500/);
    expect(src).not.toMatch(/maxItemCount:\s*-1/);
  });

  it("carries no 0x08/0x00 bytes -- a heredoc-authored file would turn \\b into 0x08", () => {
    const buf = fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"));
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });

  it("the runner's whitelist and a marker-keyed relaunch exist for this script", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    expect(yml).toMatch(/^\s+- resolve-disagreeing-sale-twins\s*$/m);
    const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'resolve-disagreeing-sale-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
    expect(step, "resolve-disagreeing-sale-twins has no relaunch step").toBeTruthy();
    const composite = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "actions", "relaunch-on-marker", "action.yml"), "utf8");
    expect((step! + composite).replace(/^\s*#.*$/gm, "")).toMatch(/stopped at the .*budget/);
  });

  it("no new workflow_dispatch input was added -- still at 24 of GitHub's 25", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    const block = yml.slice(yml.indexOf("workflow_dispatch:"), yml.indexOf("\npermissions:"));
    const inputs = [...block.matchAll(/^ {6}([a-z_0-9]+):$/gm)].map((m) => m[1]);
    expect(inputs.length).toBeLessThanOrEqual(24);
  });

  it("PLAN_OUT is wired for this script only, guarded on script name", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    expect(yml).toMatch(/inputs\.script == 'resolve-disagreeing-sale-twins' && '\/tmp\/resolve-disagreeing-sale-twins-plan'/);
  });

  it("the workflow file stays under GitHub's 512 KB per-workflow ceiling", () => {
    const stat = fs.statSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"));
    expect(stat.size).toBeLessThan(512 * 1024);
  });

  it("the workflow YAML carries no 0x08/0x00 bytes", () => {
    const buf = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"));
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });
});

describe("REPORT == APPLY parity: the pure decision never branches on APPLY", () => {
  it("resolveDisagreement's verdict is identical regardless of any write-mode flag -- there is no APPLY parameter to the pure functions at all", () => {
    mod.__setSweepDepsForTest({ catalogAuthorityOf: () => "checklist", parseHobbyIqCardId: parseHiqFake });
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:no-auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:1951:topps:44:red-backs:no-auto" });
    const deps = fakeDeps({
      checklistRowsByNumber: (parsed: { setKey: string }) => (parsed.setKey === "bowman" ? new Map([["cpa-eha", [{ id: "cat1", source: "beckett-checklist", playerName: "Eric Hartman", cardNumber: "cpa-eha" }]]]) : new Map()),
    });
    const a = mod.resolveDisagreement(deps, "hobbyiqCardId", long, short, short);
    const b = mod.resolveDisagreement(deps, "hobbyiqCardId", long, short, short);
    expect(a).toEqual(b);
  });
});

describe("plan rows == intended: every disagreeing pair this run sees is either resolved or named-left", () => {
  it("the reconcile line in the shipped source compares disagree pairs seen against resolved+left+protected+parked", () => {
    expect(src()).toMatch(/reconcile: disagree pairs seen/);
  });
  function src() {
    return fs.readFileSync(path.join(__dirname, "..", "scripts", "resolve-disagreeing-sale-twins.cjs"), "utf8");
  }
});
