/** The identity the row CARRIES today, read from its own stored fields. */
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
  // CF-SIBLING-CHECKLIST-DECIDES-THE-PRODUCT (#2060 follow-on). `identity`
  // below is what the census/classifier compares against the row's STORED
  // fields, and `slug` further down is computed independently through
  // deps.computeHobbyIqCardId, which already applies this same override
  // internally. Without applying it here too, a title reading "Bowman Chrome
  // ... CPA-MG" would derive identity.setKey = "bowman-chrome" while its own
  // slug's setKey segment says "bowman" -- one function disagreeing with
  // itself. Applying it at this ONE seam keeps both answers in agreement, the
  // same discipline CF-THE-YEAR-DOES-NOT-SPLIT-THE-PRODUCT states for the
  // interposed-year lift.
  // CF-METAL-UNIVERSE-NAME-WAS-REVIVED (#2060 follow-on). Same reasoning:
  // computeHobbyIqCardId's slug already runs spellForEra via
  // resolveSetKeyForSlug, so identity.setKey has to run it too or a vintage
  // "Skybox Metal Universe" title would derive identity.setKey =
  // "skybox-metal-universe" while its own slug says "metal-universe".
  const eraSpelled = deps.spellForEra
    ? deps.spellForEra(deps.normalizeSetKey(setKeyRaw), cardYear ?? null)
    : deps.normalizeSetKey(setKeyRaw);
  const siblingCorrected = deps.applySiblingChecklistOverride
    ? deps.applySiblingChecklistOverride(eraSpelled, cardNumber, cardYear ?? 0)
    : eraSpelled;
  // RULING R29 (Drew, 2026-09-13): THE CHECKLIST DECIDES THE PRODUCT.
  //
  // THE SAME DECISION THE SERVICE PATH MAKES, READ FROM A MAP RATHER THAN
  // RE-ASKED. `deriveIdentity` is synchronous and six census/rematch call
  // sites depend on that; the resolver is a catalog read. Making this function
  // async would turn a one-seam change into a rewrite of every fleet driver --
  // so the CALLER resolves products for its batch (one bounded, cached,
  // indexed read per distinct year+product+number, never per row) and hands
  // the answers down as a plain Map. The decision is identical because it is
  // literally the same resolver's output; only the moment it was computed
  // differs. tests/r29DeriverParity.test.ts proves the two paths agree on the
  // 1,000-row fixture rather than asserting it here.
  //
  // ONLY-IMPROVE, exactly as on the service path: a miss leaves the parser's
  // answer standing, so this can make a product more specific and never less.
  // The KEY is built by the shared helper (productResolutionKey), injected as
  // a dep, so the two paths cannot drift on the string that joins them.
  const r29 = deps.resolvedProducts && deps.productResolutionKey
    ? deps.resolvedProducts.get(deps.productResolutionKey(cardYear ?? 0, siblingCorrected, cardNumber))
    : null;
  const setKey = r29 || siblingCorrected;

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