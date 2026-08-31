/**
 * CF-1993-FINEST-SPORT-CONFLATION (Drew, 2026-08-31) -- the decision rules for
 * the 1993 Topps Finest repair, in ONE place so the report, the repair and the
 * tests all decide identically.
 *
 * THE DEFECT. 1993 Topps Finest shipped as two unrelated products -- a BASEBALL
 * set (single-year: "1993 Topps Finest") and a BASKETBALL set (split-season:
 * "1993-94 Topps Finest"). Both were ingested under one (year=1993,
 * setKey=topps-finest) key, so the two checklists share a cardNumber space:
 * #99 is Jose Canseco in baseball AND Shaquille O'Neal in basketball, #110 is
 * Ken Griffey Jr AND Jamal Mashburn. That is NOT itself the bug -- two products
 * legitimately reuse numbers, and `sport` is the field that separates them.
 *
 * The bug is rows whose SPORT SEGMENT is wrong: basketball cards filed under
 * `hiq:baseball:1993:topps-finest:...`. Measured 2026-08-31 over 1,112 catalog
 * rows and 15,725 pool rows.
 *
 * ── WHY NOT THE EXISTING AUTHORITIES ────────────────────────────────────────
 *
 * setSportAuthority.cjs (CF-SET-SPORT) asks "what sport is this SET?" and
 * refuses a setKey carrying >= MIN_OTHER rows in another sport. 1993
 * topps-finest carries 609 baseball and 502 basketball: it is a genuine
 * cross-sport key, so that authority correctly declines to adjudicate it and
 * cannot be reused here. The question here is per-CARD, not per-set.
 *
 * inferSportFromPlayer (parseTitleIdentity) is a roster of MODERN stars. Of the
 * 360 distinct players in this product it recognises almost none, and the ones
 * it does are traps -- its own comments exclude Michael Jordan precisely
 * because his 1994 Barons cards are really baseball. It would return null for
 * essentially every row here, so it decides nothing.
 *
 * ── THE EVIDENCE, IN PRIORITY ORDER ─────────────────────────────────────────
 *
 * 1. SPORT WORD in the title ("... Basketball #27 ..."). Direct evidence about
 *    THIS card. Measured precision: of 2,491 titles naming "baseball", exactly
 *    ONE also carries the 1993-94 season form, and that one is a seller's typo
 *    ("MICHAEL JORDAN PSA 10 1993-94 TOPPS FINEST BASEBALL #1 BULLS" -- Bulls,
 *    so basketball). The word is the strongest signal available.
 *
 * 2. SEASON FORM. "1993-94" is the basketball/hockey product; a bare "1993" is
 *    the baseball one. This is the signal that does the real work: it finds 397
 *    mis-sported pool rows the sport word never names -- Clyde Drexler #74, Vin
 *    Baker #139, A.C. Green #59 -- all sitting under a baseball slug.
 *
 * A row is repaired only when the evidence is POSITIVE and the two signals do
 * not disagree. Anything else is AMBIGUOUS and STAYS PUT, counted. We never
 * blank a sport to express doubt -- that trades a wrong slug for a broken one.
 *
 * ── WHY THE PLAYER NAME IS EVIDENCE BUT NOT A VERDICT ───────────────────────
 *
 * Seven players hold rows under both sports. Six are plainly NBA players
 * leaking into baseball (Rodman, Hardaway, Webber, Laettner, Avery Johnson,
 * Muggsy Bogues). The seventh is the trap: "Eddie Johnson" is a real NBA player
 * AND a real MLB player, and 1993 Finest baseball #27 is neither of them -- it
 * is Alex Fernandez. A name-only rule would move Alex Fernandez's neighbours on
 * the strength of a homonym. So a cross-sport player NAME only ever RAISES a
 * row for title adjudication; the title decides, and a row whose title is
 * silent stays exactly where it is.
 */

export type FinestSport = "baseball" | "basketball";

/** The sport segment of a `hiq:<sport>:<year>:<setKey>:...` slug. */
export function slugSport(id: string): string {
  return String(id ?? "").split(":")[1] ?? "";
}

/** The card-number segment of a hiq slug. */
export function slugCardNumber(id: string): string {
  return String(id ?? "").split(":")[4] ?? "";
}

