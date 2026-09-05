/**
 * CF-AN-ALIAS-IS-NOT-A-SECOND-POOL -- the alias reslug lane, pinned.
 *
 * #1783 declared `bellingham`, `1987-bellingham-baseball` and
 * `bellingham-mariners-team-issue` aliases of `bellingham-mariners`. That fixed
 * the deriver and moved no stored row, because post-alias the census compares a
 * row's stored identity against `normalizeSetKey(setName)`, finds them EQUAL,
 * calls the row AGREE -- and AGREE is never written. The pool stays split on
 * the old segment while the holding re-derives onto the ruled key.
 *
 * Four properties are pinned here, each with the mutation that must turn it
 * red:
 *
 *   1. an alias segment resolves to its ruled key;
 *   2. a NON-alias key is untouched, however similar it looks;
 *   3. ONLY the setKey segment changes -- number, parallel, auto, subset and
 *      print run are carried byte for byte (D28);
 *   4. an empty or inherited scope REFUSES, before a Cosmos client exists.
 *
 * Plus the guarantee the report mode has to carry: driven against a
 * call-recording fake container, a dry run performs NO container call at all --
 * not an upsert, not a read, not a delete.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require("../scripts/reslug-ruled-alias.cjs");
const { slugParts, setKeyOfSlug, withSetKeySegment, ruledKeyForSlug, planAliasReslug } = lane;
const { admitAlias, isStrictCatalogSource, RULING_CONFLICT_DENY, discoverPoolAliases } = lane;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeSetKey } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { relocateSoldComp, stripSystem, contentHashOf } = require("../scripts/lib/relocate-sold-comp.cjs");

const RULED = "bellingham-mariners";
/** The exact table #1783 declared, as the lane narrows it: Map<alias, ruled>. */
const aliasMap = new Map<string, string>([
  ["bellingham", RULED],
  ["1987-bellingham-baseball", RULED],
  ["bellingham-mariners-team-issue", RULED],
]);

/** The three stored spellings of the 1987 Bellingham Mariners Griffey #15. */
const GRIFFEY_LONG = "hiq:baseball:1987:1987-bellingham-baseball:15:base:no-auto";
const GRIFFEY_TOWN = "hiq:baseball:1987:bellingham:15:base:no-auto";
const GRIFFEY_TEAM = "hiq:baseball:1987:bellingham-mariners-team-issue:15:base:no-auto";
const GRIFFEY_RULED = "hiq:baseball:1987:bellingham-mariners:15:base:no-auto";

describe("1. an alias segment resolves to the ruled key", () => {
  it("all three declared spellings land on the ruled slug", () => {
    for (const from of [GRIFFEY_LONG, GRIFFEY_TOWN, GRIFFEY_TEAM]) {
      const plan = planAliasReslug({ cardId: from, hobbyiqCardId: from, aliasMap });
      expect(plan.move).toBe(true);
      expect(plan.target).toBe(GRIFFEY_RULED);
      expect(plan.ruledKey).toBe(RULED);
    }
  });

  it("the alias it moved FROM is reported, so the banner can group by it", () => {
    expect(planAliasReslug({ cardId: GRIFFEY_TOWN, hobbyiqCardId: GRIFFEY_TOWN, aliasMap }).aliasWas)
      .toBe("bellingham");
    expect(planAliasReslug({ cardId: GRIFFEY_LONG, hobbyiqCardId: GRIFFEY_LONG, aliasMap }).aliasWas)
      .toBe("1987-bellingham-baseball");
  });

  it("a row ALREADY at the ruled key is not a move -- it is not double-counted", () => {
    const plan = planAliasReslug({ cardId: GRIFFEY_RULED, hobbyiqCardId: GRIFFEY_RULED, aliasMap });
    expect(plan.move).toBe(false);
  });

  it("BOTH identity fields are considered: an alias on EITHER puts the row in scope", () => {
    // The exact-pool reader ORs cardId and hobbyiqCardId, so a row matching on
    // either one is in the old pool and must move.
    const viaIdentity = planAliasReslug({ cardId: "tca-ebay::123", hobbyiqCardId: GRIFFEY_TOWN, aliasMap });
    expect(viaIdentity.move).toBe(true);
    expect(viaIdentity.target).toBe(GRIFFEY_RULED);
    // A legacy vendor partition key is preserved, never silently dropped.
    expect(viaIdentity.vendorCardIdWas).toBe("tca-ebay::123");

    // The partition key carries the alias while the identity field does not.
    const viaPartition = planAliasReslug({ cardId: GRIFFEY_TOWN, hobbyiqCardId: "", aliasMap });
    expect(viaPartition.move).toBe(true);
    expect(viaPartition.target).toBe(GRIFFEY_RULED);
  });

  it("a THIRD SLUG -- two hiq fields naming different cards -- is reported, not silently normalised", () => {
    const plan = planAliasReslug({ cardId: GRIFFEY_LONG, hobbyiqCardId: GRIFFEY_TOWN, aliasMap });
    expect(plan.move).toBe(true);
    expect(plan.target).toBe(GRIFFEY_RULED);
    expect(plan.thirdSlug).toBe(GRIFFEY_LONG);
  });
});

