/**
 * BASE-EVICTION -- the one CONFLICT subclass that may write.
 *
 * CF-A-SLUG-IS-NOT-EVIDENCE-AGAINST-THE-ROW (Drew 2026-09-02). CONFLICT stays
 * report-only as a class. One shape inside it is not two rival readings of a
 * card at all: a row FILED on a parallel slug that nothing about the row
 * itself supports -- its own parallel field says Base/blank, its title names
 * no finish, and a checklist-backed base destination exists. Three
 * independent fields agree the row names no parallel; only the slug disagrees,
 * and a slug is an artifact of whichever writer keyed the row.
 *
 * The subclass is one field away from a shape that must NEVER write, so the
 * refusals are most of this file. What it pins:
 *
 *   1. the Gonzalez eviction shape tags AND writes                (the ruling)
 *   2. a title naming ANY finish token is not tagged     (the seller's word)
 *   3. a stored parallel field naming a real finish is not tagged
 *                                          (this is the Gonzalez DEMOTION)
 *   4. a PROTECTED source is never written           (mutation-checked below)
 *   5. no checklist-backed destination -> not tagged  (nowhere to evict to)
 *
 * Pin 3 is the load-bearing one. rematchClassifier.test.ts already pins that a
 * terse title must not flatten a stored `Refractor` field, and this file must
 * not weaken it: the two shapes differ ONLY in that field, and that is exactly
 * what makes one a demotion and the other a mis-filing.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

type Identity = {
  sport?: string | null; cardYear?: number | null; setKey?: string | null;
  cardNumber?: string | null; parallel?: string | null; isAuto?: boolean | null;
  printRun?: number | null; gradeCompany?: string | null; gradeValue?: number | null;
};
type Result = {
  klass: string; subclass?: string; tier: string; writable: boolean; reasons: string[];
  evidence?: {
    storedSlugParallel: string | null; titleQuoted: string;
    storedParallelField: string | null; baseDestSlug: string | null;
    baseDestChecklistBacked: boolean;
  };
  axes: { same: string[]; filled: string[]; dropped: string[]; changed: string[] };
};
type ClassifyInput = {
  row: Record<string, unknown>; stored: Identity; derived: Identity | null;
  checklistBacked?: boolean; derivationReasons?: string[];
  storedSlug?: string | null; baseDestSlug?: string | null; baseDestBacked?: boolean;
};
type Classifier = {
  AGREE: string; IMPROVE: string; CONFLICT: string; UNDERIVABLE: string;
  PROTECTED: string; AUTO: string; BASE_EVICTION: string;
  FINISH_TOKENS: string[]; FINISH_COLOR_TOKENS: string[]; FINISH_PHRASES: string[];
  titleNamesFinish: (t: string) => boolean;
  slugParallelSegment: (s: string) => string | null;
  slugNamesParallel: (s: string) => boolean;
  classifyRow: (i: ClassifyInput) => Result;
};
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs")) as Classifier;

// ── the Gonzalez EVICTION shape ────────────────────────────────────────────
// A real row: title "2026 Bowman Justin Gonzalez 1st Bowman Auto CPA-JG",
// stored parallel field "Base", sitting on the refractor/-499 slug. The title
// says "Auto" -- which is not a finish -- and says nothing else about how the
// card is printed. The card's base auto IS on the checklist.
const EVICT_SLUG = "hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499";
const BASE_DEST = "hiq:baseball:2026:bowman:cpa-jg:base:auto";
const GONZALEZ_TITLE = "2026 Bowman Justin Gonzalez 1st Bowman Auto CPA-JG";

const evictRow = (over: Record<string, unknown> = {}) => ({
  id: "sc-gonz-1", cardId: EVICT_SLUG, source: "cardhedge",
  title: GONZALEZ_TITLE, ...over,
});

/** What the row's own fields say: a base auto. The print run is the SLUG's,
 *  not the field's -- that asymmetry is the defect. */
const evictStored: Identity = {
  sport: "baseball", cardYear: 2026, setKey: "bowman", cardNumber: "CPA-JG",
  parallel: "Base", isAuto: true, printRun: null,
};
/** What today's parser reads off that title: the same base auto. */
const evictDerived: Identity = { ...evictStored };

