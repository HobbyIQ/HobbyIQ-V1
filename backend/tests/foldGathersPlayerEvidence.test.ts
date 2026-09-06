// CF-A-FOLD-NEVER-CHANGES-THE-PLAYER -- the EVIDENCE half.
//
// #1838 put the survivor rule in `chooseSurvivor` and gave it a seam,
// `playerEvidence`, with two arms: a second strict source at the identity cell
// (`corroborationOf`), and the sale titles' majority at that card number. It
// shipped that seam WIRED NOWHERE.
//
// `playerEvidence` is optional and omitting it means "I gathered nothing", so
// with no caller passing it EVERY different-player twin refused. That is the
// correct fail-safe -- it is why #1838 was safe to merge -- but it is not the
// ruling. The ruling is that corroboration DECIDES. Measured by
// probe-optic-fold-corroboration.cjs on the Optic football 2024 cell: 30 alias
// wins and 30 dest wins are decidable on evidence, and unwired they would have
// been 60 further refusals on top of the genuine 147.
//
// THESE PINS ARE ABOUT THE GATHERING, not about the rule. The rule is pinned by
// foldNeverChangesThePlayer.test.ts and is not restated here. What is pinned:
//
//   1. a fixture pool whose titles name the alias player 30/2  -> ALIAS wins
//   2. the same shape inverted, 2/30                            -> DEST wins
//   3. a dead heat 15/15                                        -> REFUSED
//   4. no titles at all                                         -> REFUSED
//   5. the reads are PARTITION-BOUNDED and sample-capped
//   6. MUTATION: drop the wiring (pass no evidence) and every one of the
//      decidable pairs refuses -- the exact state #1838 shipped in.
//
// The gathering is asserted through `gatherPlayerEvidence` + `moveCatalogRow`
// together, because a helper that returns a tally nobody acts on is not the
// claim. The claim is that a fold RESOLVES where the market says who is on the
// card, and refuses where it does not.

import { describe, it, expect } from "vitest";
import type { Container } from "@azure/cosmos";
import { createRequire } from "node:module";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service.js";

const require_ = createRequire(import.meta.url);
const {
  gatherPlayerEvidence, tallyTitlesForSlug, MAX_TITLES_PER_SLUG,
} = require_("../scripts/lib/player-evidence.cjs");

type Doc = Record<string, any>;

const ALIAS = "hiq:football:2024:panini-optic:40:gold:no-auto";
const DEST = "hiq:football:2024:donruss-optic:40:gold:no-auto";

/** The real pair from the live read: #40 gold, Ja'Marr Chase x11 vs Will
 *  Shipley x0. Both rows are checklist rank 3, so nothing on the ordinary
 *  ladder can separate them -- which is the whole reason the arms exist. */
const aliasRow = (): Doc => ({
  id: ALIAS, cardId: ALIAS, source: "checklistinsider", playerName: "Ja'Marr Chase",
  sport: "football", cardYear: 2024, setKey: "panini-optic", cardNumber: "40",
  parallelSlug: "gold", isAuto: false,
});
const destRow = (): Doc => ({
  id: DEST, cardId: DEST, source: "checklistcenter", playerName: "Will Shipley",
  sport: "football", cardYear: 2024, setKey: "donruss-optic", cardNumber: "40",
  parallelSlug: "gold", isAuto: false,
});

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

/**
 * A pool fake that RECORDS how it was queried, so "partition-bounded" is an
 * assertion and not a comment. Sales are stored per partition key; a query that
 * arrives without one, or with one that does not match, returns nothing --
 * exactly as a real cross-partition-disabled read would behave.
 */
function poolFake(byPartition: Record<string, Doc[]>) {
  const calls: Array<{ partitionKey: unknown; maxItemCount: unknown; query: string }> = [];
  return {
    calls,
    container: {
      items: {
        query(spec: any, opts: any) {
          calls.push({
            partitionKey: opts?.partitionKey,
            maxItemCount: opts?.maxItemCount,
            query: String(spec?.query ?? ""),
          });
          const pk = String(opts?.partitionKey ?? "");
          const rows = byPartition[pk] ?? [];
          let served = false;
          return {
            hasMoreResults: () => !served,
            fetchNext: async () => { served = true; return { resources: rows }; },
          };
        },
      },
    } as unknown as Container,
  };
}

/** n sale rows naming one player under one partition. */
const titles = (player: string, n: number): Doc[] =>
  Array.from({ length: n }, (_, i) => ({ playerName: player, title: `2024 Optic #40 ${player} Gold ${i}` }));

/** The catalog fake from the sibling suite, narrowed to what these pins need:
 *  a point read of the destination, an upsert, and the delete. */