describe("2. a NON-alias key is untouched", () => {
  it("a key absent from the table is never rewritten, however similar it looks", () => {
    for (const other of [
      "hiq:baseball:1987:topps:15:base:no-auto",
      "hiq:baseball:1987:donruss:15:base:no-auto",
      // Similar-looking and NOT declared: the lane reads the table, it does not
      // pattern-match on the word "bellingham".
      "hiq:baseball:1987:bellingham-mariners-team-set:15:base:no-auto",
      "hiq:baseball:1988:bellinghams:15:base:no-auto",
    ]) {
      const plan = planAliasReslug({ cardId: other, hobbyiqCardId: other, aliasMap });
      expect(plan.move, `${other} must not move`).toBe(false);
      expect(ruledKeyForSlug(other, aliasMap)).toBeNull();
    }
  });

  it("MUTATION: a substring rule instead of a table lookup turns the above red", () => {
    // The tempting shortcut -- "if the key contains the ruled key's stem, fold
    // it" -- swallows `bellingham-mariners-team-set`, a key nobody ruled.
    const buggy = (slug: string) => {
      const k = setKeyOfSlug(slug);
      return k && k.includes("bellingham") && k !== RULED ? RULED : null;
    };
    const undeclared = "hiq:baseball:1987:bellingham-mariners-team-set:15:base:no-auto";
    expect(buggy(undeclared)).toBe(RULED);              // <- the bug
    expect(ruledKeyForSlug(undeclared, aliasMap)).toBeNull(); // <- the lane
  });

  it("an unrelated sport/year carrying a declared alias still resolves -- the table is the scope", () => {
    // The alias table is not year-scoped; the YEARS/SPORTS filters are applied
    // by the sweep, not by the predicate. Pinned so the two stay distinct.
    const other = "hiq:baseball:1988:bellingham:15:base:no-auto";
    expect(planAliasReslug({ cardId: other, hobbyiqCardId: other, aliasMap }).target)
      .toBe("hiq:baseball:1988:bellingham-mariners:15:base:no-auto");
  });
});

describe("3. ONLY the setKey segment changes (D28: surgery, never a recompute)", () => {
  const cases: Array<[string, string]> = [
    // plain
    [GRIFFEY_TOWN, GRIFFEY_RULED],
    // a parallel and an auto flag the current resolver might spell differently
    ["hiq:baseball:1987:bellingham:15:gold-refractor:auto",
     "hiq:baseball:1987:bellingham-mariners:15:gold-refractor:auto"],
    // a print run rides along untouched
    ["hiq:baseball:1987:bellingham:15:gold-refractor:auto:num-499",
     "hiq:baseball:1987:bellingham-mariners:15:gold-refractor:auto:num-499"],
    // a subset segment sits between setKey and number and must survive
    ["hiq:baseball:1987:bellingham:sub-team:15:base:no-auto",
     "hiq:baseball:1987:bellingham-mariners:sub-team:15:base:no-auto"],
    // a 1/1
    ["hiq:baseball:1987:bellingham:15:black-prism-refractor:no-auto:num-1",
     "hiq:baseball:1987:bellingham-mariners:15:black-prism-refractor:no-auto:num-1"],
  ];

  it("every other segment is carried byte for byte", () => {
    for (const [from, want] of cases) {
      expect(withSetKeySegment(from, RULED)).toBe(want);
      // Segment-by-segment: only index 3 may differ.
      const a = String(from).split(":");
      const b = String(want).split(":");
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        if (i === 3) expect(b[i]).toBe(RULED);
        else expect(b[i], `segment ${i} must be untouched`).toBe(a[i]);
      }
    }
  });

  it("the parallel is NEVER re-derived -- a gold refractor stays gold", () => {
    // The Bowman Draft re-slug turned `gold-refractor` into `refractor` by
    // re-deriving from the title, caught in dry run. A vendor title routinely
    // omits the parallel the existing slug already captured correctly.
    const from = "hiq:baseball:1987:bellingham:15:gold-refractor:auto:num-499";
    const plan = planAliasReslug({ cardId: from, hobbyiqCardId: from, aliasMap });
    expect(plan.target).toContain(":gold-refractor:");
    expect(plan.target).not.toContain(":refractor:");
  });

  it("MUTATION: dropping the 'only segment 3' restriction turns this red", () => {
    // The mutation is a rebuild that also normalises the parallel -- the exact
    // shape of a full recompute riding along on a product move.
    const buggy = (slug: string, setKey: string) => {
      const p = String(slug).split(":");
      p[3] = setKey;
      p[5] = String(p[5]).replace(/^.*-refractor$/, "refractor"); // <- the extra write
      return p.join(":");
    };
    const from = "hiq:baseball:1987:bellingham:15:gold-refractor:auto:num-499";
    const want = "hiq:baseball:1987:bellingham-mariners:15:gold-refractor:auto:num-499";
    expect(withSetKeySegment(from, RULED)).toBe(want);
    expect(buggy(from, RULED)).not.toBe(want);
    expect(buggy(from, RULED)).toContain(":refractor:");
  });

  it("MUTATION: writing the ruled key to the wrong index turns this red", () => {
    const buggy = (slug: string, setKey: string) => {
      const p = String(slug).split(":");
      p[4] = setKey; // the card number, not the setKey
      return p.join(":");
    };
    expect(withSetKeySegment(GRIFFEY_TOWN, RULED)).toBe(GRIFFEY_RULED);
    expect(buggy(GRIFFEY_TOWN, RULED)).not.toBe(GRIFFEY_RULED);
  });

  it("a WRONG card number is carried across, not quietly corrected", () => {
    // Observed live: the pool's highest-priced sale ($6,151 PSA 10) is a
    // genuine #15 Griffey filed at `:1:`, because the number parser read the
    // draft position out of "*87 #1 Pick** Bellingham Team #15 XRC".
    //
    // This lane must NOT fix it. Rewriting a segment because it looks wrong is
    // a recompute wearing a re-key's clothes -- exactly what D28 forbids. The
    // row moves product and keeps its (wrong) number; the cardNumber repair is
    // its own lane.
    const from = "hiq:baseball:1987:bellingham:1:base:no-auto";
    const plan = planAliasReslug({ cardId: from, hobbyiqCardId: from, aliasMap });
    expect(plan.target).toBe("hiq:baseball:1987:bellingham-mariners:1:base:no-auto");
    expect(plan.target).toContain(":1:");
    expect(plan.target).not.toContain(":15:");
  });

  it("a malformed or foreign id is refused rather than mangled", () => {
    for (const bad of ["", "not-a-slug", "hiq:baseball:1987", "tca-ebay::12345",
      "hiq:baseball:19x7:bellingham:15:base:no-auto", "hiq:baseball:1987::15:base:no-auto"]) {
      expect(slugParts(bad), bad).toBeNull();
      expect(withSetKeySegment(bad, RULED), bad).toBeNull();
    }
  });
});

