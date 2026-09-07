/**
 * CF-NO-DEFAULT-SPORT + CF-A-SPLIT-ROW-IS-NEVER-WRITTEN (#1924 follow-up).
 *
 * The #1924 census measured 94,275 sold_comps rows whose `cardId` and
 * `hobbyiqCardId` name different SPORTS. `exactPoolReader` matches on either
 * field, so each of those rows is read into BOTH cards' pools: one sale prices
 * two cards, and no per-pool audit can see it, because each pool is internally
 * consistent every time it is asked. 3,398 of them were written in the seven
 * days before the census -- the emitter was live.
 *
 * Two facts decided the shape of the fix, and this file pins both:
 *
 *   1. BASEBALL IS A DEFAULT, NOT AN ERROR. It is the origin of 78,153 of the
 *      94,275 (82.9%). An error spread across verticals does not look like
 *      that; a hardcoded fallback does. So the fallbacks are gone.
 *   2. `hobbyiqCardId` IS NOT AUTOMATICALLY RIGHT. On the sub-class where the
 *      setKey is an unambiguous tell, `hobbyiqCardId` was correct on 2,330
 *      rows, `cardId` on 1,203, and NEITHER on 395. A blanket "canonical wins"
 *      rewrite corrupts about a third of the class. So the guard resolves ONLY
 *      toward an ATTESTED sport and otherwise PARKS.
 *
 * The MUTATION CHECK at the bottom is the load-bearing test: restore the
 * default, or drop the guard call from the write path, and this file must turn
 * red. A guard nothing proves is running is a guard that can be deleted by
 * accident.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addressDefect,
  decideSplitIdentity,
  sportOf,
  withSport,
} from "../src/services/portfolioiq/splitIdentityWriteGuard.js";
import { computeHobbyIqCardId, normalizeSport } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { resolveVertical } from "../src/services/portfolioiq/resolveVertical.service.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(backend, p), "utf8");

/** Strip comments so a test cannot be fooled by prose that QUOTES the defect
 *  it forbids -- every one of these files documents the old default at length,
 *  and a test that could not tell prose from code would force the explanation
 *  out of the file to stay green. */
const codeOf = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

// ── Real shapes, from the #1924 census ──────────────────────────────────────
// Every id below is a real one the census printed, so the fixtures assert
// against what production actually wrote rather than an invented shape.
const CENSUS = {
  // 2026-09-04 tca-ebay. cardId right, hobbyiqCardId wrong -- the direction
  // that proves "canonical wins" is a convention, not a fact.
  toppsChromeCard: "hiq:baseball:2025:topps-chrome:rpa-ac:gold-refractor:auto:num-50",
  toppsChromeHiq: "hiq:football:2025:topps-chrome:rpa-ac:gold-refractor:auto:num-50",
  // 2026-09-04 cardhedge. A Pokemon sale carrying a basketball slug.
  pokemonCard: "hiq:pokemon:2000:2000-pokemon-game-movie:nno:base:no-auto",
  pokemonHiq: "hiq:basketball:2000:unknown:player-pokemon-ancient-mew-promo:base:no-auto",
  // VENDOR-DESIGN: a CardHedge Bubble id beside our slug. 12.96M rows are
  // shaped exactly this way and they are NOT damage (#1650).
  bubbleId: "1778542173652x303328120692600800",
  bubbleHiq: "hiq:baseball:2023:topps-chrome:150:base:no-auto",
  // Cardsight's composite fallback key -- also a foreign key, also exempt.
  backstop: "backstop:eric hartman|2026|cpa-eha|1st bowman",
  // Same sport, different product: the 483,671-row class left for the
  // product-family vocabulary ruling.
  bowmanCard: "hiq:baseball:2025:bowman-chrome:cpa-kw:refractor:auto",
  bowmanHiq: "hiq:baseball:2025:bowman-draft:cpa-kw:base:auto",
};