function catFake(rows: Doc[]) {
  const store = new Map<string, Doc>();
  for (const r of rows) store.set(String(r.id), { ...r });
  const upserted: Doc[] = [];
  const deleted: string[] = [];
  return {
    store, upserted, deleted,
    container: {
      item(id: string) {
        return {
          async read() {
            const d = store.get(String(id));
            if (!d) throw notFound();
            return { resource: { ...d } };
          },
          async patch() { return { resource: store.get(String(id)) }; },
          async delete() { deleted.push(String(id)); store.delete(String(id)); return {}; },
        };
      },
      items: {
        async upsert(doc: Doc) { upserted.push(doc); store.set(String(doc.id), { ...doc }); return { resource: doc }; },
        query() {
          let served = false;
          return {
            hasMoreResults: () => !served,
            fetchNext: async () => { served = true; return { resources: [] }; },
          };
        },
      },
    } as unknown as Container,
  };
}

/** Gather evidence for the contended pair, then run the real fold with it. */
async function foldWithEvidence(poolRows: Record<string, Doc[]>, opts: { pass?: boolean } = {}) {
  const incoming = aliasRow();
  const incumbent = destRow();
  const pool = poolFake(poolRows);
  const cat = catFake([incumbent]);

  const evidence = await gatherPlayerEvidence(pool.container, incoming, incumbent, {
    incomingSlug: ALIAS, incumbentSlug: DEST,
    // arm 1 is deliberately EMPTY in these pins: they are about arm 2, the
    // titles. With no rival rows arm 1 cannot fire, so what decides is the
    // market tally alone -- which is the arm that was unreachable before.
    rivals: [],
  });

  const res = await moveCatalogRow(
    cat.container, incoming, DEST, { setKey: "donruss-optic" },
    {
      reason: "test", dryRun: true, known: incumbent,
      // `pass: false` is the MUTATION: the wiring removed, i.e. exactly what
      // #1838 shipped.
      ...(opts.pass === false ? {} : evidence ? { playerEvidence: evidence } : {}),
    },
  );
  return { res, evidence, pool, cat };
}

describe("the fold gathers the evidence its rule asks for", () => {
  it("titles name the alias player 30/2 → the ALIAS row wins, and the marker names the arm", async () => {
    const { res, evidence } = await foldWithEvidence({
      [ALIAS]: titles("Ja'Marr Chase", 30),
      [DEST]: titles("Will Shipley", 2),
    });

    expect(evidence).not.toBeNull();
    expect(evidence.titlePlayerCounts).toEqual({ "Ja'Marr Chase": 30, "Will Shipley": 2 });
    // The alias row is the INCOMING one, so it winning means survivor=incoming.
    expect(res.action).not.toBe("refused");
    expect(res.survivor).toBe("incoming");
    expect(res.playerArbitration?.by).toBe("sale-titles");
    expect(res.playerArbitration?.winningPlayer).toBe("Ja'Marr Chase");
    expect(res.playerArbitration?.losingPlayer).toBe("Will Shipley");
  });

  it("titles name the dest player 2/30 → the DEST row wins: the polarity is the market's, not the source's", async () => {
    const { res, evidence } = await foldWithEvidence({
      [ALIAS]: titles("Ja'Marr Chase", 2),
      [DEST]: titles("Will Shipley", 30),
    });

    expect(evidence.titlePlayerCounts).toEqual({ "Ja'Marr Chase": 2, "Will Shipley": 30 });
    expect(res.action).not.toBe("refused");
    expect(res.survivor).toBe("incumbent");
    expect(res.playerArbitration?.by).toBe("sale-titles");
    expect(res.playerArbitration?.winningPlayer).toBe("Will Shipley");
  });

  it("a dead heat 15/15 → REFUSED, and nothing is written", async () => {
    const { res, cat } = await foldWithEvidence({
      [ALIAS]: titles("Ja'Marr Chase", 15),
      [DEST]: titles("Will Shipley", 15),
    });

    expect(res.action).toBe("refused");
    expect(res.refusal?.incomingPlayer).toBe("Ja'Marr Chase");
    expect(res.refusal?.incumbentPlayer).toBe("Will Shipley");
    // THE WRITE BARRIER. A tie is not a tiebreak: an equal tally is the market
    // declining to answer, and a refusal writes nothing at all.
    expect(cat.upserted).toEqual([]);
    expect(cat.deleted).toEqual([]);
    expect(res.salesRepointed).toBe(0);
  });

  it("no titles at any address → gathering returns null, and the fold REFUSES", async () => {
    const { res, evidence } = await foldWithEvidence({ [ALIAS]: [], [DEST]: [] });

    // NULL, never `{}`. An empty object would claim a gathering that found
    // nothing usable; null says the true thing and keeps "no evidence ->
    // refused" a property of the module.
    expect(evidence).toBeNull();
    expect(res.action).toBe("refused");
  });

  it("sales the parser never named are not votes", async () => {
    // 30 unnamed rows on the alias side must not out-vote 2 named ones on the
    // dest side. Counting a blank as a player would let parser COVERAGE decide
    // who is on a card.
    const { res, evidence } = await foldWithEvidence({
      [ALIAS]: Array.from({ length: 30 }, () => ({ playerName: "", title: "2024 Optic #40 Gold" })),
      [DEST]: titles("Will Shipley", 2),
    });

    expect(evidence.titlePlayerCounts).toEqual({ "Will Shipley": 2 });
    expect(res.survivor).toBe("incumbent");
  });

  it("punctuation never splits a person: \"TJ Hockenson\" and \"T.J. Hockenson\" are one tally", async () => {
    const incoming = { ...aliasRow(), playerName: "T.J. Hockenson" };
    const incumbent = destRow();
    const pool = poolFake({
      [ALIAS]: [...titles("TJ Hockenson", 6), ...titles("T.J. Hockenson", 4)],
      [DEST]: titles("Will Shipley", 3),
    });
    const cat = catFake([incumbent]);
    const evidence = await gatherPlayerEvidence(pool.container, incoming, incumbent, {
      incomingSlug: ALIAS, incumbentSlug: DEST, rivals: [],
    });
    const res = await moveCatalogRow(cat.container, incoming, DEST, { setKey: "donruss-optic" }, {
      reason: "test", dryRun: true, known: incumbent, playerEvidence: evidence,
    });

    // The two spellings stay separate KEYS in the gathered counts (the module
    // tallies by display name) and are merged by chooseSurvivor's own
    // playerKeyOf -- 6+4=10 beats 3, so the incoming row wins.
    expect(res.survivor).toBe("incoming");
    expect(res.playerArbitration?.by).toBe("sale-titles");
  });
});

