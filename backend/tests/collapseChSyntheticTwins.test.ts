/**
 * CF-CH-DAILY-DOUBLE-WRITE (2026-09-20) -- the #2357 follow-up sweep.
 *
 * #2357 fixed backfill-sold-comps-from-ch.cjs going forward: every new CH
 * daily sale now writes CardHedge's own vendor sale id
 * (`cardhedge::ch-daily::<price_history_id>`) instead of a SYNTHETIC id
 * (`cardhedge::ch-daily::<chCardId>::<soldAt>::<priceCents>`). ~35% of
 * sampled September rows already carry a twin under the two shapes in the
 * SAME cardId partition. collapse-ch-synthetic-twins.cjs is the sweep that
 * retires the long (synthetic) row once a twin is PROVEN, keeping the short
 * (canonical) row every other writer produces.
 *
 * These tests pin: the pure id-shape parsers, the pure pairing/verdict
 * decision (proven pair / ambiguous-multi-sale-day / twins-disagree /
 * not-a-match), and the ONE write helper (relocate-sold-comp.cjs) against a
 * fake Cosmos container that enforces etag/IfMatch on delete -- same
 * discipline as d19.poolKeepsEverySaleOnce.test.ts's own CH-dual-id section.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(__filename);
const ch = require("../scripts/collapse-ch-synthetic-twins.cjs");
const lib = require("../scripts/lib/relocate-sold-comp.cjs");

const CHID = "1778542173652x303328120692600800";
const CARD = CHID; // sold_comps partitions on cardId; the CH card id IS the partition here

const longId = (soldAt: string, cents: number) => `cardhedge::ch-daily::${CHID}::${soldAt}::${cents}`;
const shortId = (priceHistoryId: string) => `cardhedge::ch-daily::${priceHistoryId}`;

const longRow = (over: Record<string, unknown> = {}) => ({
  id: longId("2026-07-03T01:19:00+00:00", 14000),
  cardId: CARD, source: "cardhedge", sourceExternalId: null,
  soldAt: "2026-07-03T01:19:00+00:00", price: 140,
  hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto",
  title: "2026 Bowman Baseball #CPA-EHA Base", parallel: "Base", isAuto: true,
  gradeCompany: null, gradeValue: null, cardNumber: "cpa-eha", imageUrl: "https://i.ebayimg.com/x.jpg",
  printRun: null, verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false,
  _etag: '"long-etag-1"',
  ...over,
});
const shortRow = (over: Record<string, unknown> = {}) => ({
  id: shortId("9931002211"),
  cardId: CARD, source: "cardhedge", sourceExternalId: "ch-daily::9931002211",
  soldAt: "2026-07-03T01:19:00Z", price: 140,
  hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto",
  title: "2026 Bowman #CPA-EHA Eric Hartman Base", parallel: "Base", isAuto: true,
  gradeCompany: null, gradeValue: null, cardNumber: "cpa-eha", imageUrl: null,
  printRun: null, verifiedByUser: false, flaggedWrong: false, excludedFromFmv: false,
  _etag: '"short-etag-1"',
  ...over,
});

describe("id-shape parsers", () => {
  it("parses the long synthetic shape and rejects the canonical shape", () => {
    expect(ch.parseLongSyntheticId(longRow().id)).toEqual({
      chCardId: CHID, soldAt: "2026-07-03T01:19:00+00:00", priceCents: 14000,
    });
    expect(ch.parseLongSyntheticId(shortRow().id)).toBeNull();
    // ch-comp:: is a DIFFERENT prefix (collapse-ch-dual-ids.cjs's own pair
    // shape, not this lane's) -- never mistaken for the ch-daily:: synthetic
    // shape this lane parses.
    expect(ch.parseLongSyntheticId("cardhedge::ch-comp::x::y::100")).toBeNull();
    expect(ch.parseLongSyntheticId("something-else")).toBeNull();
  });
  it("recognises the canonical shape only", () => {
    expect(ch.isCanonicalChDailyId(shortRow().id)).toBe(true);
    expect(ch.isCanonicalChDailyId(longRow().id)).toBe(false);
    expect(ch.isCanonicalChDailyId("cardhedge::ch-comp::abc")).toBe(false);
  });
  it("date-only soldAt segments are distinguished from unparseable ones", () => {
    expect(ch.parseInstant("2026-07-03T01:19:00+00:00")).toMatchObject({ ok: true, day: "2026-07-03" });
    expect(ch.parseInstant("2026-07-03")).toMatchObject({ ok: false, dateOnly: true, day: "2026-07-03" });
    expect(ch.parseInstant("not-a-date")).toMatchObject({ ok: false, dateOnly: false });
  });
  it("instant equality normalises +00:00 / Z / .000Z", () => {
    expect(ch.sameInstant("2026-07-03T01:19:00+00:00", "2026-07-03T01:19:00Z")).toBe(true);
    expect(ch.sameInstant("2026-07-03T01:19:00.000Z", "2026-07-03T01:19:00Z")).toBe(true);
    expect(ch.sameInstant("2026-07-03T01:19:00Z", "2026-07-03T01:20:00Z")).toBe(false);
  });
});

describe("decideSyntheticTwin: the proof predicate", () => {
  it("a proven pair collapses onto the SHORT row, carrying long-only repair state", () => {
    const long = longRow({ rekeyedAt: "2026-09-01T00:00:00Z", rekeyedFrom: [{ id: "old" }] });
    const short = shortRow({ hobbyiqCardId: null }); // short lacks the slug the long row carries
    const d = ch.decideSyntheticTwin(long, short, { now: "2026-09-20T00:00:00Z" });
    expect(d.verdict).toBe("collapse");
    expect(d.keep.id).toBe(short.id); // SHORT always wins
    expect(d.keep.hobbyiqCardId).toBe(long.hobbyiqCardId); // folded: short lacked one
    expect(d.keep.rekeyedAt).toBe("2026-09-01T00:00:00Z"); // folded
    expect(d.drop).toEqual({ id: long.id, cardId: CARD });
    expect(d.keep.collapsedFrom).toMatchObject({ id: long.id, soldAt: long.soldAt });
    expect(d.keep.collapsedAt).toBe("2026-09-20T00:00:00Z");
    expect(d.folded).toEqual(expect.arrayContaining(["hobbyiqCardId", "rekeyedAt", "rekeyedFrom"]));
  });

  it("never overwrites a value the SHORT row already has", () => {
    const long = longRow({ imageUrl: "https://long.example/x.jpg" });
    const short = shortRow({ imageUrl: "https://short.example/y.jpg" });
    const d = ch.decideSyntheticTwin(long, short);
    expect(d.verdict).toBe("collapse");
    // imageUrl is not in CARRY_FIELDS, but title/hobbyiqCardId ARE and both
    // rows already have one -- prove foldMissing left the short's own value.
    expect(d.keep.title).toBe(short.title);
    expect(d.keep.imageUrl).toBe(short.imageUrl);
  });

  it("a chCardId embedded in the long id that does not match the partition's own cardId is not a match", () => {
    const long = longRow({ id: longId("2026-07-03T01:19:00+00:00", 14000).replace(CHID, "some-other-card-id") });
    const short = shortRow();
    expect(ch.decideSyntheticTwin(long, short)).toEqual({ verdict: "not-a-match" });
  });

  it("a price mismatch (cents) is not a match", () => {
    const long = longRow();
    const short = shortRow({ price: 141 });
    expect(ch.decideSyntheticTwin(long, short)).toEqual({ verdict: "not-a-match" });
  });

  it("a soldAt that denotes a different instant is not a match", () => {
    const long = longRow();
    const short = shortRow({ soldAt: "2026-07-03T02:19:00Z" });
    expect(ch.decideSyntheticTwin(long, short)).toEqual({ verdict: "not-a-match" });
  });

  it("a hobbyiqCardId disagreement refuses as twins-disagree, never guessed past", () => {
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto" });
    const d = ch.decideSyntheticTwin(long, short);
    expect(d).toMatchObject({
      verdict: "twins-disagree", axis: "hobbyiqCardId",
      longValue: long.hobbyiqCardId, shortValue: short.hobbyiqCardId,
    });
  });

  it("a grade disagreement refuses as twins-disagree", () => {
    const long = longRow({ gradeCompany: "PSA", gradeValue: 10 });
    const short = shortRow({ gradeCompany: "BGS", gradeValue: 9 });
    const d = ch.decideSyntheticTwin(long, short);
    expect(d).toMatchObject({ verdict: "twins-disagree", axis: "grade" });
  });

  it("RAW is a grade too -- one side raw, the other graded, still disagrees", () => {
    const long = longRow({ gradeCompany: null, gradeValue: null });
    const short = shortRow({ gradeCompany: "PSA", gradeValue: 9 });
    expect(ch.decideSyntheticTwin(long, short)).toMatchObject({ verdict: "twins-disagree", axis: "grade" });
  });

  it("a date-only long soldAt collapses ONLY when unique on (day, price) on BOTH sides", () => {
    const long = longRow({ id: longId("2026-07-03", 14000) });
    const short = shortRow({ soldAt: "2026-07-03T09:00:00Z" });
    // unique on both sides (dayCounts/longDayCounts both count 1 for this key)
    const dayCounts = new Map([["2026-07-03|14000", 1]]);
    const longDayCounts = new Map([["2026-07-03|14000", 1]]);
    const d = ch.decideSyntheticTwin(long, short, { dayCounts, longDayCounts });
    expect(d.verdict).toBe("collapse");
    expect(d.dateOnlyPath).toBe(true);
  });

  it("several real sales same day+price -- date-only long soldAt is ambiguous, never collapsed", () => {
    const long = longRow({ id: longId("2026-07-03", 14000) });
    const short = shortRow({ soldAt: "2026-07-03T09:00:00Z" });
    const dayCounts = new Map([["2026-07-03|14000", 2]]); // two short rows this day+price
    const longDayCounts = new Map([["2026-07-03|14000", 1]]);
    expect(ch.decideSyntheticTwin(long, short, { dayCounts, longDayCounts })).toEqual({ verdict: "ambiguous-multi-sale-day" });
  });

  it("several long rows on the same day+price is ALSO ambiguous, even if only one short row exists", () => {
    const long = longRow({ id: longId("2026-07-03", 14000) });
    const short = shortRow({ soldAt: "2026-07-03T09:00:00Z" });
    const dayCounts = new Map([["2026-07-03|14000", 1]]);
    const longDayCounts = new Map([["2026-07-03|14000", 2]]); // two long rows this day+price
    expect(ch.decideSyntheticTwin(long, short, { dayCounts, longDayCounts })).toEqual({ verdict: "ambiguous-multi-sale-day" });
  });
});

describe("isProtected: never touched, either direction", () => {
  it("verifiedByUser / flaggedWrong / excludedFromFmv / pinned are all protected", () => {
    expect(ch.isProtected({ verifiedByUser: true })).toBe(true);
    expect(ch.isProtected({ flaggedWrong: true })).toBe(true);
    expect(ch.isProtected({ excludedFromFmv: true })).toBe(true);
    expect(ch.isProtected({ pinned: true })).toBe(true);
    expect(ch.isProtected({})).toBe(false);
  });
});

// ── the one write helper, fake Cosmos with etag/IfMatch enforcement ─────────
type Fake = { store: Map<string, Record<string, unknown>>; calls: Record<string, number>; container: unknown };
function fakePool(): Fake {
  const store = new Map<string, Record<string, unknown>>();
  const calls = { upsert: 0, delete: 0, read: 0, query: 0 };
  const key = (id: string, pk: string) => `${pk}::${id}`;
  const nf = () => Object.assign(new Error("not found"), { code: 404 });
  const container = {
    items: {
      async upsert(doc: Record<string, unknown>) {
        calls.upsert++;
        const k = key(String(doc.id), String(doc.cardId));
        store.set(k, structuredClone(doc));
        return { resource: doc };
      },
      query(spec: { parameters?: { name: string; value: unknown }[] }) {
        return {
          async fetchAll() {
            calls.query++;
            const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
            const resources = [...store.values()].filter((d) => d.id === p["@id"] && d.cardId === p["@pk"]);
            return { resources };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read() {
          calls.read++;
          const d = store.get(key(id, pk));
          if (!d) throw nf();
          return { resource: d };
        },
        async delete(options?: { accessCondition?: { type: string; condition: string } }) {
          calls.delete++;
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
  return { store, calls, container };
}
const noWait = async () => {};

describe("collapse-ch-synthetic-twins: the write path via relocateSoldComp", () => {
  it("a proven pair collapses: keeps the short row (with carried state), deletes the long row", async () => {
    const fake = fakePool();
    const long = longRow({ rekeyedAt: "2026-09-01T00:00:00Z", _etag: '"L1"' });
    const short = shortRow({ hobbyiqCardId: null });
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const d = ch.decideSyntheticTwin(long, short, { now: "2026-09-20T00:00:00Z" });
    expect(d.verdict).toBe("collapse");
    const res = await lib.relocateSoldComp(fake.container, {
      keep: d.keep, drop: [{ ...d.drop, ifMatchEtag: long._etag }],
      verifyFields: ["collapsedAt"], wait: noWait,
    });
    expect(res).toMatchObject({ ok: true, stage: "done" });
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(false);
    expect(fake.store.get(`${CARD}::${short.id}`)?.rekeyedAt).toBe("2026-09-01T00:00:00Z");
  });

  it("multi-sale-day is LEFT: the pure decision never reaches the write path", () => {
    const long = longRow({ id: longId("2026-07-03", 14000) });
    const short = shortRow({ soldAt: "2026-07-03T09:00:00Z" });
    const d = ch.decideSyntheticTwin(long, short, {
      dayCounts: new Map([["2026-07-03|14000", 2]]),
      longDayCounts: new Map([["2026-07-03|14000", 1]]),
    });
    expect(d.verdict).toBe("ambiguous-multi-sale-day");
    // nothing to relocate -- the caller's own loop `continue`s on this verdict
  });

  it("a disagreeing pair is LEFT: reported, both values named, nothing written", () => {
    const long = longRow({ hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto" });
    const short = shortRow({ hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto" });
    const d = ch.decideSyntheticTwin(long, short);
    expect(d.verdict).toBe("twins-disagree");
    expect(d.longValue).toBe(long.hobbyiqCardId);
    expect(d.shortValue).toBe(short.hobbyiqCardId);
  });

  it("a protected long row is never handed to decideSyntheticTwin by the caller's own guard", () => {
    // This test pins the STANDALONE predicate; the main() loop's own
    // isProtected(long) check (before any candidate matching) is what
    // actually keeps a protected row out of the decision -- see the source
    // pin below for proof the guard exists in the shipped file.
    expect(ch.isProtected(longRow({ verifiedByUser: true }))).toBe(true);
  });

  it("a STALE etag (changed since the plan read) refuses the delete via 412, keeping both rows", async () => {
    const fake = fakePool();
    const long = longRow({ _etag: '"L1"' });
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, { ...long, _etag: '"L2-CHANGED"' }); // resident etag differs from the plan-time one
    fake.store.set(`${CARD}::${short.id}`, short);
    const d = ch.decideSyntheticTwin(long, short);
    const res = await lib.relocateSoldComp(fake.container, {
      keep: d.keep, drop: [{ ...d.drop, ifMatchEtag: long._etag }], // stale plan-time etag "L1"
      verifyFields: [], wait: noWait,
    });
    expect(res.ok).toBe(false);
    expect(res.staleSincePlan).toHaveLength(1);
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(true); // NOT deleted
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
  });

  it("dry run (REPORT mode) touches nothing", async () => {
    const fake = fakePool();
    const long = longRow();
    const short = shortRow();
    fake.store.set(`${CARD}::${long.id}`, long);
    fake.store.set(`${CARD}::${short.id}`, short);
    const d = ch.decideSyntheticTwin(long, short);
    const res = await lib.relocateSoldComp(fake.container, {
      keep: d.keep, drop: [{ ...d.drop, ifMatchEtag: long._etag }], dryRun: true,
    });
    expect(res).toMatchObject({ ok: true, stage: "dry-run" });
    expect(fake.calls).toMatchObject({ upsert: 0, delete: 0 });
    expect(fake.store.has(`${CARD}::${long.id}`)).toBe(true);
    expect(fake.store.has(`${CARD}::${short.id}`)).toBe(true);
  });
});

// ── fleet discipline: report-only default, budget marker, reconcile, writes
// only through the one helper, and the workflow's whitelist + relaunch step
// (SAME pattern d19.poolKeepsEverySaleOnce.test.ts pins for its two sibling
// lanes) ──────────────────────────────────────────────────────────────────
describe("collapse-ch-synthetic-twins carries the fleet discipline", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "collapse-ch-synthetic-twins.cjs"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("report-only by default, honours BACKFILL_APPLY, prints the budget marker, reconciles, writes only through the helper", () => {
    expect(src).toMatch(/process\.env\.BACKFILL_APPLY === "true"/);
    expect(src).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
    expect(src).toMatch(/\breportWrites\(/);
    expect(src).toMatch(/\brelocateSoldComp\(/);
    // no hand-rolled write: every upsert / delete lives in the helper
    expect(src).not.toMatch(/\.items\.upsert\(|\.items\.create\(|\.delete\(\)|\.patch\(/);
  });

  it("never touches a protected row -- both isProtected call sites exist in the shipped file", () => {
    expect(src).toMatch(/isProtected\(long\)/);
    expect(src).toMatch(/isProtected\(s\)|isProtected\(short\)/);
  });

  it("the runner's whitelist and a marker-keyed relaunch exist for this script", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
    expect(yml).toMatch(/^\s+- collapse-ch-synthetic-twins\s*$/m);
    const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes("inputs.script == 'collapse-ch-synthetic-twins'") && /gh workflow run backfill-runner\.yml/.test(st));
    expect(step, "collapse-ch-synthetic-twins has no relaunch step").toBeTruthy();
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
    expect(yml).toMatch(/inputs\.script == 'collapse-ch-synthetic-twins' && '\/tmp\/collapse-ch-synthetic-twins-plan'/);
  });

  it("uses maxItemCount 500, never -1, on both the population and the per-partition walk", () => {
    expect(src).toMatch(/maxItemCount:\s*500/);
    expect(src).not.toMatch(/maxItemCount:\s*-1/);
  });

  it("carries no 0x08/0x00 bytes -- a heredoc-authored file would turn \\b into 0x08", () => {
    const buf = fs.readFileSync(path.join(__dirname, "..", "scripts", "collapse-ch-synthetic-twins.cjs"));
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });
});