describe("4. an empty or inherited scope REFUSES", () => {
  const scriptPath = join(__dirname, "..", "scripts", "reslug-ruled-alias.cjs");

  it("empty, 'refractor' and 'all' each exit 1 before any Cosmos client", () => {
    for (const bad of ["", "refractor", "all"]) {
      const r = spawnSync(process.execPath, [scriptPath], {
        // No connection string: the scope refusal must come FIRST, so a bad
        // scope can never reach a connected client even by accident.
        env: { ...process.env, SCOPE: bad, COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "true" },
        encoding: "utf8",
      });
        expect(r.status, `SCOPE=${bad}`).toBe(1);
      expect(String(r.stderr)).toContain("SCOPE is required");
      // It refused for the RIGHT reason -- not because Cosmos was missing.
      expect(String(r.stderr)).not.toContain("COSMOS_CONNECTION_STRING");
    }
  });

  it("a scope key that is not a normalizeSetKey FIXED POINT refuses, exit 2", () => {
    // `donruss` is the census's #2 by volume and can never be a destination:
    // normalizeSetKey("donruss") === "panini-donruss", an ERA SPLIT that
    // spellForEra resolves per year. Moving rows onto it queues the next move.
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, SCOPE: "donruss", COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "true" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(String(r.stderr)).toContain("is not a normalizeSetKey fixed point");
    expect(String(r.stderr)).toContain("panini-donruss");
    // It refused for the RIGHT reason -- not because Cosmos was missing.
    expect(String(r.stderr)).not.toContain("COSMOS_CONNECTION_STRING");
  });

  it("a scope on the RULING CONFLICT deny-list refuses, exit 2", () => {
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, SCOPE: "ud-choice", COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "true" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(String(r.stderr)).toContain("RULING CONFLICT deny-list");
  });

  it("a scope nothing resolves to refuses at the Cosmos gate, never sweeps nothing", () => {
    // `not-a-ruled-key` IS a fixed point (the vocabulary leaves it alone), so
    // it passes gate 1 and is refused later -- for want of a connection here,
    // and by "no alias resolves to it" once connected. What must never happen
    // is a green run that swept nothing.
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, SCOPE: "not-a-ruled-key", COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "true" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(String(r.stderr)).toContain("COSMOS_CONNECTION_STRING not set");
  });

  it("the RULED scope passes the guards and stops only for want of a connection", () => {
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, SCOPE: RULED, COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "" },
      encoding: "utf8",
    });
    expect(String(r.stderr)).toContain("COSMOS_CONNECTION_STRING not set");
    expect(String(r.stderr)).not.toContain("is not a normalizeSetKey fixed point");
  });

  it("a DERIVER-resolved scope reaches the Cosmos gate too -- #1792's blind spot", () => {
    // `donruss-optic` is a fixed point with no RULED alias naming it. Before
    // Drew's 2026-09-05 ruling this exited at the scope gate with "is not a
    // ruled alias destination"; now it must get as far as needing a connection.
    const r = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, SCOPE: "donruss-optic", COSMOS_CONNECTION_STRING: "", BACKFILL_APPLY: "" },
      encoding: "utf8",
    });
    expect(String(r.stderr)).toContain("COSMOS_CONNECTION_STRING not set");
    expect(String(r.stderr)).not.toContain("is not a ruled alias destination");
  });
});