describe("the reads are partition-bounded and capped", () => {
  it("one query per candidate slug, each under that slug's partition key", async () => {
    const pool = poolFake({ [ALIAS]: titles("Ja'Marr Chase", 3), [DEST]: titles("Will Shipley", 1) });
    await gatherPlayerEvidence(pool.container, aliasRow(), destRow(), {
      incomingSlug: ALIAS, incumbentSlug: DEST, rivals: [],
    });

    expect(pool.calls).toHaveLength(2);
    expect(pool.calls.map((c) => c.partitionKey)).toEqual([ALIAS, DEST]);
    // The predicate is the partition key itself. A query that filtered on
    // sport/year/setKey instead -- the probe's shape -- would be a
    // cross-partition scan per fold inside a fleet lane.
    for (const c of pool.calls) {
      expect(c.query).toContain("c.cardId = @slug");
      expect(c.query).not.toMatch(/normalizedSetKey|c\.sport/);
      expect(Number(c.maxItemCount)).toBeLessThanOrEqual(200);
    }
  });

  it("the same slug on both sides is read ONCE, not twice", async () => {
    const pool = poolFake({ [DEST]: titles("Will Shipley", 2) });
    await gatherPlayerEvidence(pool.container, destRow(), destRow(), {
      incomingSlug: DEST, incumbentSlug: DEST, rivals: [],
    });
    expect(pool.calls).toHaveLength(1);
  });

  it("the sample is capped: an unbounded partition does not become an unbounded read", async () => {
    const pool = poolFake({ [ALIAS]: titles("Ja'Marr Chase", 5_000) });
    const tally = await tallyTitlesForSlug(pool.container, ALIAS, {});
    const total = [...tally.values()].reduce((a: number, v: any) => a + v.n, 0);

    expect(MAX_TITLES_PER_SLUG).toBe(200);
    expect(total).toBe(MAX_TITLES_PER_SLUG);
  });

  it("no pool container → arm 2 is skipped, not faked", async () => {
    const evidence = await gatherPlayerEvidence(null, aliasRow(), destRow(), {
      incomingSlug: ALIAS, incumbentSlug: DEST, rivals: [],
    });
    expect(evidence).toBeNull();
  });
});

describe("the pins fail against the unwired code #1838 shipped", () => {
  it("MUTATION: drop the wiring and the 30/2 pair refuses — the state before this fix", async () => {
    const { res } = await foldWithEvidence(
      { [ALIAS]: titles("Ja'Marr Chase", 30), [DEST]: titles("Will Shipley", 2) },
      { pass: false },
    );

    // This is the whole justification for the PR: the evidence EXISTS in the
    // pool, the rule can read it, and with no caller passing it the fold
    // refuses a pair the market answers 30-to-2.
    expect(res.action).toBe("refused");
    expect(res.playerArbitration).toBeUndefined();
  });

  it("MUTATION: drop the wiring and the 2/30 pair refuses too — both polarities", async () => {
    const { res } = await foldWithEvidence(
      { [ALIAS]: titles("Ja'Marr Chase", 2), [DEST]: titles("Will Shipley", 30) },
      { pass: false },
    );
    expect(res.action).toBe("refused");
  });

  it("MUTATION: an empty evidence object is NOT the same as gathered evidence", async () => {
    const incoming = aliasRow();
    const incumbent = destRow();
    const cat = catFake([incumbent]);
    // `{}` is what a careless wiring would pass when it read nothing. It must
    // still refuse: the arms have nothing to fire on, and a fold that resolved
    // here would be resolving on absence.
    const res = await moveCatalogRow(cat.container, incoming, DEST, { setKey: "donruss-optic" }, {
      reason: "test", dryRun: true, known: incumbent, playerEvidence: {},
    });
    expect(res.action).toBe("refused");
    expect(cat.upserted).toEqual([]);
  });
});
