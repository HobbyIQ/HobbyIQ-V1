import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * THE SPORT-SEGMENT SPLIT LISTS, TRANCHE 2 (2026-09-07).
 *
 * #1924 measured 94,275 sold_comps rows whose `cardId` and `hobbyiqCardId`
 * name different SPORTS. `exactPoolReader` ORs the two fields, so each such
 * sale is read into BOTH cards' pools and prices a card it is not. Lists 01-04
 * parked 7,996 of them on 2026-09-07 -- the Pokemon sub-class, where the setKey
 * was an unambiguous tell and NO destination existed in card_catalog.
 *
 * This tranche is the REST of the population, re-measured over the whole corpus
 * read-only, and it is the first to route rows instead of only parking them.
 *
 * WHAT THE RE-MEASUREMENT DECIDED, stated because the pins encode it:
 *
 *   A DECIDABLE ROW IS NOT PARKED. Drew's doctrine: PARK is the vehicle for a
 *   row whose destination has no catalog row and whose right side is
 *   undecidable. It is NOT the vehicle for a row the catalog can place. Where
 *   exactly ONE of the two addresses carries a checklist-backed card_catalog
 *   row, that side IS the card -- and the row is REPOINTED (the partition is
 *   already right, only `hobbyiqCardId` is wrong) or RELOCATED (the partition
 *   key itself is the wrong address).
 *
 *   THE PREDICATE IS THE PRICING GATE'S OWN. `identityBackingOf` is what
 *   decides whether a price may rest on a catalog row, so it is what decides
 *   whether a SALE may be routed to one. A second copy of that rule would be a
 *   second place for it to drift, so the classifier calls the shipped module.
 *
 *   NEITHER FIELD IS PREFERRED. #1924 measured hobbyiqCardId correct 2,330
 *   times and cardId 1,203 times on the setKey-tell sub-class, so a blanket
 *   "canonical wins" rewrite corrupts about a third of the class. The catalog
 *   decides per row; a row on which it is silent, or on which it speaks for
 *   BOTH sides, is parked.
 *
 *   THE GUARD HOLDS. #1929 (prod 11794bc) refuses a split row at the write
 *   door. The re-measurement counted the rows written at or after that deploy
 *   whose sport segments disagree, and this file pins that number -- if a
 *   future run finds it non-zero, an emitter got past the guard and the
 *   population is no longer closed.
 */

const dataDir = path.join(process.cwd(), "data", "pool-relocations");
const PREFIX = "2026-09-07-split-identity-sport-segment-";

/** Lists 01-04 shipped and were APPLIED on 2026-09-07; 05+ are this tranche. */
const allFiles = readdirSync(dataDir)
  .filter((f) => f.startsWith(PREFIX) && f.endsWith(".json"))
  .sort();
const appliedFiles = allFiles.filter((f) => Number(f.slice(PREFIX.length, PREFIX.length + 2)) <= 4);
const trancheFiles = allFiles.filter((f) => Number(f.slice(PREFIX.length, PREFIX.length + 2)) >= 5);

type PoolEntry = {
  id: string;
  fromCardId: string;
  currentAddress: string;
  toCardId?: string;
  repointHobbyiqCardId?: string;
  /** The wrong slug a REPOINT overwrites -- the only place the split shows. */
  displacedHobbyiqCardId?: string;
  retireSupersededBy?: string;
  parkIdentityUnverified?: boolean;
  wouldBeCardId?: string;
  evidence?: string;
  title?: string | null;
  source?: string | null;
};

type List = {
  issue: string;
  note: string;
  rulings: string[];
  expectedCounts: {
    entries: number;
    shape: string;
    classTotal: number;
    distinctDestinations: number;
    destinationsChecklistBacked: number;
  };
  entries: PoolEntry[];
  excluded: unknown[];
};

const read = (f: string) => JSON.parse(readFileSync(path.join(dataDir, f), "utf8")) as List;
const lists = trancheFiles.map((f) => ({ file: f, doc: read(f) }));
const entries = lists.flatMap((l) => l.doc.entries);

