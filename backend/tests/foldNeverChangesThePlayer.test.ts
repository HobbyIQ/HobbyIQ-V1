// CF-A-FOLD-NEVER-CHANGES-THE-PLAYER (Drew, 2026-09-05 -- the donruss-optic
// arbitration). Pins the survivor rule on the EXACT shapes measured live in
// football/2024 Optic, read-only, on the day of the ruling.
//
// THE DEFECT THIS PINS. `chooseSurvivor` ranked source authority, vendorIds,
// sales and confidence, and never compared `playerName`. Two transcriptions of
// one printed checklist that put DIFFERENT PLAYERS at the same (number,
// parallel) therefore tied on every rung and fell through to "the incumbent
// keeps its address" -- so the fold silently discarded a rival's player name on
// a criterion with nothing to do with who is on the card. Measured: 181 of 186
// twin pairs (97.3%), byte-identical parallel on both sides.
//
// THE PINS ARE REAL PAIRS, from the live read:
//   #38 black-pandora   alias "Joe Burrow"  x10 sales  vs dest "Trey Benson" x0
//   #9  base            dest  "Michael Penix Jr." x31  vs alias "Tyler Allgeier" x2
//   #18 dragon          alias "Kyle Hamilton" x0       vs dest "Devin Leary"  x0
// so the three outcomes -- alias wins, dest wins, REFUSED -- are each pinned by
// a pair that really occurred, and the polarity is NOT a property of the source:
// checklistinsider wins one and loses the other. A rule that said "hobbymonitor
// loses" would have been right in #1795 and wrong here.
//
// MUTATION CHECKS (the last describe block): each asserts that REMOVING one
// half of the rule turns a pin red. Dropping the player comparison makes the
// contradicted copy win a silent fold; dropping the corroboration makes an
// arbitrable pair refuse. Both are stated as the behaviour the old code had.

import { describe, it, expect } from "vitest";
import type { Container } from "@azure/cosmos";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service.js";

type Doc = Record<string, any>;

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}

const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

/** The same fake the sibling suite uses: point read / patch / delete by
 *  (id, pk), upsert, and the two query shapes the service issues. */
