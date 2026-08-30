import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cardNumberPrefixOf,
  cleanParallelSlug,
  decideChecklistNumberedFold,
  identityKeyOf,
  isAutoByCardNumber,
  pickChecklistNumberedTarget,
  printRunOf,
  shardOfIdentity,
  type IdentityRow,
} from "../src/services/catalog/foldTwinRuleChecklistNumbered.js";
import { catalogAuthorityOf } from "../src/services/catalog/catalogAuthority.service.js";
import { isGradedChildOf } from "../src/services/catalog/catalogRowOps.service.js";

const isChecklist = (s: string | null | undefined) => catalogAuthorityOf(String(s ?? "")) === "checklist";

// ── Drew's case, pinned verbatim (2026-08-30 09:40Z) ─────────────────────────
// 2020 Bowman Chrome CPA-MH Michael Harris. 58 sales split across two rows and
// the checklist row -- the intended identity -- holds none of them.
const HARRIS_TARGET: IdentityRow = {
  id: "hiq:baseball:2020:bowman-chrome:cpa-mh:base-refractor:auto:num-499",
  source: "checklistcenter-2026-08-29",
  sport: "baseball",
  year: 2020,
  setKey: "bowman-chrome",
  cardNumber: "CPA-MH",
  parallelSlug: "base-refractor",
  isAuto: true,
  printRun: 499,
};
const HARRIS_SEED_UNNUMBERED: IdentityRow = {
  id: "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto",
  source: "ingest-auto-seed",
  sport: "baseball",
  year: 2020,
  setKey: "bowman-chrome",
  cardNumber: "CPA-MH",
  parallelSlug: "refractor",
  isAuto: true,
  printRun: null,
};
const HARRIS_SEED_NUMBERED: IdentityRow = {
  id: "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto:num-499",
  source: "ingest-auto-seed",
  sport: "baseball",
  year: 2020,
  setKey: "bowman-chrome",
  cardNumber: "CPA-MH",
  parallelSlug: "refractor",
  isAuto: true,
  printRun: 499,
};
const HARRIS_BCCP_GHOST: IdentityRow = {
  id: "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:no-auto:num-499",
  source: "bccp",
  sport: "baseball",
  year: 2020,
  setKey: "bowman-chrome",
  cardNumber: "CPA-MH",
  parallelSlug: "refractor",
  isAuto: false,
  printRun: 499,
};

const fold = (target: IdentityRow, twin: IdentityRow) =>
  decideChecklistNumberedFold({
    target,
    twin,
    targetIsChecklist: isChecklist(target.source),
    twinIsChecklist: isChecklist(twin.source),
  });