/** The full evidence bundle a qualifying row is classified with. */
const evictInput = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  row: evictRow(), stored: evictStored, derived: evictDerived,
  checklistBacked: true, storedSlug: EVICT_SLUG,
  baseDestSlug: BASE_DEST, baseDestBacked: true, ...over,
});

describe("PIN 1 -- the Gonzalez shape tags BASE-EVICTION and is writable", () => {
  it("tags the subclass, keeps the class CONFLICT, and is writable on an AUTO row", () => {
    const r = K.classifyRow(evictInput());
    // The CLASS does not change. BASE-EVICTION is a narrowing of CONFLICT, not
    // a fifth class -- every existing count and refusal keeps its meaning.
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.tier).toBe(K.AUTO);
    expect(r.writable).toBe(true);
    expect(r.reasons).toContain("subclass:BASE-EVICTION");
  });

  it("quotes all three evidence fields, so the write is auditable from the row alone", () => {
    const r = K.classifyRow(evictInput());
    // 1. what the slug claimed
    expect(r.evidence?.storedSlugParallel).toBe("refractor");
    // 2. what the row's own field said
    expect(r.evidence?.storedParallelField).toBe("Base");
    // 3. the title, quoted verbatim -- not a verdict about it
    expect(r.evidence?.titleQuoted).toBe(GONZALEZ_TITLE);
    // and where it goes, with the backing that let it go there
    expect(r.evidence?.baseDestSlug).toBe(BASE_DEST);
    expect(r.evidence?.baseDestChecklistBacked).toBe(true);
  });

  it("'Auto' in the title is not a finish -- an auto flag is not a parallel", () => {
    // The whole shape depends on this: 1st Bowman Autos are the CPA-* card
    // family, and every one of their titles says "Auto". If "auto" were read
    // as a finish word the subclass would never fire on the shape it was
    // authorized for.
    expect(K.titleNamesFinish(GONZALEZ_TITLE)).toBe(false);
  });
});

