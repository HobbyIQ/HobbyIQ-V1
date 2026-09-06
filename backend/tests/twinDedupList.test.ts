import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const LIB = path.join(process.cwd(), "scripts/lib");
const K = require_(path.join(LIB, "rematch-classify.cjs"));
const { relocateSoldComp } = require_(path.join(LIB, "relocate-sold-comp.cjs"));

/**
 * THE TWIN DEDUP LIST -- the PARALLEL axis ruling, and the accounting bug
 * that hid a duplicate.
 *
 * Drew, 2026-09-05: "title decides" extends to the PARALLEL axis for same-id
 * twins whose product agrees -- keep the copy whose parallel the title states,
 * retire the other; a title naming NO parallel keeps the base copy only if the
 * other copy's parallel has no checklist support, else park both.
 *
 * The predicate is the EXISTING reader (K.storedParallelStatedInTitle), never
 * a second copy of it: a second copy is a second source of truth that drifts
 * from the first, and these pins would then pin the copy rather than the code
 * the list generator ran.
 */
describe("PARALLEL axis: the title decides which copy is the sale", () => {
  const slugFor = (parallel: string) => `hiq:basketball:2007:topps:2:${parallel}:no-auto`;

  it("the reader finds the parallel the title states", () => {
    // Kevin Durant's twin from #1827's deferred list: one copy `orange`, one
    // `base`, product agrees (topps). The title says Orange.
    const hit = K.storedParallelStatedInTitle({
      title: "2007-08 Topps Kevin Durant Orange RC #2 SuperSonics Rookie",
      storedSlug: slugFor("orange"),
      stored: { parallel: "orange" },
      setKey: "topps",
      playerName: "Kevin Durant",
    });
    expect(hit).toBeTruthy();
    expect(hit.phrase).toBe("orange");
  });

  it("the reader does NOT claim the base copy for the same title", () => {
    // `base` is a generic parallel and names no finish, so the title cannot
    // state it. This asymmetry is what makes the ruling decidable.
    const hit = K.storedParallelStatedInTitle({
      title: "2007-08 Topps Kevin Durant Orange RC #2 SuperSonics Rookie",
      storedSlug: slugFor("base"),
      stored: { parallel: "base" },
      setKey: "topps",
      playerName: "Kevin Durant",
    });
    expect(hit).toBeNull();
  });

  it("a colour inside a TEAM name is not evidence the seller named a finish", () => {
    // The reader strips team phrases. Without this, every Blue Jays sale
    // would 'state' a Blue parallel and the ruling would retire the wrong
    // copy -- which is precisely why this lane reuses the reader.
    const hit = K.storedParallelStatedInTitle({
      title: "1992 Topps Roberto Alomar #12 Toronto Blue Jays",
      storedSlug: "hiq:baseball:1992:topps:12:blue:no-auto",
      stored: { parallel: "blue" },
      setKey: "topps",
      playerName: "Roberto Alomar",
    });
    expect(hit).toBeNull();
  });

  it("the Members Choice twin resolves to the copy the title names", () => {
    // #1827's second deferred group: members-choice vs base, product agrees.
    const hit = K.storedParallelStatedInTitle({
      title: "Topps 1992 Stadium Club Members Choice Ken Griffey Jr #603 Seattle Mariners",
      storedSlug: "hiq:baseball:1992:topps-stadium-club:603:members-choice:no-auto",
      stored: { parallel: "members-choice" },
      setKey: "topps-stadium-club",
      playerName: "Ken Griffey Jr",
    });
    expect(hit).toBeTruthy();
  });
});