describe("R1 -- the Harris case Drew named, end to end as a pure decision", () => {
  it("BOTH ingest-auto-seed twins fold onto the checklist /499, spelled base-refractor", () => {
    const a = fold(HARRIS_TARGET, HARRIS_SEED_UNNUMBERED);
    expect(a.fold).toBe(true);
    if (a.fold) expect(a.kind).toBe("unnumbered-twin");

    const b = fold(HARRIS_TARGET, HARRIS_SEED_NUMBERED);
    expect(b.fold).toBe(true);
    // The half today's script cannot reach at all: same /499, different spelling.
    if (b.fold) expect(b.kind).toBe("respelled-same-print-run");
  });

  it("A RIVAL /N IS A DIFFERENT CARD AND MUST NOT FOLD", () => {
    // The first dry run folded `topps:259:foilfractor:num-1` onto a /36,960
    // and `mlm-cs:gold:num-2025` onto a /50. Two real print runs are two rungs
    // of the parallel ladder; collapsing them is the 3.1x bloat in reverse.
    const rival: IdentityRow = { ...HARRIS_SEED_NUMBERED, id: "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto:num-1", printRun: 1 };
    const d = fold(HARRIS_TARGET, rival);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("rival-print-run");

    const foil: IdentityRow = { id: "hiq:baseball:2020:topps:259:foilfractor:no-auto:num-1", source: "catalog-explode-actuals-2026-08-12", sport: "baseball", year: 2020, setKey: "topps", cardNumber: "259", parallelSlug: "foilfractor", isAuto: false, printRun: 1 };
    const foilTarget: IdentityRow = { ...foil, id: "hiq:baseball:2020:topps:259:foilfractor:no-auto:num-36960", source: "baseballcardpedia-ladders-2026-08-28", printRun: 36960 };
    const e = fold(foilTarget, foil);
    expect(e.fold).toBe(false);
    if (!e.fold) expect(e.skip).toBe("rival-print-run");
  });

  it("the three rows share ONE identity key despite three different id spellings", () => {
    const k = identityKeyOf(HARRIS_TARGET);
    expect(identityKeyOf(HARRIS_SEED_UNNUMBERED)).toBe(k);
    expect(identityKeyOf(HARRIS_SEED_NUMBERED)).toBe(k);
    expect(k).toBe("baseball|2020|bowman-chrome|cpa-mh|refractor|auto");
  });

  it("the checklist row is the target the group picks", () => {
    const picked = pickChecklistNumberedTarget(
      [HARRIS_SEED_UNNUMBERED, HARRIS_TARGET, HARRIS_SEED_NUMBERED],
      isChecklist,
    );
    expect("target" in picked && picked.target.id).toBe(
      "hiq:baseball:2020:bowman-chrome:cpa-mh:base-refractor:auto:num-499",
    );
  });

  it("THE GROUP EXACTLY AS PROD HOLDS IT (read 2026-08-30): 4 rows, 69 sale-minted sales, one identity", () => {
    // All four CPA-MH rows whose cleaned identity is
    // baseball|2020|bowman-chrome|cpa-mh|refractor|auto, verified read-only
    // against prod. The other 35 CPA-MH rows are OTHER parallels (gold, orange,
    // superfractor, ...) and must not be in this group -- which is why the
    // script groups by identity key and does not hand a whole card number to
    // the picker.
    const group = [HARRIS_SEED_UNNUMBERED, HARRIS_SEED_NUMBERED, HARRIS_BCCP_GHOST, HARRIS_TARGET];
    expect(new Set(group.map((r) => identityKeyOf(r))).size).toBe(1);

    const picked = pickChecklistNumberedTarget(group, isChecklist);
    expect("target" in picked).toBe(true);
    if (!("target" in picked)) return;
    // Both checklist rows in the group (checklistcenter and bccp) say /499, so
    // the target resolves without ambiguity.
    expect(printRunOf(picked.target)).toBe(499);
    expect(isChecklist(picked.target.source)).toBe(true);

    const decisions = group.map((r) => ({
      id: r.id,
      d: decideChecklistNumberedFold({
        target: picked.target,
        twin: r,
        targetIsChecklist: isChecklist(picked.target.source),
        twinIsChecklist: isChecklist(r.source),
      }),
    }));
    const folded = decisions.filter((x) => x.d.fold).map((x) => x.id).sort();
    // The two ingest-auto-seed rows -- which between them hold the 69 sales
    // prod reports, while the checklist row holds none -- both fold.
    expect(folded).toContain("hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto");
    expect(folded).toContain("hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto:num-499");
    // The bccp no-auto ghost folds too (CPA is auto by definition).
    expect(folded).toContain("hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:no-auto:num-499");
    // and the target never folds onto itself.
    expect(folded).not.toContain(picked.target.id);
  });
});

describe("R1 -- cleanParallelSlug is D28's strip, and stops after one", () => {
  it("base-refractor and base-cards-refractor are both refractor", () => {
    expect(cleanParallelSlug("base-refractor")).toBe("refractor");
    expect(cleanParallelSlug("base-cards-refractor")).toBe("refractor");
    expect(cleanParallelSlug("BASE-Refractor")).toBe("refractor");
  });

  it("base stays base -- never empty", () => {
    expect(cleanParallelSlug("base")).toBe("base");
    expect(cleanParallelSlug("base-")).toBe("base-");
    expect(cleanParallelSlug("base-cards-")).toBe("base-cards-");
  });

  it("a real rung name is NOT stripped: base-variation-refractor keeps variation", () => {
    // Stripping real rung names is the 3.1x bloat mistake in reverse.
    expect(cleanParallelSlug("base-variation-refractor")).toBe("variation-refractor");
    expect(cleanParallelSlug("variation-refractor")).toBe("variation-refractor");
    // and the strip happens ONCE -- no recursion down to "refractor".
    expect(cleanParallelSlug("base-base-refractor")).toBe("base-refractor");
  });

  it("an unrelated slug beginning with the letters 'base' is untouched", () => {
    expect(cleanParallelSlug("baseball-heroes")).toBe("baseball-heroes");
  });
});

