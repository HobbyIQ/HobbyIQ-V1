/**
 * checklistAutoLookup — does this product's CHECKLIST list a signed variant
 * for this card number?
 *
 * CF-A-CARDNUMBER-PREFIX-IS-SUFFICIENT-NEVER-NECESSARY (Drew, 2026-09-04,
 * ruled by the 2011 Topps Chrome Freddie Freeman rookie auto).
 *
 * The standing rule is `isAuto boundary is cardNumber, not text`: a card
 * number carrying an auto-subset prefix (CPA-, BCPA-, RA-) PROVES the card is
 * signed, and that rule is untouched here — it stays sufficient. What the
 * Freeman card shows is that it was also being read as NECESSARY, and it is
 * not:
 *
 *     2011 Topps Chrome #173 Freddie Freeman         (base rookie)
 *     2011 Topps Chrome #173 Freddie Freeman AUTO    (Autographed Rookies)
 *
 * One number, two cards. `isCardNumberAutoSubset` needs a letter prefix, so
 * it is STRUCTURALLY BLIND to every shared-number autograph — the Topps
 * flagship "Autographed Rookies" lane, Contenders Rookie Ticket, Prizm
 * veteran auto parallels. Those are named in `inferIsAuto`'s own doc comment
 * as traps needing slab OCR. They do not need OCR. The checklist already
 * knows: the product's own checklist lists an auto row at #173, with its own
 * ladder (Blue /199, where the BASE Blue is /99).
 *
 * So the authority here is the CHECKLIST, per `every ingest uses the one
 * checklist format`: autos exist only where a source says signed. This module
 * answers one question — "does the checklist for (sport, year, setKey) carry
 * an auto row at this card number?" — and nothing else.
 *
 * WHAT IT DOES NOT DO
 *
 *  - It never invents. No checklist loaded, or no auto row at that number,
 *    means `false` — which leaves today's behaviour exactly as it is. A blank
 *    is UNKNOWN, never "Base" and never "auto" (`blank means unknown`).
 *  - It never overrules a prefix. The prefix rule short-circuits first in
 *    `inferIsAuto`; this only ever ADDS a positive.
 *  - It does not decide the parallel or the print run. Whether the sale is
 *    the /199 Blue auto or the unparalleled auto is the resolver's job; this
 *    decides only the auto BOUNDARY.
 *
 * CORROBORATION. A checklist saying "#173 has a signed variant" does not make
 * every #173 sale an auto — most #173 sales are the base rookie. The
 * checklist makes the auto POSSIBLE; the title's own auto words are what say
 * THIS sale is the signed one. So the checklist signal is gated on
 * corroboration by default (`requireCorroboration`), which is what keeps this
 * from re-tagging the entire base pool. A caller holding an independent
 * signal (slab OCR reading "AUTOGRAPH" off the label) can pass
 * `corroborated: true` on its own evidence.
 *
 * Pure: no I/O, no Cosmos, no clock. The checklist is INJECTED by the caller,
 * so the rule is testable against a fixture and can never reach the network
 * from inside a title parse.
 */

/** The one fact this module needs about a product's checklist: the card
 *  numbers it lists a signed row for. */
export interface ChecklistAutoIndex {
  sport: string;
  year: number;
  setKey: string;
  /** Folded card numbers carrying an auto row. Folding is the caller's, so
   *  this module never disagrees with `sameCardNumber` about identity. */
  autoCardNumbers: ReadonlySet<string>;
}

/** How a checklist index is reached for a product. Injected — a title parse
 *  must never do I/O, so the caller supplies a resolved, in-memory index. */
export type ChecklistAutoResolver = (
  key: { sport: string | null; year: number | null; setKey: string | null },
) => ChecklistAutoIndex | null;

/** The card-number fold used to compare a sale's number with the checklist's.
 *  Hyphen- and case-insensitive, matching `sameCardNumber`'s treatment
 *  (CPA-BR ≡ CPABR) so this rule and identity never disagree. */
export function foldChecklistCardNumber(cardNumber: string | null | undefined): string {
  return String(cardNumber ?? "")
    .toUpperCase()
    .replace(/^#/, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

/** Build an index from a checklist's rows. `isAuto` is the source's own
 *  statement — never inferred here, because inferring it is the very thing
 *  this module exists to stop guessing at. */
export function buildChecklistAutoIndex(
  key: { sport: string; year: number; setKey: string },
  rows: ReadonlyArray<{ cardNumber?: string | null; isAuto?: boolean | null }>,
): ChecklistAutoIndex {
  const autoCardNumbers = new Set<string>();
  for (const r of rows) {
    if (r?.isAuto !== true) continue;
    const n = foldChecklistCardNumber(r.cardNumber);
    if (n) autoCardNumbers.add(n);
  }
  return {
    sport: String(key.sport ?? "").toLowerCase(),
    year: Number(key.year),
    setKey: String(key.setKey ?? ""),
    autoCardNumbers,
  };
}

export interface ChecklistSaysAutoInput {
  sport?: string | null;
  year?: number | null;
  setKey?: string | null;
  cardNumber?: string | null;
  /** The title's own auto words, or another independent positive. */
  corroborated?: boolean;
  /** Default true: the checklist makes an auto POSSIBLE at this number, the
   *  corroborating signal says THIS sale is the signed one. Only a caller
   *  with its own evidence should turn this off. */
  requireCorroboration?: boolean;
  resolve: ChecklistAutoResolver;
}

/**
 * True when the product's checklist lists a signed row at this card number
 * (and, unless the caller opts out, something corroborates that this
 * particular sale is that row).
 *
 * False whenever we do not know — no resolver hit, no auto row, no number.
 */
export function checklistSaysAuto(input: ChecklistSaysAutoInput): boolean {
  const cardNumber = foldChecklistCardNumber(input.cardNumber);
  if (!cardNumber) return false;
  if ((input.requireCorroboration ?? true) && input.corroborated !== true) return false;

  let index: ChecklistAutoIndex | null = null;
  try {
    index = input.resolve({
      sport: input.sport ?? null,
      year: input.year ?? null,
      setKey: input.setKey ?? null,
    });
  } catch {
    // A checklist lookup that throws is an ABSENT checklist, never an auto.
    return false;
  }
  if (!index) return false;
  return index.autoCardNumbers.has(cardNumber);
}
