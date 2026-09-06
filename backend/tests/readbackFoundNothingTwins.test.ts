import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const { relocateSoldComp } = require_(path.join(LIB, "relocate-sold-comp.cjs"));

/**
 * THE "read-back found nothing" TWINS -- 49 duplicates the GREAT REMATCH
 * IMPROVE fleet left behind, and the proof that not one sale was lost.
 *
 * The fleet (backfill-runner, rematch-sold-comps, APPLY_SCOPE=improve, 32
 * slots) logged 82 `FAILED at verify` lines: 22 "read-back differs" and 60
 * "read-back found nothing". The 60 were read out of the container one id at
 * a time:
 *
 *   49  keeper LIVE at its new address carrying THIS run's stamp, old twin
 *       still resident            -> a duplicate; this list retires the twin
 *   11  keeper live, twin already gone -- a LATER pass re-relocated the row
 *       (rekeyedAt 2.3-7.6h after the log line)  -> no action
 *    0  write did not land
 *
 * That last number is not luck, and the first test below is why: the upsert
 * is checked for success BEFORE the read-back runs, and the mismatch branch
 * deletes nothing. "FAILED at verify" can only ever mean a duplicate was
 * left -- never a lost sale.
 *
 * All 49 came from the PRE-#1850 passes (slots 0-15, 05:22Z-14:44Z) running
 * the helper that believed the first null point-read. Every one of them
 * CHANGED PARTITION, which is exactly the Eventual-consistency surface
 * #1850 documents. The post-fix passes logged zero of these, so the list is
 * closed by construction.
 */
describe("a failed verify is a duplicate, never a lost sale", () => {
  it("the upsert has already landed when the read-back returns nothing", async () => {
    // THE LOAD-BEARING FACT behind class (c) being empty. The read-back here
    // finds NOTHING at all (the stale-replica case, not the mismatch case):
    // every point-read 404s and the both-keys query comes back empty. The
    // keeper is still reported as written, and the old row is still not
    // deleted -- so the row is resident twice, which is what this list fixes.
    const keep = { id: "tca-ebay::1", cardId: "hiq:baseball:2023:topps:1:base:no-auto", price: 10 };
    let upserted = false;
    const notFound = Object.assign(new Error("NotFound"), { code: 404 });
    const pool = {
      item: () => ({
        read: async () => { throw notFound; },
        delete: async () => { throw new Error("must not delete when the read-back found nothing"); },
      }),
      items: {
        upsert: async () => { upserted = true; return { resource: keep }; },
        query: () => ({ fetchAll: async () => ({ resources: [] }) }),
      },
    };

    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: "tca-ebay::1", cardId: "1756834708461x104226419332249520" }],
      wait: async () => {},
    });

    expect(upserted).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("verify");
    expect(res.error).toBe("read-back found nothing");
    // The duplicate is REPORTED and the old row survives: a sale is never lost.
    expect(res.duplicatesLeft).toHaveLength(1);
    expect(res.deleted).toHaveLength(0);
  });
});

describe("the committed read-back-found-nothing list is report-first and well-formed", () => {
  const list = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "data/pool-relocations/2026-09-06-readback-found-nothing-twins.json"),
      "utf8",
    ),
  );
  const entries = list.entries as any[];

  it("carries exactly the 49 class-(a) ids, none of them twice", () => {
    expect(entries).toHaveLength(49);
    expect(new Set(entries.map((e) => e.id)).size).toBe(49);
  });

  it("names ONLY marker shapes — never a relocate or a delete", () => {
    // CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE. RETIRE is a patch in place: no
    // partition moves and no document is removed.
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
      expect(shapes[0]).toBe("retire");
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
    // A marker pointing at the row it is stamped on would orphan the sale.
    for (const e of entries) expect(e.retireSupersededBy).not.toBe(e.fromCardId);
  });

  it("every keeper was verified present, by the run's OWN stamp", () => {
    // The keeper is never identified by address alone. Each entry's evidence
    // records the rekeyedAt this fleet wrote, the rekeyedFrom naming the very
    // address being retired, and the GREAT REMATCH IMPROVE reason -- which is
    // what makes the retired copy provably the stale twin and not a rival
    // reading of the card.
    for (const e of entries) {
      const ev = String(e.evidence);
      expect(ev).toMatch(/keeper is LIVE at /);
      expect(ev).toMatch(/rekeyedAt 2026-09-05T/);
      expect(ev).toMatch(/rekeyedFrom naming this exact address/);
      expect(ev).toMatch(/GREAT REMATCH \(2026-09-01\): IMPROVE/);
      expect(ev).toContain(e.retireSupersededBy);
    }
  });

  it("is closed: every entry is pre-#1850, from slots 0-15 on 2026-09-05", () => {
    // The cause is fixed, so no new member can appear. The post-fix passes
    // logged zero "read-back found nothing" lines.
    expect(String(list.provenance.allPre1850)).toMatch(/slots 0-15/);
    for (const e of entries) {
      const at = String(e.evidence).match(/read-back found nothing" at (\S+)/)?.[1] ?? "";
      expect(at.startsWith("2026-09-05T")).toBe(true);
      const hour = Number(at.slice(11, 13));
      expect(hour).toBeGreaterThanOrEqual(5);
      expect(hour).toBeLessThanOrEqual(14);
    }
  });

  it("leaves the maker-default third address alone", () => {
    // tca-ebay::117210597158 is resident at THREE addresses. Only the
    // stale-read-back twin is retired here; the pre-existing bowman copy
    // predates the rematch (no rekeyedAt, absent from the keeper's
    // rekeyedFrom), so it is a separate split with its own census.
    const three = entries.filter((e) => e.id === "tca-ebay::117210597158");
    expect(three).toHaveLength(1);
    expect(three[0].fromCardId).toBe("hiq:hockey:2025:unknown:60:base:no-auto");
    expect(three[0].retireSupersededBy).toBe("hiq:hockey:2025:spx:60:base:no-auto");
    expect(entries.some((e) => e.fromCardId === "hiq:hockey:2025:bowman:60:base:no-auto")).toBe(false);
    expect(JSON.stringify(list.deferred)).toMatch(/left in place; maker-default split, own census/);
  });

  it("tells the operator that no IMPROVE pass may run before it is applied", () => {
    // The retired addresses still match the IMPROVE predicate, so a fleet
    // pass between merge and apply would re-relocate them and race this list.
    expect(String(list.provenance.APPLY_ORDER)).toMatch(/NO IMPROVE FLEET PASS MAY RUN BETWEEN MERGE AND APPLY/);
  });

  it("is addressed to the by-list lane", () => {
    expect(list.forLane).toBe("relocate-pool-rows-by-list.cjs");
  });
});