describe("PIN 2 -- a title naming ANY finish token is NOT tagged", () => {
  // The seller's own word wins. If the title says how the card is printed,
  // the row is not a mis-filing and the fleet does not touch it.
  it.each([
    ["Refractor", "2026 Bowman Justin Gonzalez 1st Bowman Auto Refractor CPA-JG"],
    ["plural Refractors", "2026 Bowman Gonzalez Auto Refractors CPA-JG"],
    ["Gold (a colour alone names a parallel)", "2026 Bowman Justin Gonzalez Gold Auto CPA-JG"],
    ["Shimmer", "2026 Bowman Gonzalez Shimmer Auto CPA-JG"],
    ["X-Fractor", "2005 Bowman Chrome Verlander X-Fractor BDP129"],
    ["Prizm", "2024 Panini Prizm Wembanyama Prizm 1"],
    ["Cracked Ice (a two-word phrase)", "2024 Panini Select Cracked Ice 44"],
    ["Cracked-Ice hyphenated", "2024 Panini Select Cracked-Ice 44"],
    ["Sapphire", "2026 Bowman Sapphire Gonzalez CPA-JG"],
  ])("%s in the title -> no subclass, not writable", (_label, title) => {
    // The title alone decides this, so it is asserted on the vocabulary
    // directly as well as through the classifier -- the row is left where it
    // is, whatever class the eight axes then report it as.
    expect(K.titleNamesFinish(title)).toBe(true);
    const r = K.classifyRow(evictInput({ row: evictRow({ title }) }));
    expect(r.subclass).toBeUndefined();
    expect(r.writable).toBe(false);
  });

  // ── two shapes the LIVE POOL taught us, 2026-09-02 ───────────────────────
  // The corpus probe surfaced six qualifying rows; THREE of them would have
  // been written wrongly by the first version of this vocabulary. Both defects
  // are pinned here because they came from real rows, not from imagination.

  it("a SERIAL NUMBER in the title is a parallel named in digits", () => {
    // A base card is not serial-numbered. A title stating a print run is
    // telling us the card is from a limited parallel whose NAME the seller
    // omitted -- exactly the residual risk the ruling names.
    for (const t of [
      "2024 Bowman Sterling Prospect Autographs Cole Young #PA-CY /50",
      "2025 Bowman Draft Kade Anderson #Pp-15 Prized Pros. /250 Oakland",
      "2025 PANINI DONRUSS #140 JARLIN SUSANA 59/149 PSA 1",
    ]) {
      expect(K.titleNamesFinish(t)).toBe(true);
    }
    const r = K.classifyRow(evictInput({
      row: evictRow({ title: "2026 Bowman Justin Gonzalez Auto CPA-JG /499" }),
    }));
    expect(r.subclass).toBeUndefined();
    expect(r.writable).toBe(false);
  });

  it("the serial-number test does not fire on a grade, a card number or a date", () => {
    // The slash must be a real boundary or "PSA 10" and "#140" start reading
    // as print runs and the subclass switches itself off.
    for (const t of [
      "2024 Topps #131 Aaron Judge PSA 10",
      "2024 Topps #140 Susana Base",
      "2026 Bowman Gonzalez CPA-JG sold 8/2026",
    ]) {
      expect(K.titleNamesFinish(t)).toBe(false);
    }
  });

  it("a HYPHENATED COMPOUND is its parts -- 'OPTIC-FLEX' names a finish", () => {
    // This row was in the probe's own qualifying sample, one hyphen away from
    // being written to a base slug: "optic-flex" tokenises whole and never
    // matched bare "optic".
    expect(K.titleNamesFinish("2025 PANINI DONRUSS OPTIC-FLEX #140 JARLIN SUSANA")).toBe(true);
    expect(K.titleNamesFinish("2024 Topps Chrome-Refractor Judge 99")).toBe(true);
    // ...but a hyphenated name that contains no finish word is still clean.
    expect(K.titleNamesFinish("2026 Bowman Jean-Carlos Rodriguez CPA-JR Auto")).toBe(false);
  });

  it("matches finish words WHOLE -- a surname is not a parallel", () => {
    // A substring test would read "Goldschmidt" as "gold" and strand a real
    // eviction; it would also read "Refractory" as "refractor". Neither word
    // is naming how the card is printed.
    expect(K.titleNamesFinish("2024 Topps Paul Goldschmidt 12")).toBe(false);
    expect(K.titleNamesFinish("2024 Topps Goldschmidt Gold 12")).toBe(true);
    expect(K.titleNamesFinish("2019 Panini Chromed Rookie 5")).toBe(false);
  });

  it("an empty title is never an eviction -- absent beats wrong", () => {
    const r = K.classifyRow(evictInput({ row: evictRow({ title: "" }) }));
    expect(r.subclass).toBeUndefined();
    expect(r.writable).toBe(false);
  });
});

describe("PIN 3 -- a stored parallel field naming a real finish is NOT tagged", () => {
  // THIS IS THE GONZALEZ DEMOTION, and it must stay CONFLICT forever. It is
  // one field away from PIN 1: there the row's own field said "Base" and only
  // the slug claimed a finish; here the ROW ITSELF names the parallel, and a
  // terse title never displaces what the row knows about itself.
  it("stored parallel 'Refractor' on the same slug and title is refused", () => {
    const stored: Identity = { ...evictStored, parallel: "Refractor", printRun: 499 };
    const r = K.classifyRow(evictInput({ stored }));
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.subclass).toBeUndefined();
    expect(r.writable).toBe(false);
    expect(r.reasons.join(" ")).toContain("stored-parallel-names-a-finish");
  });

  it.each(["Refractor", "Gold Refractor", "X-Fractor", "Orange Shimmer Refractor", "Sapphire"])(
    "a stored parallel of %s is the row's own answer, never evicted",
    (parallel) => {
      const r = K.classifyRow(evictInput({ stored: { ...evictStored, parallel } }));
      expect(r.subclass).toBeUndefined();
      expect(r.writable).toBe(false);
    },
  );

  it.each(["Base", "base", "[Base]", "", "none", "unknown"])(
    "a stored parallel of %j names nothing, so the shape survives to the other gates",
    (parallel) => {
      const r = K.classifyRow(evictInput({ stored: { ...evictStored, parallel } }));
      expect(r.subclass).toBe(K.BASE_EVICTION);
    },
  );

  it("a derived reading that DOES name a finish is not an eviction -- it is an ordinary IMPROVE", () => {
    // If today's parser reads a parallel off this row, the three fields no
    // longer agree and the subclass declines. What is left is the plain
    // only-improve case: a blank stored parallel filled by a checklist-backed
    // reading, onto the slug the row is ALREADY on. That is the existing
    // machinery working, and the subclass must not divert it.
    const r = K.classifyRow(evictInput({ derived: { ...evictDerived, parallel: "Refractor" } }));
    expect(r.subclass).toBeUndefined();
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.axes.filled).toContain("parallel");
  });
});

