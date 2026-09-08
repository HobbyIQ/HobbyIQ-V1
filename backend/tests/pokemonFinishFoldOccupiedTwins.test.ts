/**
 * CF-A-FOLD-NEVER-CHANGES-THE-PLAYER, the "occupied: unnamed" half (2026-09-07).
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * #1953 shipped the corrected finish-fold lists 06b/07b/08b, and the 06b REPORT
 * (run 34169134810) still reconciled with
 *
 *     refused — occupied  5     intended 2,000 = written 1,992 + skipped 3 + refused 5
 *
 * Those five were not collisions. Point-read against prod for this change, all
 * nineteen refusals across the three lists (5 + 9 + 5) are ONE shape:
 *
 *     source hiq:pokemon:2023:sv2a:160:reverse-holo:no-auto      "たべのこし"
 *     twin   hiq:pokemon:2023:sv2a:160:reverse-holofoil:no-auto  "たべのこし"
 *
 * The two playerName strings are BYTE-IDENTICAL. They refuse because
 * `playerIdentityKey` reduces a name to `[a-z0-9]`, kana and kanji carry none
 * of those, and both sides therefore reduce to `""` -- whereupon the lane's
 * `occupancyRefusal` applies its deliberately safe rule: "blank is unknown,
 * never 'the same'". That rule is CORRECT and is not changed here. A
 * delete-bearing lane must not fold two rows whose names it cannot read.
 *
 * The defect is in the LIST, which asked for a reslug onto an address its own
 * evidence already knew was held by the same card. A reslug refuses when a
 * different row holds the target; the right shape when the twin IS this card is
 * a FOLD -- retire the source, the twin keeps the address, one card gets one
 * row and one pool.
 *
 * ── WHY RETIRE, AND NOT `keepSales` ─────────────────────────────────────────
 *
 * `keepSales` is a RESLUG option: `keepsSales()` is read only on the reslug
 * path, and `classifyEntry` rejects a retire that names a `to` at all. So a
 * fold onto an occupied address cannot be spelled as a keepSales reslug -- the
 * lane would still refuse it at `occupancyRefusal`, before `keepsSales` is ever
 * consulted. The shape the lane accepts is `retire`, whose contract is stated
 * in its own header: sales are LEFT WHERE THEY ARE, unplaced, and the rematch
 * owns them. That is the same hand-off #1953's own 43 conversions made (1,140
 * sales unplaced); these nineteen make 21.
 *
 * ── WHAT THIS TEST PINS ─────────────────────────────────────────────────────
 *
 * These tests run offline and cannot ask prod who holds an address. What they
 * CAN hold is the property that made the refusal possible in the first place:
 * the nineteen ids measured as occupied must carry the fold action, never a
 * reslug, and no entry may reslug onto an address the same list is also acting
 * on. A future regeneration that re-emits any of them as a reslug turns red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { playerIdentityKey } = require_("../scripts/lib/player-identity.cjs") as {
  playerIdentityKey: (s: string) => string;
};

const DIR = join(__dirname, "..", "data", "catalog-relocations");
const PARTS = ["06b", "07b", "08b"] as const;
type Entry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
type Doc = { forLane: string; note: string; entries: Entry[] };

const LISTS: Record<string, Doc> = Object.fromEntries(
  PARTS.map((p) => [
    p,
    JSON.parse(
      readFileSync(join(DIR, `2026-09-07-pokemon-finish-token-fold-${p}.json`), "utf-8"),
    ) as Doc,
  ]),
);

/**
 * The ids measured `occupied` against prod on 2026-09-07, by list. Written out
 * rather than derived, because the whole point of the pin is that a REGENERATED
 * list must not quietly put any of them back on the reslug path -- a derived
 * expectation would regenerate along with the defect.
 */
const MEASURED_OCCUPIED: Record<string, string[]> = {
  "06b": [
    "hiq:pokemon:2023:sv4a:174:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:161:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:160:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:164:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv4a:189:reverse-holo:no-auto",
  ],
  "07b": [
    "hiq:pokemon:2023:sv2a:156:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv4a:183:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:154:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:163:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv4a:168:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:152:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:158:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:155:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:153:reverse-holo:no-auto",
  ],
  "08b": [
    "hiq:pokemon:2023:sv4a:182:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:162:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv4a:172:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv2a:157:reverse-holo:no-auto",
    "hiq:pokemon:2023:sv4a:186:reverse-holo:no-auto",
  ],
};

