// CF-A-NAME-SHAPE-IS-NOT-A-DIFFERENT-PLAYER (run 35638061024, 2026-09-21).
//
// Run 35638061024 (baseball 2025, topps-series-1/topps-series-2 -> topps)
// refused 127 catalog different-player pairs. A diagnosis against that run's
// own log (`gh run view 35638061024 --log`) classified ALL 127 as name-SHAPE
// noise, none a genuinely different player:
//
//   ~55%  multi-player league-leader/insert cards: the incumbent reads
//         "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR" against
//         the bare "Shohei Ohtani".
//   ~30%  a subset tag on the same player: "Joey Ortiz RCup" vs "Joey Ortiz",
//         "Ceddanne Rafaela FS" vs "Ceddanne Rafaela",
//         'Carlos Correa "Say Cheese!"' vs "Carlos Correa".
//   ~15%  Jr./Sr. presence: "Vladimir Guerrero Jr." vs "Vladimir Guerrero",
//         "Nacho Alvarez Jr." vs "Nacho Alvarez".
//
// EVERY PAIR BELOW IS A REAL PAIR FROM THAT RUN'S LOG, not invented -- pulled
// verbatim from the "REFUSED ... (this row) vs ... (at topps)" lines. The two
// genuinely-different-player pairs and the two "first name in the wrong
// position" pairs are real too: they are what proves this fix does not widen
// past what the diagnosis found.
//
// Pinned at TWO layers, because the fix is wired in two places:
//   1. `namesAgree` itself (scripts/lib/name-agreement.cjs / nameAgreement.ts)
//   2. `arbitratePlayer`'s conflict gate (catalogRowOps.service.ts), through
//      `moveCatalogRow` end to end -- the same shape foldNeverChangesThePlayer
//      .test.ts already pins the OLD refusal in.

import { describe, expect, it } from "vitest";
import type { Container } from "@azure/cosmos";
import { moveCatalogRow } from "../src/services/catalog/catalogRowOps.service.js";
import { namesAgree } from "../src/services/catalog/nameAgreement.js";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cjs = require("../scripts/lib/name-agreement.cjs") as { namesAgree: (a: unknown, b: unknown) => boolean };

// ── layer 1: namesAgree, the 127 real pairs (deduplicated to their unique
//    name-shapes -- the run repeats the same product-level pair across many
//    card numbers/parallels, and the shape is what this function decides on) ──

/** [incoming, incumbent, expectAgree] -- every row read verbatim from the
 *  run's "REFUSED ... (this row) vs ... (at topps)" lines. */