/**
 * 5. THE ADMISSION RULE (#1793) -- RULED union DERIVER-RESOLVED.
 *
 * Drew's 2026-09-05 ruling widened this lane's scope gate: a DERIVER-RESOLVED
 * alias (one the live vocabulary already folds onto the scope key) qualifies
 * alongside a RULED one. #1792 measured 306,807 pool rows sitting in that blind
 * spot -- classified AGREE by the census, which never writes them, and refused
 * by this lane, which accepted only RULED scopes.
 *
 * The admission is DATA-DRIVEN: it asks the LIVE normalizeSetKey about each
 * candidate rather than consulting a typed list, so it cannot drift from the
 * vocabulary. These cases therefore also serve as a canary on the vocabulary
 * itself -- if `normalizeSetKey("panini-optic")` ever stops returning
 * `donruss-optic`, this file goes red and says so.
 */
describe("5. the admission rule: RULED union DERIVER-RESOLVED", () => {
  const noRuled = new Set<string>();

  it("a DERIVER-resolved alias is admitted, and says which rule admitted it", () => {
    // Every pair here is a live normalizeSetKey fact, not a fixture.
    const pairs: Array<[string, string]> = [
      ["panini-optic", "donruss-optic"],
      ["finest", "topps-finest"],
      ["stadium-club", "topps-stadium-club"],
      ["chrome", "topps-chrome"],
      ["ud", "upper-deck"],
      ["panini-leather-lumber", "leather-lumber"],
    ];
    for (const [alias, scope] of pairs) {
      // The premise, asserted rather than assumed.
      expect(normalizeSetKey(alias), `${alias} must derive to ${scope}`).toBe(scope);
      const v = admitAlias({ alias, scope, ruledSet: noRuled, normalizeSetKey });
      expect(v.admit, `${alias} -> ${scope}`).toBe(true);
      expect(v.rule).toBe("DERIVER");
    }
  });

  it("a RULED alias is admitted as RULED even where no derivation would reach it", () => {
    const v = admitAlias({
      alias: "some-hand-ruled-spelling", scope: "bellingham-mariners",
      ruledSet: new Set(["some-hand-ruled-spelling"]), normalizeSetKey,
    });
    expect(v.admit).toBe(true);
    expect(v.rule).toBe("RULED");
  });

  it("the two rules agree where they overlap -- RULED wins the label", () => {
    // panini-hoops IS declared, and also derives. It reports RULED, because a
    // human decision carries the authority a derivation does not.
    expect(normalizeSetKey("panini-hoops")).toBe("nba-hoops");
    const v = admitAlias({
      alias: "panini-hoops", scope: "nba-hoops",
      ruledSet: new Set(["panini-hoops"]), normalizeSetKey,
    });
    expect(v.admit).toBe(true);
    expect(v.rule).toBe("RULED");
  });

  it("REFUSAL: an alias that is a FIXED POINT of its own is a product, not a spelling", () => {
    // #1792's 58-pair SPLIT bucket, refused by mechanism rather than by a list.
    for (const alias of ["select", "score", "studio", "diamond-kings"]) {
      expect(normalizeSetKey(alias), `${alias} must be a fixed point`).toBe(alias);
      const v = admitAlias({ alias, scope: alias, ruledSet: noRuled, normalizeSetKey });
      expect(v.admit, alias).toBe(false);
    }
    // And with a DIFFERENT scope, so the self-alias check is not what refused it.
    expect(normalizeSetKey("donruss-studio")).toBe("donruss-studio");
    const v = admitAlias({ alias: "donruss-studio", scope: "studio", ruledSet: noRuled, normalizeSetKey });
    expect(v.admit).toBe(false);
    expect(v.why).toContain("fixed point");
  });

  it("REFUSAL: an alias that derives SOMEWHERE ELSE is not this scope's business", () => {
    expect(normalizeSetKey("panini-optic")).toBe("donruss-optic");
    const v = admitAlias({ alias: "panini-optic", scope: "topps-chrome", ruledSet: noRuled, normalizeSetKey });
    expect(v.admit).toBe(false);
    expect(v.why).toContain("donruss-optic");
  });

  it("REFUSAL: an alias may not be its own destination", () => {
    const v = admitAlias({ alias: "donruss-optic", scope: "donruss-optic", ruledSet: noRuled, normalizeSetKey });
    expect(v.admit).toBe(false);
    expect(v.why).toContain("own destination");
  });

  it("REFUSAL: the RULING CONFLICT deny-list outranks both rules", () => {
    // upper-deck-choice was DECLARED an alias on 2026-09-05 and WITHDRAWN the
    // same day, because exquisiteIsItsOwnProduct.test.ts pins it a fixed point.
    // A standing ruling outranks a source count -- and outranks a RULED_ALIASES
    // row too, so a table edited into conflict refuses rather than sweeps.
    const v = admitAlias({
      alias: "upper-deck-choice", scope: "ud-choice",
      ruledSet: new Set(["upper-deck-choice"]), normalizeSetKey,
    });
    expect(v.admit).toBe(false);
    expect(v.why).toContain("RULING CONFLICT");
    // Every deny-list entry carries its reason -- a list without one is a list
    // nobody dares to change.
    for (const [k, why] of Object.entries(RULING_CONFLICT_DENY)) {
      expect(String(why).length, k).toBeGreaterThan(30);
    }
  });
});

