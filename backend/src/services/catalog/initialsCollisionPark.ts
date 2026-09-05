/**
 * CF-A-COLLISION-NUMBER-WITH-NO-PLAYER-PARKS (Drew, 2026-09-05).
 *
 * CPA-/BCP- card numbers are INITIALS, and initials collide ACROSS PRODUCTS.
 * 2026 Bowman and 2026 Bowman Chrome both ship Chrome Prospect Autographs, and
 * for nine numbers the two checklists name two DIFFERENT players:
 *
 *     CPA-AG   bowman Adrian Gil        chrome Angeibel Gomez
 *     CPA-EM   bowman Edgar Montero     chrome Ezequiel Melbourne
 *     ...      (the full nine are in COLLISION_NUMBERS_2026_BASEBALL)
 *
 * A sale titled only "2026 Bowman ... #CPA-AG" with no readable player names a
 * NUMBER, and that number is not an identity here -- it is two identities. The
 * product words cannot break the tie either: the census (2026-09-05) measured
 * 33.1% of `bowman`-stem sales carrying the word "Chrome" in the title, because
 * a CPA card IS chrome stock inside the Bowman product. So the title's product
 * words are vocabulary, not evidence.
 *
 * Drew, asked what such a sale should do:
 *
 *     "a NEW sale titled only '2026 Bowman ... CPA-AG' with no player readable
 *      PARKS -- identityUnverified, no pool, prices nothing until the title or
 *      a player field resolves it (never default to either side)."
 *
 * NEVER DEFAULT TO EITHER SIDE. Pooling the sale on `bowman` because that is
 * the commoner product would put Angeibel Gomez's sales in Adrian Gil's pool
 * half the time, and FMV is the projected next sale from a pool -- so a wrong
 * pool is a wrong price, silently, forever. Parking prices nothing, which is
 * the correct answer to "we do not know which card this is".
 *
 * WHAT THIS IS NOT. It is not a judgement that the sale is bad, and it is not
 * a matcher failure: it is a NAMED refusal that the acquisition queue can act
 * on, in the same vocabulary `identityBacking` already uses for an identity we
 * decline to price.
 *
 * SCOPE. Only (sport, year, cardNumber) triples on the registry below --
 * numbers PROVEN by two checklists to name two players. A number that is not
 * a measured collision is untouched: absence from this table is not a defect
 * (feedback: "absence from vocab is not a defect"), it means one card.
 *
 * Pure: no I/O, no Cosmos, no clock.
 */

/**
 * The measured collisions. Each entry is a card number that TWO dedicated
 * checklists claim for TWO different players in the same year and sport.
 *
 * Sourced from the 2026-09-05 census
 * (backend/docs/reports/bowman-vs-bowman-chrome-2026-09-05.md), which compared
 * the 239 checklist-sourced CPA/BCP numbers present on both product stems and
 * found 230 naming the same player (one card, split slug) and these nine
 * naming two.
 *
 * ADDING TO THIS TABLE IS A RULING, not a guess: an entry must be backed by
 * two checklist rows that disagree on the player, never by a matcher's
 * suspicion.
 */