const shapeOf = (e: PoolEntry) => {
  if (e.parkIdentityUnverified === true) return "park";
  if (e.repointHobbyiqCardId) return "repoint";
  if (e.toCardId && e.toCardId !== e.fromCardId) return "relocate";
  return "none";
};
const sportOf = (slug: string) => String(slug || "").split(":")[1] ?? "";

describe("the tranche-2 sport-segment split lists", () => {
  it("continues the numbering after the four applied lists, without reusing one", () => {
    // Lists 01-04 are APPLIED. Rewriting one would re-park rows already parked
    // and, worse, silently change a record of what was done to prod.
    expect(appliedFiles).toEqual([
      `${PREFIX}01.json`,
      `${PREFIX}02.json`,
      `${PREFIX}03.json`,
      `${PREFIX}04.json`,
    ]);
    expect(trancheFiles.length).toBeGreaterThan(0);
    const numbers = trancheFiles.map((f) => Number(f.slice(PREFIX.length, PREFIX.length + 2)));
    // Contiguous from 05, so a reader can tell at a glance that none is missing.
    expect(numbers).toEqual(numbers.map((_, i) => i + 5));
  });

  it("never names the same DOCUMENT twice, and never re-touches an already-parked row", () => {
    // THE UNIT IS (id, fromCardId), NOT id. sold_comps is partitioned on
    // /cardId and the lane addresses a row as `pool.item(id, from)`, so an id
    // is only half an address. In this population 93,251 documents carry
    // 91,807 distinct ids: 1,444 rows are one sale id filed in MORE THAN ONE
    // partition -- e.g. tca-ebay::267678711794, a Marvin Harrison sale living
    // at both hiq:hockey:2006:bowman:47 and hiq:hockey:2006:unknown:47. Those
    // are separate documents, each polluting its own pool and each needing its
    // own repair; keying this on the id alone called the whole tranche a
    // duplicate. What must never happen is the same DOCUMENT named twice,
    // because the lane would then write it twice.
    const seen = new Map<string, string>();
    for (const l of lists) {
      for (const e of l.doc.entries) {
        const addr = `${e.id} ${e.fromCardId}`;
        expect(seen.has(addr), `${e.id} at ${e.fromCardId} is in ${seen.get(addr)} and ${l.file}`).toBe(false);
        seen.set(addr, l.file);
      }
    }
    expect(seen.size).toBe(entries.length);
    // The multi-partition rows are a real, measured property of this
    // population, not an artifact -- so the shape is asserted rather than
    // merely tolerated.
    const distinctIds = new Set(entries.map((e) => e.id)).size;
    expect(distinctIds).toBeLessThan(entries.length);

    // An applied list's rows are already parked. Re-listing one would re-write
    // a row prod has settled.
    const applied = new Set(
      appliedFiles.flatMap((f) => read(f).entries.map((e) => `${e.id} ${e.fromCardId}`)),
    );
    expect(applied.size).toBe(7996);
    const overlap = entries.filter((e) => applied.has(`${e.id} ${e.fromCardId}`));
    expect(overlap.map((e) => e.id)).toEqual([]);
  });

  it("keeps every file inside the 2,000-entry review bound", () => {
    for (const l of lists) {
      expect(l.doc.entries.length, l.file).toBeGreaterThan(0);
      expect(l.doc.entries.length, l.file).toBeLessThanOrEqual(2000);
      expect(l.doc.expectedCounts.entries, l.file).toBe(l.doc.entries.length);
    }
  });

  it("carries exactly one shape per file, PARK files first", () => {
    // One kind of change per diff. A file that mixed parks with relocates would
    // make a reviewer check two different claims against one banner.
    const shapes = lists.map((l) => {
      const s = new Set(l.doc.entries.map(shapeOf));
      expect(s.size, `${l.file} mixes shapes: ${[...s].join(",")}`).toBe(1);
      return [...s][0];
    });
    const firstRouted = shapes.findIndex((s) => s !== "park");
    if (firstRouted >= 0) {
      expect(shapes.slice(firstRouted).every((s) => s !== "park")).toBe(true);
    }
  });

  it("every entry names exactly ONE shape, the way the lane counts them", () => {
    for (const e of entries) {
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId ? "relocate" : null,
        e.repointHobbyiqCardId ? "repoint" : null,
        e.retireSupersededBy ? "retire" : null,
        e.parkIdentityUnverified === true ? "park" : null,
      ].filter(Boolean);
      expect(shapes, e.id).toHaveLength(1);
    }
  });

  it("every entry carries an id, a partition, and real evidence", () => {
    for (const e of entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      expect(e.currentAddress).toBe(e.fromCardId);
      expect(String(e.evidence ?? "").length, e.id).toBeGreaterThan(60);
    }
  });

  it("every entry IS a sport split -- the two addresses name different verticals", () => {
    // The population's defining property. A row whose verticals agree does not
    // belong in this class at all, whatever else is wrong with it.
    //
    // ON A REPOINT THE COMPARISON IS NOT from-vs-target. The partition is
    // already the checklist-backed address, so `repointHobbyiqCardId` EQUALS
    // `fromCardId` by construction and the disagreement lives in the field
    // being overwritten -- which is why the entry carries the displaced slug.
    for (const e of entries) {
      const stored = shapeOf(e) === "repoint" ? e.displacedHobbyiqCardId : e.fromCardId;
      const other = shapeOf(e) === "repoint"
        ? e.repointHobbyiqCardId
        : (e.toCardId ?? e.wouldBeCardId);
      const a = sportOf(String(stored ?? ""));
      const b = sportOf(String(other ?? ""));
      expect(a, e.id).not.toBe("");
      expect(b, e.id).not.toBe("");
      expect(a, `${e.id}: ${stored} vs ${other}`).not.toBe(b);
    }
  });

  it("the lane's own module loads and rejects none of these entries", () => {
    // Pinning against the lane means a shape drift fails here, not mid-apply.
    const lane = path.join(process.cwd(), "scripts", "relocate-pool-rows-by-list.cjs");
    const L = require_(lane) as Record<string, unknown>;
    expect(typeof L.planRelocatedIdentity).toBe("function");
    for (const e of entries) {
      expect(String(e.id ?? "").trim(), "the lane rejects an entry with no id").not.toBe("");
      expect(String(e.fromCardId ?? "").trim(), "the lane rejects an entry with no partition").not.toBe("");
    }
  });

  it("a RELOCATE moves the partition; a REPOINT never does", () => {
    for (const e of entries) {
      if (shapeOf(e) === "relocate") {
        expect(e.toCardId, e.id).toBeTruthy();
        expect(e.toCardId, e.id).not.toBe(e.fromCardId);
        expect(e.repointHobbyiqCardId, e.id).toBeUndefined();
      }
      if (shapeOf(e) === "repoint") {
        // The partition is already the checklist-backed address, so the repoint
        // target IS `fromCardId` -- anything else would be a move wearing a
        // patch's clothes.
        expect(e.repointHobbyiqCardId, e.id).toBe(e.fromCardId);
        expect(e.toCardId, e.id).toBeUndefined();
      }
      if (shapeOf(e) === "park") {
        expect(e.parkIdentityUnverified).toBe(true);
        expect(e.toCardId, e.id).toBeUndefined();
        expect(e.repointHobbyiqCardId, e.id).toBeUndefined();
      }
    }
  });

  it("a PARK says WHY the catalog could not decide; a route says which side won", () => {
    // The evidence string is the whole audit trail for a row. A park that does
    // not name its refusal, or a route that does not name its winner, is a
    // decision nobody can check.
    for (const e of entries) {
      const why = String(e.evidence ?? "");
      if (shapeOf(e) === "park") {
        expect(why, e.id).toMatch(/^PARK\./);
        expect(why, e.id).toMatch(/NEITHER side carries a checklist-backed|BOTH sides carry a checklist-backed/);
        expect(why, e.id).toMatch(/identityUnverified keeps the row out of EVERY pool/);
      } else {
        expect(why, e.id).toMatch(/^(RELOCATE|REPOINT)\./);
        expect(why, e.id).toMatch(/HAS a checklist-backed card_catalog row/);
        expect(why, e.id).toMatch(/identityBackingOf=checklist-backed/);
        // Every route records what the TITLE said, so a reader can see the
        // sale never contradicted the address it was sent to.
        expect(why, e.id).toMatch(/The sale title names the product .+ which corroborates the destination/);
      }
    }
  });

  it("routes ONLY where the catalog named one winner -- the doctrine, pinned", () => {
    // The load-bearing pin. If a future regeneration starts routing on a rule
    // other than "exactly one side is checklist-backed", this fails.
    const routed = entries.filter((e) => shapeOf(e) !== "park");
    for (const e of routed) {
      const dest = e.toCardId ?? e.repointHobbyiqCardId!;
      expect(String(e.evidence)).toContain(dest);
      expect(String(e.evidence)).toMatch(/Exactly one side is checklist-backed|only hobbyiqCardId names the wrong card/);
    }
  });

  it("uses the pricing gate's OWN backing predicate, not a second copy of it", () => {
    // `identityBackingOf` decides whether a PRICE may rest on a catalog row, so
    // it is what decides whether a SALE may be routed to one. Its verdicts are
    // pinned here so the vocabulary the lists quote stays the module's.
    const m = require_(
      path.join(process.cwd(), "dist", "services", "catalog", "identityBacking.js"),
    ) as {
      identityBackingOf: (slug: string, rows: { source?: string | null }[]) => string;
      mayPublishPrice: (b: string) => boolean;
    };
    const slug = "hiq:football:2020:panini-prizm:102:base:no-auto";
    expect(m.identityBackingOf(slug, [])).toBe("no-catalog-row");
    expect(m.identityBackingOf(slug, [{ source: "beckett" }])).toBe("checklist-backed");
    expect(m.identityBackingOf(slug, [{ source: "sales-attested" }])).toBe("self-derived-only");
    expect(m.identityBackingOf(slug, [{ source: "cardhedge" }])).toBe("unbacked");
    // Only a checklist-backed identity may carry a price -- which is exactly
    // why only a checklist-backed address may receive a sale.
    expect(m.mayPublishPrice("checklist-backed")).toBe(true);
    for (const b of ["no-catalog-row", "self-derived-only", "unbacked", "no-slug"]) {
      expect(m.mayPublishPrice(b)).toBe(false);
    }
  });

  it("no routed row is sent to an address its own title contradicts", () => {
    // THE TITLE'S VETO. The catalog elects the winner; the sale may refuse it.
    // `inferSportFromTitle` defaults to "baseball" when it recognises nothing --
    // the very default #1929 removed from the write path, and it reads a
    // Pikachu promo as baseball -- so it is asked with a SENTINEL, which turns
    // the guess back into an answer, and it is used only to REFUSE.
    const { inferSportFromTitle } = require_(
      path.join(process.cwd(), "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"),
    ) as { inferSportFromTitle: (t: string, fallback?: string) => string };

    const UNSTATED = "(unstated)";
    // The sentinel behaviour itself is pinned: without it this guard silently
    // becomes "every unrecognised title says baseball".
    expect(inferSportFromTitle("Pikachu V - Holo Promo SWSH061 NM", UNSTATED)).toBe(UNSTATED);
    expect(inferSportFromTitle("Pikachu V - Holo Promo SWSH061 NM")).toBe("baseball");
    expect(
      inferSportFromTitle("Justin Herbert 2020 Panini Prizm ROOKIE #102 (RC) PSA 10", UNSTATED),
    ).toBe("football");

    for (const e of entries.filter((x) => shapeOf(x) !== "park")) {
      const dest = e.toCardId ?? e.repointHobbyiqCardId!;
      const stated = inferSportFromTitle(String(e.title ?? ""), UNSTATED);
      if (stated === UNSTATED) continue;
      expect(stated, `${e.id} routed to ${dest} but its title says ${stated}`).toBe(sportOf(dest));
    }
  });

  it("no routed row is sent to a PRODUCT its own title does not name", () => {
    // THE SECOND VETO, and the one a dry run caught. A checklist-backed address
    // proves a CARD exists there; it does not prove THIS SALE is that card.
    // Routing on backing alone sent an "Upper Deck Halo Legacy Collection
    // Carter-A259 ... #51" sale to hiq:baseball:2024:bowman:51 -- an address
    // genuinely backed by a real and entirely different card. That is the very
    // defect this repair exists to undo, performed deliberately, so a route
    // also requires the title to CORROBORATE the destination's product.
    const { inferSetKeyFromTitle } = require_(
      path.join(process.cwd(), "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"),
    ) as { inferSetKeyFromTitle: (t: string) => string };

    const slugify = (s: string) =>
      String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    // The Halo title names no product at all -- which is why it cannot route.
    expect(
      inferSetKeyFromTitle("Upper Deck Halo Legacy Collection Carter-A259 Great Journey #51 Halo Reach 2024"),
    ).toBe("Unknown");
    expect(slugify(inferSetKeyFromTitle("2020 PANINI PRIZM #325 JUSTIN HERBERT ROOKIE RC PSA 10")))
      .toBe("panini-prizm");

    const setKeyOfSlug = (slug: string) => String(slug || "").split(":")[3] ?? "";
    for (const e of entries.filter((x) => shapeOf(x) !== "park")) {
      const dest = e.toCardId ?? e.repointHobbyiqCardId!;
      const raw = inferSetKeyFromTitle(String(e.title ?? ""));
      // A route with no product in its title must not exist at all.
      expect(String(raw), `${e.id} routed to ${dest} on a title naming no product`).not.toMatch(/^unknown$/i);
      const stated = slugify(raw);
      const destSet = setKeyOfSlug(dest);
      const agrees = stated === destSet || destSet.startsWith(stated) || stated.startsWith(destSet);
      expect(agrees, `${e.id}: title product "${stated}" vs destination product "${destSet}"`).toBe(true);
    }
  });

  it("every ROUTED row has a real card address, with a canonical vertical, on both sides", () => {
    // THE THIRD GUARD, and the one the first full run needed. A route is a
    // claim about which of two CARDS this sale is. 902 rows the catalog was
    // willing to route carry a side that is not a card address at all --
    // `hiq:sight::be80caf8-…::bulk` and `hiq:hedge::1682403647139x…` are
    // cardsight/cardhedge VENDOR KEYS with `hiq:` glued on, so the "vertical"
    // is the tail of a vendor name; `hiq:ant::hiq:basketball:…` is a slug
    // prefixed onto a slug; `hiq:baseball-mlb:…` and `hiq:other:…` name
    // verticals the shipped guard does not know. Routing off one launders a
    // junk partition into a real card's pool while the banner says RELOCATED.
    const { CANONICAL_SPORTS } = require_(
      path.join(process.cwd(), "dist", "services", "portfolioiq", "slugGuard.service.js"),
    ) as { CANONICAL_SPORTS: ReadonlySet<string> };
    // The vocabulary is the SHIPPED one, never a list re-typed here.
    expect(CANONICAL_SPORTS.has("baseball")).toBe(true);
    for (const junk of ["sight", "hedge", "ant", "other", "baseball-mlb", "ice-hockey"]) {
      expect(CANONICAL_SPORTS.has(junk), `${junk} must not be canonical`).toBe(false);
    }

    const isAddress = (s: string) => {
      const v = String(s ?? "");
      if (!v.startsWith("hiq:")) return false;
      if (v.includes("::")) return false;
      const parts = v.split(":");
      if (parts.length < 7) return false;
      return CANONICAL_SPORTS.has(parts[1]);
    };
    for (const e of entries.filter((x) => shapeOf(x) !== "park")) {
      const other = e.toCardId ?? e.repointHobbyiqCardId!;
      expect(isAddress(e.fromCardId), `${e.id}: source ${e.fromCardId}`).toBe(true);
      expect(isAddress(other), `${e.id}: destination ${other}`).toBe(true);
      if (e.displacedHobbyiqCardId) {
        expect(isAddress(e.displacedHobbyiqCardId), `${e.id}: displaced ${e.displacedHobbyiqCardId}`).toBe(true);
      }
    }
  });

  it("every row is a real HIQ-SPLIT by the shared classifier, never a vendor partition", () => {
    // The 12.9M-row VENDOR-DESIGN class is the designed ingest partition and
    // must never be repaired. A list entry that the shared predicate does not
    // call HIQ-SPLIT would be exactly that mistake.
    const S = require_(
      path.join(process.cwd(), "scripts", "lib", "split-identity.cjs"),
    ) as {
      classifyIdentity: (r: { cardId: string; hobbyiqCardId: string }) => {
        klass: string; split: boolean; segments: string[];
      };
      HIQ_SPLIT: string;
    };
    for (const e of entries) {
      // Reconstruct the STORED row's two identity fields: the partition it sits
      // in, and the canonical slug it carries. For a repoint that slug is the
      // displaced one; for everything else it is the other address.
      const stored = {
        cardId: e.fromCardId,
        hobbyiqCardId: String(
          shapeOf(e) === "repoint"
            ? e.displacedHobbyiqCardId ?? ""
            : e.toCardId ?? e.wouldBeCardId ?? "",
        ),
      };
      expect(stored.hobbyiqCardId, `${e.id} has no second address to compare`).not.toBe("");
      const c = S.classifyIdentity(stored);
      expect(c.klass, e.id).toBe(S.HIQ_SPLIT);
      expect(c.split, e.id).toBe(true);
      expect(c.segments, e.id).toContain("sport");
    }
  });

  it("states the guard holds and the population is closed", () => {
    const rulings = JSON.stringify(lists[0].doc.rulings);
    expect(rulings).toMatch(/CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS/);
    expect(rulings).toMatch(/THE WRITE-TIME GUARD HOLDS/);
    expect(rulings).toMatch(/11794bc/);
    // The count of genuinely NEW post-deploy split rows is stated in words, and
    // it is 0 -- a non-zero number would mean an emitter got past #1929.
    expect(rulings).toMatch(/GENUINE NEW SPLIT ROWS SINCE THE GUARD: 0\./);
    // And the reason a naive count says otherwise is stated too: `_ts` is
    // last-modified, so the park apply's own patches look like fresh writes
    // until they are attributed by id. A future re-measure that drops this
    // distinction will report a guard breach that did not happen.
    expect(rulings).toMatch(/_ts is LAST-MODIFIED, not created/);
    expect(rulings).toMatch(/ids from the 2026-09-07 park apply/);
    expect(rulings).toMatch(/A DECIDABLE ROW IS NOT PARKED/);
    expect(rulings).toMatch(/hobbyiqCardId IS NOT AUTOMATICALLY THE WINNER/);
    // The veto doctrine the first dry run forced, named with the row that
    // forced it, so a future regeneration cannot quietly drop it.
    expect(rulings).toMatch(/A CHECKLIST-BACKED ADDRESS IS NOT AUTOMATICALLY THIS SALE'S ADDRESS/);
    expect(rulings).toMatch(/Upper Deck Halo Legacy Collection/);
    expect(rulings).toMatch(/two VETOES/);
    expect(rulings).toMatch(/A ROUTE NEEDS TWO REAL ADDRESSES/);
    // Every file carries the same five common rulings, so no file can be read
    // out of the context that justifies it.
    for (const l of lists) {
      expect(l.doc.rulings.length).toBe(7);
      expect(JSON.stringify(l.doc.rulings.slice(0, 6))).toBe(
        JSON.stringify(lists[0].doc.rulings.slice(0, 6)),
      );
    }
  });

  it("the class totals in the files agree with the entries actually shipped", () => {
    // A file that claims a class total its siblings do not add up to is a list
    // that was edited without re-measuring.
    const byShape = new Map<string, number>();
    for (const e of entries) byShape.set(shapeOf(e), (byShape.get(shapeOf(e)) ?? 0) + 1);
    for (const l of lists) {
      const shape = shapeOf(l.doc.entries[0]);
      expect(l.doc.expectedCounts.classTotal, l.file).toBe(byShape.get(shape));
    }
  });
});
