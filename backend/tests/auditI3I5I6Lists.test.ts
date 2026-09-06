import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * THE 2026-09-06 PRICING-INVARIANT AUDIT LISTS (run 34018932244) -- I3, I5, I6.
 *
 * Three report-only lists, and the shapes that make them safe to hand a
 * dispatch box later. Every number pinned here was MEASURED read-only against
 * prod on 2026-09-06 by point-reading each row, each rival address, and each
 * proposed destination; a list edited without re-measuring fails here rather
 * than in an apply.
 *
 * WHAT THE MEASUREMENT OVERTURNED, stated because the pins encode it:
 *
 *   I3  The finding was framed as "the refile lane patched the FIELD and left
 *       the STEM behind". It did not. All 17 rows carry an EMPTY provenance
 *       block -- no rekeyedFrom, movedFrom, lastRepair, repairedBy or
 *       authoritativeSetKey -- so no lane touched them. They were MINTED this
 *       way by three checklist ingests while CHROME_PREFIX_OVERRIDES rewrote
 *       the slug and upsertCatalogEntry stored the caller's bare "bowman".
 *
 *   I5  All 7 are new (none appear in the three existing twin lists), all 7
 *       were rekeyed by ONE fleet inside 42 seconds, and in 6 of them exactly
 *       one copy is both stamped AND checklist-backed -- so the keeper is read
 *       off provenance, never guessed from the address.
 *
 *   I6  24 reported rows are 23 distinct sales, and 8 of those 23 are CHECKER
 *       false positives: a plural title token against a singular slug segment,
 *       or a compound segment reduced to its colour family so the rest of its
 *       own words read as "unstated". `light-blue-die-cut-prizm` was reported
 *       for lacking die-cut.
 */

const dataDir = path.join(process.cwd(), "data");
const readList = (rel: string) => JSON.parse(readFileSync(path.join(dataDir, rel), "utf8"));

const i3 = readList("catalog-relocations/2026-09-06-audit-i3-setkey-field-stem.json");
const i5 = readList("pool-relocations/2026-09-06-audit-i5-one-sale-one-address.json");
const i6 = readList("pool-relocations/2026-09-06-audit-i6-pool-coherence.json");

type CatEntry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
type PoolEntry = {
  id: string;
  fromCardId: string;
  toCardId?: string;
  retireSupersededBy?: string;
  parkIdentityUnverified?: boolean;
  repointHobbyiqCardId?: string;
  evidence?: string;
};

// ── I3: the catalog list ────────────────────────────────────────────────────