describe("R1 -- THE MUTATION CHECK: the authority gate lives in the rule", () => {
  it("a NON-checklist numbered row as the only candidate target must SKIP, never fold", () => {
    // decideTwinFold folds onto a derived target when handed one, because its
    // gate is the caller's query. This decision must refuse on its own.
    const derivedTarget: IdentityRow = { ...HARRIS_SEED_NUMBERED, source: "ingest-auto-seed" };
    const d = fold(derivedTarget, HARRIS_SEED_UNNUMBERED);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("no-checklist-numbered");
  });

  it("even asserting targetIsChecklist=false explicitly cannot be overridden by a checklist-looking source string", () => {
    const d = decideChecklistNumberedFold({
      target: HARRIS_TARGET,
      twin: HARRIS_SEED_UNNUMBERED,
      targetIsChecklist: false,
      twinIsChecklist: false,
    });
    expect(d.fold).toBe(false);
  });

  it("pickChecklistNumberedTarget will not nominate a vendor row even when it is the only numbered one", () => {
    const picked = pickChecklistNumberedTarget([HARRIS_SEED_UNNUMBERED, HARRIS_SEED_NUMBERED], isChecklist);
    expect("skip" in picked && picked.skip).toBe("no-checklist-numbered");
  });

  it("an un-numbered checklist row is not a target either -- the /N is what makes it the identity", () => {
    const unnumberedChecklist: IdentityRow = { ...HARRIS_TARGET, id: "hiq:baseball:2020:bowman-chrome:cpa-mh:base-refractor:auto", printRun: null };
    const d = fold(unnumberedChecklist, HARRIS_SEED_UNNUMBERED);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("target-not-numbered");
  });
});

describe("R1 -- a checklist twin is NOT this decision's business, and ambiguity never guesses", () => {
  it("a checklist twin is left to cross-source", () => {
    const checklistTwin: IdentityRow = { ...HARRIS_SEED_UNNUMBERED, source: "beckett-checklist" };
    const d = fold(HARRIS_TARGET, checklistTwin);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("twin-is-checklist");
  });

  it("two checklist rows with DIFFERENT print runs in one group -> ambiguous, never a guess", () => {
    const other: IdentityRow = { ...HARRIS_TARGET, id: "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto:num-150", source: "beckett-checklist", parallelSlug: "refractor", printRun: 150 };
    const picked = pickChecklistNumberedTarget([HARRIS_TARGET, other, HARRIS_SEED_UNNUMBERED], isChecklist);
    expect("skip" in picked && picked.skip).toBe("ambiguous");
  });

  it("two checklist rows at the SAME /N are one rung in two spellings -- deterministic pick, no ambiguity", () => {
    const alt: IdentityRow = { ...HARRIS_TARGET, id: "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto:num-499", source: "beckett-checklist", parallelSlug: "refractor" };
    const a = pickChecklistNumberedTarget([HARRIS_TARGET, alt], isChecklist);
    const b = pickChecklistNumberedTarget([alt, HARRIS_TARGET], isChecklist);
    expect("target" in a && "target" in b && a.target.id).toBe("target" in b ? b.target.id : "");
  });

  it("the target is never folded onto itself", () => {
    const d = fold(HARRIS_TARGET, HARRIS_TARGET);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("twin-is-target");
  });

  it("a different card in the same product does not fold", () => {
    const otherCard: IdentityRow = { ...HARRIS_SEED_UNNUMBERED, id: "hiq:baseball:2020:bowman-chrome:cpa-xx:refractor:auto", cardNumber: "CPA-XX" };
    const d = fold(HARRIS_TARGET, otherCard);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("different-identity");
  });

  it("a different PARALLEL does not fold -- gold-refractor is not refractor", () => {
    const gold: IdentityRow = { ...HARRIS_SEED_UNNUMBERED, id: "hiq:baseball:2020:bowman-chrome:cpa-mh:gold-refractor:auto", parallelSlug: "gold-refractor" };
    const d = fold(HARRIS_TARGET, gold);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("different-identity");
  });
});

