/**
 * CF-THE-POOL-KEEPS-EVERY-SALE-ONCE (D19, 2026-08-30).
 *
 * The D14 probe found the pool holding the same real transaction twice (the
 * eBay import's `holding::` row and the poll's item-id row), user sales keyed
 * by their timestamp under a vendor partition, and the same CardHedge sale
 * under both `ch-daily::` and `ch-comp::` ids. Two scripts fix the stored
 * rows; the live writers were fixed by D9 / D12-a. These tests pin the pure
 * decisions those scripts make and the ONE helper through which a row ever
 * changes its key -- create, verify, then delete -- against a fake container
 * that fails on command.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { purchaseSaleIdentity } from "../src/services/portfolioiq/ebayAutoHolding.service.js";

const require = createRequire(__filename);
const rekey = require("../scripts/rekey-user-comps.cjs");
const ch = require("../scripts/collapse-ch-dual-ids.cjs");
const lib = require("../scripts/lib/relocate-sold-comp.cjs");

// ── fixtures: one user, one imported holding, one manual sale ──────────────
const U1 = "user-aaaa";
const VENDOR = "1778542140951x283396404010038530";
const NUM = "hiq:baseball:2026:bowman-chrome:cpa-ba:refractor:auto:num-499";
const UNNUM = "hiq:baseball:2026:bowman-chrome:cpa-ba:refractor:auto";
const ORDER = "366593705490-10084007307712", ITEM = "366593705490";
const H1 = { id: "h1", cardId: VENDOR, hobbyiqCardId: NUM, ebayOrderId: ORDER, ebayItemId: ITEM, sourcePurchaseId: "p1", purchasePrice: 74.86, purchaseDate: "2026-08-08T14:21:33.869Z", printRun: 499, playerName: "Brailyn Antunez" };
const P1 = { id: "p1", userId: U1, ebayOrderId: ORDER, ebayItemId: ITEM, subtotal: 64, totalCost: 74.86, purchaseDate: "2026-08-08T14:21:33.869Z", holdingIds: ["h1"], source: "ebay" };
const L1 = { id: "l1", holdingId: "h1", unitSalePrice: 100, soldAt: "2026-08-10T12:00:00.000Z", source: "manual" };
const SCORE = "hiq:baseball:1991:score:396:base:no-auto";
const H2 = { id: "h2", cardId: SCORE, hobbyiqCardId: SCORE, purchasePrice: 183.75, purchaseDate: "2026-07-31T04:09:15.193Z" };
const docs = [{ id: U1, userId: U1, holdings: { h1: H1, h2: H2 }, purchases: [P1], ledger: [L1] }];
const idx = rekey.buildPortfolioIndex(docs);
const catalog = new Set([NUM, UNNUM, SCORE]);

const row = (over: Record<string, unknown>) => ({
  id: "x", cardId: VENDOR, hobbyiqCardId: UNNUM, source: rekey.PURCHASE, sourceExternalId: null, contributorUserId: null,
  price: 74.86, soldAt: "2026-08-08T14:21:33.869Z", title: "2026 Bowman Chrome Brailyn Antunez", parallel: "Refractor", isAuto: true,
  gradeCompany: null, gradeValue: null, verifiedByUser: false, observedAt: "2026-08-11T00:00:00Z", ...over,
});
const R_HOLDING = row({ id: `ebay-user-purchase::holding::h1`, sourceExternalId: "holding::h1" });
const R_ITEM = row({ id: `ebay-user-purchase::${ITEM}`, cardId: NUM, sourceExternalId: ITEM, price: 64, contributorUserId: U1, verifiedByUser: true, observedAt: "2026-08-12T00:00:00Z" });
const R_SALE = row({ id: `ebay-user-sale::${VENDOR}::2026-08-10T12:00:00.000Z`, source: rekey.SALE, sourceExternalId: null, price: 100, soldAt: "2026-08-10T12:00:00.000Z", contributorUserId: U1 });

function derive(r: Record<string, unknown>, held = catalog) {
  const link = rekey.linkRowToHolding(r, idx);
  return rekey.deriveUserRowIdentity(r, link, rekey.resolveSlug(r, link, held), { purchaseSaleIdentity });
}

describe("D19 rekey: linking a pool row to the holding it came from", () => {
  it("a holding:: key names the holding; the purchase record comes with it", () => {
    const link = rekey.linkRowToHolding(R_HOLDING, idx);
    expect(link.ok).toBe(true);
    expect(link.via).toBe("holding-id");
    expect(link.holding.id).toBe("h1");
    expect(link.purchase.id).toBe("p1");
  });
  it("an eBay item id finds the holding that carries it", () => {
    const link = rekey.linkRowToHolding(R_ITEM, idx);
    expect(link.ok).toBe(true);
    expect(link.via).toBe("ebay item id");
    expect(link.holding.id).toBe("h1");
  });
  it("a timestamp-keyed sale links through the ledger entry with the same instant and price", () => {
    const link = rekey.linkRowToHolding(R_SALE, idx);
    expect(link.ok).toBe(true);
    expect(link.via).toBe("ledger");
    expect(link.ledgerEntry.id).toBe("l1");
    expect(link.holding.id).toBe("h1");
  });
  it("a sale at another price is no link, not a near miss", () => {
    expect(rekey.linkRowToHolding({ ...R_SALE, price: 101 }, idx)).toEqual({ ok: false, reason: "no-ledger-link" });
  });
  it("a holding:: key whose holding is gone is a counted reason", () => {
    expect(rekey.linkRowToHolding(row({ sourceExternalId: "holding::ghost" }), idx)).toEqual({ ok: false, reason: "holding-gone" });
  });
  it("an unknown key shape links by card + price + purchase day, only when unique", () => {
    const r = row({ sourceExternalId: "batch-backfill::z", cardId: SCORE, hobbyiqCardId: SCORE, price: 183.75, soldAt: "2026-07-31T09:00:00Z", contributorUserId: U1 });
    const link = rekey.linkRowToHolding(r, idx);
    expect(link.ok).toBe(true);
    expect(link.via).toBe("attributes");
    expect(link.holding.id).toBe("h2");
    expect(rekey.linkRowToHolding({ ...r, price: 1 }, idx)).toEqual({ ok: false, reason: "no-holding-link" });
  });
});

describe("D19 rekey: the identity the live writers would give the row", () => {
  it("a purchase takes D9's order-id key and subtotal, and D12-a's pinned slug", () => {
    const id = derive(R_HOLDING);
    expect(id.ok).toBe(true);
    expect(id.id).toBe(`ebay-user-purchase::${ORDER}`);
    expect(id.cardId).toBe(NUM);
    expect(id.hobbyiqCardId).toBe(NUM);
    expect(id.sourceExternalId).toBe(ORDER);
    expect(id.price).toBe(64);
    expect(id.keyVia).toBe("purchaseSaleIdentity");
    expect(id.slugVia).toBe("holding.hobbyiqCardId");
    expect(id.contributorUserId).toBe(U1);
    expect(id.vendorCardId).toBe(VENDOR);
  });
  it("the same transaction under the item id derives the same target", () => {
    const a = derive(R_HOLDING), b = derive(R_ITEM);
    expect([b.id, b.cardId]).toEqual([a.id, a.cardId]);
  });
  it("falls to the row's own slug when the catalog does not hold the holding's pin", () => {
    const id = derive(R_HOLDING, new Set([UNNUM]));
    expect(id.ok).toBe(true);
    expect(id.cardId).toBe(UNNUM);
    expect(id.slugVia).toBe("row.hobbyiqCardId");
  });
  it("is UNRESOLVED, with the reason, when the catalog holds none of the candidates", () => {
    expect(derive(R_HOLDING, new Set())).toEqual({ ok: false, reason: "slug-not-in-catalog" });
    expect(derive(row({ sourceExternalId: "holding::ghost", hobbyiqCardId: null }))).toEqual({ ok: false, reason: "no-identity" });
  });
  it("a holding-gone row still re-homes on its own catalog-held slug, key kept", () => {
    const id = derive(row({ sourceExternalId: "holding::ghost" }));
    expect(id.ok).toBe(true);
    expect(id.cardId).toBe(UNNUM);
    expect(id.sourceExternalId).toBe("holding::ghost");
    expect(id.keyVia).toBe("kept");
  });
  it("refuses to move a sale off a catalog-held slug on the word of a two-minded holding", () => {
    // the holding's cardId and hobbyiqCardId are both hiq and disagree; the
    // row already sits under a slug the catalog holds -> leave it alone
    const two = { ...H1, cardId: NUM, hobbyiqCardId: UNNUM };
    const idx2 = rekey.buildPortfolioIndex([{ id: U1, userId: U1, holdings: { h1: two }, purchases: [P1], ledger: [] }]);
    const r = row({ sourceExternalId: "holding::h1", cardId: NUM, hobbyiqCardId: NUM });
    const link = rekey.linkRowToHolding(r, idx2);
    expect(rekey.resolveSlug(r, link, catalog)).toEqual({ ok: false, reason: "holding-two-identities" });
    // ... but a row under a VENDOR id follows the pin: any identity beats none
    const v = row({ sourceExternalId: "holding::h1" });
    expect(rekey.resolveSlug(v, rekey.linkRowToHolding(v, idx2), catalog)).toEqual({ ok: true, slug: UNNUM, via: "holding.hobbyiqCardId" });
  });
  it("a sale keys by the ledger's order id, then the holding's ids, then the timestamp", () => {
    const viaHolding = derive(R_SALE);
    expect(viaHolding.id).toBe(`ebay-user-sale::${ORDER}`);
    expect(viaHolding.keyVia).toBe("holding.ebayOrderId");
    const idx3 = rekey.buildPortfolioIndex([{ id: U1, userId: U1, holdings: { h1: { ...H1, ebayOrderId: undefined, ebayItemId: undefined } }, purchases: [], ledger: [{ ...L1, ebayOrderId: "99-00000-00001" }, { ...L1, id: "l2", soldAt: "2026-08-11T12:00:00.000Z" }] }]);
    const viaLedger = rekey.deriveUserRowIdentity(R_SALE, rekey.linkRowToHolding(R_SALE, idx3), { ok: true, slug: NUM, via: "t" }, { purchaseSaleIdentity });
    expect(viaLedger.id).toBe("ebay-user-sale::99-00000-00001");
    const r2 = { ...R_SALE, soldAt: "2026-08-11T12:00:00.000Z" };
    const ts = rekey.deriveUserRowIdentity(r2, rekey.linkRowToHolding(r2, idx3), { ok: true, slug: NUM, via: "t" }, { purchaseSaleIdentity });
    expect(ts.id).toBe(`ebay-user-sale::${NUM}::2026-08-11T12:00:00.000Z`);
    expect(ts.sourceExternalId).toBeNull();
    expect(ts.keyVia).toBe("timestamp");
  });
});

describe("D19 rekey: one target, its rows, and what varied", () => {
  const target = { id: `ebay-user-purchase::${ORDER}`, cardId: NUM };
  const members = [{ row: R_HOLDING, identity: derive(R_HOLDING) }, { row: R_ITEM, identity: derive(R_ITEM) }];
  it("the import row and the poll row collapse to one; what varied is on the plan", () => {
    const plan = rekey.planGroup({ target, members, existing: null }, "2026-08-30T00:00:00Z");
    expect(plan.kind).toBe("collapse");
    expect(plan.variance.differing).toEqual(expect.arrayContaining(["cardId", "sourceExternalId", "price", "verifiedByUser", "contributorUserId"]));
    expect(plan.keep.id).toBe(target.id);
    expect(plan.keep.cardId).toBe(NUM);
    expect(plan.keep.hobbyiqCardId).toBe(NUM);
    expect(plan.keep.sourceExternalId).toBe(ORDER);
    expect(plan.keep.price).toBe(64);
    expect(plan.keep.verifiedByUser).toBe(true); // the richer row was kept
    expect(plan.keep.contentHash).toBe(lib.contentHashOf(plan.keep));
    expect(plan.keep.rekeyedAt).toBe("2026-08-30T00:00:00Z");
    expect(plan.keep.rekeyedFrom.map((t: { id: string }) => t.id).sort()).toEqual([R_HOLDING.id, R_ITEM.id].sort());
    expect(plan.drops).toHaveLength(2);
    expect(plan.creates).toBe(true);
  });
  it("a lone row off its target is a re-key; on its target it is already canonical", () => {
    const one = rekey.planGroup({ target, members: [members[0]], existing: null });
    expect(one.kind).toBe("rekey");
    expect(one.drops).toEqual([{ id: R_HOLDING.id, cardId: VENDOR }]);
    expect(one.priceCorrected).toEqual({ from: 74.86, to: 64 });
    const at = { ...R_ITEM, id: target.id, cardId: NUM, sourceExternalId: ORDER };
    expect(rekey.planGroup({ target, members: [{ row: at, identity: derive(at) }], existing: at }).kind).toBe("already-canonical");
  });
  it("a document already at the target is the winner; the old rows fold into it", () => {
    const existing = { ...R_ITEM, id: target.id, cardId: NUM, sourceExternalId: ORDER, title: null, _etag: "e" };
    const plan = rekey.planGroup({ target, members: [members[0]], existing });
    expect(plan.kind).toBe("collapse");
    expect(plan.creates).toBe(false);
    expect(plan.keep.title).toBe(R_HOLDING.title); // folded from the old row
    expect(plan.keep._etag).toBeUndefined();
    expect(plan.drops).toEqual([{ id: R_HOLDING.id, cardId: VENDOR }]);
  });
  it("refuses two grades or two parallels: those are two sales", () => {
    const graded = [{ row: { ...R_HOLDING, gradeCompany: "PSA", gradeValue: 10 }, identity: members[0].identity }, { row: { ...R_ITEM, gradeCompany: "BGS", gradeValue: 9 }, identity: members[1].identity }];
    expect(rekey.planGroup({ target, members: graded, existing: null })).toMatchObject({ kind: "refused", reason: "grade-differs" });
    const par = [{ row: { ...R_HOLDING, parallel: "Gold" }, identity: members[0].identity }, { row: { ...R_ITEM, parallel: "Blue Refractor" }, identity: members[1].identity }];
    expect(rekey.planGroup({ target, members: par, existing: null })).toMatchObject({ kind: "refused", reason: "parallel-differs" });
    // D31 (2026-08-30) RETRACTED "Colour ≡ Colour Refractor". There is no
    // colour/finish vocabulary rule; the catalog resolver decides per card, and
    // Topps Finest #197 lists `Uncommon` AND `Uncommon Refractor` as two of
    // ~600 real pairs Drew named. So `Blue` and `Blue Refractor` are now two
    // parallels and this collapse is REFUSED -- the safe direction: refusing
    // leaves two rows a later pass can still merge, while collapsing destroys
    // one card's pool irreversibly.
    const colourPair = [{ row: { ...R_HOLDING, parallel: "Blue" }, identity: members[0].identity }, { row: { ...R_ITEM, parallel: "Blue Refractor", gradeCompany: "BGS", gradeValue: 9 }, identity: members[1].identity }];
    expect(rekey.planGroup({ target, members: colourPair, existing: null })).toMatchObject({ kind: "refused", reason: "parallel-differs" });

    // ...and what this test was really pinning still holds: on ONE parallel, a
    // missing grade FOLDS rather than differing.
    const same = [{ row: { ...R_HOLDING, parallel: "Blue" }, identity: members[0].identity }, { row: { ...R_ITEM, parallel: "Blue", gradeCompany: "BGS", gradeValue: 9 }, identity: members[1].identity }];
    const plan = rekey.planGroup({ target, members: same, existing: null });
    expect(plan.kind).toBe("collapse");
    expect(plan.keep.gradeCompany).toBe("BGS");
  });
  it("CF-A-SALE-IS-NEVER-LOST: after = before - deleted + created", () => {
    expect(rekey.reconcileCounts({ before: 110, after: 105, deleted: 72, created: 67 })).toEqual({ expected: 105, ok: true, drift: 0 });
    expect(rekey.reconcileCounts({ before: 110, after: 104, deleted: 72, created: 67 })).toMatchObject({ ok: false, drift: -1 });
  });
});

// ── CardHedge dual ids ─────────────────────────────────────────────────────
const CHID = "1778542173652x303328120692600800";
const chRow = (over: Record<string, unknown>) => ({
  id: "d", cardId: CHID, source: "cardhedge", sourceExternalId: `ch-daily::${CHID}::2026-07-03T01:19:00+00:00::14000`, price: 140, soldAt: "2026-07-03T01:19:00+00:00",
  hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto", title: "2026 Bowman Baseball #CPA-EHA Base", parallel: "Base", isAuto: true, gradeCompany: null, gradeValue: null,
  cardNumber: "cpa-eha", imageUrl: "https://i.ebayimg.com/x.jpg", printRun: null, ...over,
});
const DAILY = chRow({});
const COMP = chRow({ id: "c", sourceExternalId: `ch-comp::${CHID}::2026-07-03T00:07:00.000Z::14000`, soldAt: "2026-07-03T00:07:00.000Z", hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto", title: "Eric Hartman 1st Bowman Chrome Auto 2026 Bowman #CPA-EHA Atlanta Braves - Raw", cardNumber: "CPA-EHA", imageUrl: null });

describe("D19 collapse: the same CardHedge sale under two ids", () => {
  it("pairs exactly one ch-daily:: with exactly one ch-comp:: on (day, price); more is ambiguous", () => {
    const { pairs, ambiguous, compAlone } = ch.pairUp([DAILY, COMP, chRow({ id: "d2", price: 99 }), chRow({ id: "c2", sourceExternalId: "ch-comp::x", price: 99 }), chRow({ id: "d3", price: 99 }), chRow({ id: "c3", sourceExternalId: "ch-comp::y", price: 5 })]);
    expect(pairs.map((p: { daily: { id: string }; comp: { id: string } }) => [p.daily.id, p.comp.id])).toEqual([["d", "c"]]);
    expect(ambiguous).toEqual([{ key: "2026-07-03|9900", daily: 2, comp: 1 }]);
    expect(compAlone).toBe(1);
  });
  it("prints what varied before deciding, and refuses a differing grade or parallel", () => {
    const graded = ch.decideChCollapse(DAILY, { ...COMP, gradeCompany: "PSA", gradeValue: 9 });
    expect(graded).toMatchObject({ collapse: false, reason: "grade-differs" });
    expect(graded.variance.differing).toEqual(expect.arrayContaining(["soldAt", "title", "hobbyiqCardId", "gradeCompany", "gradeValue"]));
    expect(ch.decideChCollapse(DAILY, { ...COMP, parallel: "Blue Refractor" })).toMatchObject({ collapse: false, reason: "parallel-differs" });
    expect(ch.decideChCollapse({ ...DAILY, parallel: "Refractor" }, { ...COMP, parallel: "Blue Refractor" })).toMatchObject({ collapse: false, reason: "parallel-differs" });
    expect(ch.decideChCollapse(DAILY, { ...COMP, isAuto: false })).toMatchObject({ collapse: false, reason: "auto-differs" });
    expect(ch.decideChCollapse({ ...DAILY, printRun: 50 }, { ...COMP, printRun: 150 })).toMatchObject({ collapse: false, reason: "printrun-differs" });
    expect(ch.decideChCollapse(DAILY, { ...COMP, cardNumber: "39" })).toMatchObject({ collapse: false, reason: "cardnumber-differs" });
  });
  it("D31: Blue and Blue Refractor are TWO cards -- but #CPA-EHA and cpa-eha are still one number", () => {
    // The card-number half of this rule is unchanged: the `#` and the case are
    // formatting. The colour half was RETRACTED by D31 -- a bare colour and its
    // `<colour> Refractor` sibling are separate cards unless the checklist says
    // otherwise, so collapsing them across ids would merge two pools.
    expect(ch.decideChCollapse({ ...DAILY, parallel: "Blue" }, { ...COMP, parallel: "Blue Refractor", cardNumber: "#CPA-EHA" }))
      .toMatchObject({ collapse: false, reason: "parallel-differs" });

    // the number rule on its own, with the parallels agreeing
    expect(ch.decideChCollapse({ ...DAILY, parallel: "Blue" }, { ...COMP, parallel: "Blue", cardNumber: "#CPA-EHA" }).collapse).toBe(true);
  });
  it("keeps the richer identity and folds what it lacks; the other's title and slug ride along", () => {
    // equal on the catalog: the comp row's real listing title outranks the composed one
    const d = ch.decideChCollapse(DAILY, COMP, { now: "2026-08-30T00:00:00Z" });
    expect(d.collapse).toBe(true);
    expect(d.kept).toBe("ch-comp");
    expect(d.keep.id).toBe("c");
    expect(d.keep.imageUrl).toBe(DAILY.imageUrl); // folded
    expect(d.folded).toContain("imageUrl");
    expect(d.drop).toEqual({ id: "d", cardId: CHID });
    expect(d.keep.collapsedFrom).toMatchObject({ id: "d", title: DAILY.title, hobbyiqCardId: DAILY.hobbyiqCardId });
    expect(d.keep.collapsedAt).toBe("2026-08-30T00:00:00Z");
    // a slug the catalog holds outranks a title
    expect(ch.decideChCollapse(DAILY, COMP, { held: { daily: true, comp: false } }).kept).toBe("ch-daily");
    // equal -> the ch-daily row
    const tie = ch.decideChCollapse(DAILY, { ...COMP, title: DAILY.title, imageUrl: DAILY.imageUrl });
    expect(tie.kept).toBe("ch-daily");
  });
});

// ── the one helper ─────────────────────────────────────────────────────────
type Fake = { store: Map<string, Record<string, unknown>>; calls: Record<string, number>; container: unknown };
/**
 * `lagReads` models the Eventual-consistency replica that answers 404 for the
 * first N point-reads of a document it has not caught up with. `blindQuery`
 * models the counterfactual: a fallback that cannot see the row either.
 */
