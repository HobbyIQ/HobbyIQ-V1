// rematch-derive-identity.cjs -- THE DERIVATION, extracted out of
// rematch-sold-comps.cjs (2026-09-11, run 34360565942 follow-up).
//
// CF-A-DERIVATION-STAMP-MUST-NOT-HASH-PLUMBING. derivation-version.cjs hashes
// a small set of files into the I9 reference's "derivation stamp" -- the
// thing that answers "would two measurements have been produced by the same
// code?" Before this file existed, `scripts/rematch-sold-comps.cjs` was
// hashed WHOLE, so a change to ANYTHING in that file -- the worker pool's
// concurrency, the write ledger, the budget clock, finishLane's exit code --
// invalidated the I9 reference exactly as if the row's VERDICT had changed,
// even though none of that plumbing decides AGREE/IMPROVE/CONFLICT/
// UNDERIVABLE or the slug a row derives to.
//
// So the two functions that actually DECIDE a derivation -- `storedIdentity`
// (what the row's own stored fields say) and `deriveIdentity` (what today's
// parser + matcher would say from the title) -- live here, alone, pure (no
// Cosmos, no clock, no I/O beyond what `deps` is handed), and
// `derivation-version.cjs`'s DERIVATION_INPUTS hashes THIS file instead of
// the whole rematch-sold-comps.cjs. rematch-sold-comps.cjs still exports both
// names (re-exported from here) so no caller -- the apply loop, the revert
// loop, or a test that does `require(".../rematch-sold-comps.cjs").deriveIdentity`
// -- has to change.
//
// THE OLD DERIVATION_INPUTS ENTRY this replaces was the literal string
// "scripts/rematch-sold-comps.cjs" (the whole file). See
// tests/derivationStampNarrowedToIdentity.test.ts for the two properties this
// split exists to prove: a plumbing-only change to rematch-sold-comps.cjs no
// longer moves the stamp, and a one-token change to deriveIdentity still does.

/** The row's OWN stored identity -- no title reading, no parser. */
function storedIdentity(row, deps) {
  return {
    sport: row.sport ?? null,
    cardYear: row.cardYear ?? null,
    setKey: row.setName ? deps.normalizeSetKey(String(row.setName)) : "",
    cardNumber: row.cardNumber ?? null,
    parallel: row.parallel ?? null,
    isAuto: row.isAuto === true,
    printRun: row.printRun ?? null,
    gradeCompany: row.gradeCompany ?? null,
    gradeValue: row.gradeValue ?? null,
  };
}

/**
 * The identity today's parser + matcher produce for this row. Returns
 * { ok, identity, slug, reasons }.
 *
 * The title is the evidence; the stored raw fields fill only what the title
 * does not say. A blank title cannot be re-derived -- absent beats wrong.
 * The slug guard is the same one the live writers use, so a derivation this
 * function accepts is one the pool would accept from an ingest today.
 */
function deriveIdentity(row, deps) {
  const title = String(row.title ?? "").trim();
  if (!title) return { ok: false, reasons: ["no-title"] };

  const parsed = deps.parseListingIdentity(title, undefined, {
    vertical: row.sport ?? null,
    hobbyiqCardId: row.hobbyiqCardId ?? row.cardId ?? null,
  });
  // Grade lives in the fields AND the child slug. ingestGradeFromTitle is the
  // one reader the write path uses; a title stating no grade yields RAW, which
  // is an answer -- but it must never demote a row that STORES a grade, so the
  // stored grade wins when the title is silent.
  const g = deps.ingestGradeFromTitle(title);
  const gradeCompany = g.gradeCompany ?? row.gradeCompany ?? null;
  const gradeValue = g.gradeValue ?? (g.gradeCompany ? null : row.gradeValue ?? null);

  const sportRaw = deps.inferSportFromTitle(title, "");
  const sport = deps.normalizeSportStrict(sportRaw) ?? deps.normalizeSportStrict(row.sport);
  const cardYear = deps.extractYearFromTitle(title) ?? (row.cardYear ?? null);
  const cardNumber = parsed.cardNumber ?? row.cardNumber ?? "";
  const setKeyRaw = deps.inferSetKeyFromTitle(title, cardNumber) || row.setName || "";
  const setKey = deps.normalizeSetKey(setKeyRaw);

  // CF-BOWMAN-DEFAULT-NOT-EVIDENCE + CF-UNKNOWN-IS-ALSO-A-GUESS: the parser's
  // fallbacks are guesses, not readings, and a guess that passes the guard is
  // a confident wrong slug -- exactly what this census exists to find, not to
  // create. Both stay UNDERIVABLE for a later pass with a better vocabulary.
  if (setKey.startsWith("bowman") && !/bowman/i.test(title)) return { ok: false, reasons: ["setkey-bowman-default-unsupported"] };
  if (setKey === "unknown" || setKey === "") return { ok: false, reasons: ["setkey-unknown-unsupported"] };

  const guard = deps.guardSlugInputs({ sport, year: cardYear, normalizedSetKey: setKey, cardNumber, playerName: row.playerName ?? null });
  if (!guard.ok) return { ok: false, reasons: guard.reasons.map((r) => `guard:${r}`) };

  const isAuto = parsed.isAuto || row.isAuto === true;
  // THE ONE THING THAT LEGITIMATELY MAKES A ROW AN AUTO.
  //
  // parseListingIdentity ORs a title-word reader with the cardNumber reader
  // and returns one flag, so by the time it lands here the evidence is gone.
  // The census reported 33,283 rows flipped no-auto -> auto, 100% of them on
  // the title word alone -- a cut signature mounted with a base card reads
  // "PSA AUTHENTIC AUTO" and is still a base card. Carry the cardNumber
  // verdict out separately so the classifier can tell the two apart.
  const autoByCardNumber = deps.isCardNumberAutoSubset ? !!deps.isCardNumberAutoSubset(cardNumber) : false;
  const parallel = parsed.parallel || row.parallel || "Base";
  const printRun = parsed.printRun ?? row.printRun ?? null;
  const identity = { sport: guard.sport, cardYear, setKey, setNameRaw: setKeyRaw, cardNumber, parallel, isAuto, printRun, gradeCompany, gradeValue };
  const slug = deps.computeHobbyIqCardId({
    sport: guard.sport, year: cardYear, setKey: setKeyRaw, cardNumber, parallel, isAuto, printRun,
    playerName: row.playerName ?? null, gradeCompany, gradeValue,
  });

  // The BASE destination for this same card: the identity as derived, with the
  // parallel forced to Base and the print run dropped. A parallel's print run
  // belongs to the parallel -- a base card that is not serial-numbered must not
  // carry `/499` to its base slug, or the eviction lands on a slug that names a
  // numbered base card the checklist may never list. Everything else (set,
  // number, auto flag, grade) is the row's own and travels unchanged.
  const baseSlug = deps.computeHobbyIqCardId({
    sport: guard.sport, year: cardYear, setKey: setKeyRaw, cardNumber, parallel: "Base", isAuto,
    printRun: null, playerName: row.playerName ?? null, gradeCompany, gradeValue,
  });
  const baseIdentity = { ...identity, parallel: "Base", printRun: null };
  return { ok: true, identity, slug, baseSlug, baseIdentity, autoByCardNumber, reasons: [] };
}

module.exports = { storedIdentity, deriveIdentity };
