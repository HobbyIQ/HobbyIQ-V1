import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE VINTAGE-UNDER-SALE-YEAR LIST (2026-09-06).
 *
 * A vintage sale is filed under the year it SOLD, not the year the card was
 * issued. `hiq:baseball:2015:bowman:253:base:no-auto` holds a 1951 Bowman
 * Mickey Mantle rookie; `hiq:baseball:2015:topps:311:base:no-auto` holds a
 * 1952 Topps Mantle that sold for $54,000. The pools are real and the cards
 * are real -- only the year segment is wrong, and it is wrong in a way that
 * splits every vintage card across as many pools as it has sale years.
 *
 * WHAT THE MEASUREMENT DECIDED, stated because the pins encode it:
 *
 *   THE CLASS IS TOO BIG FOR A LIST. 4,616 of 5,939 in-scope slugs (77.7%) in
 *   a partition-bounded sample; extrapolated against the tca-ebay population
 *   at five slug years, 180,000-320,000 rows. This file is a VERIFIED SAMPLE
 *   that proves the shape and the destination arithmetic. The class itself
 *   needs a LANE, and the lane needs a ruling, because the rematch IMPROVE
 *   predicate forbids a CHANGED axis and this moves cardYear.
 *
 *   THE RETRO CASE IS THE ONE THAT WOULD MAKE THIS WRONG, AND IT IS EXCLUDED.
 *   A 2023 Topps Heritage card homaging a 1954 design states 1954 in its title
 *   and IS a 2023 card. Every such product is filtered out by setKey and by
 *   title word before a row reaches this list -- 27 rows in the sample. A pin
 *   below asserts no entry carries a homage marker, so a later widening that
 *   drops the filter turns this red.
 *
 *   A COLLISION IS THE POINT. 154 of 160 point-read destinations (96.3%)
 *   already hold sales: the relocation MERGES a split pool rather than
 *   creating one. That is the expected outcome of "one card, one row, one
 *   pool", not a hazard.
 *
 *   AN UNBACKED DESTINATION IS A PARK. 44 of 160 destinations returned no
 *   checklist-backed card_catalog row, so those rows stay exactly where they
 *   are and are marked identityUnverified. Routing them would mint an identity
 *   whose only evidence is the sale (CF-CATALOG-MATCH-IS-SELF-CONFIRMING).
 */

const listPath = path.join(
  process.cwd(),
  "data",
  "pool-relocations",
  "2026-09-06-vintage-under-sale-year-slugs.json",
);
const list = JSON.parse(readFileSync(listPath, "utf8"));

type Entry = {
  id: string;
  fromCardId: string;
  currentAddress: string;
  toCardId?: string;
  parkIdentityUnverified?: boolean;
  wouldBeCardId?: string;
  price?: number | null;
  evidence?: string;
};

const entries = list.entries as Entry[];
const yearOf = (slug: string) => Number(slug.split(":")[2]);
const segs = (slug: string) => slug.split(":");

