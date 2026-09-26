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
  // CF-R75-REDIRECT-BOTH-ANSWERS-AGREE (stamp-fix batch, 2026-09-26, defect 5
  // / C:/tmp/mega_ident_1430/RESULT.md). Same seam, same reasoning as the two
  // comments above: `slug` a few lines down is computed through
  // deps.computeHobbyIqCardId, which calls resolveSetKeyForSlug internally
  // and so already carries R75 (BOWMAN_MEGA_BOX_SPLIT_FROM_YEAR -- a bare
  // "Bowman Mega Box" title, no "chrome", year >= 2026, resolves to the
  // distinct `bowman-mega` key, not `bowman-chrome-mega-box`). Nothing above
  // this line ever called resolveSetKeyForSlug, so identity.setKey silently
  // kept answering "bowman-chrome-mega-box" for every bare 2026 Mega Box
  // title -- the exact "one function disagreeing with itself" shape
  // CF-SIBLING-CHECKLIST-DECIDES-THE-PRODUCT and CF-METAL-UNIVERSE-NAME-WAS-
  // REVIVED already exist to prevent, just never patched at this one call.
  // `setKeyRaw` (the title's own raw setName text) is what resolveSetKeyForSlug
  // needs to see "no chrome" -- passing `eraSpelled` (already folded to a
  // fixed-point key) would hide the very word the redirect keys on.
  // ONLY-IMPROVE / additive: an undeclared dep leaves eraSpelled standing
  // exactly as it was, so a caller that has not wired resolveSetKeyForSlug in
  // sees identical behavior to before this change.
  const redirected = deps.resolveSetKeyForSlug
    ? deps.resolveSetKeyForSlug(sport ?? "", setKeyRaw, cardYear ?? 0)
    : eraSpelled;
  const eraAndRedirectSpelled = deps.normalizeSetKey(redirected || eraSpelled);
  const siblingCorrected = deps.applySiblingChecklistOverride
    ? deps.applySiblingChecklistOverride(eraAndRedirectSpelled, cardNumber, cardYear ?? 0)
    : eraAndRedirectSpelled;
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

  // CF-ISAUTO-FROM-CHECKLIST-NOT-JUST-TITLE (stamp-fix batch, 2026-09-26,
  // defect 4 / C:/tmp/rootcause_1234/RESULT.md, corrected 2026-09-26 per
  // review). `parsed.isAuto` alone is ONLY a title-word reader OR'd with a
  // cardNumber-prefix reader (parseListingIdentity), which is structurally
  // blind to a signed variant that shares its base card's number with no
  // distinguishing letter prefix -- 2025 Bowman's Best (B25-xx) mints its
  // autograph rung exactly this way (5,121 of 23,383 traced base-parallel
  // sales, 21.9%, backed only at the FLIPPED isAuto value --
  // C:/tmp/bb25_trace_1530/RESULT.md). The fix is to consult the
  // checklist's own signed-row list at this card number
  // (checklistAutoLookup.ts's `checklistSaysAuto`, exposed through
  // parseTitleIdentity.service.ts's exported `inferIsAuto`) -- gated on
  // corroboration, so it can only CONFIRM a positive some other signal
  // already raised, never invent one from a bare base-card title.
  //
  // THE DOCTRINE THIS MUST NOT VIOLATE (feedback_isauto_boundary_is_not_
  // text; memory ruling "isAuto boundary is cardNumber, not text -- text on
  // card_set is HARMFUL"). `inferIsAuto` ALSO carries an earlier,
  // UNCONDITIONAL branch that reads `input.setName` against
  // AUTO_SETNAME_RE with no corroboration gate at all -- a setName
  // containing the word "Autographs" (e.g. a product-wide label a vendor
  // slapped on every row, base cards included) would flip isAuto true with
  // zero connection to THIS row's card number. That is exactly the "text on
  // card_set is HARMFUL" shape the ruling forbids, so `setName` is
  // deliberately NEVER passed to `inferIsAuto` here -- only the checklist
  // branch is reachable from this call, and it alone decides.
  //
  // ADDITIVE ONLY, DOCTRINE-COMPLIANT ONLY: an absent `inferIsAuto` dep, or
  // an absent `checklistAuto` dep, leaves `isAuto` exactly as it was (the
  // plain OR below) -- the checklist can only turn a false into a true,
  // never the reverse, and only when the checklist itself says this exact
  // cardNumber is signed.
  //
  // CORROBORATION SOURCE, STATED PLAINLY (added 2026-09-26 per review). With
  // corroboration sourced from `row.isAuto === true` ALONE, this branch can
  // only ever CONFIRM a row the plain OR below already resolves true --
  // it cannot flip a single real row, because a row with row.isAuto=false
  // and no title auto text never corroborates, so the checklist never even
  // runs. That is NOT a repair for the 5,121 Bowman's Best sales the trace
  // measured (C:/tmp/bb25_trace_1530/RESULT.md) -- those need either a
  // genuinely independent signal (slab OCR, see
  // `slabOcrVerify.service.ts`'s own `isAuto` label read, which this
  // deriver has no access to) or a direct repoint list, neither of which is
  // parser work. `row.autoCorroborated` is added below as the pass-through
  // for exactly that future independent signal -- a caller holding one
  // (e.g. an OCR pipeline) can set it on the row and this wiring uses it
  // immediately, with no further code change; today, with no caller
  // setting it, `row.isAuto` is the only corroboration source in practice
  // and this remains a confirm-only, no-op-for-real-rows wiring.
  const isAuto = deps.inferIsAuto
    ? deps.inferIsAuto({
        sport, year: cardYear, setKey, cardNumber,
        // setName is INTENTIONALLY OMITTED -- see the doctrine note above.
        titleHasAutoText: parsed.isAuto === true,
        // CORROBORATION, NOT INVENTION: the checklist only confirms an
        // autograph some INDEPENDENT signal already pointed at -- the
        // row's own STORED isAuto verdict from an earlier ingest, OR an
        // explicit `row.autoCorroborated` a caller with its own evidence
        // (slab OCR, a manual review) can set. A plain base-card title at
        // a shared number with no other signal stays non-auto, exactly as
        // `checklistAutoLookup.ts`'s own doc comment requires (most
        // #B25-GW sales are the base prospect, not the auto).
        autoCorroboration: row.isAuto === true || row.autoCorroborated === true,
        checklistAuto: deps.checklistAuto ?? null,
      })
    : (parsed.isAuto || row.isAuto === true);
  // THE ONE THING THAT LEGITIMATELY MAKES A ROW AN AUTO.
  //
  // parseListingIdentity ORs a title-word reader with the cardNumber reader
  // and returns one flag, so by the time it lands here the evidence is gone.
  // The census reported 33,283 rows flipped no-auto -> auto, 100% of them on
  // the title word alone -- a cut signature mounted with a base card reads
  // "PSA AUTHENTIC AUTO" and is still a base card. Carry the cardNumber
  // verdict out separately so the classifier can tell the two apart.
  // Scope threaded through (CF-SCOPED-AUTO-PREFIX, 2026-09-21): additive
  // only -- sport/cardYear/setKey are already resolved above this line, so
  // passing them lets product-year-scoped prefixes (2025 Topps Chrome Update
  // CRDA-/CHRU-/CLA-, etc.) resolve here exactly as they do on the service
  // path, without changing behavior for any other product-year.
  const autoByCardNumber = deps.isCardNumberAutoSubset
    ? !!deps.isCardNumberAutoSubset(cardNumber, { sport, year: cardYear, setKey })
    : false;
  // CF-A-STATED-PARALLEL-IS-NEVER-EVICTED-TO-BASE (post-wave audit,
  // 2026-09-15).
  //
  // THE DEFECT. This line used to read `parsed.parallel || row.parallel ||
  // "Base"`, and `parsed.parallel` is the string "Base" -- truthy -- whenever
  // the parser could not name a rung. So a title that STATES a parallel the
  // parser could not resolve derived Base, discarding both the title's
  // evidence and the row's own stored field. Measured in the 1,300-row
  // post-wave audit: the largest single sports CONFLICT pattern at 95 of 400
  // sampled rows ("stored is right, the deriver drops it"), plus 41 more on
  // the AGREE side where both sides say Base and the census cannot see them.
  //
  //   "2025 Panini Rookies & Stars Football #28 Silver"  stored Silver -> Base
  //   "2026 Topps Baseball #282 Wood"                    stored Wood   -> Base
  //   "2025 Panini Mosaic Football #79 Purple Scope"     stored ...    -> Base
  //
  // WHY BASE IS NOT A SAFE DEFAULT. Base is a CLAIM, not an absence: it names
  // the unparalleled card, which has its own pool, its own print run and its
  // own price curve. Answering it for a title reading "Purple Scope" does not
  // lose information, it files the sale on a different card -- the pool-split
  // shape `feedback_one_card_one_row_one_pool` names.
  //
  // THE ORDER, AND WHY IT IS THIS ORDER. The title is the evidence, so a rung
  // the parser NAMED still wins. Below that the row's own stored parallel is
  // better evidence than a manufactured Base -- it is what an earlier writer
  // read from this same sale. Only when the title states nothing and the row
  // stores nothing is Base the honest answer.
  //
  // `unknown` rather than null: the classifier's GENERIC_PARALLELS already
  // carries it and axisIsBlank already treats it as blank, so a withheld
  // parallel reads as ABSENT on the diff rather than as a named rung. Emitting
  // a novel sentinel would read as `changed:parallel` and trip R26's
  // identity-axis-moved guard; emitting null would be coerced back to "Base"
  // by the `||` chain this comment exists to remove.
  const parsedNamedARung = parsed.parallel && !/^base$/i.test(parsed.parallel);
  const parallelBeforeSpelling = parsedNamedARung
    ? parsed.parallel
    : parsed.parallelIsUnconfirmed
      ? (row.parallel || "unknown")
      : (parsed.parallel || row.parallel || "Base");

  // CF-THE-CHECKLIST-SPELLS-ITS-OWN-RUNGS (round-2 ladder probe, 2026-09-15).
  //
  // 938,802 sports rows name a parallel the checklist DOES back, under a
  // longer spelling: the pool writes `Silver`, the 2025 panini-prizm checklist
  // says `Silver Prizms`. Those are one card. The single largest gap cell --
  // baseball|2025|panini-prizm, 333,931 rows -- is 100% this, and an acquirer
  // sent there would buy a ladder we already own.
  //
  // ONLY WHEN THE PRODUCT'S OWN CHECKLIST IS UNAMBIGUOUS. Exactly one rung may
  // extend the stated finish, and only by the product's stock word
  // (Prizm/Refractor/Holo...). `Blue` on that same product has FOUR candidates
  // (Blue Ice / Blue / Blue Pulsar / Blue Shimmer FOTL Prizms) and is left
  // exactly as written -- a tie is the product really having four rungs, not a
  // spelling for us to pick between.
  //
  // Never Base, never a sibling product's rung, never a changed colour: an
  // adoption is a strict extension of the text the row already carried.
  const adopted = deps.checklistSpellingFor
    ? deps.checklistSpellingFor(parallelBeforeSpelling, {
        sport: guard.sport, year: cardYear, setKey,
      })
    : null;
  if (adopted && deps.noteSpellingAdopted) deps.noteSpellingAdopted();
  const parallelBeforeMarketLanguage = adopted || parallelBeforeSpelling;
  // CF-SCOPED-MARKET-LANGUAGE (2026-09-21): additive only, same shape as
  // autoByCardNumber's scope pass above -- sport/cardYear/setKey are already
  // resolved by here, so a product-year-scoped alias ("Blue Sapphire" ->
  // Base, ONLY on the verified no-Blue-rung Sapphire product-years) can be
  // seen. A miss (dep not injected, or no table entry for this scope) leaves
  // parallelBeforeMarketLanguage exactly as it was.
  const marketLanguageAlias = deps.scopedMarketLanguageAlias
    ? deps.scopedMarketLanguageAlias(parallelBeforeMarketLanguage, { sport: guard.sport, year: cardYear, setKey })
    : null;
  const parallel = marketLanguageAlias || parallelBeforeMarketLanguage;
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