/**
 * 6. GATE 3 -- a competing checklist must prove it names the SAME CARDS.
 *
 * The gate that the first REPORT run against prod corrected. Refusing on
 * "strict rows exist" refused `panini-optic`, the 235,186-row headline case of
 * the ruling itself. The measurement that tells the two shapes apart:
 *
 *   panini-optic vs donruss-optic         football/2024   74.7% card overlap
 *                                         basketball/2023 97.6%
 *   panini-diamond-kings vs diamond-kings 2020, 2022       0.0%
 *
 * Same row counts in shape, same strict sources; only the CARDS differ.
 */
describe("6. gate 3: strict rows are admitted only on proven card overlap", () => {
  const noRuled = new Set<string>();
  const base = { alias: "panini-optic", scope: "donruss-optic", ruledSet: noRuled, normalizeSetKey };

  it("no strict rows -> no overlap evidence is needed", () => {
    const v = admitAlias({ ...base, strictRows: 0, overlap: null });
    expect(v.admit).toBe(true);
    expect(v.rule).toBe("DERIVER");
  });

  it("strict rows + HIGH overlap -> admitted (the measured panini-optic case)", () => {
    for (const overlap of [0.747, 0.822, 0.976]) {
      const v = admitAlias({ ...base, strictRows: 15995, overlap });
      expect(v.admit, `overlap ${overlap}`).toBe(true);
      expect(v.rule).toBe("DERIVER");
      expect(v.overlap).toBe(overlap);
    }
  });

  it("strict rows + ZERO overlap -> refused (the measured diamond-kings SHAPE)", () => {
    // Gate 3 can only be reached by a pair the deriver actually resolves, so
    // the case is stated on a resolving pair carrying the diamond-kings
    // MEASUREMENT (0.0% shared cards). The real panini-diamond-kings pair never
    // gets this far -- gate 2 refuses it as a fixed point first, which is the
    // stronger refusal and is pinned in its own case below.
    const v = admitAlias({ ...base, strictRows: 14429, overlap: 0 });
    expect(v.admit).toBe(false);
    expect(v.why).toContain("DIFFERENT CARDS");
    expect(v.why).toContain("0.0%");

    // And the real pair, refused earlier and for a different reason.
    const real = admitAlias({
      alias: "panini-diamond-kings", scope: "diamond-kings", ruledSet: noRuled,
      normalizeSetKey, strictRows: 14429, overlap: 0,
    });
    expect(real.admit).toBe(false);
    expect(real.why).toContain("fixed point");
  });

  it("strict rows + NO SHARED CELL -> refused; silence is not proof of sameness", () => {
    const v = admitAlias({ ...base, strictRows: 100, overlap: null });
    expect(v.admit).toBe(false);
    expect(v.why).toContain("NO SHARED");
  });

  it("the floor sits in the two-order-of-magnitude gap between the two shapes", () => {
    // Every measured SPLIT pair scored 0.0%; every measured same-product pair
    // scored 74.7% or better. The exact floor is not load-bearing, and this
    // pins that it separates the observations rather than splitting them.
    const SPLIT = [0, 0];
    const SAME = [0.747, 0.822, 0.976];
    for (const o of SPLIT) expect(admitAlias({ ...base, strictRows: 1, overlap: o }).admit).toBe(false);
    for (const o of SAME) expect(admitAlias({ ...base, strictRows: 1, overlap: o }).admit).toBe(true);
  });

  it("STRICT vs self-derived is decided by SOURCE, never by row count", () => {
    // CF-COUNT-BY-SOURCE-NOT-ROW-COUNT. The self-derived families are exactly
    // the stale spellings this lane exists to move; they must never be read as
    // a competing checklist claim.
    for (const s of ["checklistinsider", "checklistinsider-2026-08-27", "beckett-xlsx",
      "bccp-product-structure", "hobbymonitor-2026-09-04", "baseballcardpedia",
      "drew-ruling-checklist-2026-08-30"]) {
      expect(isStrictCatalogSource(s), s).toBe(true);
    }
    for (const s of ["ingest-auto-seed", "ingest-auto-seed-graded", "sales-attested",
      "sales-attested-unnumbered", "ebay-browse", "ebay-user-purchase", "user-verified",
      "tree-builder-v1", "", "(no source)"]) {
      expect(isStrictCatalogSource(s), s).toBe(false);
    }
  });

  it("MUTATION: dropping the strict-row refusal admits a genuine SPLIT pair", () => {
    // The mutation is "trust the derivation alone" -- no gate 3 at all.
    const buggy = ({ alias, scope }: { alias: string; scope: string }) =>
      normalizeSetKey(alias) === scope && alias !== scope;
    // A DERIVING pair carrying a genuine SPLIT's measurement: zero shared cards.
    // The lane refuses it on gate 3; the mutation, which trusts the derivation
    // alone, would fold two products into one pool.
    const pair = { alias: "panini-optic", scope: "donruss-optic" };
    const real = admitAlias({ ...pair, ruledSet: noRuled, normalizeSetKey, strictRows: 14429, overlap: 0 });
    expect(real.admit).toBe(false);                        // <- the lane
    expect(real.why).toContain("DIFFERENT CARDS");
    expect(buggy(pair)).toBe(true);                        // <- the bug
  });

  it("MUTATION: dropping the fixed-point refusal admits the whole SPLIT bucket", () => {
    // Without gate 2, `donruss-studio` -> `studio` (11,296 rows, a key carrying
    // bccp-product-structure rows of its own) becomes admissible on nothing but
    // a name resemblance.
    const buggy = (alias: string, scope: string) => alias !== scope && alias.endsWith(scope);
    expect(buggy("donruss-studio", "studio")).toBe(true);   // <- the bug
    expect(admitAlias({ alias: "donruss-studio", scope: "studio", ruledSet: noRuled, normalizeSetKey }).admit)
      .toBe(false);                                          // <- the lane
    expect(buggy("panini-diamond-kings", "diamond-kings")).toBe(true);
    expect(admitAlias({ alias: "panini-diamond-kings", scope: "diamond-kings", ruledSet: noRuled, normalizeSetKey }).admit)
      .toBe(false);
  });
});

