/**
 * CF-CPA-IS-AMBIGUOUS-FROM-2023, the stored half (#1824 fixed the mint).
 *
 * These pins drive the PURE module the lane runs -- `planCrossProductSale` and
 * `planCrossProductCatalogRow` read no Cosmos, so what is pinned here is
 * exactly what decides a write.
 *
 * The numbers behind them, measured read-only 2026-09-05 (see the PR body):
 *
 *   sales    20,083 chrome-stem CPA sales whose player a bowman-draft
 *                   checklist names and no bowman-chrome one does
 *                   (8,638 in 2024 + 11,445 in 2025; 2023 measures ZERO)
 *   park      3,038 sales on one of the 45 collision numbers
 *   refused  16,768 sales whose destination names a DIFFERENT player
 *   catalog      10 rows whose own setName says "Bowman Draft"
 *
 * The refusal is the pin that matters most: a move that lands one player's
 * sale on another player's address pools two people irreversibly, and there is
 * no undo once the comps mix.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const X = require_("../scripts/lib/cross-product-refile.cjs");

const FROM = "bowman-chrome";
const TO = "bowman-draft";

const sale = (over: Record<string, unknown> = {}) => ({
  id: "sale-1",
  hobbyiqCardId: "hiq:baseball:2025:bowman-chrome:cpa-gw:base:auto",
  cardId: "hiq:baseball:2025:bowman-chrome:cpa-gw:base:auto",
  cardNumber: "CPA-GW",
  playerName: "Gage Wood",
  title: "2025 Bowman Chrome Gage Wood CPA-GW Auto",
  ...over,
});

const DEST = "hiq:baseball:2025:bowman-draft:cpa-gw:base:auto";

describe("parseScopeTriple -- a scope names BOTH ends of the move", () => {
  it("parses sport:year:fromKey>toKey", () => {
    expect(X.parseScopeTriple("baseball:2025:bowman-chrome>bowman-draft")).toEqual({
      sport: "baseball", year: 2025, fromKey: "bowman-chrome", toKey: "bowman-draft",
      raw: "baseball:2025:bowman-chrome>bowman-draft",
    });
  });

  it("refuses the OLD pair grammar -- it names no destination", () => {
    expect(X.parseScopeTriple("baseball:2025:bowman-chrome")).toBeNull();
  });

  it("refuses the runner's inherited defaults and an empty scope", () => {
    for (const s of ["", "all", "refractor", "   "]) {
      expect(X.parseScopeTriple(s)).toBeNull();
    }
  });

  it("refuses a move onto itself -- a typo must not report a clean run", () => {
    expect(X.parseScopeTriple("baseball:2025:bowman-chrome>bowman-chrome")).toBeNull();
  });
});

describe("deriveCollisionNumbers -- the unsafe set is DERIVED, never typed", () => {
  it("flags a number whose two checklists name different players", () => {
    const from = new Map([["cpadj", new Set(["daweljoseph"])]]);
    const to = new Map([["cpadj", new Set(["dakotajordan"])]]);
    expect([...X.deriveCollisionNumbers(from, to)]).toEqual(["cpadj"]);
  });

  it("does NOT flag a number both checklists give to the same player", () => {
    const from = new Map([["cpagw", new Set(["gagewood"])]]);
    const to = new Map([["cpagw", new Set(["gagewood"])]]);
    expect([...X.deriveCollisionNumbers(from, to)]).toEqual([]);
  });

  it("does NOT flag a number only one side claims", () => {
    const from = new Map([["cpagw", new Set(["gagewood"])]]);
    expect([...X.deriveCollisionNumbers(from, new Map())]).toEqual([]);
    expect([...X.deriveCollisionNumbers(new Map(), from)]).toEqual([]);
  });
});

describe("planCrossProductSale -- the move", () => {
  it("moves when the DESTINATION checklist names this player and the source does not", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
      fromClaimPlayers: new Set(), toClaimPlayers: new Set(["gagewood"]),
    });
    expect(p.move).toBe(true);
    expect(p.dest).toBe(DEST);
    expect(p.reason).toBeNull();
  });

  it("does NOT move when the destination checklist never names this player", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
      fromClaimPlayers: new Set(), toClaimPlayers: new Set(),
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.TO_KEY_DOES_NOT_CLAIM);
  });

  it("does NOT move when BOTH checklists name this player -- undecidable", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
      fromClaimPlayers: new Set(["gagewood"]), toClaimPlayers: new Set(["gagewood"]),
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.BOTH_CLAIM);
  });
});

describe("THE REFUSAL -- never onto a different player's address", () => {
  it("refuses BY NAME when the destination already holds someone else", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
      destPlayerName: "Dakota Jordan",
      fromClaimPlayers: new Set(), toClaimPlayers: new Set(["gagewood"]),
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.DEST_DIFFERENT_PLAYER);
    // BOTH names travel into the report -- a refusal nobody can read is a
    // refusal nobody can act on.
    expect(p.evidence.player).toBe("Gage Wood");
    expect(p.evidence.destPlayer).toBe("Dakota Jordan");
  });

  it("is asked LAST: no other verdict can override it", () => {
    // Everything else about this row is perfect -- checklist-backed, on the
    // right key, clean axis. The guard still refuses.
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
      destPlayerName: "Someone Else",
      fromClaimPlayers: new Set(), toClaimPlayers: new Set(["gagewood"]),
      isCollisionNumber: false, isProtected: false,
    });
    expect(p.reason).toBe(X.SKIP.DEST_DIFFERENT_PLAYER);
  });

  it("allows the move when the destination holds the SAME player", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
      destPlayerName: "gage  WOOD",
      fromClaimPlayers: new Set(), toClaimPlayers: new Set(["gagewood"]),
    });
    expect(p.move).toBe(true);
  });
});

describe("THE PARK -- a collision number with no readable player", () => {
  it("parks rather than defaulting to either side", () => {
    const p = X.planCrossProductSale({
      row: sale({ playerName: null, title: "2025 Bowman Chrome CPA-DJ Auto Refractor" }),
      fromKey: FROM, toKey: TO, destSlug: DEST,
      fromClaimPlayers: new Set(["daweljoseph"]), toClaimPlayers: new Set(["dakotajordan"]),
      isCollisionNumber: true,
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.PARK_COLLISION);
    expect(p.evidence.parks).toBe(true);
  });

  it("the title's product words CANNOT rescue it -- a CPA card is chrome stock in both", () => {
    const p = X.planCrossProductSale({
      row: sale({ playerName: "", title: "2025 Bowman DRAFT Chrome CPA-DJ Auto" }),
      fromKey: FROM, toKey: TO, destSlug: DEST,
      fromClaimPlayers: new Set(["daweljoseph"]), toClaimPlayers: new Set(["dakotajordan"]),
      isCollisionNumber: true,
    });
    expect(p.reason).toBe(X.SKIP.PARK_COLLISION);
  });

  it("a NON-collision number with no player is a plain skip, not a park", () => {
    const p = X.planCrossProductSale({
      row: sale({ playerName: null }), fromKey: FROM, toKey: TO, destSlug: DEST,
      toClaimPlayers: new Set(["gagewood"]), isCollisionNumber: false,
    });
    expect(p.reason).toBe(X.SKIP.ROW_HAS_NO_PLAYER);
  });
});

describe("the other named refusals", () => {
  it("a protected row is report-only forever", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
      toClaimPlayers: new Set(["gagewood"]), isProtected: true,
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.PROTECTED);
  });

  it("a row not on the from-key is left alone", () => {
    const p = X.planCrossProductSale({
      row: sale({ hobbyiqCardId: "hiq:baseball:2025:topps-chrome:cpa-gw:base:auto" }),
      fromKey: FROM, toKey: TO, destSlug: DEST, toClaimPlayers: new Set(["gagewood"]),
    });
    expect(p.reason).toBe(X.SKIP.NOT_ON_FROM_KEY);
  });

  it("refuses a re-slug that moves more than the product segment", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO,
      // parallel changed too -- not this repair
      destSlug: "hiq:baseball:2025:bowman-draft:cpa-gw:gold-refractor:auto",
      toClaimPlayers: new Set(["gagewood"]),
    });
    expect(p.move).toBe(false);
    expect(String(p.reason)).toContain(X.SKIP.AXIS);
  });

  it("never moves without a destination slug", () => {
    const p = X.planCrossProductSale({
      row: sale(), fromKey: FROM, toKey: TO, destSlug: null,
      toClaimPlayers: new Set(["gagewood"]),
    });
    expect(p.reason).toBe(X.SKIP.REMINT_FAILED);
  });

  it("every non-move names a reason -- there is no silent skip", () => {
    const cases = [
      { isProtected: true },
      { row: sale({ playerName: null }) },
      { toClaimPlayers: new Set() },
      { destSlug: null, toClaimPlayers: new Set(["gagewood"]) },
      { destPlayerName: "Other Guy", toClaimPlayers: new Set(["gagewood"]) },
    ];
    for (const c of cases) {
      const p = X.planCrossProductSale({
        row: sale(), fromKey: FROM, toKey: TO, destSlug: DEST,
        toClaimPlayers: new Set(["gagewood"]), ...c,
      });
      if (!p.move) expect(typeof p.reason).toBe("string");
    }
  });
});

describe("planCrossProductCatalogRow -- the ten ingest-auto-seed rows", () => {
  const catRow = (over: Record<string, unknown> = {}) => ({
    id: "hiq:baseball:2025:bowman-chrome:cpa-rq:purple:auto:num-250",
    setKey: "bowman-chrome",
    setName: "2025 Bowman Draft Chrome Baseball",
    playerName: "Riley Quick",
    cardNumber: "CPA-RQ",
    source: "ingest-auto-seed",
    ...over,
  });
  const catDest = "hiq:baseball:2025:bowman-draft:cpa-rq:purple:auto:num-250";

  it("moves a row whose OWN setName says Draft", () => {
    const p = X.planCrossProductCatalogRow({
      row: catRow(), fromKey: FROM, toKey: TO, destSlug: catDest,
    });
    expect(p.move).toBe(true);
    expect(p.dest).toBe(catDest);
  });

  it("leaves a row whose words do NOT name the destination product", () => {
    const p = X.planCrossProductCatalogRow({
      row: catRow({ setName: "2025 Bowman Chrome Baseball" }),
      fromKey: FROM, toKey: TO, destSlug: catDest,
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.TO_KEY_DOES_NOT_CLAIM);
  });

  it("refuses a catalog move onto a different player's address, by name", () => {
    const p = X.planCrossProductCatalogRow({
      row: catRow(), fromKey: FROM, toKey: TO, destSlug: catDest,
      destPlayerName: "Dakota Jordan",
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.DEST_DIFFERENT_PLAYER);
    expect(p.evidence.destPlayer).toBe("Dakota Jordan");
  });

  it("a user-verified row is report-only forever", () => {
    const p = X.planCrossProductCatalogRow({
      row: catRow(), fromKey: FROM, toKey: TO, destSlug: catDest, isProtected: true,
    });
    expect(p.reason).toBe(X.SKIP.PROTECTED);
  });
});

describe("ONE definition of identity -- this lane cannot drift from the others", () => {
  it("re-exports playerKey and foldNumber from bowman-product-refile", () => {
    const B = require_("../scripts/lib/bowman-product-refile.cjs");
    expect(X.playerKey).toBe(B.playerKey);
    expect(X.foldNumber).toBe(B.foldNumber);
  });
});

/**
 * CF-THE-STORED-PLAYERNAME-IS-NOT-THE-EVIDENCE (#1849, Drew 2026-09-06).
 *
 * The 2025 CPA-DT pool is the case that found this. CPA-DT names FOUR cards in
 * 2025 -- Diego Tornes (bowman-chrome), Devin Taylor (bowman-draft), Drew
 * Thorpe (topps-chrome-platinum) and Dallas Turner (football topps-chrome) --
 * and Devin Taylor sales sat in Diego Tornes' chrome pool.
 *
 * `planCrossProductSale` asked ONE question of identity: playerKey(playerName)
 * against the checklist claim, folded EXACTLY. Measured over all 1,044 CPA-DT
 * rows of 2025, 12 carry a dirty playerName ("Draft Devin Taylor", "Devin
 * Taylor Oakland", "Devin Taylor On Caes", "Devin Taylor Au") and one is
 * flatly wrong ("Diego Tornes" on a title reading "Devin Taylor 2025 Bowman
 * Chrome Draft 1st Auto Oakland Athletics"). Those were exactly the rows the
 * lane skipped as to-key-checklist-does-not-name-this-player.
 *
 * So the row's OWN WORDS may corroborate a checklist claim when the exact fold
 * cannot -- under guards that keep it corroboration and never a guess.
 */
