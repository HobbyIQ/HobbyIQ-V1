/**
 * CF-SET-SPORT-AUTHORITY (Drew, 2026-08-20) — ONE declaration of "what sport is
 * this set, and may it overrule a comp's slug?", shared by the audit that
 * measures the repair and the script that applies it.
 *
 * They MUST NOT each carry their own copy. That exact split — one rule, two
 * implementations, differences nobody chose — is what produced the setKey
 * fragmentation we spent 2026-08-20 merging, and what let five copies of
 * "is this a checklist source" drift far enough to flip 51 card-number prefixes
 * between "repair" and "blocked". An audit that measures with different gates
 * than the repair applies is not an audit of that repair.
 *
 * ── WHY THE GATES ARE SHAPED THIS WAY ───────────────────────────────────────
 *
 * The first version of this logic reported 8.69% contamination (1,243,562
 * comps) and its two largest moves were BACKWARDS. It ranked only
 * checklist-backed rows and required 0.95 dominance — but dominance over a
 * single-sport sample is always 1.0:
 *
 *   2024 panini-donruss
 *     ALL rows       baseball 5,503   football 19,130   basketball 4,031
 *     CHECKLIST rows football 3,993   ONLY
 *     -> dominance 1.0000, authority "football", gate PASSES
 *
 * We simply have no checklist for Donruss BASEBALL 2024; the product plainly
 * exists. Absence of checklist COVERAGE was read as absence of the PRODUCT.
 *
 * So the two questions are separated, because they need different evidence:
 *
 *   IS THIS SET MULTI-SPORT?  asked of ALL catalog rows. A vendor row is weak
 *     evidence of what a card IS, but perfectly good evidence that the product
 *     EXISTS in that sport.
 *
 *   IF SINGLE-SPORT, WHICH?   asked of checklist rows only.
 *
 * MIN_OTHER is ABSOLUTE, not a ratio: 4% of a large set is thousands of real
 * cards, and a ratio gate lets them through.
 */

/** Absolute count of catalog rows in OTHER sports that makes a setKey a
 *  cross-sport franchise and therefore unable to adjudicate. */
const MIN_OTHER = 200;
const MIN_CHECKLIST = 20;
const DOMINANCE = 0.95;

const SPORT_WORDS = ["baseball", "football", "basketball", "hockey", "soccer"];

/**
 * Build the (year, setKey) -> sport authority map.
 *
 * @param {Map<string, Map<string, number>>} checklistCounts  key -> sport -> n, CHECKLIST rows only
 * @param {Map<string, Map<string, number>>} allCounts        key -> sport -> n, ALL rows
 */
function buildAuthority(checklistCounts, allCounts, opts = {}) {
  const minOther = opts.minOther ?? MIN_OTHER;
  const minChecklist = opts.minChecklist ?? MIN_CHECKLIST;
  const dominance = opts.dominance ?? DOMINANCE;

  const authority = new Map();
  const skipped = { mixed: 0, crossSport: 0, thin: 0 };
  const examples = [];

  for (const [k, m] of checklistCounts) {
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    if (total < minChecklist) { skipped.thin++; continue; }
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] / total < dominance) {
      skipped.mixed++;
      if (examples.length < 12) examples.push(`${k}  MIXED  ${ranked.slice(0, 3).map(([s, n]) => `${s}:${n}`).join(" ")}`);
      continue;
    }
    const all = allCounts.get(k);
    const other = all
      ? [...all.entries()].filter(([s]) => s !== ranked[0][0]).reduce((n, [, c]) => n + c, 0)
      : 0;
    if (other >= minOther) {
      skipped.crossSport++;
      if (examples.length < 12) {
        const top = [...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}:${n}`).join(" ");
        examples.push(`${k}  CROSS-SPORT  checklist=${ranked[0][0]}:${ranked[0][1]}  allRows= ${top}`);
      }
      continue;
    }
    authority.set(k, ranked[0][0]);
  }
  return { authority, skipped, examples };
}

/**
 * Decide one comp. Returns a verdict rather than a boolean so both callers
 * report the same categories.
 *
 * THE TITLE VETO is the reason this returns "vetoed" instead of just false. A
 * title that NAMES a sport is direct evidence about THIS card; the set-level
 * verdict is only a prior about its neighbours. When they disagree the card
 * wins — that is the pair the first version measured wrong: 4,000 comps slugged
 * hiq:baseball:2024:panini-donruss carried baseball 424, soccer 32, football 0
 * while the set-level rule wanted every one moved to football.
 *
 * It is high-precision and low-recall — only ~11% of titles name a sport — so
 * it can STOP a repair but must never drive one. That asymmetry is deliberate.
 */
function judgeComp({ slugSport, year, setKey, title }, authority) {
  const truth = authority.get(`${year}|${setKey}`);
  if (!truth) return { verdict: "no-authority" };
  if (truth === slugSport) return { verdict: "agree" };

  const t = String(title || "").toLowerCase();
  const named = SPORT_WORDS.filter((s) => t.includes(s));
  if (named.length === 1) {
    if (named[0] === slugSport) return { verdict: "vetoed-title-backs-slug" };
    if (named[0] !== truth) return { verdict: "vetoed-title-backs-neither", named: named[0] };
  }
  return { verdict: "contradict", from: slugSport, to: truth };
}

module.exports = { buildAuthority, judgeComp, SPORT_WORDS, MIN_OTHER, MIN_CHECKLIST, DOMINANCE };