describe("R1 -- the bccp no-auto ghost folds only behind the prefix list", () => {
  it("CPA-MH no-auto folds onto the auto row: CPA is an autograph by definition", () => {
    const d = fold(HARRIS_TARGET, HARRIS_BCCP_GHOST);
    expect(d.fold).toBe(true);
    if (d.fold) expect(d.kind).toBe("no-auto-ghost");
    expect(isAutoByCardNumber("CPA-MH")).toBe(true);
    expect(cardNumberPrefixOf("CPA-MH")).toBe("CPA");
  });

  it("a NON-auto-prefix cardNumber with auto and no-auto rows must NOT be merged", () => {
    // The isAuto boundary is the cardNumber, not the text: BCP-109 is a base
    // prospect, and its auto/no-auto rows are two different cards.
    const target: IdentityRow = { id: "hiq:baseball:2020:bowman-chrome:bcp-109:refractor:auto:num-499", source: "checklistcenter-2026-08-29", sport: "baseball", year: 2020, setKey: "bowman-chrome", cardNumber: "BCP-109", parallelSlug: "refractor", isAuto: true, printRun: 499 };
    const noAuto: IdentityRow = { ...target, id: "hiq:baseball:2020:bowman-chrome:bcp-109:refractor:no-auto", source: "bccp", isAuto: false, printRun: null };
    const d = fold(target, noAuto);
    expect(d.fold).toBe(false);
    expect(isAutoByCardNumber("BCP-109")).toBe(false);

    // A vendor-source no-auto row on the same non-auto-prefix number is refused
    // on IDENTITY -- the auto boundary is the cardNumber, so auto and no-auto
    // BCP-109 are two different cards and no source's opinion merges them.
    const vendorNoAuto: IdentityRow = { ...noAuto, source: "ingest-auto-seed" };
    const v = fold(target, vendorNoAuto);
    expect(v.fold).toBe(false);
    if (!v.fold) expect(v.skip).toBe("different-identity");
  });

  it("THE PREFIX LIST IS THE WHOLE BOUNDARY: identityKeyOf merges auto/no-auto only for auto-by-definition numbers", () => {
    // The `ghost` predicate and identityKeyOf share one gate --
    // isAutoByCardNumber -- so this pins the gate at its source. A CPA no-auto
    // row keys as AUTO (it is the same card as its auto twin); a BCP no-auto
    // row keys as NO-AUTO (auto and no-auto BCP-109 are two different cards,
    // and no source's opinion merges them).
    const cpaNoAuto: IdentityRow = { id: "a", sport: "baseball", year: 2020, setKey: "bowman-chrome", cardNumber: "CPA-MH", parallelSlug: "refractor", isAuto: false };
    const cpaAuto: IdentityRow = { ...cpaNoAuto, id: "b", isAuto: true };
    expect(identityKeyOf(cpaNoAuto)).toBe(identityKeyOf(cpaAuto));
    expect(identityKeyOf(cpaNoAuto).endsWith("|auto")).toBe(true);

    const bcpNoAuto: IdentityRow = { ...cpaNoAuto, cardNumber: "BCP-109" };
    const bcpAuto: IdentityRow = { ...bcpNoAuto, id: "d", isAuto: true };
    expect(identityKeyOf(bcpNoAuto)).not.toBe(identityKeyOf(bcpAuto));
    expect(identityKeyOf(bcpNoAuto).endsWith("|no-auto")).toBe(true);

    // and every prefix on the list behaves like CPA, none beyond it does.
    for (const p of ["CPA", "BCPA", "CDA", "BDCA", "PA"]) expect(isAutoByCardNumber(`${p}-XX`)).toBe(true);
    for (const p of ["BCP", "BD", "TC", "RA"]) expect(isAutoByCardNumber(`${p}-XX`)).toBe(false);
  });

  it("a checklist twin that is NOT a no-auto ghost is still refused -- the exemption is narrow", () => {
    // bccp classifies as checklist authority, so the ghost exemption must not
    // become a general "bccp folds" rule.
    const bccpUnnumbered: IdentityRow = { ...HARRIS_SEED_UNNUMBERED, source: "bccp", isAuto: true };
    const d = fold(HARRIS_TARGET, bccpUnnumbered);
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("twin-is-checklist");
  });

  it("the prefix list is injectable and gates the merge -- drop CPA and the ghost stops folding", () => {
    const d = decideChecklistNumberedFold({
      target: HARRIS_TARGET,
      twin: HARRIS_BCCP_GHOST,
      targetIsChecklist: true,
      twinIsChecklist: false,
      forceAutoPrefixes: ["BCPA"],
    });
    expect(d.fold).toBe(false);
    if (!d.fold) expect(d.skip).toBe("different-identity");
  });
});

