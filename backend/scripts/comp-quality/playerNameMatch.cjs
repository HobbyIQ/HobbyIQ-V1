// Is this catalog row the same PLAYER as this sale?
//
// One definition, shared, because two copies of this list drifted apart within
// an hour of each other and the second copy silently rejected 828 sales the
// first would have moved.
//
// WHY IT IS NOT JUST STRING EQUALITY. A playerName field carries designations
// that describe the CARD, not the person:
//
//   "Darryl Strawberry XRC"   extended rookie card
//   "Larry Bowa MGR"          manager card
//   "Todd Greene USA"         Team USA
//   "Pete Rose MGR"
//
// Raw comparison called those different people and rejected 12,870 of 20,678
// sales in one sweep.
//
// WHY IT IS NOT FUZZY EITHER. The guard has to keep catching real mismatches —
// it found a sale labelled Doug Jones pointing at 1989 Topps #6, which is Pedro
// Guerrero. Loosening to substring or edit-distance matching would wave that
// through, and the whole point of the check is that base sets and their Traded
// or Tiffany counterparts both number from 1, so the same number is routinely a
// different player.
//
// "jr" AND "sr" ARE DELIBERATELY ABSENT from the strip list. Ken Griffey and
// Ken Griffey Jr are two players. Collapsing them would file a father's cards
// into his son's pool, which is a worse error than leaving a few rows unmoved.
//
// WHAT THE ACCENT FIX DID NOT FIX (measured 2026-08-23). Re-running the Tiffany
// and Topps Traded sweeps after the NFKD fold landed recovered 14 sales. The
// rejections were then classified rather than guessed at, and 1,050 of 1,669
// Topps Traded rejects plus 98 of 612 Tiffany rejects were the same shape: the
// catalog name in full, plus noise the catalog does not carry.
//
//   "Traded Kent Hrbek"           || "Kent Hrbek"
//   "Ed Romero Collector 's"      || "Ed Romero"
//   "Traded Barry Bonds No"       || "Barry Bonds XRC"
//
// One word explains most of it: "traded" appears in 1,035 of those 1,050. It is
// the SET NAME — Topps Traded — describing the card exactly as "xrc" and "mgr"
// already do. Adding it is not a loosening of the guard; it is finishing the
// list the guard was always meant to have. The rest is seller vocabulary about
// condition and packaging, which likewise never names a person.
//
// WORDS THAT LOOK LIKE NOISE AND ARE NOT, all rejected on purpose:
//
//   "tiffany"           also a person. Tiffany Stratton is a wrestler with 99
//                       rows in this pool; stripping it could fuse two
//                       different Strattons. The era/brand guard already
//                       excludes her cards, so nothing is gained by the risk.
//   "operation","desert" Operation Desert Shield is a DIFFERENT product line,
//                       not noise on a Tiffany card. Stripping it would file
//                       Desert Shield sales onto the Tiffany card — the very
//                       conflation these sweeps exist to undo.
//   "oakland","expos"   team names. A place can be a surname; the counts (14
//                       and 9) do not justify finding out which.
//   "jr","sr","ii","iii" see above. 49 Topps Traded and 153 Tiffany rejects are
//                       "Cal Ripken" against "Cal Ripken, Jr." — those STAY
//                       rejected, which is why this change adds vocabulary and
//                       never a subset rule.
const DESIGNATION = new Set([
  // card-status
  "xrc", "rc", "rookie", "rookies", "prospect", "prospects", "draft", "pick", "picks",
  // honours / roles printed on the card
  "hof", "mgr", "mg", "manager", "coach", "usa", "team", "oly",
  // subset labels
  "tc", "cl", "checklist", "ldr", "ldrs", "leaders", "rb", "hl", "highlight",
  "highlights", "star", "allstar", "as", "fs", "future",
  // print variations
  "sp", "ssp", "err", "cor", "uer", "var", "variation",
  // PRODUCT LINE AND PACKAGING. The set the card came out of, or the box it
  // came in — never the person on it.
  "traded", "collector", "collectors", "set", "box", "break",
  // CONDITION AND GRADING, as sellers write it into a name field. These
  // describe the physical object; no player is called Nm or Vg.
  "nm", "mt", "mint", "near", "ex", "exnm", "vg", "nr", "graded", "bccg",
]);

/** "Collector 's" tokenises to collector + s, and a bare "s" survives the
 *  designation filter to poison 68 comparisons. Stripping the possessive is the
 *  right fix rather than adding "s" to DESIGNATION, which would also eat middle
 *  initials.
 *
 *  The negative lookahead protects names that legitimately carry an apostrophe
 *  followed by s-something: O'Shea keeps its apostrophe-S because "h" follows,
 *  while "Collector's" and "Collector 's" both lose it. */
const POSSESSIVE = /['’]\s*s(?![a-z])/gi;

/** Normalised form for comparison: ASCII-folded, designations removed.
 *
 *  FOLDING HAS TO HAPPEN BEFORE THE SPLIT. Splitting on [^a-z] first tears an
 *  accented name in half instead of folding it — "Luis Peña" became
 *  luis + pe + a while the sale's "Luis Pena" stayed luispena, so the two never
 *  matched and 576 sapphire sales were refused as different people. Same
 *  mistake would silently under-move every Peña, Acuña, Suárez and Jiménez in
 *  the pool, and it did on the Tiffany and Topps Traded sweeps before this.
 *
 *  NFKD splits "ñ" into "n" + a combining tilde; stripping the combining marks
 *  leaves plain "n". Mirrors fold() in catalogSearch.service. */
function normPlayerName(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(POSSESSIVE, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t && !DESIGNATION.has(t))
    .join("");
}

/** True only when both sides name the same person. Empty on either side is
 *  NOT a match — unverifiable must never read as verified. */
function samePlayer(a, b) {
  const x = normPlayerName(a);
  const y = normPlayerName(b);
  return Boolean(x) && Boolean(y) && x === y;
}

module.exports = { DESIGNATION, normPlayerName, samePlayer };