describe("the vintage-under-sale-year list", () => {
  it("is report-only and names the lane it is for", () => {
    expect(list.forLane).toBe("relocate-pool-rows-by-list.cjs");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
    expect(list.provenance.readOnly).toBe(true);
    expect(String(list.provenance.writes)).toMatch(/none/i);
  });

  it("carries entries, each with an id and its current address", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.id).toBeTruthy();
      expect(e.fromCardId).toMatch(/^hiq:/);
      expect(e.currentAddress).toBe(e.fromCardId);
      expect(String(e.evidence ?? "")).not.toBe("");
    }
  });

  it("every entry is EITHER a relocate or a park, never both and never neither", () => {
    for (const e of entries) {
      const relocate = typeof e.toCardId === "string";
      const park = e.parkIdentityUnverified === true;
      expect(relocate !== park).toBe(true);
      if (park) expect(e.wouldBeCardId).toMatch(/^hiq:/);
    }
  });

  it("MOVES ONLY THE YEAR SEGMENT -- sport, setKey, number, parallel and auto are carried verbatim", () => {
    // This is the whole safety argument for the destination: no identity is
    // invented, because every other segment is copied. A mutant that rebuilt
    // the slug from a re-parse would drift on one of these.
    for (const e of entries) {
      const to = e.toCardId ?? e.wouldBeCardId!;
      const a = segs(e.fromCardId);
      const b = segs(to);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        if (i === 2) continue;
        expect(b[i]).toBe(a[i]);
      }
    }
  });

  it("the source year is a SALE year (>= 2015) and the destination a vintage one (< 1990)", () => {
    for (const e of entries) {
      const to = e.toCardId ?? e.wouldBeCardId!;
      expect(yearOf(e.fromCardId)).toBeGreaterThanOrEqual(2015);
      expect(yearOf(to)).toBeLessThan(1990);
    }
  });

  it("MUTATION -- no entry is a retro/homage product", () => {
    // The 2023-Heritage-homaging-1954 case is the one shape that would make
    // every relocation here wrong. Dropping the retro filter puts those rows
    // back in and turns this red.
    const homage = /\b(heritage|archives|tribute|reprint|relic|design|anniversary|retro|buyback|commemorative)\b/i;
    for (const e of entries) {
      const title = (String(e.evidence ?? "").match(/\| title: "([^"]*)"/) ?? [])[1] ?? "";
      expect(title).not.toBe("");
      expect(homage.test(title)).toBe(false);
      expect(homage.test(segs(e.fromCardId)[3] ?? "")).toBe(false);
    }
  });

  it("a RELOCATE names a checklist-backed destination; a PARK does not", () => {
    for (const e of entries) {
      const ev = String(e.evidence ?? "");
      if (e.toCardId) expect(ev).toMatch(/checklistBacked=true/);
      else expect(ev).toMatch(/PARK \(destination is not checklist-backed\)/);
    }
  });

  it("the title's stated year is the destination year, and the evidence says so", () => {
    for (const e of entries) {
      const to = e.toCardId ?? e.wouldBeCardId!;
      const stated = (String(e.evidence ?? "").match(/first stated year is (\d{4})/) ?? [])[1];
      expect(Number(stated)).toBe(yearOf(to));
    }
  });

  it("pins the census the lane proposal rests on", () => {
    const c = list.census;
    expect(c.hits).toBe(4616);
    expect(c.slugsInScope).toBe(5939);
    expect(c.excludedAsRetro).toBe(27);
    expect(c.destinationsPointRead).toBe(160);
    expect(c.destinationsChecklistBacked).toBe(116);
    expect(c.destinationsNotBacked).toBe(44);
    expect(c.destinationsCollidingWithExistingPool).toBe(154);
    expect(c.destinationsEmpty).toBe(6);
    // backed + not-backed and colliding + empty must each account for every
    // destination that was point-read, or one of the four numbers is stale.
    expect(c.destinationsChecklistBacked + c.destinationsNotBacked).toBe(c.destinationsPointRead);
    expect(c.destinationsCollidingWithExistingPool + c.destinationsEmpty).toBe(c.destinationsPointRead);
  });

  it("says a LANE is needed and states the ruling that blocks it", () => {
    const p = list.laneProposal;
    expect(p.needed).toBe(true);
    expect(String(p.blocker)).toMatch(/IMPROVE predicate forbids a CHANGED axis/i);
    expect(String(p.rulingQuestion)).toMatch(/changed:cardYear/);
    // The guard is what a ruling would be ruling ON, so it must be spelled out.
    expect(Array.isArray(p.proposedGuard)).toBe(true);
    expect(p.proposedGuard.length).toBeGreaterThanOrEqual(5);
    expect(p.proposedGuard.join(" ")).toMatch(/< 1990/);
    expect(p.proposedGuard.join(" ")).toMatch(/>= 2015/);
    expect(p.proposedGuard.join(" ")).toMatch(/vintage-capable/);
    expect(p.proposedGuard.join(" ")).toMatch(/checklist-backed, else PARK/);
  });

  it("the vintage vocabulary is DERIVED from the corpus, not guessed", () => {
    expect(String(list.census.vintageVocabularySource)).toMatch(/derived, not guessed/i);
    // Every setKey the list actually uses must be one the census names.
    const vocab = String(list.census.vintageVocabularySource);
    for (const e of entries) expect(vocab).toContain(segs(e.fromCardId)[3]);
  });
});