function fakePool(opts: {
  failUpsert?: boolean; failDelete?: "throw" | 404; staleRead?: boolean;
  lagReads?: number; blindQuery?: boolean;
} = {}): Fake {
  const store = new Map<string, Record<string, unknown>>();
  const calls = { upsert: 0, delete: 0, read: 0, query: 0 };
  const key = (id: string, pk: string) => `${pk}::${id}`;
  const nf = () => Object.assign(new Error("not found"), { code: 404 });
  // Only reads of a row written during this run lag; a pre-existing row is
  // already replicated everywhere.
  const lagging = new Set<string>();
  let lagLeft = opts.lagReads ?? 0;
  const container = {
    items: {
      async upsert(doc: Record<string, unknown>) {
        calls.upsert++;
        if (opts.failUpsert) throw new Error("upsert boom");
        const k = key(String(doc.id), String(doc.cardId));
        store.set(k, structuredClone(doc));
        if (lagLeft > 0) lagging.add(k);
        return { resource: doc };
      },
      // The primary. A query is served from an up-to-date replica set, so it
      // sees writes a lagging point-read replica has not caught up with.
      query(spec: { parameters?: { name: string; value: unknown }[] }) {
        return {
          async fetchAll() {
            calls.query++;
            if (opts.blindQuery) return { resources: [] };
            const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
            // Mirrors the helper's query, which no longer names @slug: a
            // row matches on (id, cardId) only. Kept as an OR so a
            // reintroduced @slug clause would still be exercised here.
            const resources = [...store.values()].filter((d) =>
              d.id === p["@id"]
              && (d.cardId === p["@pk"]
                || (p["@slug"] !== undefined && d.hobbyiqCardId === p["@slug"])));
            return { resources };
          },
        };
      },
    },
    item(id: string, pk: string) {
      return {
        async read() {
          calls.read++;
          const k = key(id, pk);
          if (lagging.has(k) && lagLeft > 0) { lagLeft--; if (lagLeft === 0) lagging.delete(k); throw nf(); }
          const d = store.get(k);
          if (!d) throw nf();
          return { resource: opts.staleRead ? { ...d, rekeyedAt: "stale" } : d };
        },
        async delete() { calls.delete++; if (opts.failDelete === "throw") throw new Error("delete boom"); if (opts.failDelete === 404 || !store.has(key(id, pk))) throw nf(); store.delete(key(id, pk)); return {}; },
      };
    },
  };
  return { store, calls, container };
}
/** Drives the helper's backoff without spending real time. */
const noWait = async () => {};
const KEEP = { id: "ebay-user-purchase::o", cardId: NUM, rekeyedAt: "t", price: 64 };
const OLD = { id: "ebay-user-purchase::holding::h1", cardId: VENDOR, price: 74.86 };