export const INITIALS_COLLISIONS: ReadonlyArray<{
  sport: string;
  year: number;
  cardNumber: string;
  /** The two products and the player each names. Documentation for the
   *  reviewer and the acquisition queue; the rule keys only on the number. */
  claimants: ReadonlyArray<{ setKey: string; playerName: string }>;
}> = [
  { sport: "baseball", year: 2026, cardNumber: "CPA-AG", claimants: [
    { setKey: "bowman", playerName: "Adrian Gil" },
    { setKey: "bowman-chrome", playerName: "Angeibel Gomez" }] },
  { sport: "baseball", year: 2026, cardNumber: "CPA-EM", claimants: [
    { setKey: "bowman", playerName: "Edgar Montero" },
    { setKey: "bowman-chrome", playerName: "Ezequiel Melbourne" }] },
  { sport: "baseball", year: 2026, cardNumber: "CPA-LA", claimants: [
    { setKey: "bowman", playerName: "Luis Arana" },
    { setKey: "bowman-chrome", playerName: "Louis Andujar" }] },
  { sport: "baseball", year: 2026, cardNumber: "CPA-DF", claimants: [
    { setKey: "bowman", playerName: "Dauri Fernandez" },
    { setKey: "bowman-chrome", playerName: "Diego Frontado" }] },
  { sport: "baseball", year: 2026, cardNumber: "CPA-HL", claimants: [
    { setKey: "bowman", playerName: "Henry Lalane" },
    { setKey: "bowman-chrome", playerName: "Hyun Seung Lee" }] },
  { sport: "baseball", year: 2026, cardNumber: "CPA-WA", claimants: [
    { setKey: "bowman", playerName: "Wehiwa Aloy" },
    { setKey: "bowman-chrome", playerName: "Wandy Asigen" }] },
  { sport: "baseball", year: 2026, cardNumber: "CPA-JS", claimants: [
    { setKey: "bowman", playerName: "Juan Sanchez" },
    { setKey: "bowman-chrome", playerName: "Jaider Suarez" }] },
  { sport: "baseball", year: 2026, cardNumber: "CPA-BC", claimants: [
    { setKey: "bowman", playerName: "Billy Carlson" },
    { setKey: "bowman-chrome", playerName: "Brandon Clarke" }] },
  { sport: "baseball", year: 2026, cardNumber: "BCP-151", claimants: [
    { setKey: "bowman", playerName: "Seong-Jun Kim" },
    { setKey: "bowman-chrome", playerName: "Slater de Brun" }] },
];

/** Hyphen- and case-insensitive, matching `foldCardNumber`'s comparison. */
function foldNumber(n: string | null | undefined): string {
  return String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COLLISION_INDEX: ReadonlyMap<string, (typeof INITIALS_COLLISIONS)[number]> = new Map(
  INITIALS_COLLISIONS.map((c) => [
    `${c.sport.toLowerCase()}|${c.year}|${foldNumber(c.cardNumber)}`,
    c,
  ]),
);

/** Is this (sport, year, cardNumber) a number two checklists claim for two players? */
export function findInitialsCollision(input: {
  sport?: string | null;
  year?: number | string | null;
  cardNumber?: string | null;
}): (typeof INITIALS_COLLISIONS)[number] | null {
  const sport = String(input?.sport ?? "").toLowerCase().trim();
  const year = Number(input?.year);
  const num = foldNumber(input?.cardNumber);
  if (!sport || !Number.isFinite(year) || !num) return null;
  return COLLISION_INDEX.get(`${sport}|${year}|${num}`) ?? null;
}

/** The closed reason vocabulary. Consumers never infer the reason from prose. */
export const COLLISION_NUMBER_NO_PLAYER = "collision-number-no-player" as const;

export type CollisionParkDecision =
  | { kind: "ok" }
  | {
      kind: "park";
      reason: typeof COLLISION_NUMBER_NO_PLAYER;
      cardNumber: string;
      claimants: ReadonlyArray<{ setKey: string; playerName: string }>;
      message: string;
    };

/**
 * Should this SALE park rather than pool?
 *
 * Parks only when BOTH halves are true:
 *   - the (sport, year, cardNumber) is a measured initials collision, AND
 *   - no player is readable on the sale.
 *
 * A readable player resolves the card by itself -- that is the whole point of
 * the player gate -- so a sale that names Adrian Gil pools normally on
 * `bowman`, and one that names Angeibel Gomez pools on `bowman-chrome`. Only
 * the sale that names NEITHER is undecidable, and only that one parks.
 */
export function decideCollisionPark(input: {
  sport?: string | null;
  year?: number | string | null;
  cardNumber?: string | null;
  playerName?: string | null;
}): CollisionParkDecision {
  const collision = findInitialsCollision(input);
  if (!collision) return { kind: "ok" };
  // A readable name decides the card. Blank, whitespace and null are all
  // "nobody told us" -- never agreement with either claimant.
  if (String(input?.playerName ?? "").trim()) return { kind: "ok" };
  const names = collision.claimants.map((c) => `${c.setKey}/${c.playerName}`).join(" vs ");
  return {
    kind: "park",
    reason: COLLISION_NUMBER_NO_PLAYER,
    cardNumber: collision.cardNumber,
    claimants: collision.claimants,
    message:
      `${collision.year} ${collision.cardNumber} names two different players (${names}) and this sale `
      + "reads no player — parked as identityUnverified rather than pooled on either. "
      + "(CF-A-COLLISION-NUMBER-WITH-NO-PLAYER-PARKS)",
  };
}