const REAL_PAIRS: ReadonlyArray<[string, string, boolean]> = [
  // ~55% -- multi-player league-leader / insert cards, bare name vs FIRST-listed.
  ["Shohei Ohtani", "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR", true],
  ["Tarik Skubal", "Tarik Skubal / José Berríos / Seth Lugo LL AL W", true],
  ["Chris Sale", "Chris Sale / Zack Wheeler / Shota Imanaga LL NL ERA", true],
  ["José Ramírez", "José Ramírez / Steven Kwan", true],
  ["José Ramírez", "José Ramírez / Aaron Judge / Brent Rooker LL AL RBI", true],
  ["Willy Adames", "Willy Adames / Shohei Ohtani / Manny Machado LL NL RBI", true],
  ["Tarik Skubal", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA", true],
  ["Aaron Judge", 'Aaron Judge / Juan Soto / Alex Verdugo "Bronx Bombers II"', true],
  ["Aaron Judge", "Aaron Judge / Juan Soto / Anthony Santander LL AL HR", true],
  ["Aaron Judge", "Aaron Judge / A Boogie Wit Da Hoodie", true],
  ["Carlos Correa", "Carlos Correa / Royce Lewis", true],
  ["Jonathan India", "Jonathan India / Elly De La Cruz", true],
  ["Wyatt Langford", "Wyatt Langford / Evan Carter", true],
  ["Oneil Cruz", "Oneil Cruz / Andrew McCutchen", true],
  ["Elly De La Cruz", 'Elly De La Cruz / Jonathan India "It Takes Two"', true],
  ["Manny Machado", 'Manny Machado / Jackson Merrill "All Smiles"', true],
  ["Marcell Ozuna", "Marcell Ozuna / Adam Duvall \"Let's Dance!\"", true],
  ["Will Brennan", 'Will Brennan / Steven Kwan "Incoming!"', true],
  ["Taylor Walls", 'Taylor Walls / Richie Palacios "Hoop Dreams"', true],
  ["Shohei Ohtani", "Shohei Ohtani / Luis Arraez / Marcell Ozuna LL NL AVG", true],

  // ~30% -- subset tag on the same player.
  ["Pete Crow-Armstrong", "Pete Crow-Armstrong FS", true],
  ["Joey Ortiz", "Joey Ortiz RCup", true],
  ["Michael Busch", "Michael Busch RCup", true],
  ["Ceddanne Rafaela", "Ceddanne Rafaela FS", true],
  ["Jackson Merrill", "Jackson Merrill RCup", true],
  ["Colt Keith", "Colt Keith RCup", true],
  ["Evan Carter", "Evan Carter FS", true],
  ["Jordan Westburg", "Jordan Westburg FS", true],
  ["Jackson Holliday", "Jackson Holliday FS", true],
  ["Colton Cowser", "Colton Cowser RCup", true],
  ["Nolan Schanuel", "Nolan Schanuel FS", true],
  ["Yoshinobu Yamamoto", "Yoshinobu Yamamoto FS", true],
  ["Carlos Correa", 'Carlos Correa "Say Cheese!"', true],
  ["Masyn Winn", "Masyn Winn RCup", true],
  ["Tyler Soderstrom", "Tyler Soderstrom FS", true],
  ["Kyle Harrison", "Kyle Harrison FS", true],

  // ~15% -- Jr./Sr. presence.
  ["Nacho Alvarez Jr.", "Nacho Alvarez", true],
  ["Vladimir Guerrero Jr.", "Vladimir Guerrero", true],

  // Still a real refusal: the single name IS in the multi-name list, but not
  // FIRST -- rule (a) compares the first-listed name only, by design (the
  // brief's own words: "a multi-name incumbent whose FIRST name differs must
  // refuse"). Both are real rows from run 35638061024, card #5 and #234.
  ["Ronel Blanco", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA", false],
  ["Chris Sale", "Zack Wheeler / Chris Sale / Shota Imanaga LL NL W", false],
];

describe("namesAgree -- every real pair from run 35638061024's 127 refusals", () => {
  it.each(REAL_PAIRS)("\"%s\" vs \"%s\" -> agree=%s", (a, b, expected) => {
    expect(namesAgree(a, b)).toBe(expected);
  });
});

describe("namesAgree -- genuinely different players still refuse (not in the 127, sanity check)", () => {
  it.each([
    ["Aaron Judge", "Juan Soto"],
    ["Will Brennan", "Steven Kwan"],
  ])("\"%s\" vs \"%s\" -> still disagree", (a, b) => {
    expect(namesAgree(a, b)).toBe(false);
  });
});

// ── mirror equality: the .cjs and the .ts must agree on every fixture,
//    both directions, per the pokemonFinishFromTitle.ts mirror pattern ──

describe("namesAgree -- the .ts mirror and scripts/lib/name-agreement.cjs agree on every fixture", () => {
  const ALL_PAIRS: ReadonlyArray<[string, string]> = [
    ...REAL_PAIRS.map(([a, b]): [string, string] => [a, b]),
    ["Aaron Judge", "Juan Soto"],
    ["Will Brennan", "Steven Kwan"],
    ["", "Aaron Judge"],
    ["Aaron Judge", ""],
  ];
  it.each(ALL_PAIRS)("ts(%s, %s) === cjs(%s, %s)", (a, b) => {
    expect(namesAgree(a, b)).toBe(cjs.namesAgree(a, b));
  });
});

// ── mutation checks: rule (b) subset-tag strip, rule (c) Jr./Sr. equivalence ──
//
// Each states the behaviour the OLD compare (a bare toLowerCase +
// [^a-z0-9]-strip on the whole string, with no tag stripping at all) had, and
// asserts the current code does NOT have it. Delete the corresponding rule
// from name-agreement.cjs / nameAgreement.ts and one of these goes red.

describe("mutation check -- rule (b), the subset-tag strip", () => {
  it("DROP THE RCup/FS STRIP -> red: a bare toLowerCase+strip never folds \"Joey Ortiz RCup\" onto \"Joey Ortiz\"", () => {
    // The pre-fix expression the script itself used to gate `contended`
    // (still visible as the FIRST half of that gate in rekey-product-setkey.cjs).
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Joey Ortiz", "Joey Ortiz RCup")).toBe(false); // the old defect
    expect(namesAgree("Joey Ortiz", "Joey Ortiz RCup")).toBe(true);  // the fix
  });

  it("DROP THE QUOTED-SUBSET-NAME STRIP -> red: a quoted insert name would still disagree", () => {
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Carlos Correa", 'Carlos Correa "Say Cheese!"')).toBe(false);
    expect(namesAgree("Carlos Correa", 'Carlos Correa "Say Cheese!"')).toBe(true);
  });

  it("the subset-tag vocabulary is CLOSED -- an unlisted trailing word is never stripped", () => {
    // "Soto" is not on the list, so "Juan Soto" must not fold onto "Juan".
    expect(namesAgree("Juan", "Juan Soto")).toBe(false);
    // A quoted phrase not in QUOTED_SUBSET_NAMES is left alone.
    expect(namesAgree("Bobby Witt", 'Bobby Witt "Not A Real Tag"')).toBe(false);
  });

  it("the league-leader suffix is matched by SHAPE (LL + league + stat), not by string-chopping", () => {
    expect(namesAgree("Chris Sale", "Chris Sale LL NL ERA")).toBe(true);
    // A near-miss shape (missing the league token) must not be swallowed by a
    // looser "drop the last N words" rule.
    expect(namesAgree("Chris Sale", "Chris Sale LL ERA")).toBe(false);
  });
});

describe("mutation check -- rule (c), Jr./Sr./II/III equivalence", () => {
  it("DROP THE GENERATIONAL-SUFFIX RULE -> red: \"Vladimir Guerrero Jr.\" would still disagree with \"Vladimir Guerrero\"", () => {
    const oldCompare = (x: string, y: string) =>
      x.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === y.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(oldCompare("Vladimir Guerrero Jr.", "Vladimir Guerrero")).toBe(false);
    expect(namesAgree("Vladimir Guerrero Jr.", "Vladimir Guerrero")).toBe(true);
  });

  it("II/III/IV/V presence is equivalent too, symmetric in either direction", () => {
    expect(namesAgree("Ken Griffey II", "Ken Griffey")).toBe(true);
    expect(namesAgree("Ken Griffey", "Ken Griffey II")).toBe(true);
  });
});

describe("mutation check -- rule (a) fires only on the FIRST-listed name, never a search of the whole list", () => {
  it("a multi-name incumbent whose FIRST name differs from the single-name side still refuses", () => {
    expect(namesAgree("Ronel Blanco", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA")).toBe(false);
  });
});

describe("mutation check -- genuinely different players are never swept into agreement", () => {
  it("two unrelated single names never agree, tag stripping or not", () => {
    expect(namesAgree("Aaron Judge", "Juan Soto")).toBe(false);
    expect(namesAgree("Will Brennan", "Steven Kwan")).toBe(false);
  });
});

// ── layer 2: end-to-end through moveCatalogRow, so the wiring into
//    arbitratePlayer's conflict gate is pinned, not just the standalone
//    function. Same fake-container shape foldNeverChangesThePlayer.test.ts
//    uses, so this suite is directly comparable to the OLD refusal it pins. ──

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist in the system"), { code: 404 });
}
const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

type Doc = Record<string, any>;

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

const FROM_KEY = "topps-series-1";
const TO_KEY = "topps";
const REASON = "ruled setKey re-key topps-series-1 -> topps";
const slug = (num: string, parallel: string, setKey: string) => `hiq:baseball:2025:${setKey}:${num}:${parallel}:no-auto`;

function toppsRow(setKey: string, num: string, parallel: string, player: string | null, over: Doc = {}): Doc {
  const id = slug(num, parallel, setKey);
  return {
    id, cardId: id, hobbyiqCardId: id,
    sport: "baseball", year: 2025, cardYear: 2025,
    setKey, setName: "2025 Topps",
    cardNumber: num, parallel: parallel === "base" ? "Base" : parallel, parallelSlug: parallel,
    isAuto: false, printRun: null,
    playerName: player, playerSlug: player ? player.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null,
    vendorIds: {},
    source: setKey === FROM_KEY ? "checklistinsider-2026-09-01" : "hobbymonitor-2026-09-10",
    confidence: 0.9,
    observedAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function world(fromRow: Doc, toRow: Doc | null, sales: Doc[] = []) {
  const log: string[] = [];
  const catalog = new FakeContainer("card_catalog", log, [fromRow, ...(toRow ? [toRow] : [])]);
  const pool = new FakeContainer("sold_comps", log, sales);
  return { log, catalog, pool, cat: catalog as unknown as Container, sales: pool as unknown as Container };
}

const move = (w: ReturnType<typeof world>, from: Doc, toSlug: string, opts: Doc = {}) =>
  moveCatalogRow(w.cat, from, toSlug, { setKey: TO_KEY }, {
    reason: REASON, repointNormalizedSetKey: true, salesContainer: w.sales, ...opts,
  });

describe("end to end -- namesAgree lets the real 35638061024 shapes reach the ordinary ladder", () => {
  it("#144 purple-rainbow-foil -- bare \"Shohei Ohtani\" vs the LL NL HR trio: no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "144", "purple-rainbow-foil", "Shohei Ohtani");
    const to = toppsRow(TO_KEY, "144", "purple-rainbow-foil", "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR", { vendorIds: { cardhedge: "ch-1" } });
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined(); // never even reached the arms
  });

  it("#165 gold-holo-foil -- \"Joey Ortiz\" vs \"Joey Ortiz RCup\": no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "165", "gold-holo-foil", "Joey Ortiz");
    const to = toppsRow(TO_KEY, "165", "gold-holo-foil", "Joey Ortiz RCup", { vendorIds: { cardhedge: "ch-2" } });
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("#345 gold-diamante-foil -- \"Vladimir Guerrero Jr.\" vs \"Vladimir Guerrero\": no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "345", "gold-diamante-foil", "Vladimir Guerrero Jr.");
    const to = toppsRow(TO_KEY, "345", "gold-diamante-foil", "Vladimir Guerrero");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("#81 gold-rainbow-foil -- \"Carlos Correa\" vs 'Carlos Correa \"Say Cheese!\"': no longer refused", async () => {
    const from = toppsRow(FROM_KEY, "81", "gold-rainbow-foil", "Carlos Correa");
    const to = toppsRow(TO_KEY, "81", "gold-rainbow-foil", 'Carlos Correa "Say Cheese!"');
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration).toBeUndefined();
  });

  it("#5 foilfractor -- \"Ronel Blanco\" (2nd-listed, not first) vs the trio: STILL REFUSED", async () => {
    const from = toppsRow(FROM_KEY, "5", "foilfractor", "Ronel Blanco");
    const to = toppsRow(TO_KEY, "5", "foilfractor", "Tarik Skubal / Ronel Blanco / Framber Valdez LL AL ERA");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
    expect(r.refusal?.reason).toBe("different-player-uncorroborated");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("#234 foilfractor -- \"Chris Sale\" (2nd-listed) vs the trio: STILL REFUSED", async () => {
    const from = toppsRow(FROM_KEY, "234", "foilfractor", "Chris Sale");
    const to = toppsRow(TO_KEY, "234", "foilfractor", "Zack Wheeler / Chris Sale / Shota Imanaga LL NL W");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("a genuinely different player still refuses when neither side is corroborated", async () => {
    const from = toppsRow(FROM_KEY, "99", "base", "Aaron Judge");
    const to = toppsRow(TO_KEY, "99", "base", "Juan Soto");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
    expect(r.refusal?.incomingPlayer).toBe("Aaron Judge");
    expect(r.refusal?.incumbentPlayer).toBe("Juan Soto");
    expect(w.catalog.writes()).toEqual([]);
  });

  it("a genuinely different player (Will Brennan vs Steven Kwan) still refuses", async () => {
    const from = toppsRow(FROM_KEY, "26", "base", "Will Brennan");
    const to = toppsRow(TO_KEY, "26", "base", "Steven Kwan");
    const w = world(from, to);
    const r = await move(w, from, to.id);
    expect(r.action).toBe("refused");
  });

  it("corroboration still decides when namesAgree does NOT recognise the pair (Optic's own shape, unaffected)", async () => {
    // Sanity: the new gate must not swallow the case the OLD suite already
    // pins as arbitrable-by-evidence -- a genuinely different-player pair
    // that a title tally settles.
    const from = toppsRow(FROM_KEY, "38", "base", "Joe Burrow");
    const to = toppsRow(TO_KEY, "38", "base", "Trey Benson");
    const w = world(from, to);
    const r = await move(w, from, to.id, {
      playerEvidence: { titlePlayerCounts: { "Joe Burrow": 10, "Trey Benson": 0 } },
    });
    expect(r.action).not.toBe("refused");
    expect(r.playerArbitration?.by).toBe("sale-titles");
  });
});