describe("R1 -- identityKeyOf reads the setKey FIELD, not the id segment", () => {
  it("the D23 mid-flight state: id says topps, the field says topps-triple-threads, the field wins", () => {
    const row: IdentityRow = { id: "hiq:baseball:2020:topps:sjr-am:sapphire:no-auto:num-25", source: "bccp", sport: "baseball", year: 2020, setKey: "topps-triple-threads", cardNumber: "SJR-AM", parallelSlug: "sapphire", isAuto: false, printRun: 25 };
    expect(identityKeyOf(row)).toBe("baseball|2020|topps-triple-threads|sjr-am|sapphire|no-auto");
    expect(identityKeyOf(row).includes("|topps|")).toBe(false);
  });

  it("a row whose id has been renamed but whose field has not is keyed by the field either way", () => {
    const renamedId: IdentityRow = { id: "hiq:baseball:2020:topps-triple-threads:sjr-am:sapphire:no-auto:num-25", source: "bccp", sport: "baseball", year: 2020, setKey: "topps-triple-threads", cardNumber: "SJR-AM", parallelSlug: "sapphire", isAuto: false, printRun: 25 };
    const oldId: IdentityRow = { ...renamedId, id: "hiq:baseball:2020:topps:sjr-am:sapphire:no-auto:num-25" };
    expect(identityKeyOf(renamedId)).toBe(identityKeyOf(oldId));
  });
});

describe("R1 -- printRunOf reads the field or the id", () => {
  it("field first, id as the fallback, null when neither says", () => {
    expect(printRunOf({ id: "x", printRun: 499 })).toBe(499);
    expect(printRunOf({ id: "hiq:a:b:c:d:e:auto:num-150" })).toBe(150);
    expect(printRunOf({ id: "hiq:a:b:c:d:e:auto" })).toBe(null);
    expect(printRunOf({ id: "hiq:a:b:c:d:e:auto:num-50:psa-10" })).toBe(null);
    expect(printRunOf({ id: "x", printRun: 0 })).toBe(null);
  });
});

describe("R1 -- the shard axis puts a whole identity group on ONE slot", () => {
  const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

  it("every row of one identity lands on the same slot, so two workers cannot race one target", () => {
    const rows = [HARRIS_TARGET, HARRIS_SEED_UNNUMBERED, HARRIS_SEED_NUMBERED, HARRIS_BCCP_GHOST];
    for (const slots of [2, 4, 8, 16]) {
      const slotsHit = new Set(rows.map((r) => shardOfIdentity(identityKeyOf(r), slots, sha1)));
      expect(slotsHit.size).toBe(1);
    }
  });

  it("the axis reaches every slot and is roughly balanced -- not the setKey-range mistake", () => {
    const keys: string[] = [];
    for (let i = 0; i < 4000; i++) {
      keys.push(identityKeyOf({ id: `x${i}`, sport: "baseball", year: 2020 + (i % 7), setKey: "bowman-chrome", cardNumber: `CPA-${i}`, parallelSlug: "refractor", isAuto: true }));
    }
    const counts = new Array(8).fill(0);
    for (const k of keys) counts[shardOfIdentity(k, 8, sha1)]++;
    expect(counts.every((c) => c > 0)).toBe(true);
    // No slot carries anywhere near the 89% one setKey-range worker did.
    expect(Math.max(...counts) / keys.length).toBeLessThan(0.2);
  });

  it("SLOTS=1 is slot 0 for everything", () => {
    expect(shardOfIdentity("anything", 1, sha1)).toBe(0);
  });
});

describe("R1 -- retiring a NUMBERED twin sweeps its own ladder and no sibling's", () => {
  // R1 is the first mode to fold a numbered twin, so this guard needs a pin.
  const twin = "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto:num-499";

  it("the numbered twin's own graded children ARE its children", () => {
    expect(isGradedChildOf({ id: `${twin}:psa-10` }, twin)).toBe(true);
    expect(isGradedChildOf({ id: `${twin}:bgs-9-5` }, twin)).toBe(true);
  });

  it("a sibling at a different /N and ITS children are NOT swept", () => {
    const sibling = "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto:num-50";
    expect(isGradedChildOf({ id: sibling }, twin)).toBe(false);
    expect(isGradedChildOf({ id: `${sibling}:psa-10` }, twin)).toBe(false);
  });

  it("the un-numbered parent's sweep still refuses the numbered sibling's ladder", () => {
    const unnumbered = "hiq:baseball:2020:bowman-chrome:cpa-mh:refractor:auto";
    expect(isGradedChildOf({ id: `${unnumbered}:psa-10` }, unnumbered)).toBe(true);
    expect(isGradedChildOf({ id: `${unnumbered}:num-499` }, unnumbered)).toBe(false);
    expect(isGradedChildOf({ id: `${unnumbered}:num-499:psa-10` }, unnumbered)).toBe(false);
  });

  it("parentSlug settles it when present", () => {
    expect(isGradedChildOf({ id: `${twin}:psa-10`, parentSlug: twin }, twin)).toBe(true);
    expect(isGradedChildOf({ id: `${twin}:psa-10`, parentSlug: "hiq:something:else" }, twin)).toBe(false);
  });
});