/**
 * 7. THE ALIAS SET IS DISCOVERED FROM THE POOL, NEVER TYPED.
 *
 * A hand-written list of spellings is a second copy of the vocabulary. It
 * drifts when normalizeSetKey changes, it can name a spelling that does not
 * exist (sweeping nothing and reporting success), and it can miss one that
 * does. The discovery reads segment 3 of the ids the pool actually stores and
 * asks the live deriver about each.
 */
describe("7. alias discovery reads the pool, and only the setKey segment", () => {
  /** A page-serving fake: one query, whatever ids the test supplies. */
  const fakePool = (ids: string[], pageSize = 3) => ({
    queries: [] as string[],
    items: {
      query(spec: { query: string; parameters: Array<{ name: string; value: string }> }, opts: { continuationToken?: string }) {
        const prefix = spec.parameters[0].value;
        const matching = ids.filter((i) => i.startsWith(prefix));
        const from = Number(opts.continuationToken ?? 0);
        const slice = matching.slice(from, from + pageSize);
        const next = from + pageSize < matching.length ? String(from + pageSize) : undefined;
        return {
          fetchNext: async () => ({
            resources: slice.map((hobbyiqCardId) => ({ hobbyiqCardId })),
            continuationToken: next,
          }),
        };
      },
    },
  });
  const retry = async (fn: () => unknown) => fn();

  it("finds the spellings the pool stores that derive onto the scope", async () => {
    const pool = fakePool([
      "hiq:football:2024:panini-optic:56:holo:no-auto",
      "hiq:football:2024:panini-optic:288:green-velocity:no-auto",
      "hiq:football:2024:donruss-optic:12:base:no-auto",     // already home
      "hiq:football:2024:topps-chrome:1:base:no-auto",        // another product
      "hiq:football:2024:prizm:9:base:no-auto",               // another product
    ]);
    const { found } = await discoverPoolAliases({
      pool, scope: "donruss-optic", sports: ["football"], years: [2024],
      normalizeSetKey, retry, maxPages: 10,
    });
    expect([...found.keys()]).toEqual(["panini-optic"]);
    expect(found.get("panini-optic").sampled).toBe(2);
    // The destination itself is never reported as an alias of itself.
    expect(found.has("donruss-optic")).toBe(false);
  });

  it("reports TRUNCATION rather than passing a bounded sample off as a census", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `hiq:football:2024:panini-optic:${i}:base:no-auto`);
    const { truncated } = await discoverPoolAliases({
      pool: fakePool(many, 3), scope: "donruss-optic", sports: ["football"], years: [2024],
      normalizeSetKey, retry, maxPages: 2,
    });
    expect(truncated).toContain("football/2024");
  });

  it("an empty pool discovers nothing -- and the lane refuses rather than sweeping", async () => {
    const { found } = await discoverPoolAliases({
      pool: fakePool([]), scope: "donruss-optic", sports: ["football"], years: [2024],
      normalizeSetKey, retry, maxPages: 4,
    });
    expect(found.size).toBe(0);
  });

  it("the discovery is READ-ONLY -- the fake exposes no write method at all", async () => {
    const pool = fakePool(["hiq:football:2024:panini-optic:56:holo:no-auto"]);
    // If discovery ever tried to upsert/patch/delete, this would throw rather
    // than silently succeed against a permissive stub.
    expect((pool as Record<string, unknown>).item).toBeUndefined();
    expect((pool.items as Record<string, unknown>).upsert).toBeUndefined();
    await discoverPoolAliases({
      pool, scope: "donruss-optic", sports: ["football"], years: [2024],
      normalizeSetKey, retry, maxPages: 4,
    });
  });
});