describe("CF-THE-STORED-PLAYERNAME-IS-NOT-THE-EVIDENCE", () => {
  const NAMES_FROM = new Set(["Diego Tornes"]);
  const NAMES_TO = new Set(["Devin Taylor"]);
  const CLAIM_FROM = new Set([X.playerKey("Diego Tornes")]);
  const CLAIM_TO = new Set([X.playerKey("Devin Taylor")]);
  const dtDest = "hiq:baseball:2025:bowman-draft:cpa-dt:base:auto";
  const dtSale = (over: Record<string, unknown> = {}) => sale({
    id: "cpa-dt-1",
    hobbyiqCardId: "hiq:baseball:2025:bowman-chrome:cpa-dt:base:auto",
    cardId: "hiq:baseball:2025:bowman-chrome:cpa-dt:base:auto",
    cardNumber: "CPA-DT",
    ...over,
  });
  const plan = (over: Record<string, unknown> = {}) => X.planCrossProductSale({
    row: dtSale(over), fromKey: FROM, toKey: TO, destSlug: dtDest,
    destPlayerName: "Devin Taylor",
    fromClaimPlayers: CLAIM_FROM, toClaimPlayers: CLAIM_TO,
    fromClaimNames: NAMES_FROM, toClaimNames: NAMES_TO,
    isCollisionNumber: true,
  });

  it("a name glued to a product word still reaches the checklist that claims it", () => {
    const p = plan({
      playerName: "Draft Devin Taylor",
      title: "2025 Bowman Draft Devin Taylor Chrome Auto 1st Prospect #CPA-DT Athletics",
    });
    expect(p.move).toBe(true);
    expect(p.dest).toBe(dtDest);
    expect(p.evidence.playerResolvedFromWords).toBe(true);
    expect(p.evidence.playerAsStored).toBe("Draft Devin Taylor");
  });

  it("a name glued to a team, and an OCR-mangled one, both resolve", () => {
    for (const n of ["Devin Taylor Oakland", "Devin Taylor On Caes", "Devin Taylor Au"]) {
      expect(plan({ playerName: n }).move).toBe(true);
    }
  });

  it("the TITLE carries the identity when the stored name is the WRONG player", () => {
    // The row that proves the field is not the evidence: playerName says the
    // other product's player, the title says who it actually is.
    const p = X.planCrossProductSale({
      row: dtSale({
        playerName: "Diego Tornes",
        title: "Devin Taylor 2025 Bowman Chrome Draft 1st Auto Oakland Athletics A's #CPA-DT",
      }),
      fromKey: FROM, toKey: TO, destSlug: dtDest, destPlayerName: "Devin Taylor",
      fromClaimPlayers: CLAIM_FROM, toClaimPlayers: CLAIM_TO,
      fromClaimNames: NAMES_FROM, toClaimNames: NAMES_TO,
      isCollisionNumber: true,
    });
    // The EXACT fold still wins first: "Diego Tornes" IS a from-key claim, so
    // the row reads as a Tornes sale and is left alone. Words never override a
    // name the checklist actually recognises -- that row needs a human, and it
    // is carried in the committed relocation list instead.
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.TO_KEY_DOES_NOT_CLAIM);
  });

  it("a clean name is decided by the exact fold, never by the words", () => {
    const p = plan({ playerName: "Devin Taylor" });
    expect(p.move).toBe(true);
    expect(p.evidence.playerResolvedFromWords).toBeUndefined();
  });

  it("the from-key's own player is never dragged across by his title", () => {
    const p = plan({
      playerName: "Tornes True",
      title: "2025 Bowman Chrome Diego Tornes 1st Auto #CPA-DT True Refractor",
    });
    expect(p.move).toBe(false);
  });

  it("a row naming BOTH products' players is refused, never moved", () => {
    const p = plan({
      playerName: "",
      title: "Devin Taylor Diego Tornes 2025 dual auto lot #CPA-DT",
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.WORDS_NAME_TWO_PLAYERS);
  });

  it("with no claim names passed, the plan behaves exactly as before", () => {
    const p = X.planCrossProductSale({
      row: dtSale({ playerName: "Draft Devin Taylor" }),
      fromKey: FROM, toKey: TO, destSlug: dtDest, destPlayerName: "Devin Taylor",
      fromClaimPlayers: CLAIM_FROM, toClaimPlayers: CLAIM_TO,
      isCollisionNumber: true,
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.TO_KEY_DOES_NOT_CLAIM);
  });

  it("a collision row with NO readable player anywhere still PARKS", () => {
    const p = plan({ playerName: "", title: "2025 Bowman Chrome #CPA-DT auto" });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(X.SKIP.PARK_COLLISION);
  });
});

describe("nameAppearsInWords -- corroboration, never a substring guess", () => {
  it("matches a consecutive whole-word run", () => {
    expect(X.nameAppearsInWords("Devin Taylor", "Draft Devin Taylor")).toBe(true);
    expect(X.nameAppearsInWords("Devin Taylor", "Devin Taylor Oakland")).toBe(true);
  });

  it("never matches inside a longer word -- Taylor is not Taylorson", () => {
    expect(X.nameAppearsInWords("Devin Taylor", "Devin Taylorson hit a homer")).toBe(false);
  });

  it("requires the words in order, and at least two of them", () => {
    expect(X.nameAppearsInWords("Devin Taylor", "Taylor Devin")).toBe(false);
    expect(X.nameAppearsInWords("Taylor", "Devin Taylor")).toBe(false);
  });
});