/** Re-spell only the sport segment; every other segment is left byte-identical. */
export function withSport(id: string, sport: string): string {
  const parts = String(id ?? "").split(":");
  if (parts.length < 2) return id;
  parts[1] = sport;
  return parts.join(":");
}

/** `hockey` and `ice-hockey` are the same sport spelled two ways. */
export function canonSport(s: string): string {
  const v = String(s ?? "").trim().toLowerCase();
  return v === "ice-hockey" ? "hockey" : v;
}

/**
 * NHL clubs whose 1993-94 cards can land in this product's number space.
 *
 * WHY A TEAM LIST AND NOT JUST THE WORD "hockey". The row that forced this is
 * real: "1993-94 Topps Finest Mats Sundin #110 Toronto Maple Leafs Unpeeled",
 * sitting on a 1993 topps-finest slug. It never says "hockey" — but it carries
 * the 1993-94 season form, so a season-form-only rule confidently files an NHL
 * card as basketball and drops a hockey sale into Jamal Mashburn's pool.
 *
 * The list is deliberately SMALL and one-sided: it only ever STOPS a repair,
 * never drives one. A name it misses costs a row left alone (safe); a false hit
 * costs a row left alone (also safe). Nothing here can move a card.
 */
const HOCKEY_TEAM_WORDS = [
  "maple leafs", "canadiens", "nordiques", "oilers", "flames", "canucks",
  "jets", "senators", "bruins", "whalers", "sabres", "rangers", "islanders",
  "devils", "flyers", "penguins", "capitals", "lightning", "panthers",
  "blackhawks", "red wings", "blues", "north stars", "mighty ducks",
  "sharks", "kings", "avalanche", "coyotes", "nhl",
];

export type Verdict =
  | { decided: true; sport: FinestSport; signal: "sport-word" | "season-form"; }
  | { decided: false; reason: "no-evidence" | "signals-disagree" | "names-other-sport" };

/**
 * Decide the sport of ONE 1993 Topps Finest row from its title.
 *
 * Returns `decided:false` far more often than true, and that is the point: an
 * undecided row is left alone, so the cost of silence is a row that stays as it
 * is, never a row moved on a guess.
 */
export function decideFinestSport(title: string): Verdict {
  const t = String(title ?? "").toLowerCase();
  if (!t.trim()) return { decided: false, reason: "no-evidence" };

  // A title naming football/hockey/soccer is about neither of our two products.
  // Say so distinctly rather than silently calling it "no evidence": these are
  // the rows a later, wider repair wants to find.
  const foreign = ["football", "soccer", "wrestling"].filter((w) => t.includes(w));
  // Hockey is named either outright or by a club — see HOCKEY_TEAM_WORDS.
  const namesHockey = /\bhockey\b/.test(t) || HOCKEY_TEAM_WORDS.some((w) => t.includes(w));

  const saysBasketball = /\bbasketball\b/.test(t);
  const saysBaseball = /\bbaseball\b/.test(t);
  // "1993-94" / "1993-4" — the split-season form. Anchored so a print run or a
  // price ("1993-9400") cannot masquerade as a season.
  const seasonForm = /\b1993\s*-\s*9?4\b/.test(t);

  if (saysBasketball && saysBaseball) return { decided: false, reason: "signals-disagree" };

  if (saysBasketball) {
    return { decided: true, sport: "basketball", signal: "sport-word" };
  }
  if (saysBaseball) {
    // The word says baseball but the season form says otherwise. One real case
    // in 2,491 (a "BASEBALL ... BULLS" typo); refuse rather than trust either.
    if (seasonForm) return { decided: false, reason: "signals-disagree" };
    if (foreign.length || namesHockey) return { decided: false, reason: "signals-disagree" };
    return { decided: true, sport: "baseball", signal: "sport-word" };
  }

  // No sport word. The season form is then the only positive evidence, and it
  // only ever speaks FOR basketball: a bare "1993" is not evidence of baseball,
  // because a basketball listing may simply omit the season.
  if (seasonForm) {
    if (foreign.length || namesHockey) return { decided: false, reason: "names-other-sport" };
    return { decided: true, sport: "basketball", signal: "season-form" };
  }

  if (foreign.length || namesHockey) return { decided: false, reason: "names-other-sport" };
  return { decided: false, reason: "no-evidence" };
}