/** A call-RECORDING stand-in for a Cosmos container. Every method appends to
 *  `calls` before doing anything, so "no write happened" is provable as "no
 *  call happened at all" rather than inferred from an unchanged store. */
function recordingPool(seed: Record<string, unknown>[]) {
  const key = (id: string, cardId: string) => `${cardId} ${id}`;
  const store = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  for (const d of seed) store.set(key(String(d.id), String(d.cardId)), { ...d });
  const notFound = () => Object.assign(new Error("NotFound"), { code: 404 });
  return {
    store,
    calls,
    item(id: string, cardId: string) {
      return {
        read: async () => {
          calls.push(`read ${key(id, cardId)}`);
          const r = store.get(key(id, cardId));
          if (!r) throw notFound();
          return { resource: { ...r } };
        },
        delete: async () => {
          calls.push(`delete ${key(id, cardId)}`);
          if (!store.delete(key(id, cardId))) throw notFound();
          return {};
        },
      };
    },
    items: {
      upsert: async (doc: Record<string, unknown>) => {
        calls.push(`upsert ${key(String(doc.id), String(doc.cardId))}`);
        store.set(key(String(doc.id), String(doc.cardId)), { ...doc });
        return { resource: { ...doc } };
      },
    },
  };
}

/** The lane's per-row write, exactly as the script performs it. */
async function runLaneMove(
  pool: ReturnType<typeof recordingPool>,
  row: Record<string, unknown>,
  dryRun: boolean,
) {
  const plan = planAliasReslug({ cardId: row.cardId, hobbyiqCardId: row.hobbyiqCardId, aliasMap });
  const keep = stripSystem(row);
  if (plan.vendorCardIdWas) keep.vendorCardIdWas = plan.vendorCardIdWas;
  keep.cardId = plan.target;
  keep.hobbyiqCardId = plan.target;
  keep.setKey = plan.ruledKey;
  keep.normalizedSetKey = plan.ruledKey;
  keep.rekeyedSetKeyWas = plan.aliasWas;
  keep.rekeyedFrom = plan.identityWas;
  keep.rekeyedAt = new Date().toISOString();
  keep.rekeyedReason = lane.REASON;
  keep.contentHash = contentHashOf(keep);
  const res = await relocateSoldComp(pool, {
    keep,
    drop: [{ id: row.id, cardId: row.cardId }],
    verifyFields: ["cardId", "hobbyiqCardId", "setKey", "contentHash", "rekeyedFrom"],
    dryRun,
  });
  return { res, plan, keep };
}

const griffeyRow = () => ({
  id: "tca-ebay::EBAY-v1|1987bellingham|0",
  cardId: GRIFFEY_LONG,
  hobbyiqCardId: GRIFFEY_LONG,
  title: "1987 Bellingham Mariners Team Issue #15 Ken Griffey Jr. RC",
  setName: "1987 Bellingham Baseball",
  price: 1250,
  soldAt: "2026-08-21T06:25:43.000Z",
  parallel: "Base",
  isAuto: false,
});