describe("PIN 4 -- a PROTECTED source is never written", () => {
  it.each([
    ["ebay-user-purchase", { source: "ebay-user-purchase" }],
    ["ebay-user-sale", { source: "ebay-user-sale" }],
    ["ebay-account", { source: "ebay-account" }],
    ["manual-user-entry", { source: "manual-user-entry" }],
    ["a drew-ruling source", { source: "drew-ruling-2026-08-10" }],
    ["verifiedByUser", { source: "cardhedge", verifiedByUser: true }],
    ["a hand relocation", { source: "cardhedge", handRelocated: true }],
  ])("%s tags the subclass but is NOT writable", (_label, over) => {
    const r = K.classifyRow(evictInput({ row: evictRow(over) }));
    // The census still MEASURES it -- the subclass is what was seen...
    expect(r.subclass).toBe(K.BASE_EVICTION);
    expect(r.tier).toBe(K.PROTECTED);
    // ...and the apply pass still may not touch it.
    expect(r.writable).toBe(false);
  });

  it("the identical row on a vendor source IS writable -- the refusals are the guard", () => {
    const r = K.classifyRow(evictInput());
    expect(r.tier).toBe(K.AUTO);
    expect(r.writable).toBe(true);
  });
});

describe("MUTATION CHECK: the protected guard on BASE-EVICTION is load-bearing", () => {
  // The subclass added a SECOND `writable` expression to the classifier, and a
  // guard nothing tests is a guard that gets deleted. This mutates the
  // subclass's own tier check -- not IMPROVE's -- and proves that without it a
  // protected row becomes writable through the new path.
  it("removing the tier check from the subclass makes a PROTECTED row writable", () => {
    const file = path.join(backend, "scripts", "lib", "rematch-classify.cjs");
    const src = fs.readFileSync(file, "utf8");

    // The subclass's writable line, identified by the comment that precedes it
    // so the mutation cannot accidentally hit IMPROVE's identical expression.
    // Indentation-insensitive: this pins the GUARD, not the source's layout.
    const marker = /(\/\/ forever, subclass or no subclass -- see the mutation check\.\s*\n\s*)writable: prov\.tier === AUTO,/;
    expect(src).toMatch(marker);
    const mutated = src.replace(marker, "$1writable: true,");
    expect(mutated).not.toBe(src);
    // ...and exactly ONE expression was mutated, so IMPROVE's own guard is
    // untouched and the two answers below differ only by the subclass's.
    expect(mutated.match(/writable: prov\.tier === AUTO,/g) ?? []).toHaveLength(
      (src.match(/writable: prov\.tier === AUTO,/g) ?? []).length - 1,
    );

    const tmp = path.join(backend, "scripts", "lib", `.rematch-classify.be-mutant-${process.pid}.cjs`);
    try {
      fs.writeFileSync(tmp, mutated);
      const mutant = require_(tmp) as Classifier;
      const input = evictInput({ row: evictRow({ source: "ebay-user-sale" }) });

      const real = K.classifyRow(input);
      const broken = mutant.classifyRow(input);

      expect(real.subclass).toBe(K.BASE_EVICTION);
      expect(broken.subclass).toBe(K.BASE_EVICTION);
      expect(real.tier).toBe(K.PROTECTED);
      expect(broken.tier).toBe(K.PROTECTED);
      // The guard is the ONLY thing standing between these two answers.
      expect(real.writable).toBe(false);
      expect(broken.writable).toBe(true);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });
});

describe("PIN 5 -- no checklist-backed base destination -> NOT tagged", () => {
  it("an unbacked destination is refused: there is nowhere to evict TO", () => {
    const r = K.classifyRow(evictInput({ baseDestBacked: false }));
    expect(r.subclass).toBeUndefined();
    expect(r.writable).toBe(false);
    // The class falls back to whatever the EIGHT axes say. On this fixture the
    // row's fields and its title agree, so that is AGREE -- a refusal to evict
    // is "leave the row alone", not "invent a conflict". The row keeps sitting
    // on its parallel slug, which is exactly what report-only means.
    expect(r.klass).toBe(K.AGREE);
  });

  it("a match proves nothing unless checklist-backed -- this is the same gate IMPROVE uses", () => {
    // The catalog having a row is not evidence; the row's SOURCE being a
    // checklist ingest is. A vendor-minted base row is not a destination.
    const backed = K.classifyRow(evictInput({ baseDestBacked: true }));
    const unbacked = K.classifyRow(evictInput({ baseDestBacked: false }));
    expect(backed.writable).toBe(true);
    expect(unbacked.writable).toBe(false);
  });
});

describe("the slug is read by POSITION, not by scanning for a finish word", () => {
  it("reads the 6th colon-segment as the parallel", () => {
    expect(K.slugParallelSegment(EVICT_SLUG)).toBe("refractor");
    expect(K.slugParallelSegment(BASE_DEST)).toBe("base");
  });

  it("a set name containing a finish word is NOT a parallel slug", () => {
    // `topps-chrome` carries "chrome" in its SET. A scan would read that row
    // as sitting on a parallel and try to evict a base card off its own slug.
    const s = "hiq:baseball:2024:topps-chrome:150:base:no-auto";
    expect(K.slugParallelSegment(s)).toBe("base");
    expect(K.slugNamesParallel(s)).toBe(false);
  });

  it("a base slug is never an eviction candidate -- there is nothing to evict", () => {
    const r = K.classifyRow(evictInput({
      row: evictRow({ cardId: "hiq:baseball:2026:bowman:cpa-jg:base:auto" }),
      storedSlug: "hiq:baseball:2026:bowman:cpa-jg:base:auto",
    }));
    expect(r.subclass).toBeUndefined();
    expect(r.writable).toBe(false);
    // And it is not even DIAGNOSED as a near miss -- every ordinary conflict
    // fails this way, and a reason on all of them tells the banner nothing.
    expect(r.reasons.join(" ")).not.toContain("not-base-eviction");
  });

  it.each(["", "not-a-slug", "hiq:baseball:2026", "holding::12345"])(
    "a malformed slug %j names no parallel and is refused",
    (slug) => {
      expect(K.slugNamesParallel(slug)).toBe(false);
      const r = K.classifyRow(evictInput({ row: evictRow({ cardId: slug }), storedSlug: slug }));
      expect(r.subclass).toBeUndefined();
    },
  );
});

describe("the finish vocabulary is closed and grounded", () => {
  it("carries the finishes the checklist corpus actually uses", () => {
    // Measured over data/checklist-parallel-names.json (21,090 distinct
    // checklist-sourced names). These are the heads by frequency.
    for (const t of ["refractor", "prizm", "holo", "shimmer", "mojo", "sapphire", "foil", "wave"]) {
      expect(K.FINISH_TOKENS).toContain(t);
    }
  });

  it("colour words count as finishes -- they name parallels with no finish noun", () => {
    for (const c of ["gold", "orange", "blue", "red", "black"]) {
      expect(K.FINISH_COLOR_TOKENS).toContain(c);
    }
    expect(K.titleNamesFinish("2026 Bowman Gonzalez Orange CPA-JG")).toBe(true);
  });

  it("does NOT contain words that are not about how a card is printed", () => {
    // A vocabulary that grows by accident stops being evidence. `auto`, `rc`
    // and `rookie` describe the CARD, not its finish, and every 1st Bowman
    // Auto title carries at least one of them.
    for (const w of ["auto", "autograph", "rc", "rookie", "1st", "prospect", "base"]) {
      expect(K.FINISH_TOKENS).not.toContain(w);
      expect(K.FINISH_COLOR_TOKENS).not.toContain(w);
    }
    expect(K.titleNamesFinish("2026 Bowman Justin Gonzalez 1st Bowman Auto RC Prospect")).toBe(false);
  });
});