/**
 * Grade suffixes that make a slug a GRADED CHILD of an ungraded parent row.
 * A graded child holds no sales of its own -- the sales sit on the parent -- so
 * anything reasoning from sales must ask the parent.
 */
const GRADE_SUFFIX = /^(psa|bgs|sgc|cgc|csg|hga|ace|tag|gma|isa|pgs|rcg)-[0-9.]+$/;

/**
 * The ungraded parent of a slug, or the slug itself when it is already one.
 * `hiq:baseball:1993:topps-finest:212:refractor:no-auto:psa-8`
 *   -> `hiq:baseball:1993:topps-finest:212:refractor:no-auto`
 */
export function gradeParentOf(id: string): string {
  const parts = String(id ?? "").split(":");
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 5 && GRADE_SUFFIX.test(last)) return parts.slice(0, -1).join(":");
  return String(id ?? "");
}

/**
 * Fold a name (or a whole title) to a comparable form: lowercase, apostrophes
 * dropped, everything else non-alphanumeric to a single space.
 */
export function normPlayer(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does this title name this player? Compared on the SURNAME plus one more
 * token, because the stored names are not clean enough for equality.
 *
 * "Shaquille O'Neal" is stored on some rows as "Shaquille 'neal" -- an ingest
 * casualty -- which folds to "shaquille neal" while the title folds to
 * "shaquille oneal". Full-string containment misses that pair entirely, and a
 * surname-only rule would let "Johnson" match Avery, Ervin, Larry and Eddie
 * Johnson indiscriminately, which is precisely the collision this repair must
 * not get wrong.
 *
 * So: the LAST token must appear (allowing the o-prefix to have been eaten),
 * and so must at least one other token of the name -- normally the first. Both
 * halves are required, so "Johnson" alone never matches anybody.
 */
export function titleNamesPlayer(title: string, player: string): boolean {
  const t = normPlayer(title);
  const parts = normPlayer(player).split(" ").filter(Boolean);
  if (!t || parts.length === 0) return false;

  const tokens = new Set(t.split(" ").filter(Boolean));
  const last = parts[parts.length - 1];
  // "neal" should meet "oneal"; "oneal" should meet "neal".
  const surnameHit = [...tokens].some((tok) => tok === last || tok === `o${last}` || `o${tok}` === last);
  if (!surnameHit) return false;

  if (parts.length === 1) return true;
  return parts.slice(0, -1).some((p) => tokens.has(p));
}

/**
 * The fabricated print run. 1993 Topps Finest is a PRE-SERIAL product: no card
 * in it carries a stated print run. The "/241" seen in listings is the hobby's
 * estimate of Refractor scarcity (Drew's ruling manifest, 2026-08-31: "the /241
 * figure is a hobby estimate, never a stated run"). A row carrying printRun 241
 * is asserting something the cardboard never said, so it is blanked -- blank
 * means unknown, which is the truth here.
 */
export const FABRICATED_PRINT_RUN = 241;

export function isFabricatedPrintRun(printRun: unknown): boolean {
  if (printRun === null || printRun === undefined || printRun === "") return false;
  return Number(printRun) === FABRICATED_PRINT_RUN;
}

/**
 * cardNumber 1927 -- the smear. A basketball row carries cardNumber "1927" with
 * printRun 27, i.e. "#19" and "/27" run together into one token by an early
 * parser.
 *
 * IT IS PARKED, NOT REPAIRED. The tempting read is #19 + /27. Both halves fail:
 * this product is pre-serial so /27 cannot be a print run either, the row's
 * playerName is null and its slug carries NO sales, so there is no title and no
 * pool row anywhere that attests what the true number is. Repairing it would
 * mean inventing #19 from the shape of a typo. A row with no evidence is parked
 * and reported for a human, which is what `blank means unknown` requires.
 */
export const SMEARED_CARD_NUMBER = "1927";

export function isSmearedCardNumber(cardNumber: unknown): boolean {
  return String(cardNumber ?? "").trim() === SMEARED_CARD_NUMBER;
}