describe("no fold-list entry targets an occupied address without a fold action", () => {
  it.each(PARTS)("%s: every measured-occupied id carries the fold shape, not a reslug", (part) => {
    const byId = new Map(LISTS[part]!.entries.map((e) => [e.id, e]));
    for (const id of MEASURED_OCCUPIED[part]!) {
      const e = byId.get(id);
      expect(e, `${id} left ${part} entirely`).toBeDefined();
      // THE PIN. A reslug here is the defect: the lane refuses it as `occupied`
      // and the two rows stay two rows for one card forever, because every
      // re-run makes the same refusal.
      expect(
        e!.action,
        `${id} is occupied at its destination — a reslug there is refused, not applied`,
      ).toBe("retire");
      // `classifyEntry` rejects a retire that names a `to`; the lane would count
      // it MALFORMED rather than apply it.
      expect(e!.to, `${id} is a retire and must not name a "to"`).toBeUndefined();
    }
  });

  it.each(PARTS)("%s: the note states the conversions this list carries", (part) => {
    const n = MEASURED_OCCUPIED[part]!.length;
    expect(LISTS[part]!.note).toContain("REVISION 2026-09-07");
    expect(LISTS[part]!.note, `${part} must state its ${n} conversions`).toContain(`All ${n} are`);
  });

  it("names 19 folds in total, and never the same id twice", () => {
    const all = PARTS.flatMap((p) => MEASURED_OCCUPIED[p]!);
    expect(all.length).toBe(19);
    expect(new Set(all).size, "an id measured twice would be folded twice").toBe(19);
  });
});

describe("the fold is spelled the way the lane reads it", () => {
  it.each(PARTS)("%s: every entry states ONE shape with a reason and evidence", (part) => {
    for (const e of LISTS[part]!.entries) {
      expect(["retire", "reslug"], `${e.id} has action ${e.action}`).toContain(e.action);
      if (e.action === "reslug") {
        expect(e.to, `${e.id} reslug with no target`).toBeTruthy();
        expect(e.to, `${e.id} reslug onto itself`).not.toBe(e.id);
        expect(String(e.to).startsWith("hiq:"), `${e.id} target is not a hiq slug`).toBe(true);
      } else {
        expect(e.to, `${e.id} retire must not name a target`).toBeUndefined();
      }
      expect(String(e.reason).length, `${e.id} has no reason`).toBeGreaterThan(20);
      expect(String(e.evidence).length, `${e.id} has no evidence`).toBeGreaterThan(20);
      expect(e.id.startsWith("hiq:"), `${e.id} is not a hiq slug`).toBe(true);
    }
  });

  it.each(PARTS)("%s: no reslug targets an address this list also acts on", (part) => {
    // The list is applied top to bottom and the lane does not reorder. A reslug
    // whose destination is ALSO some other entry's source is order-dependent at
    // best and a refusal at worst; neither belongs in a finish fold.
    const sources = new Set(LISTS[part]!.entries.map((e) => e.id));
    for (const e of LISTS[part]!.entries) {
      if (e.action !== "reslug") continue;
      expect(
        sources.has(String(e.to)),
        `${e.id} reslugs onto ${e.to}, which this list also acts on`,
      ).toBe(false);
    }
  });

  it.each(PARTS)("%s: no id is addressed twice", (part) => {
    const ids = LISTS[part]!.entries.map((e) => e.id);
    expect(new Set(ids).size, `${part} names an id more than once`).toBe(ids.length);
  });
});

describe("why the guard refused: the reduction empties a Japanese name", () => {
  it("reduces kana and kanji to the empty key, on BOTH sides of the pair", () => {
    // The mechanism, asserted rather than described. Both rows of each refused
    // pair carry the SAME name, and the reduction cannot tell us so -- which is
    // why the lane refused, and why the LIST is what this change fixes.
    for (const name of ["たべのこし", "ナンジャモ", "古びたひみつのコハク", "安全ゴーグル", "ポケモンリーグ本部"]) {
      expect(
        playerIdentityKey(name),
        `${name} must reduce to "" for this to be the refusal we fixed`,
      ).toBe("");
    }
  });

  it("still tells two LATIN names apart, so the guard is not weakened", () => {
    // Nothing in this change touches occupancyRefusal. Pinned so a later
    // "just make blank-vs-blank fold" edit has to argue with a red test.
    expect(playerIdentityKey("Derek Jeter")).not.toBe(playerIdentityKey("Todd Hundley"));
    expect(playerIdentityKey("Mr. Mime")).toBe(playerIdentityKey("Mr Mime"));
  });
});