describe("the committed twin list is report-first and well-formed", () => {
  const list = JSON.parse(
    readFileSync(path.join(process.cwd(), "data/pool-relocations/2026-09-05-twin-address-dedup.json"), "utf8"),
  );

  it("names ONLY marker shapes — never a relocate or a delete", () => {
    // CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE. RETIRE and PARK are patches in
    // place: no partition moves and no document is removed. A relocate shape
    // in this list would move rows, which this ruling does not authorize.
    const relocate = list.entries.filter((e: any) => e.toCardId && e.toCardId !== e.fromCardId);
    const repoint = list.entries.filter((e: any) => e.repointHobbyiqCardId);
    expect(relocate).toHaveLength(0);
    expect(repoint).toHaveLength(0);
    expect(list.entries.length).toBeGreaterThan(0);
  });

  it("every entry names exactly ONE shape", () => {
    // The lane refuses an entry naming two shapes; a silent precedence order
    // is how the wrong one gets applied.
    for (const e of list.entries as any[]) {
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
    for (const e of list.entries as any[]) {
      expect(String(e.id ?? "")).not.toBe("");
      expect(String(e.fromCardId ?? "")).not.toBe("");
      expect(String(e.evidence ?? "").length).toBeGreaterThan(30);
    }
  });

  it("never retires a row onto its own address", () => {
    // A marker pointing at the row it is stamped on would orphan the sale.
    for (const e of list.entries as any[]) {
      if (e.retireSupersededBy) expect(e.retireSupersededBy).not.toBe(e.fromCardId);
    }
  });

  it("no bowman copy is retired when the title actually says bowman", () => {
    // The bowman-vs-unknown ruling rests ENTIRELY on the title refuting the
    // key. If a title said "bowman", the key would be evidence and retiring
    // it would be the guess.
    const bowman = (list.entries as any[]).filter((e) => /bowman-vs-unknown/.test(String(e.evidence)));
    for (const e of bowman) {
      const title = String(e.evidence).split("Title: ")[1] ?? "";
      expect(title.toLowerCase()).not.toMatch(/\bbowman\b/);
    }
  });
});

describe("CF-A-VERIFY-MISMATCH-IS-A-DUPLICATE-NOT-A-FAILURE", () => {
  /**
   * THE BUG THIS PINS. relocateSoldComp upserts the keeper, reads it back,
   * then deletes the old row. When the read-back fails verification the
   * keeper is ALREADY WRITTEN -- so the sale now exists at two addresses --
   * but the branch returned `duplicatesLeft: []`. Callers counted it as
   * `failed` and printed "duplicates left in pool: 0" while a duplicate
   * stood in the container. Measured: rekey-product-setkey run 33973364948
   * hit this on 12 of 35,173 rows.
   */
  it("reports the undeleted old rows as duplicatesLeft when read-back fails", async () => {
    const keep = { id: "tca-ebay::1", cardId: "hiq:baseball:2023:topps:1:base:no-auto", price: 10 };
    const pool = {
      item: () => ({
        // read-back returns a row whose price does NOT match -> mismatch
        read: async () => ({ resource: { ...keep, price: 999 } }),
        delete: async () => { throw new Error("must not delete on an unverified read-back"); },
      }),
      items: {
        upsert: async () => ({ resource: keep }),
        query: () => ({ fetchAll: async () => ({ resources: [{ ...keep, price: 999 }] }) }),
      },
    };

    const res = await relocateSoldComp(pool, {
      keep,
      drop: [{ id: "tca-ebay::1", cardId: "hiq:baseball:2023:bowman:1:base:no-auto" }],
      verifyFields: ["price"],
      wait: async () => {},
    });

    expect(res.ok).toBe(false);
    expect(res.stage).toBe("verify");
    // THE ASSERTION. Before the fix this was `[]` and the duplicate was
    // invisible to every caller's "must be 0" summary line.
    expect(res.duplicatesLeft).toHaveLength(1);
    expect(res.duplicatesLeft[0].cardId).toBe("hiq:baseball:2023:bowman:1:base:no-auto");
    expect(String(res.duplicatesLeft[0].error)).toMatch(/two addresses/i);
    // And the old row is still NOT deleted: a sale is never lost.
    expect(res.deleted).toHaveLength(0);
  });
});