class FakeContainer {
  readonly docs = new Map<string, Doc>();
  constructor(readonly name: string, readonly log: string[], seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  get(id: string, pk?: string): Doc | undefined {
    if (pk !== undefined) return this.docs.get(keyOf(id, pk));
    return this.docs.get(id) ?? [...this.docs.values()].find((d) => d.id === id);
  }
  has(id: string, pk?: string): boolean {
    return this.get(id, pk) !== undefined;
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        this.log.push(`${this.name}.read ${id}`);
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d), statusCode: 200 };
      },
      patch: async (ops: Array<{ op: string; path: string; value: unknown }>) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op !== "set") throw new Error(`fake: unsupported patch op ${o.op}`);
          d[o.path.slice(1)] = o.value;
        }
        this.log.push(`${this.name}.patch ${id}`);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        if (!this.docs.has(k)) throw notFound();
        this.docs.delete(k);
        this.log.push(`${this.name}.delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
      this.log.push(`${this.name}.upsert ${doc.id}`);
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => ({
      fetchNext: async () => ({ resources: this.run(spec), continuationToken: undefined }),
      fetchAll: async () => ({ resources: this.run(spec) }),
    }),
  };
  private run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }): Doc[] {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = [...this.docs.values()];
    if (spec.query.includes("c.hobbyiqCardId = @s")) {
      return all.filter((d) => d.hobbyiqCardId === p["@s"]).map((d) => ({ id: d.id, cardId: d.cardId }));
    }
    if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
      return all
        .filter((d) => String(d.id).startsWith(String(p["@p"])) && d.gradeTier !== undefined)
        .map((d) => ({ id: d.id, cardId: d.cardId, parentSlug: d.parentSlug }));
    }
    throw new Error(`fake container: unsupported query ${spec.query}`);
  }
  writes(): string[] {
    return this.log.filter((l) => /\.(upsert|patch|delete) /.test(l));
  }
}

// ── the live Optic shapes ────────────────────────────────────────────────────

const ALIAS = "panini-optic";
const DEST = "donruss-optic";
const REASON = "ruled: panini-optic -> donruss-optic (football 2024)";

/** `hiq:football:2024:<setKey>:<num>:<parallel>:no-auto` */
const slug = (setKey: string, num: string, parallel: string) => `hiq:football:2024:${setKey}:${num}:${parallel}:no-auto`;

function opticRow(setKey: string, num: string, parallel: string, player: string | null, over: Doc = {}): Doc {
  const id = slug(setKey, num, parallel);
  return {
    id, cardId: id, hobbyiqCardId: id,
    sport: "football", year: 2024, cardYear: 2024,
    setKey, setName: setKey === ALIAS ? "2024 Panini Donruss Optic Football" : "2024 donruss optic",
    cardNumber: num, parallel: parallel === "base" ? "Base" : parallel, parallelSlug: parallel,
    isAuto: false, printRun: null,
    playerName: player, playerSlug: player ? player.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null,
    vendorIds: {},
    // BOTH sides classify CHECKLIST rank 3 -- that is exactly why the ladder
    // could not separate them and the fold was silent.
    source: setKey === ALIAS ? "checklistinsider-2026-08-27" : "hobbymonitor-2026-09-04",
    confidence: 0.9,
    observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function world(aliasRow: Doc, destRow: Doc | null, sales: Doc[] = []) {
  const log: string[] = [];
  const catalog = new FakeContainer("card_catalog", log, [aliasRow, ...(destRow ? [destRow] : [])]);
  const pool = new FakeContainer("sold_comps", log, sales);
  return { log, catalog, pool, cat: catalog as unknown as Container, sales: pool as unknown as Container };
}

const move = (w: ReturnType<typeof world>, from: Doc, toSlug: string, opts: Doc = {}) =>
  moveCatalogRow(w.cat, from, toSlug, { setKey: DEST }, {
    reason: REASON, repointNormalizedSetKey: true, salesContainer: w.sales, ...opts,
  });

// ── 1. the refusal ───────────────────────────────────────────────────────────

describe("a fold never changes the player: the refusal", () => {
  it("#18 dragon -- Kyle Hamilton vs Devin Leary, neither corroborated: REFUSED, and nothing is written", async () => {
    const alias = opticRow(ALIAS, "18", "dragon", "Kyle Hamilton");
    const dest = opticRow(DEST, "18", "dragon", "Devin Leary");
    const w = world(alias, dest, [{ id: "s1", cardId: "p1", hobbyiqCardId: alias.id, price: 10 }]);

    const r = await move(w, alias, dest.id);

    expect(r.action).toBe("refused");
    expect(r.survivor).toBeNull();
    expect(r.refusal?.reason).toBe("different-player-uncorroborated");
    expect(r.refusal?.incomingPlayer).toBe("Kyle Hamilton");
    expect(r.refusal?.incumbentPlayer).toBe("Devin Leary");
    // BY NAME: a reader must be able to act on the decision string alone.
    expect(r.decision).toContain("Kyle Hamilton");
    expect(r.decision).toContain("Devin Leary");
    expect(r.decision).toMatch(/neither is corroborated/);

    // NOTHING WRITTEN -- not the survivor, not the sale, not the delete.
    expect(w.catalog.writes()).toEqual([]);
    expect(w.pool.writes()).toEqual([]);
    expect(w.catalog.has(alias.id)).toBe(true);      // the alias row stays put
    expect(w.catalog.get(dest.id)!.playerName).toBe("Devin Leary");
    expect(w.pool.get("s1")!.hobbyiqCardId).toBe(alias.id);
    expect(r.salesRepointed).toBe(0);
    expect(r.gradedChildrenRetired).toBe(0);
  });

  it("no evidence at all is a refusal, not a fold -- the old code's silent default", async () => {
    const alias = opticRow(ALIAS, "25", "black-pandora", "Montez Sweat");
    const dest = opticRow(DEST, "25", "black-pandora", "Spencer Rattler");
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id);   // no playerEvidence at all
    expect(r.action).toBe("refused");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("an EMPTY title tally is still no evidence: a tie at zero refuses", async () => {
    const alias = opticRow(ALIAS, "18", "ice", "Kyle Hamilton");
    const dest = opticRow(DEST, "18", "ice", "Devin Leary");
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id, {
      playerEvidence: { titlePlayerCounts: { "Derrick Henry": 31 } },   // a THIRD player
    });
    expect(r.action).toBe("refused");
    expect(w.catalog.writes()).toEqual([]);
  });
});

// ── 2. corroboration decides ─────────────────────────────────────────────────

describe("a fold never changes the player: corroboration decides", () => {
  it("#38 black-pandora -- the market names Joe Burrow x10 and Trey Benson x0: the ALIAS row wins", async () => {
    const alias = opticRow(ALIAS, "38", "black-pandora", "Joe Burrow");
    const dest = opticRow(DEST, "38", "black-pandora", "Trey Benson");
    const w = world(alias, dest, [{ id: "s1", cardId: "p1", hobbyiqCardId: alias.id, price: 40 }]);

    const r = await move(w, alias, dest.id, {
      playerEvidence: { titlePlayerCounts: { "Joe Burrow": 10, "Trey Benson": 0 } },
    });

    expect(r.action).toBe("replace");
    expect(r.survivor).toBe("incoming");
    expect(r.playerArbitration).toMatchObject({
      winner: "incoming", by: "sale-titles", winningPlayer: "Joe Burrow", losingPlayer: "Trey Benson",
    });
    const row = w.catalog.get(dest.id)!;
    expect(row.playerName).toBe("Joe Burrow");
    // THE LOSER IS RECORDED, NOT ERASED. A marker, never a silent absorb.
    expect(row.supersededPlayerName).toBe("Trey Benson");
    expect(row.playerArbitratedBy).toBe("sale-titles");
    expect(String(row.playerArbitrationDetail)).toContain("10 refereed sale titles");
    expect(w.catalog.has(alias.id)).toBe(false);
    expect(w.pool.get("s1")!.hobbyiqCardId).toBe(dest.id);
  });

  it("#9 base -- the market names Michael Penix Jr. x31 over Tyler Allgeier x2: the DEST row wins", async () => {
    // THE POLARITY FLIPS. Same rule, same product, and checklistinsider is the
    // side that loses this one -- which is why the rule is about evidence and
    // not about a source's name.
    const alias = opticRow(ALIAS, "9", "base", "Tyler Allgeier");
    const dest = opticRow(DEST, "9", "base", "Michael Penix Jr.");
    const w = world(alias, dest, [{ id: "s1", cardId: "p1", hobbyiqCardId: alias.id, price: 25 }]);

    const r = await move(w, alias, dest.id, {
      playerEvidence: { titlePlayerCounts: { "Michael Penix Jr.": 31, "Tyler Allgeier": 2 } },
    });

    expect(r.action).toBe("fold");
    expect(r.survivor).toBe("incumbent");
    expect(r.playerArbitration).toMatchObject({
      winner: "incumbent", by: "sale-titles", winningPlayer: "Michael Penix Jr.", losingPlayer: "Tyler Allgeier",
    });
    const row = w.catalog.get(dest.id)!;
    expect(row.playerName).toBe("Michael Penix Jr.");
    expect(row.supersededPlayerName).toBe("Tyler Allgeier");
    // The sales still follow the survivor -- a fold is still a move.
    expect(w.pool.get("s1")!.hobbyiqCardId).toBe(dest.id);
  });

  it("punctuation is not a disagreement: \"Michael Penix Jr.\" tallies as \"Michael Penix Jr\"", async () => {
    const alias = opticRow(ALIAS, "9", "gold", "Tyler Allgeier");
    const dest = opticRow(DEST, "9", "gold", "Michael Penix Jr.");
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id, {
      playerEvidence: { titlePlayerCounts: { "michael penix jr": 31, "Tyler Allgeier": 2 } },
    });
    expect(r.action).toBe("fold");
    expect(r.playerArbitration?.winningPlayer).toBe("Michael Penix Jr.");
  });

  it("a SECOND STRICT SOURCE outranks the sale titles: corroborationOf decides first", async () => {
    const alias = opticRow(ALIAS, "40", "gold", "Ja'Marr Chase");
    const dest = opticRow(DEST, "40", "gold", "Will Shipley");
    const w = world(alias, dest);
    // A third strict source at the same identity CELL naming the alias player.
    // `identityCellOf` reads the slug's first six segments, so the rival must
    // sit at the destination's own cell for the read to see it.
    const rival = opticRow(DEST, "40", "gold", "Ja'Marr Chase", { source: "checklistcenter", id: "rival", cardId: "rival" });
    const r = await move(w, alias, dest.id, {
      playerEvidence: {
        rivals: [rival],
        // The titles point the OTHER way; the second source must still win.
        titlePlayerCounts: { "Will Shipley": 99 },
      },
    });
    expect(r.action).toBe("replace");
    expect(r.playerArbitration).toMatchObject({ winner: "incoming", by: "second-source", winningPlayer: "Ja'Marr Chase" });
    expect(String(r.playerArbitration?.detail)).toContain("checklistcenter");
  });

  it("a hobbymonitor incumbent CONTRADICTED by a second source loses -- #1795's shape, folded polarity", async () => {
    const alias = opticRow(ALIAS, "26", "gold", "Bryce Young");
    const dest = opticRow(DEST, "26", "gold", "Derek Carr");           // hobbymonitor
    const w = world(alias, dest);
    // checklistcenter at the destination cell names Bryce Young -- so the
    // hobbymonitor incumbent is `player-disagrees` and forfeits its backing,
    // while the checklistinsider incoming row needs no corroboration at all.
    const rival = opticRow(DEST, "26", "gold", "Bryce Young", { source: "checklistcenter", id: "rival", cardId: "rival" });
    const r = await move(w, alias, dest.id, { playerEvidence: { rivals: [rival] } });
    expect(r.action).toBe("replace");
    expect(r.survivor).toBe("incoming");
    expect(r.playerArbitration?.by).toBe("second-source");
    expect(w.catalog.get(dest.id)!.playerName).toBe("Bryce Young");
    expect(w.catalog.get(dest.id)!.supersededPlayerName).toBe("Derek Carr");
  });
});

// ── 3. the rule fires ONLY on a real conflict ────────────────────────────────

describe("a fold never changes the player: the ordinary ladder is untouched", () => {
  it("the SAME player on both sides still folds on the authority ladder", async () => {
    const alias = opticRow(ALIAS, "12", "base", "Ja'Marr Chase");
    const dest = opticRow(DEST, "12", "base", "Ja'Marr Chase", { vendorIds: { cardhedge: "ch-1" } });
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id);
    expect(r.action).toBe("fold");
    expect(r.survivor).toBe("incumbent");
    expect(r.decision).toMatch(/vendorIds/);
    expect(r.playerArbitration).toBeUndefined();
    expect(w.catalog.get(dest.id)!.supersededPlayerName).toBeUndefined();
  });

  it("ONE SIDE MISSING A NAME is not a disagreement: bccp's null playerName never manufactures a conflict", async () => {
    const alias = opticRow(ALIAS, "12", "ice", "Ja'Marr Chase");
    const dest = opticRow(DEST, "12", "ice", null, { source: "bccp" });
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id);
    // bccp is rank 3 too, so this lands on the ordinary ladder -- the point is
    // that it is NOT refused over a blank field.
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("AN AUTHORITY GAP still decides, even on different players: a seed row is not a rival numbering", async () => {
    // The pre-existing contract, and it must survive the new rule:
    // `ingest-auto-seed` (rank 1) naming someone else is a seed artefact, not a
    // second transcription. Refusing these would strand every seeded twin.
    const alias = opticRow(ALIAS, "31", "base", "Bo Nix");
    const dest = opticRow(DEST, "31", "base", "Bo Nix (seed)", { source: "ingest-auto-seed", confidence: 0.99 });
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id);
    expect(r.action).toBe("replace");
    expect(r.decision).toMatch(/authority/);
    expect(r.playerArbitration).toBeUndefined();
  });

  it("a plain MOVE with no incumbent is never arbitrated", async () => {
    const alias = opticRow(ALIAS, "77", "base", "Bo Nix");
    const w = world(alias, null);
    const r = await move(w, alias, slug(DEST, "77", "base"));
    expect(r.action).toBe("move");
    expect(r.survivor).toBe("incoming");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("an authority gap still decides BEFORE the ladder -- but only once the players agree", async () => {
    const alias = opticRow(ALIAS, "12", "holo", "Ja'Marr Chase");
    const dest = opticRow(DEST, "12", "holo", "Ja'Marr Chase", { source: "ingest-auto-seed", confidence: 0.99 });
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id);
    expect(r.action).toBe("replace");
    expect(r.decision).toMatch(/authority/);
  });

  it("a dryRun refusal is still a refusal and still writes nothing", async () => {
    const alias = opticRow(ALIAS, "2", "holo", "Jalin Hyatt");
    const dest = opticRow(DEST, "2", "holo", "James Conner");
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id, { dryRun: true });
    expect(r.action).toBe("refused");
    expect(w.catalog.writes()).toEqual([]);
  });
});

// ── 4. mutation checks ───────────────────────────────────────────────────────
//
// Each of these states the behaviour the code had BEFORE the rule, and asserts
// the current code does NOT do it. Re-introduce the mutation and the assertion
// fires -- that is what makes these checks and not decoration.

describe("mutation checks", () => {
  it("DROP THE PLAYER COMPARISON -> red: without it, #38 folds Joe Burrow away silently", async () => {
    const alias = opticRow(ALIAS, "38", "black-pandora", "Joe Burrow");
    const dest = opticRow(DEST, "38", "black-pandora", "Trey Benson");
    const w = world(alias, dest, [{ id: "s1", cardId: "p1", hobbyiqCardId: alias.id, price: 40 }]);

    const r = await move(w, alias, dest.id, {
      playerEvidence: { titlePlayerCounts: { "Joe Burrow": 10, "Trey Benson": 0 } },
    });

    // THE OLD BEHAVIOUR, asserted absent: equal rank 3, equal vendorIds, equal
    // sales, equal confidence -> "the incumbent keeps its address", and Joe
    // Burrow's row is absorbed with no marker and no report.
    expect(r.decision).not.toMatch(/the incumbent keeps its address/);
    expect(r.survivor).not.toBe("incumbent");
    expect(w.catalog.get(dest.id)!.playerName).not.toBe("Trey Benson");
    // and the loser is NAMED rather than vanished
    expect(w.catalog.get(dest.id)!.supersededPlayerName).toBe("Trey Benson");
  });

  it("DROP THE PLAYER COMPARISON -> red: an uncorroborated pair must not resolve on the ladder at all", async () => {
    const alias = opticRow(ALIAS, "18", "gold-vinyl", "Kyle Hamilton");
    const dest = opticRow(DEST, "18", "gold-vinyl", "Devin Leary");
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id);
    // Without the comparison this is a clean tiebreak fold. With it, a refusal.
    expect(r.action).not.toBe("fold");
    expect(r.action).not.toBe("replace");
    expect(r.action).toBe("refused");
  });

  it("DROP THE CORROBORATION -> red: an arbitrable pair must NOT fall through to a refusal", async () => {
    const alias = opticRow(ALIAS, "40", "gold", "Ja'Marr Chase");
    const dest = opticRow(DEST, "40", "gold", "Will Shipley");
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id, {
      playerEvidence: { titlePlayerCounts: { "Ja'Marr Chase": 11, "Will Shipley": 0 } },
    });
    // If the corroboration arms were removed and every different-player pair
    // simply refused, this would be "refused" and the 60 decidable pairs in
    // football/2024 would never move.
    expect(r.action).not.toBe("refused");
    expect(r.action).toBe("replace");
    expect(r.playerArbitration?.by).toBe("sale-titles");
  });

  it("DROP THE SECOND-SOURCE ARM -> red: a rival checklist must beat a louder title tally", async () => {
    const alias = opticRow(ALIAS, "26", "ice", "Bryce Young");
    const dest = opticRow(DEST, "26", "ice", "Derek Carr");
    const rival = opticRow(DEST, "26", "ice", "Bryce Young", { source: "checklistcenter", id: "rival", cardId: "rival" });
    const w = world(alias, dest);
    const r = await move(w, alias, dest.id, {
      playerEvidence: { rivals: [rival], titlePlayerCounts: { "Derek Carr": 500 } },
    });
    // Titles alone would hand this to Derek Carr. The second source must win.
    expect(r.playerArbitration?.by).toBe("second-source");
    expect(r.playerArbitration?.winningPlayer).toBe("Bryce Young");
  });

  it("DROP THE REFUSAL'S WRITE BARRIER -> red: a refusal must not re-point a single sale", async () => {
    const alias = opticRow(ALIAS, "23", "black-pandora", "Khalil Shakir");
    const dest = opticRow(DEST, "23", "black-pandora", "Keon Coleman");
    const w = world(alias, dest, [
      { id: "s1", cardId: "p1", hobbyiqCardId: alias.id, price: 10 },
      { id: "s2", cardId: "p2", hobbyiqCardId: alias.id, price: 12 },
    ]);
    const r = await move(w, alias, dest.id);
    expect(r.action).toBe("refused");
    expect(r.salesRepointed).toBe(0);
    expect(w.pool.get("s1")!.hobbyiqCardId).toBe(alias.id);
    expect(w.pool.get("s2")!.hobbyiqCardId).toBe(alias.id);
    expect(w.pool.writes()).toEqual([]);
  });
});