describe("D19: the create -> verify -> delete helper never leaves the pool without the sale", () => {
  it("writes the kept row, reads it back, then deletes the old one", async () => {
    const fake = fakePool();
    fake.store.set(`${OLD.cardId}::${OLD.id}`, OLD);
    const res = await lib.relocateSoldComp(fake.container, { keep: KEEP, drop: [OLD], verifyFields: ["rekeyedAt"] });
    expect(res).toMatchObject({ ok: true, stage: "done", existedBefore: false, deleted: [OLD], alreadyGone: [], duplicatesLeft: [] });
    expect(fake.store.has(`${KEEP.cardId}::${KEEP.id}`)).toBe(true);
    expect(fake.store.has(`${OLD.cardId}::${OLD.id}`)).toBe(false);
  });
  it("create fails -> nothing is deleted", async () => {
    const fake = fakePool({ failUpsert: true });
    fake.store.set(`${OLD.cardId}::${OLD.id}`, OLD);
    const res = await lib.relocateSoldComp(fake.container, { keep: KEEP, drop: [OLD] });
    expect(res).toMatchObject({ ok: false, stage: "upsert", deleted: [] });
    expect(fake.calls.delete).toBe(0);
    expect(fake.store.has(`${OLD.cardId}::${OLD.id}`)).toBe(true);
  });
  it("the read-back disagrees with what was written -> nothing is deleted", async () => {
    // EVERY read disagrees, the fallback query included. Since 2026-09-06 a
    // read that does not SHOW THE WRITE is retried past rather than accepted,
    // so a stale point-read alone no longer decides this -- the query would
    // (correctly) rescue it. Blinding the query is what makes this the case
    // it means to be: verification that genuinely cannot succeed.
    const fake = fakePool({ staleRead: true, blindQuery: true });
    fake.store.set(`${OLD.cardId}::${OLD.id}`, OLD);
    const res = await lib.relocateSoldComp(fake.container, { keep: KEEP, drop: [OLD], verifyFields: ["rekeyedAt"], wait: noWait });
    expect(res).toMatchObject({ ok: false, stage: "verify", deleted: [] });
    expect(fake.calls.delete).toBe(0);
  });
  it("delete fails -> the sale is reported as a duplicate, present twice, never retried into a missing row", async () => {
    const fake = fakePool({ failDelete: "throw" });
    fake.store.set(`${OLD.cardId}::${OLD.id}`, OLD);
    const res = await lib.relocateSoldComp(fake.container, { keep: KEEP, drop: [OLD], verifyFields: ["rekeyedAt"] });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("done");
    expect(res.duplicatesLeft).toMatchObject([{ id: OLD.id, cardId: OLD.cardId }]);
    expect(res.deleted).toEqual([]);
    expect(fake.calls.delete).toBe(1);
    expect(fake.store.has(`${KEEP.cardId}::${KEEP.id}`)).toBe(true);
    expect(fake.store.has(`${OLD.cardId}::${OLD.id}`)).toBe(true);
  });
  it("an old row already gone (404) is not a failure and not a deletion of ours", async () => {
    const fake = fakePool({ failDelete: 404 });
    const res = await lib.relocateSoldComp(fake.container, { keep: KEEP, drop: [OLD] });
    expect(res).toMatchObject({ ok: true, alreadyGone: [OLD], deleted: [] });
  });
  it("a collapse onto an existing target reports existedBefore and never deletes the kept address", async () => {
    const fake = fakePool();
    fake.store.set(`${KEEP.cardId}::${KEEP.id}`, { ...KEEP, rekeyedAt: "old" });
    fake.store.set(`${OLD.cardId}::${OLD.id}`, OLD);
    const res = await lib.relocateSoldComp(fake.container, { keep: KEEP, drop: [OLD, { id: KEEP.id, cardId: KEEP.cardId }], verifyFields: ["rekeyedAt"] });
    expect(res).toMatchObject({ ok: true, existedBefore: true, deleted: [OLD] });
    expect(fake.calls.delete).toBe(1);
    expect(fake.store.get(`${KEEP.cardId}::${KEEP.id}`)?.rekeyedAt).toBe("t");
  });
  it("dry run touches nothing", async () => {
    const fake = fakePool();
    fake.store.set(`${OLD.cardId}::${OLD.id}`, OLD);
    const res = await lib.relocateSoldComp(fake.container, { keep: KEEP, drop: [OLD], dryRun: true });
    expect(res).toMatchObject({ ok: true, stage: "dry-run", wouldDelete: 1 });
    expect(fake.calls).toEqual({ upsert: 0, delete: 0, read: 0, query: 0 });
  });
});