describe("I3 SETKEY-FIELD-EXTENDS-STEM: the catalog list", () => {
  const entries = i3.entries as CatEntry[];

  it("is addressed to the catalog lane and is report-only", () => {
    expect(i3.forLane).toBe("relocate-catalog-rows-by-list");
    expect(String(i3.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("carries 16 of the 17 audit rows — the sapphire collision is EXCLUDED", () => {
    // The 17th row is a Beckett-initials collision over WHOSE card SSA-JC is,
    // not a field/stem repair, so it is reported and not acted on.
    expect(i3.census.auditRows).toBe(17);
    expect(entries).toHaveLength(16);
    expect(i3.excluded).toHaveLength(1);
    expect(i3.excluded[0].id).toBe("hiq:baseball:2025:bowman-chrome-sapphire:ssa-jc:base:no-auto");
    expect(i3.excluded[0].auditKind).toBe("field-unrelated-to-stem");
    expect(new Set(entries.map((e) => e.id)).size).toBe(16);
  });

  it("every entry passes the LANE'S OWN classifier — not a second copy of it", () => {
    // The lane refuses a malformed entry at runtime; pinning against the lane
    // itself means a shape drift fails here instead of mid-apply.
    const lane = path.join(process.cwd(), "scripts", "relocate-catalog-rows-by-list.cjs");
    const L = require_(lane) as { classifyEntry: (e: unknown) => { ok: boolean; why?: string } };
    for (const e of entries) {
      const r = L.classifyEntry(e);
      expect(r.ok, `${e.id}: ${r.why ?? ""}`).toBe(true);
    }
  });

  it("retires come BEFORE reslugs — the lane applies top to bottom", () => {
    // A reslug onto an address a retire has not yet vacated would be refused
    // as occupied. Order in the file IS the apply order.
    const firstReslug = entries.findIndex((e) => e.action === "reslug");
    const lastRetire = entries.map((e) => e.action).lastIndexOf("retire");
    expect(firstReslug).toBeGreaterThan(lastRetire);
    expect(entries.filter((e) => e.action === "retire")).toHaveLength(11);
    expect(entries.filter((e) => e.action === "reslug")).toHaveLength(5);
  });

  it("every reslug moves the STEM onto the setKey FIELD, never the reverse", () => {
    // CF-IT-CAME-OUT-OF-BOWMAN: the field is the checklist's word and the stem
    // is the override artifact, so `to` must be the id with bowman-chrome
    // collapsed to bowman — and must never rewrite the field to chrome.
    for (const e of entries.filter((x) => x.action === "reslug")) {
      expect(e.id).toContain(":bowman-chrome:");
      expect(e.to).toBe(e.id.replace(":bowman-chrome:", ":bowman:"));
      expect(e.to).not.toContain(":bowman-chrome:");
    }
  });

  it("records that NO lane stamped these rows — they were minted this way", () => {
    // The load-bearing correction. If a future census finds provenance stamps,
    // this list's whole reading is wrong and this pin says so.
    expect(i3.census.provenanceStampsFound).toBe(0);
    expect(JSON.stringify(i3.rulings)).toMatch(/NO LANE STAMPED THESE/);
    expect(JSON.stringify(i3.rulings)).toMatch(/CHROME_PREFIX_OVERRIDES/);
    // Three checklist ingests, not a repair lane.
    expect(Object.keys(i3.census.stampedBy).sort()).toEqual([
      "beckett-checklist-2026-08-29",
      "checklistcenter-2026-08-29",
      "checklistinsider-2026-08-27",
    ]);
  });

  it("states that retire is a DELETE and hands that row's sales to the rematch", () => {
    // catalogVisibility.ts:23-25 — every state is matchable, so only absence
    // removes a row. The cost is stated before an apply, not after.
    expect(JSON.stringify(i3.rulings)).toMatch(/RETIRE IS A DELETE/);
    expect(JSON.stringify(i3.rulings)).toMatch(/unplaced/);
  });

  it("every entry carries a reason and real evidence", () => {
    for (const e of entries) {
      expect(String(e.reason ?? "").length).toBeGreaterThan(20);
      expect(String(e.evidence ?? "").length).toBeGreaterThan(60);
    }
  });
});

// ── I5: one sale, one address ───────────────────────────────────────────────

describe("I5 ONE-SALE-ONE-ADDRESS: the new twin list", () => {
  const entries = i5.entries as PoolEntry[];

  it("is addressed to the pool lane and is report-only", () => {
    expect(i5.forLane).toBe("relocate-pool-rows-by-list.cjs");
    expect(String(i5.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("all 7 breaches are NEW — none was already listed", () => {
    expect(i5.census.auditBreaches).toBe(7);
    expect(i5.census.alreadyListed).toBe(0);
    expect(i5.census.groups).toBe(7);
  });

  it("names ONLY marker shapes — never a relocate or a delete", () => {
    // CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE. RETIRE and PARK are patches in
    // place: no partition moves and no document is removed.
    expect(entries.filter((e) => e.toCardId && e.toCardId !== e.fromCardId)).toHaveLength(0);
    expect(entries.filter((e) => e.repointHobbyiqCardId)).toHaveLength(0);
  });

  it("every entry names exactly ONE shape", () => {
    for (const e of entries) {
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId ? "relocate" : null,
        e.repointHobbyiqCardId ? "repoint" : null,
        e.retireSupersededBy ? "retire" : null,
        e.parkIdentityUnverified === true ? "park" : null,
      ].filter(Boolean);
      expect(shapes).toHaveLength(1);
    }
  });

  it("every entry carries an id, an address, and its evidence", () => {
    for (const e of entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      expect(String(e.evidence ?? "").length).toBeGreaterThan(30);
    }
  });

  it("never retires a row onto its own address", () => {
    for (const e of entries) {
      if (e.retireSupersededBy) expect(e.retireSupersededBy).not.toBe(e.fromCardId);
    }
  });

  it("NEVER keeps a maker-default or player- key", () => {
    // Drew's rule, and the whole reason the keeper is decidable here: "bowman"
    // on a Pokemon card, "unknown", and "player-" buckets are parser defaults,
    // never identities. Three of the retired addresses are exactly those.
    for (const e of entries) {
      if (!e.retireSupersededBy) continue;
      const stem = e.retireSupersededBy.split(":")[3] ?? "";
      expect(stem).not.toBe("unknown");
      expect(stem.startsWith("player-")).toBe(false);
      // a pokemon sale never keeps a `bowman` key
      if (e.retireSupersededBy.startsWith("hiq:pokemon:")) expect(stem).not.toBe("bowman");
    }
  });

  it("the retired copy is always the UNSTAMPED, uncatalogued one", () => {
    // The keeper is read off provenance -- this run's own rekeyedAt plus a
    // rekeyedFrom naming the retired address -- never guessed from the address.
    for (const e of entries.filter((x) => x.retireSupersededBy)) {
      const ev = String(e.evidence);
      expect(ev).toMatch(/KEEPER/);
      expect(ev).toMatch(/GREAT REMATCH \(2026-09-01\): IMPROVE/);
      expect(ev).toMatch(/CHECKLIST-BACKED/);
      expect(ev).toMatch(/UNSTAMPED/);
      expect(ev).toContain(e.fromCardId);
    }
  });

  it("the baseball group PARKS BOTH — it is a sport misfile, not a product dispute", () => {
    // The sale's own title states "2005 Topps Finest ... X-Fractor /250" and
    // names no Donruss product at all. Corey Dillon is football; the rematch
    // keeper is Lyle Overbay's BASEBALL card; no checklist-backed football
    // Topps Finest #72 row exists. CF-NEVER-DEFAULT-TO-EITHER-SIDE.
    const parks = entries.filter((e) => e.parkIdentityUnverified === true);
    expect(parks).toHaveLength(2);
    expect(new Set(parks.map((p) => p.id)).size).toBe(1);
    expect(parks[0].id).toBe("tca-ebay::277910774346");
    for (const p of parks) {
      expect(String(p.evidence)).toMatch(/Topps Finest/);
      expect(String(p.evidence)).toMatch(/LYLE OVERBAY/i);
      expect(String(p.evidence)).toMatch(/NEVER-DEFAULT-TO-EITHER-SIDE/);
    }
    expect(JSON.stringify(i5.rulings)).toMatch(/NOT A DONRUSS-VS-FINEST DISPUTE/i);
  });

  it("tells the operator that no IMPROVE pass may run before it is applied", () => {
    expect(String(i5.provenance.APPLY_ORDER)).toMatch(
      /NO IMPROVE FLEET PASS MAY RUN BETWEEN MERGE AND APPLY/,
    );
  });
});

// ── I6: pool identity coherence ─────────────────────────────────────────────

describe("I6 POOL-IDENTITY-COHERENCE: the coherence list", () => {
  const entries = i6.entries as PoolEntry[];

  it("is addressed to the pool lane and is report-only", () => {
    expect(i6.forLane).toBe("relocate-pool-rows-by-list.cjs");
    expect(String(i6.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("24 reported rows are 23 distinct sales", () => {
    // tca-ebay::237048906564 appears twice in the artifact's rows[].
    expect(i6.census.auditRowsReported).toBe(24);
    expect(i6.census.distinctSales).toBe(23);
    expect(i6.census.duplicateInArtifact).toBe(1);
    const classified = Object.values(i6.census.byClass as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    expect(classified).toBe(23);
  });

  it("classifies every sale into the four named classes", () => {
    expect(Object.keys(i6.census.byClass).sort()).toEqual([
      "falsePositive",
      "finishMissing",
      "productMisfile",
      "sportMisfile",
    ]);
  });

  it("false positives produce NO entry — the checker is the defect there", () => {
    // 8 of 23 are the checker comparing a plural against a singular, or
    // reducing a compound segment to its colour family and then reporting the
    // segment's own remaining words as unstated.
    expect(i6.census.byClass.falsePositive).toBe(8);
    expect(entries).toHaveLength(23 - 8);
    expect(i6.census.entries).toBe(entries.length);
    expect(String(i6.provenance.checkerDefect)).toMatch(/family/i);
  });

  it("every entry names exactly ONE shape, and only relocate or park", () => {
    for (const e of entries) {
      const shapes = [
        e.toCardId && e.toCardId !== e.fromCardId ? "relocate" : null,
        e.repointHobbyiqCardId ? "repoint" : null,
        e.retireSupersededBy ? "retire" : null,
        e.parkIdentityUnverified === true ? "park" : null,
      ].filter(Boolean);
      expect(shapes).toHaveLength(1);
      expect(["relocate", "park"]).toContain(shapes[0]);
    }
  });

  it("parks outnumber relocates, because minting is refused", () => {
    // CF-NO-SYNTHETIC-PARALLELS-ONLY-ACTUALS. A sale with no checklist-backed
    // destination parks; it never gets a row minted for it.
    expect(i6.census.parked).toBe(11);
    expect(i6.census.relocate).toBe(4);
    expect(entries.filter((e) => e.parkIdentityUnverified === true)).toHaveLength(11);
    expect(entries.filter((e) => e.toCardId)).toHaveLength(4);
  });

  it("every relocate destination is a real, DIFFERENT hiq address", () => {
    for (const e of entries.filter((x) => x.toCardId)) {
      expect(e.toCardId!.startsWith("hiq:")).toBe(true);
      expect(e.toCardId).not.toBe(e.fromCardId);
    }
  });

  it("the sport-misfile relocates actually CHANGE the sport", () => {
    // Bowman University is football; Giddey and Robinson are basketball. A
    // relocate that left the sport alone would not be fixing the real defect.
    const lloyd = entries.find((e) => e.id === "tca-ebay::167964411848")!;
    expect(lloyd.fromCardId).toContain("hiq:baseball:");
    expect(lloyd.toCardId).toBe("hiq:football:2021:bowman:62:chrome-prospects-gold-refractor:no-auto:num-50");
    expect(String(lloyd.evidence)).toMatch(/Bowman University is a FOOTBALL/);
    // and it also moves the sale off ANOTHER player's pool
    expect(String(lloyd.evidence)).toMatch(/ACUNA/i);

    const giddey = entries.find((e) => e.id === "tca-ebay::206523678519")!;
    expect(giddey.toCardId).toContain("hiq:basketball:");
    const robinson = entries.find((e) => e.id === "tca-ebay::297423487135")!;
    expect(robinson.toCardId).toContain("hiq:basketball:");
  });

  it("never files a raw sale onto a graded identity", () => {
    // Herbert's reactive-orange rows all exist but every one is a graded
    // child, so that sale parks instead of landing on a grade it never stated.
    const gradeSuffix = /:(psa|bgs|sgc|cgc)-[0-9]/;
    for (const e of entries.filter((x) => x.toCardId)) {
      expect(e.toCardId).not.toMatch(gradeSuffix);
    }
    const herbert = entries.find((e) => e.id === "tca-ebay::366640883026")!;
    expect(herbert.parkIdentityUnverified).toBe(true);
    expect(String(herbert.evidence)).toMatch(/GRADED children/);
  });

  it("every entry carries an id, an address, and its title evidence", () => {
    for (const e of entries) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      expect(String(e.evidence ?? "").length).toBeGreaterThan(60);
      // the title is the evidence this invariant turns on
      expect(String(e.evidence)).toMatch(/title: /);
    }
  });
});
