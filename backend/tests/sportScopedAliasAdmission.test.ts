/**
 * CF-SOCCER-PRIZM-IS-PRIZM-FIFA -- the reslug lane's SPORT-SCOPED admission.
 *
 * The lane's four standing gates cannot reach this move, and each refusal is
 * CORRECT on its own terms:
 *
 *   gate 2  `panini-prizm` is a normalizeSetKey FIXED POINT, because it is the
 *           right key for football and basketball Prizm. "A key the deriver
 *           leaves alone is a key the vocabulary considers a PRODUCT."
 *   RULED   it must NOT be declared in RULED_ALIASES: a flat alias has no
 *           sport axis and would move every NFL and NBA Prizm sale.
 *
 * So the admission carries the scope itself, and pays for that with a STRICTER
 * gate than any other rule in the file: the run must be filtered to exactly
 * the ruled sport and to years inside the ruling, or it REFUSES.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lane = require("../scripts/reslug-ruled-alias.cjs");
const { admitAlias, sportScopedAdmission, SPORT_SCOPED_ADMISSIONS, planAliasReslug } = lane;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeSetKey } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { titleNamesOtherCompetition } = require("../dist/services/catalog/productSetKeys.js");

const SCOPE = "panini-prizm-fifa";
const FROM = "panini-prizm";
const ruledSet = new Set<string>();
const admit = (o: Record<string, unknown> = {}) =>
  admitAlias({ alias: FROM, scope: SCOPE, ruledSet, normalizeSetKey, sports: ["soccer"], years: [2025], ...o });

describe("1. the premise: the standing gates cannot reach this move", () => {
  it("panini-prizm IS a deriver fixed point -- which is why gate 2 would refuse it", () => {
    expect(normalizeSetKey(FROM)).toBe(FROM);
  });

  it("with NO sport-scoped entry, a fixed-point alias is refused by gate 2", () => {
    const v = admitAlias({ alias: "panini-select", scope: "select", ruledSet, normalizeSetKey, sports: ["football"], years: [2025] });
    expect(v.admit).toBe(false);
  });
});

describe("2. the sport-scoped admission, correctly scoped", () => {
  it("admits panini-prizm -> panini-prizm-fifa for sports=soccer years=2025", () => {
    const v = admit();
    expect(v.admit).toBe(true);
    expect(v.rule).toBe("SPORT_SCOPED");
  });

  it("the declaration carries its sport, its years and its evidence", () => {
    const e = SPORT_SCOPED_ADMISSIONS.find((x: { from: string; to: string }) => x.from === FROM && x.to === SCOPE);
    expect(e).toBeTruthy();
    expect(e.sport).toBe("soccer");
    expect(e.years).toEqual([2025]);
    expect(String(e.why)).toMatch(/30,773|FIFA/);
  });
});

describe("3. THE REFUSALS -- an unscoped run never widens", () => {
  /** MUTATION: let sportScopedAdmission admit on an empty `sports` filter and
   *  every case here goes red -- which is the FB/BK wreck Drew forbade. */
  it("an UNFILTERED run refuses: no sports filter", () => {
    const v = admit({ sports: [] });
    expect(v.admit).toBe(false);
    expect(v.why).toMatch(/SPORT-SCOPED/);
  });

  it("the WRONG sport refuses -- football and basketball can never be swept", () => {
    for (const sport of ["football", "basketball", "baseball", "hockey"]) {
      const v = admit({ sports: [sport] });
      expect(v.admit, `${sport} must refuse`).toBe(false);
    }
  });

  it("a run naming soccer AND another sport refuses -- that is not the ruled population", () => {
    expect(admit({ sports: ["soccer", "football"] }).admit).toBe(false);
  });

  it("a missing or out-of-ruling YEAR refuses", () => {
    expect(admit({ years: [] }).admit).toBe(false);
    expect(admit({ years: [2024] }).admit).toBe(false);
    expect(admit({ years: [2025, 2026] }).admit).toBe(false);
  });

  it("the rule fires ONLY for its declared pair -- not for a lookalike scope", () => {
    expect(sportScopedAdmission({ alias: FROM, scope: "panini-prizm-wnba", sports: ["soccer"], years: [2025] })).toBeNull();
    expect(sportScopedAdmission({ alias: "panini-select", scope: SCOPE, sports: ["soccer"], years: [2025] })).toBeNull();
  });
});

describe("4. the per-row title test -- absent beats wrong", () => {
  const slug = "hiq:soccer:2025:panini-prizm:186:base:no-auto";
  const aliasMap = new Map([[FROM, SCOPE]]);
  const plan = (title: string) =>
    planAliasReslug({ cardId: slug, hobbyiqCardId: slug, aliasMap, title, titleParks: titleNamesOtherCompetition });

  it("a FIFA title moves", () => {
    const p = plan("2025-26 Panini Prizm FIFA Francisco Moura RC Snakeskin Prizm #264");
    expect(p.move).toBe(true);
    expect(p.target).toBe("hiq:soccer:2025:panini-prizm-fifa:186:base:no-auto");
  });

  it("a SILENT title moves -- Drew ruled the bare case in", () => {
    expect(plan("2025-26 Panini Prizm Soccer MIKE MAIGNAN /149 Red Prizm AC Milan #22").move).toBe(true);
  });

  it("ANOTHER competition's product PARKS, and is reported by name", () => {
    const p = plan("2025-26 Topps UEFA Club Competitions - Quim Junyent #93 Purple Prizm /75");
    expect(p.move).toBe(false);
    expect(p.parked).toBe(true);
    expect(p.title).toMatch(/UEFA/);
  });

  /** The measured trap, at the LANE level: a FIFA card whose title names the
   *  player's club competition must still move. MUTATION: make the predicate
   *  match a bare competition word and this row parks -- losing a real sale. */
  it("a FIFA card whose title mentions the player's league still MOVES", () => {
    expect(plan("Panini Prizm FIFA 2025-26 Jude Bellingham #186 Real Madrid La Liga Prizm").move).toBe(true);
  });

  it("with NO title predicate the plan is unchanged -- other scopes are untouched", () => {
    const p = planAliasReslug({ cardId: slug, hobbyiqCardId: slug, aliasMap, title: "2025 Topps UEFA", titleParks: null });
    expect(p.move).toBe(true);
  });
});