describe("CF-A-VENDOR-KEYED-SALE-REKEYS-WHERE-IT-LIVES: read back where the row lives", () => {
  // The failure shape from rekey-product-setkey run 33973364948: a row whose
  // partition key was a CardHedge vendor id moves onto its hiq: slug, and the
  // point-read at the NEW partition answers 404 for a document that was
  // written. All 12 of that run's failures were later found alive at the new
  // address; the old row was (correctly) never deleted, so the sale was in the
  // pool TWICE.
  const VENDOR_PK = "1759162133350x316407940720022640";
  const SLUG = "hiq:football:2025:score:15:base:no-auto";
  const VENDOR_KEYED = { id: "cardhedge::ch-daily::1752927656211x698620124795439600", cardId: VENDOR_PK, hobbyiqCardId: "hiq:football:2025:panini-score:15:base:no-auto", price: 1.99 };
  const REKEYED = { ...VENDOR_KEYED, cardId: SLUG, hobbyiqCardId: SLUG, setKey: "score", rekeyedAt: "2026-09-05T15:04:15.342Z", vendorCardIdWas: VENDOR_PK };

  it("a vendor-keyed row rekeys and verifies even when the first read lags", async () => {
    const fake = fakePool({ lagReads: 2 });
    fake.store.set(`${VENDOR_PK}::${VENDOR_KEYED.id}`, VENDOR_KEYED);
    const res = await lib.relocateSoldComp(fake.container, {
      keep: REKEYED, drop: [{ id: VENDOR_KEYED.id, cardId: VENDOR_PK }],
      verifyFields: ["hobbyiqCardId", "setKey", "rekeyedAt"], wait: noWait,
    });
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    // the sale is at its new address exactly once, and the old row is gone --
    // no duplicate left behind
    expect(fake.store.has(`${SLUG}::${REKEYED.id}`)).toBe(true);
    expect(fake.store.has(`${VENDOR_PK}::${VENDOR_KEYED.id}`)).toBe(false);
  });

  it("the run's own failure shape -- a lag longer than every retry -- is saved by the fallback query", async () => {
    const fake = fakePool({ lagReads: 99 });
    fake.store.set(`${VENDOR_PK}::${VENDOR_KEYED.id}`, VENDOR_KEYED);
    const res = await lib.relocateSoldComp(fake.container, {
      keep: REKEYED, drop: [{ id: VENDOR_KEYED.id, cardId: VENDOR_PK }],
      verifyFields: ["hobbyiqCardId", "setKey", "rekeyedAt"], wait: noWait,
    });
    expect(res.ok).toBe(true);
    // The fallback is the POINT READ AS A QUERY (2026-09-06): addressed by
    // (id, cardId) and never OR'd onto hobbyiqCardId, which a re-keyed row's
    // old-address twin also carries. A query is still served from an
    // up-to-date replica set, so it still defeats the lag this test creates.
    expect(res.readBackVia).toBe("query-point-read");
    expect(fake.calls.query).toBeGreaterThan(0);
    expect(fake.store.has(`${VENDOR_PK}::${VENDOR_KEYED.id}`)).toBe(false);
  });

  it("MUTATION: reading back by the new slug ALONE -- no retry, no query -- reproduces the red run", async () => {
    // This is the pre-fix behaviour: one point-read at (id, new cardId). With
    // the replica lagging it finds nothing, the verify fails, the old row
    // survives, and the pool now holds the sale twice.
    const fake = fakePool({ lagReads: 99, blindQuery: true });
    fake.store.set(`${VENDOR_PK}::${VENDOR_KEYED.id}`, VENDOR_KEYED);
    const res = await lib.relocateSoldComp(fake.container, {
      keep: REKEYED, drop: [{ id: VENDOR_KEYED.id, cardId: VENDOR_PK }],
      verifyFields: ["hobbyiqCardId", "setKey", "rekeyedAt"], wait: noWait,
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("verify");
    expect(res.error).toBe("read-back found nothing");
    // the exact damage the real run did: written AND still there
    expect(fake.store.has(`${SLUG}::${REKEYED.id}`)).toBe(true);
    expect(fake.store.has(`${VENDOR_PK}::${VENDOR_KEYED.id}`)).toBe(true);
  });

  it("an hiq-keyed row still relocates as before, on the first read", async () => {
    const FROM_SLUG = "hiq:football:2025:panini-score:15:base:no-auto";
    const before = { id: "tca-ebay::1", cardId: FROM_SLUG, hobbyiqCardId: FROM_SLUG, price: 2 };
    const after = { ...before, cardId: SLUG, hobbyiqCardId: SLUG, setKey: "score", rekeyedAt: "t" };
    const fake = fakePool();
    fake.store.set(`${FROM_SLUG}::${before.id}`, before);
    const res = await lib.relocateSoldComp(fake.container, {
      keep: after, drop: [{ id: before.id, cardId: FROM_SLUG }],
      verifyFields: ["hobbyiqCardId", "setKey", "rekeyedAt"], wait: noWait,
    });
    expect(res).toMatchObject({ ok: true, stage: "done", readBackVia: "point-read" });
    expect(fake.calls.query).toBe(0);   // no fallback needed
    expect(fake.calls.read).toBe(2);    // existedBefore + the one read-back
    expect(fake.store.has(`${SLUG}::${after.id}`)).toBe(true);
    expect(fake.store.has(`${FROM_SLUG}::${before.id}`)).toBe(false);
  });

  it("the fallback finds a row whose cardId and hobbyiqCardId differ", async () => {
    // Not every stored row has cardId === hobbyiqCardId: the pool holds rows
    // like tca-ebay::128012214430, whose cardId is the ungraded slug while its
    // hobbyiqCardId carries a :psa-8 grade suffix. The fallback addresses the
    // row by (id, cardId) -- the partition it was WRITTEN to -- so a divergent
    // hobbyiqCardId does not hide it. It is no longer OR'd onto hobbyiqCardId,
    // which a re-keyed row's old-address twin also carries (2026-09-06).
    const PK = "hiq:football:2025:score:14:base:no-auto";
    const GRADED = PK + ":psa-8";
    const keep = { id: "tca-ebay::128012214430", cardId: PK, hobbyiqCardId: GRADED, setKey: "score", rekeyedAt: "t" };
    const fake = fakePool({ lagReads: 99 });
    const res = await lib.relocateSoldComp(fake.container, {
      keep, drop: [{ id: keep.id, cardId: "1668294538085x926692677514323000" }],
      verifyFields: ["setKey", "rekeyedAt"], wait: noWait,
    });
    expect(res.ok).toBe(true);
    expect(res.readBackVia).toBe("query-point-read");
    expect(fake.store.has(`${PK}::${keep.id}`)).toBe(true);
  });

  it("a row that truly was never written stays a failure, and nothing is deleted", async () => {
    // The guarantee the retry must NOT weaken: when no read can find the row,
    // the old one survives. A sale is never lost.
    const fake = fakePool({ blindQuery: true });
    fake.store.set(`${VENDOR_PK}::${VENDOR_KEYED.id}`, VENDOR_KEYED);
    // upsert lands nowhere the reads can see it
    (fake.container as { items: { upsert: unknown } }).items.upsert = async () => ({ resource: REKEYED });
    const res = await lib.relocateSoldComp(fake.container, {
      keep: REKEYED, drop: [{ id: VENDOR_KEYED.id, cardId: VENDOR_PK }],
      verifyFields: ["hobbyiqCardId"], wait: noWait,
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("verify");
    expect(fake.store.has(`${VENDOR_PK}::${VENDOR_KEYED.id}`)).toBe(true);
  });
});

describe("D19: both scripts carry the fleet discipline", () => {
  const src = (name: string) => fs.readFileSync(path.join(__dirname, "..", "scripts", `${name}.cjs`), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const name of ["rekey-user-comps", "collapse-ch-dual-ids"]) {
    it(`${name}: report-only by default, honours BACKFILL_APPLY, prints the budget marker, reconciles, writes only through the helper`, () => {
      const s = src(name);
      expect(s).toMatch(/process\.env\.BACKFILL_APPLY === "true"/);
      expect(s).toMatch(/stopped at the \$\{RUN_MINUTES\}-minute budget/);
      expect(s).toMatch(/\breportWrites\(/);
      expect(s).toMatch(/\brelocateSoldComp\(/);
      // no hand-rolled write: every upsert / delete lives in the helper
      // (`.replace(` only in its Cosmos shape -- never `.replace(/^#/, "")`)
      expect(s).not.toMatch(/\.items\.upsert\(|\.items\.create\(|\.delete\(\)|\.patch\(|\.replace\((?![/"'`])/);
      // the runner's whitelist and a marker-keyed relaunch
      const yml = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");
      expect(yml).toMatch(new RegExp(`^\\s+- ${name}\\s*$`, "m"));
      const step = yml.split(/\n(?=      - name:)/).find((st) => st.includes(`inputs.script == '${name}'`) && /gh workflow run backfill-runner\.yml/.test(st));
      expect(step, `${name} has no relaunch step`).toBeTruthy();
      expect(step!.replace(/^\s*#.*$/gm, "")).toMatch(/stopped at the .*budget/);
    });
  }
});