describe("CF-NO-DEFAULT-SPORT: nothing invents a sport", () => {
  it("resolveVertical returns NO sport when nothing identified one", () => {
    // The old code returned `input.fallback ?? "baseball"`, so a caller that
    // deliberately passed no fallback was handed the very default the module
    // exists to expose. Absent beats wrong.
    const res = resolveVertical({ title: "2019 Panini #12 Some Card" });
    expect(res.confident).toBe(false);
    expect(res.reason).toBe("defaulted");
    expect(res.vertical).toBe("");
    expect(res.vertical).not.toBe("baseball");
  });

  it("still resolves confidently when the title DOES name a vertical", () => {
    // The fix must not cost real detection: parking everything would be as
    // wrong as defaulting everything.
    expect(resolveVertical({ title: "1969 Topps Baseball #500" })).toMatchObject({
      vertical: "baseball",
      confident: true,
    });
    expect(resolveVertical({ title: "2022 Panini Prizm NFL Football" })).toMatchObject({
      vertical: "football",
      confident: true,
    });
    // TCG is checked FIRST -- a Pokemon title contains no sport keyword and
    // would otherwise fall straight through to the fallback.
    expect(resolveVertical({ title: "Charizard VMAX Champions Path Pokemon" })).toMatchObject({
      vertical: "pokemon",
      confident: true,
    });
  });

  it("an explicitly passed fallback is still honoured", () => {
    // dataCleanJob passes the ROW's already-resolved sport, which is a real
    // prior rather than a guess. Only the hardcoded half was removed.
    expect(resolveVertical({ title: "no vertical here", fallback: "hockey" })).toMatchObject({
      vertical: "hockey",
      confident: false,
    });
  });

  it("the tca-ebay emitter no longer passes a baseball fallback", () => {
    // 88,165 of the 94,275 mismatched rows came from tca-ebay, and this call
    // site is where its sport was decided.
    const code = codeOf(read("src/services/portfolioiq/persistVendorSalesToPool.service.ts"));
    expect(code).not.toMatch(/fallback:\s*["']baseball["']/);
    // ...and an unresolved vertical must SKIP rather than compute a slug.
    expect(code).toContain("skippedSportUnresolved");
  });

  it("resolveVertical's own source carries no hardcoded baseball fallback", () => {
    const code = codeOf(read("src/services/portfolioiq/resolveVertical.service.ts"));
    expect(code).not.toMatch(/input\.fallback\s*\?\?\s*["']baseball["']/);
  });

  it("the admin labeler refuses to mint a slug from a defaulted sport", () => {
    const code = codeOf(read("src/services/portfolioiq/labeler.service.ts"));
    expect(code).not.toMatch(/input\.sport\s*\?\?\s*["']baseball["']/);
  });

  it("the hobbyiqCardId backfill infers with the SAME arguments as ingest", () => {
    // The backfill passed two args where deriveHobbyIqSlug passes three. The
    // third gates the vintage-flagship rules, so ingest and backfill could
    // infer DIFFERENT sports for one row -- and the backfill writes only
    // `hobbyiqCardId`, leaving `cardId` on the other answer. That asymmetry is
    // how the split became 2.4M rows wide.
    const code = codeOf(read("scripts/backfill-hobbyiq-cardid.mjs"));
    expect(code).toContain("inferSportFromContext(row.setName, row.title, row.cardYear)");
    expect(code).not.toMatch(/inferSportFromContext\(row\.setName,\s*row\.title\)/);
  });

  it("inferSportFromContext answers null rather than guessing", () => {
    // It is the OTHER inference path, and it was already correct: it returns
    // null on no evidence. Pinned so a future 'helpful' default cannot be
    // added back here either.
    const code = codeOf(read("src/services/portfolioiq/soldCompsStore.service.ts"));
    expect(code).toMatch(/export function inferSportFromContext[\s\S]{0,200}?\n/);
    const fn = code.slice(code.indexOf("export function inferSportFromContext"));
    const body = fn.slice(0, fn.indexOf("\nfunction makeId"));
    // The last statement of the function is the no-evidence answer.
    expect(body.trimEnd().endsWith("return null;\n}")).toBe(true);
  });
});

describe("CF-A-SPLIT-ROW-IS-NEVER-WRITTEN: the write-door guard", () => {
  it("passes a coherent row through untouched", () => {
    expect(
      decideSplitIdentity({
        cardId: CENSUS.bubbleHiq,
        hobbyiqCardId: CENSUS.bubbleHiq,
      }),
    ).toEqual({ verdict: "ok" });
  });

  it("EXEMPTS the vendor partition -- 12.96M rows are shaped that way", () => {
    // A CardHedge Bubble id beside our slug disagrees BY CONSTRUCTION. This is
    // the #1650 mistake in test form: guard these and the whole CardHedge pool
    // is mis-repaired.
    expect(
      decideSplitIdentity({ cardId: CENSUS.bubbleId, hobbyiqCardId: CENSUS.bubbleHiq }),
    ).toEqual({ verdict: "ok" });
    // Cardsight's composite fallback key is the same shape of foreign key.
    expect(
      decideSplitIdentity({ cardId: CENSUS.backstop, hobbyiqCardId: CENSUS.bubbleHiq }),
    ).toEqual({ verdict: "ok" });
  });

  it("PARKS a cross-sport split when nothing attests either side", () => {
    const out = decideSplitIdentity({
      cardId: CENSUS.toppsChromeCard,
      hobbyiqCardId: CENSUS.toppsChromeHiq,
    });
    expect(out.verdict).toBe("park");
    if (out.verdict !== "park") throw new Error("unreachable");
    expect(out.reason).toBe("split-identity");
    // It must not have quietly picked a side.
    expect(out.detail).toContain("no source attests");
  });

  it("RESOLVES toward an attested sport -- and to EITHER side", () => {
    // CardHedge's `group` field states the vertical. That is a source, not a
    // convention, so it decides -- including when it names `cardId`, the side
    // the "canonical wins" convention would have thrown away.
    const toCardId = decideSplitIdentity({
      cardId: CENSUS.toppsChromeCard,      // baseball
      hobbyiqCardId: CENSUS.toppsChromeHiq, // football
      attestedSport: "baseball",
      attestedBy: "cardhedge-group",
    });
    expect(toCardId).toEqual({
      verdict: "resolve",
      resolvedTo: CENSUS.toppsChromeCard,
      attestedBy: "cardhedge-group",
    });

    const toHiq = decideSplitIdentity({
      cardId: CENSUS.toppsChromeCard,
      hobbyiqCardId: CENSUS.toppsChromeHiq,
      attestedSport: "football",
      attestedBy: "cardhedge-group",
    });
    expect(toHiq).toEqual({
      verdict: "resolve",
      resolvedTo: CENSUS.toppsChromeHiq,
      attestedBy: "cardhedge-group",
    });
  });

  it("PARKS when the attested sport matches NEITHER side", () => {
    // 395 rows in the census matched neither. An attestation that names a
    // third sport does not license picking one of the two present.
    const out = decideSplitIdentity({
      cardId: CENSUS.toppsChromeCard,
      hobbyiqCardId: CENSUS.toppsChromeHiq,
      attestedSport: "hockey",
      attestedBy: "cardhedge-group",
    });
    expect(out.verdict).toBe("park");
  });

  it("PARKS the same-sport / different-product split rather than writing it", () => {
    // Bowman Chrome and Bowman Draft are DIFFERENT CARDS under the setKey
    // taxonomy ruling. The 483,671-row class needs a vocabulary decision, but
    // until then a NEW row of that shape must not be written: it would price
    // two cards exactly as the sport class does.
    const out = decideSplitIdentity({
      cardId: CENSUS.bowmanCard,
      hobbyiqCardId: CENSUS.bowmanHiq,
    });
    expect(out.verdict).toBe("park");
    if (out.verdict !== "park") throw new Error("unreachable");
    expect(out.detail).toContain("same sport, different product");
  });

  it("reads the sport segment, and rewrites only that segment", () => {
    expect(sportOf(CENSUS.pokemonCard)).toBe("pokemon");
    expect(sportOf(CENSUS.bubbleId)).toBeNull();       // a vendor key names no product
    expect(sportOf(null)).toBeNull();
    expect(withSport(CENSUS.toppsChromeHiq, "baseball")).toBe(CENSUS.toppsChromeCard);
  });

  it("a cardhedge Pokemon/basketball split parks without an attestation", () => {
    expect(
      decideSplitIdentity({
        cardId: CENSUS.pokemonCard,
        hobbyiqCardId: CENSUS.pokemonHiq,
      }).verdict,
    ).toBe("park");
  });
});

describe("the guard is WIRED, on the path every emitter shares", () => {
  const store = read("src/services/portfolioiq/soldCompsStore.service.ts");

  it("recordSoldComp calls the guard before the upsert", () => {
    const code = codeOf(store);
    expect(code).toContain("decideSplitIdentity");
    const guardAt = code.indexOf("decideSplitIdentity({");
    const upsertAt = code.indexOf("await c.items.upsert(doc as any)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(upsertAt).toBeGreaterThan(-1);
    // A guard AFTER the write is not a guard.
    expect(guardAt).toBeLessThan(upsertAt);
  });

  it("only an ATTESTED sport is offered to the guard", () => {
    // The whole fix collapses if `inferSportFromContext`'s answer is passed as
    // an attestation: a text heuristic is what produced the damage, so it may
    // not be the thing that resolves it. The attestation is gated on a caller
    // NAMING who attested.
    const code = codeOf(store);
    expect(code).toContain("attestedSport: input.sportAttestedBy ? input.sport ?? null : null");
  });

  it("a parked row seeds no catalog card", () => {
    // "Never mint from sales" already gated auto-seed to user sources; a
    // PARKED row has no identity we stand behind, so it must not seed either.
    const code = codeOf(store);
    expect(code).toContain("identityParked");
    expect(code).toMatch(/if\s*\(!identityParked\s*&&\s*doc\.hobbyiqCardId/);
  });

  it("the CardHedge emitter names its attestor, and only when it has one", () => {
    // CF-CH-INGEST-MULTI-SPORT: sport comes from the `group` field. That IS
    // the vendor's statement, so it may attest -- but `normSport` returns null
    // for groups it cannot map, and an absent attestation must never be
    // claimed.
    const code = codeOf(read("src/services/portfolioiq/chRowToSoldComp.ts"));
    expect(code).toContain('...(sport ? { sportAttestedBy: "cardhedge-group" } : {})');
  });

  it("the parked row carries a reason a human can act on", () => {
    const code = codeOf(store);
    expect(code).toContain("identityUnverified");
    expect(code).toContain("identityUnverifiedReason");
    // Counted by reason, per the brief.
    expect(code).toContain("sold_comp_split_identity_parked");
    expect(code).toContain("sold_comp_split_identity_resolved");
  });

  it("the admin labeler no longer rewrites hobbyiqCardId across products", () => {
    // labeler.service.ts is named by the census as a CONTINUING generator: it
    // set `row.hobbyiqCardId = newSlug` and left `cardId` alone, minting a
    // split on every cross-product label.
    const code = codeOf(read("src/services/portfolioiq/labeler.service.ts"));
    expect(code).toContain("mayUnionIdentities(row.cardId, newSlug)");
    expect(code).toContain("skippedCrossProduct");
  });
});

describe("MUTATION CHECK -- these tests fail when the fix is removed", () => {
  // Each case re-implements the OLD behaviour and asserts the pin above would
  // have caught it. A pin that passes with the defect restored is decoration.

  it("restoring the baseball fallback would break the no-default pins", () => {
    const oldResolve = (fallback?: string) => ({ vertical: fallback ?? "baseball", confident: false });
    // This is exactly what the first test forbids.
    expect(oldResolve().vertical).toBe("baseball");
    expect(resolveVertical({ title: "2019 Panini #12" }).vertical).not.toBe(oldResolve().vertical);
  });

  it("dropping the guard would let a known-damaging row through", () => {
    // The census's own 2026-09-04 example. With no guard this is written and
    // priced into both a baseball pool and a football pool.
    const noGuard = { verdict: "ok" as const };
    const withGuard = decideSplitIdentity({
      cardId: CENSUS.toppsChromeCard,
      hobbyiqCardId: CENSUS.toppsChromeHiq,
    });
    expect(withGuard).not.toEqual(noGuard);
    expect(withGuard.verdict).toBe("park");
  });

  it("a 'canonical wins' shortcut would corrupt the 1,203-row direction", () => {
    // The convention picks `hobbyiqCardId`. On the census's own example that
    // is the WRONG side, and an attestation naming `cardId` must beat it.
    const conventionPicks = CENSUS.toppsChromeHiq;
    const guardPicks = decideSplitIdentity({
      cardId: CENSUS.toppsChromeCard,
      hobbyiqCardId: CENSUS.toppsChromeHiq,
      attestedSport: "baseball",
      attestedBy: "cardhedge-group",
    });
    if (guardPicks.verdict !== "resolve") throw new Error("expected resolve");
    expect(guardPicks.resolvedTo).not.toBe(conventionPicks);
    expect(guardPicks.resolvedTo).toBe(CENSUS.toppsChromeCard);
  });

  it("dropping the vendor exemption would flag the 12.96M-row designed shape", () => {
    // The inverse mutation: a guard that compared raw strings instead of
    // parsed products would call every CardHedge row a split.
    const naive = (a: string, b: string) => (a === b ? "ok" : "park");
    expect(naive(CENSUS.bubbleId, CENSUS.bubbleHiq)).toBe("park");
    expect(
      decideSplitIdentity({ cardId: CENSUS.bubbleId, hobbyiqCardId: CENSUS.bubbleHiq }).verdict,
    ).toBe("ok");
  });
});


// ── #1938 · CF-A-SLUG-SEGMENT-IS-NOT-A-VENDOR-LABEL ─────────────────────────
//
// Every id below is a REAL one, read from sold_comps on 2026-09-07. The census
// found 8,102 rows whose cardId sport segment is empty or non-canonical, and
// 337 of them were written that morning -- AFTER #1929 shipped. That is the
// finding this block pins: the write door parked those rows for the sport
// disagreement they happened to carry, and never once refused the KEY that
// made them unaddressable in the first place.
const MALFORMED = {
  // `cardhedge::<bubble-id>` after `hiq:${slug.slice(4)}` ate "card".
  hedge: "hiq:hedge::1773078923701x852055104605271300::43f7ac3c",
  // `cardsight::<uuid>` the same way.
  sight: "hiq:sight::be80caf8-1c9c-4a1e-9e0d-2f6b0c1d3e4f::bulk",
  // `variant::` the same way, glued onto a whole second slug.
  ant: "hiq:ant::hiq:football:2024:bowman:215:base:no-auto",
  antHiq: "hiq:football:2024:donruss-optic:215:base:no-auto",
  // A vertical ALIAS that is not in CANONICAL_SPORTS.
  baseballMlb: "hiq:baseball-mlb:2018:topps-heritage:600:base:no-auto",
  baseballMlbHiq: "hiq:baseball:2018:topps-heritage:600:base:no-auto",
  // The same defect wearing a spelling the alias table already knows.
  iceHockey: "hiq:ice-hockey:1990:upper-deck:1:base:no-auto",
  iceHockeyHiq: "hiq:hockey:1990:upper-deck:1:base:no-auto",
  // An EMPTY sport segment.
  emptySport: "hiq::2018:topps:1:base:no-auto",
};

describe("#1938 — a malformed key is parked, never written as though it named a card", () => {
  it.each([
    ["a cardhedge vendor key wearing our prefix", MALFORMED.hedge, null],
    ["a cardsight vendor key wearing our prefix", MALFORMED.sight, null],
    ["a variant key prefixed onto a second slug", MALFORMED.ant, MALFORMED.antHiq],
    ["a non-canonical vertical alias", MALFORMED.baseballMlb, MALFORMED.baseballMlbHiq],
    ["an un-normalised hockey spelling", MALFORMED.iceHockey, MALFORMED.iceHockeyHiq],
    ["an empty sport segment", MALFORMED.emptySport, null],
  ])("parks %s with reason malformed-key", (_label, cardId, hobbyiqCardId) => {
    const out = decideSplitIdentity({ cardId, hobbyiqCardId });
    if (out.verdict !== "park") throw new Error(`expected park, got ${out.verdict}`);
    expect(out.reason).toBe("malformed-key");
    // The detail names a defect a human can act on, not just "invalid".
    expect(out.detail.length).toBeGreaterThan(20);
  });

  it("parks on a malformed hobbyiqCardId too, not only the partition key", () => {
    const out = decideSplitIdentity({
      cardId: "hiq:baseball:2018:topps:1:base:no-auto",
      hobbyiqCardId: MALFORMED.hedge,
    });
    if (out.verdict !== "park") throw new Error("expected park");
    expect(out.reason).toBe("malformed-key");
    expect(out.detail).toContain("hobbyiqCardId");
  });

  it("an ATTESTED sport does NOT unpark a malformed key", () => {
    // Attestation settles a SPORT DISAGREEMENT between two readable addresses.
    // It cannot make an unreadable address readable, so it must not launder one
    // into a real pool on the strength of a vendor naming the vertical.
    const out = decideSplitIdentity({
      cardId: MALFORMED.baseballMlb,
      hobbyiqCardId: MALFORMED.baseballMlbHiq,
      attestedSport: "baseball",
      attestedBy: "cardhedge-group",
    });
    expect(out.verdict).toBe("park");
  });

  // ── The exemptions the guard must KEEP ───────────────────────────────────
  it("leaves the 12.96M-row designed vendor partition alone", () => {
    // A bare vendor key claims nothing: no `hiq:` prefix, so no broken promise.
    expect(addressDefect(CENSUS.bubbleId)).toBeNull();
    expect(
      decideSplitIdentity({ cardId: CENSUS.bubbleId, hobbyiqCardId: CENSUS.bubbleHiq }).verdict,
    ).toBe("ok");
  });

  it("leaves a well-formed row alone", () => {
    const good = "hiq:baseball:2018:topps:1:base:no-auto";
    expect(addressDefect(good)).toBeNull();
    expect(decideSplitIdentity({ cardId: good, hobbyiqCardId: good }).verdict).toBe("ok");
  });

  it("still parks a REAL sport split — malformed-key does not swallow the class", () => {
    const out = decideSplitIdentity({
      cardId: CENSUS.toppsChromeCard,
      hobbyiqCardId: CENSUS.toppsChromeHiq,
    });
    if (out.verdict !== "park") throw new Error("expected park");
    expect(out.reason).toBe("split-identity");
  });
});

describe("#1938 — ONE vertical vocabulary: the builder asks the door's table", () => {
  it("refuses to mint a slug for a non-canonical vertical", () => {
    // The emitter half. Before the fix `normalizeSport` ended `return s`, so
    // "Baseball - MLB" slugified to "baseball-mlb" and became a NAMESPACE.
    expect(normalizeSport("Baseball - MLB")).toBeNull();
    expect(() =>
      computeHobbyIqCardId({
        sport: "Baseball - MLB", year: 2018, setKey: "Topps Heritage",
        cardNumber: "600", parallel: "Base", isAuto: false, printRun: null,
      }),
    ).toThrow(/not a canonical vertical/);
  });

  it("COLLAPSES the alias onto the real pool instead of splitting it", () => {
    // The point of the fix is not only refusal. "Ice Hockey" and "hockey" are
    // the SAME card, and before this they did not share a slug -- so the comps
    // split and neither side could price.
    expect(normalizeSport("Ice Hockey")).toBe("hockey");
    expect(normalizeSport("auto racing")).toBe("racing");
    const viaAlias = computeHobbyIqCardId({
      sport: "Ice Hockey", year: 1990, setKey: "Upper Deck",
      cardNumber: "1", parallel: "Base", isAuto: false, printRun: null,
    });
    const viaCanonical = computeHobbyIqCardId({
      sport: "hockey", year: 1990, setKey: "Upper Deck",
      cardNumber: "1", parallel: "Base", isAuto: false, printRun: null,
    });
    expect(viaAlias).toBe(viaCanonical);
  });

  it("rejects a multi-value vendor tag dump rather than picking a token", () => {
    expect(normalizeSport("football, baseball")).toBeNull();
  });

  it("the builder and the door agree — nothing the builder mints is malformed", () => {
    // The two-normalizer defect, in one assertion: anything
    // `computeHobbyIqCardId` is willing to emit must be an address the write
    // door will accept. Two tables meant the door refused what the builder had
    // happily minted.
    for (const sport of ["baseball", "Ice Hockey", "MLB", "nfl", "auto racing", "Pokemon"]) {
      const slug = computeHobbyIqCardId({
        sport, year: 2018, setKey: "Topps", cardNumber: "1",
        parallel: "Base", isAuto: false, printRun: null,
      });
      expect(addressDefect(slug)).toBeNull();
    }
  });

  it("the vendor-key adoption is refused at the matcher, not patched at the reassembly", () => {
    // The root cause: `adoptResolvedSlug` gated on CONFIDENCE and never on
    // SHAPE, so a `cardhedge::` catalog row matched at >= 0.7 became `slug`,
    // and persistVendorSalesToPool's documented "just slug reassembled" then
    // ate four characters of the vendor name.
    const code = codeOf(read("src/services/catalog/catalogMatcher.service.ts"));
    expect(code).toContain('resolved.slug.startsWith("hiq:")');
  });

  it("the write path still calls the guard", () => {
    const code = codeOf(read("src/services/portfolioiq/soldCompsStore.service.ts"));
    expect(code).toContain("decideSplitIdentity(");
  });
});

describe("#1938 MUTATION CHECK -- these fail when the fix is removed", () => {
  it("the OLD normalizeSport would have minted every one of the 77 verticals", () => {
    // Re-implement the removed tail (`return s`) and prove the pin catches it.
    const slugifyLocal = (r: string) =>
      String(r).toLowerCase().replace(/[^\w\s-]/g, "").replace(/_/g, "-")
        .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const oldNormalize = (sport: string) => {
      const v = slugifyLocal(sport);
      if (v === "nfl") return "football";
      if (v === "nba") return "basketball";
      if (v === "mlb") return "baseball";
      if (v === "nhl") return "hockey";
      return v;                     // <-- the defect
    };
    expect(oldNormalize("Baseball - MLB")).toBe("baseball-mlb");
    expect(normalizeSport("Baseball - MLB")).not.toBe(oldNormalize("Baseball - MLB"));
    // And the address that old value produced is exactly the parked shape.
    expect(
      addressDefect(`hiq:${oldNormalize("Baseball - MLB")}:2018:topps-heritage:600:base:no-auto`),
    ).toContain("not a canonical vertical");
  });

  it("a guard without the malformed check would call a vendor key a real product", () => {
    // `hiq:hedge::<id>` splits into >= 4 segments, so `productIdentityOf`
    // answers "hedge::" and the OLD guard went on to reason about "hedge" as
    // though it were a sport.
    const productIdentityOfNaive = (slug: string) => {
      const seg = slug.split(":");
      return seg.length >= 4 ? `${seg[1]}:${seg[2]}:${seg[3]}` : null;
    };
    // Segments 1..3 are "hedge", "" and the bubble id: the guard would have
    // read the tail of a VENDOR NAME as the sport, and an empty string as the
    // year, and called the result a product.
    expect(productIdentityOfNaive(MALFORMED.hedge))
      .toBe("hedge::1773078923701x852055104605271300");
    // With the check, it is named for what it is instead.
    const out = decideSplitIdentity({ cardId: MALFORMED.hedge, hobbyiqCardId: null });
    if (out.verdict !== "park") throw new Error("expected park");
    expect(out.reason).toBe("malformed-key");
  });

  it("dropping the shape check on adoption would re-open the slice(4) path", () => {
    // The reassembly is correct for an hiq slug and catastrophic for a vendor
    // key. This is the exact transform, on the exact id measured in prod.
    const reassemble = (slug: string) => `hiq:${slug.slice(4)}`;
    expect(reassemble("hiq:baseball:2018:topps:1:base:no-auto"))
      .toBe("hiq:baseball:2018:topps:1:base:no-auto");            // identity
    expect(reassemble("cardhedge::1773078923701x852055104605271300::43f7ac3c"))
      .toBe(MALFORMED.hedge);                                      // the defect
    expect(
      addressDefect(reassemble("cardhedge::1773078923701x852055104605271300::43f7ac3c")),
    ).toContain("empty slug segment");
  });
});