describe("the dry run is provably write-free", () => {
  it("a report-mode move performs NO container call at all", async () => {
    const pool = recordingPool([griffeyRow()]);
    const { res } = await runLaneMove(pool, griffeyRow(), /* dryRun */ true);

    expect(res.stage).toBe("dry-run");
    expect(res.ok).toBe(true);
    // The guarantee, stated as the absence of every call -- not as an
    // unchanged store, which a compensating pair of writes could also produce.
    expect(pool.calls).toEqual([]);
    expect(pool.store.size).toBe(1);
    expect([...pool.store.values()][0].cardId).toBe(GRIFFEY_LONG);
    expect([...pool.store.values()][0].hobbyiqCardId).toBe(GRIFFEY_LONG);
  });

  it("the SAME row in apply mode moves both fields and drops the old row", async () => {
    // The counterfactual: identical input, dryRun off. If this did not write,
    // the test above would prove nothing.
    const pool = recordingPool([griffeyRow()]);
    const { res, keep } = await runLaneMove(pool, griffeyRow(), /* dryRun */ false);

    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.duplicatesLeft).toHaveLength(0);
    // upsert -> read back -> delete, in that order: a sale is never lost.
    expect(pool.calls.filter((c) => c.startsWith("upsert"))).toHaveLength(1);
    expect(pool.calls.filter((c) => c.startsWith("delete"))).toHaveLength(1);
    expect(pool.calls.findIndex((c) => c.startsWith("upsert")))
      .toBeLessThan(pool.calls.findIndex((c) => c.startsWith("delete")));

    const rows = [...pool.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(GRIFFEY_RULED);
    expect(rows[0].hobbyiqCardId).toBe(GRIFFEY_RULED);
    // The old pool no longer reaches it by EITHER field.
    expect(rows[0].cardId).not.toBe(GRIFFEY_LONG);
    expect(rows[0].hobbyiqCardId).not.toBe(GRIFFEY_LONG);
    // The ledger is stamped.
    expect(rows[0].rekeyedFrom).toBe(GRIFFEY_LONG);
    expect(rows[0].rekeyedSetKeyWas).toBe("1987-bellingham-baseball");
    expect(rows[0].rekeyedReason).toBe(lane.REASON);
    expect(String(rows[0].rekeyedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The sale itself is carried across untouched.
    expect(rows[0].price).toBe(1250);
    expect(rows[0].title).toBe(griffeyRow().title);
    // THE HASH FOLLOWS THE ADDRESS -- cardId is its first component.
    expect(rows[0].contentHash).toBe(keep.contentHash);
    expect(rows[0].contentHash).not.toBe(contentHashOf(griffeyRow()));
  });

  it("MUTATION: a hash left at the old address is invisible to pre-write dedup", () => {
    const moved = { ...griffeyRow(), cardId: GRIFFEY_RULED, hobbyiqCardId: GRIFFEY_RULED };
    expect(contentHashOf(moved)).not.toBe(contentHashOf(griffeyRow()));
  });
});

describe("the lane source keeps its guarantees", () => {
  const script = readFileSync(join(__dirname, "..", "scripts", "reslug-ruled-alias.cjs"), "utf8");
  const body = script.slice(script.indexOf("async function main()"));

  it("APPLY comes from BACKFILL_APPLY -- the runner exports that, not APPLY", () => {
    expect(script).toContain('String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true"');
  });

  it("every partition move goes through relocateSoldComp, never a hand-rolled delete", () => {
    // CF-A-SALE-IS-NEVER-LOST (D19) owns the upsert-verify-delete ordering.
    expect(script).toContain("relocateSoldComp");
    expect(body).not.toMatch(/pool\.item\([^)]*\)\.delete\(/);
  });

  it("BOTH identity fields are verified on the relocate call", () => {
    const vf = /verifyFields:\s*\[([^\]]*)\]/.exec(script)?.[1] ?? "";
    expect(vf).toContain('"cardId"');
    expect(vf).toContain('"hobbyiqCardId"');
    expect(vf).toContain('"contentHash"');
  });

  it("the contentHash is computed AFTER both identity fields are final", () => {
    const pk = body.indexOf("keep.cardId = plan.target");
    const hiq = body.indexOf("keep.hobbyiqCardId = plan.target");
    const hash = body.indexOf("keep.contentHash = contentHashOf(keep)");
    expect(pk).toBeGreaterThan(-1);
    expect(hash).toBeGreaterThan(pk);
    expect(hash).toBeGreaterThan(hiq);
  });

  it("the alias table is READ from ruledAliases(), never retyped", () => {
    expect(script).toContain("ruledAliases");
    // No hardcoded destination anywhere in the executable body -- the ruling
    // lives in setKeyReconciliation and a copy here could drift from it.
    expect(body).not.toContain('"bellingham-mariners"');
  });

  it("the catalog side is reported and never written", () => {
    expect(script).toContain("REPORTED, NEVER WRITTEN");
    // No catalog mutation of any kind.
    expect(body).not.toMatch(/cat\.item\([^)]*\)\.(patch|delete|replace)\(/);
    expect(body).not.toMatch(/cat\.items\.(upsert|create)\(/);
  });

  it("the reconciliation closes: intended = written + skipped + failed", () => {
    expect(script).toContain("reconciled: intended");
    expect(script).toContain("reportWrites({ job: \"reslug-ruled-alias\"");
  });

  it("sharding is OPT-IN through the shared helper, not an inherited default", () => {
    // CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD: slot=0/slots=16 is the
    // runner's default and must sweep EVERY row.
    expect(script).toContain("runnerShardScope");
    expect(script).not.toMatch(/Number\(process\.env\.SLOTS[^)]*\)\s*\|\|\s*16/);
  });
});

describe("the runner can dispatch this script", () => {
  const repoRoot = join(__dirname, "..", "..");
  const runner = readFileSync(join(repoRoot, ".github", "workflows", "backfill-runner.yml"), "utf8");

  it("is on the script whitelist -- the dropdown IS the gate", () => {
    expect(runner.replace(/\r\n/g, "\n")).toContain("          - reslug-ruled-alias\n");
  });

  it("the exec is generic, which is what makes the dropdown the gate", () => {
    expect(runner).toContain('node "backend/scripts/${{ inputs.script }}.cjs"');
  });

  it("the runner passes SCOPE through, so the ruled key is dispatchable", () => {
    expect(runner).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
  });

  it("adds no new runner input -- the lane rides the 24 that exist", () => {
    // CF-THE-RUNNER-HAS-24-INPUTS: workflow_dispatch caps at 25.
    const dispatchBlock = runner.slice(runner.indexOf("  workflow_dispatch:"), runner.indexOf("jobs:"));
    const inputNames = [...dispatchBlock.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputNames.length).toBeLessThanOrEqual(25);
    expect(inputNames).toContain("scope");
    expect(inputNames).toContain("apply");
    expect(inputNames).toContain("years");
    expect(inputNames).toContain("sports");
  });
});
