/**
 * finish-collision-refile.cjs -- the TITLE's finish wins when the checklist
 * backs it.
 *
 * CF-FINISH-FAMILY-COLLISION (Drew's ruling, 2026-09-05).
 *
 * ── THE RULING ──────────────────────────────────────────────────────────────
 *
 * A sold_comps row whose TITLE names a finish/parallel the stored slug lacks
 * -- "Gold Shimmer /50" stored as `gold-refractor`, "Ray Wave" stored as
 * `base`, a Blue Ray Wave stored as `blue-ray-wave` -- is a sale of the card
 * the TITLE names, provided two things hold:
 *
 *   the title-stated identity is CHECKLIST-BACKED, and
 *   the stored row is not user-verified / ruled.
 *
 * The seller held the card and wrote what was on it. Our slug is a derivation.
 * When the checklist independently lists the card the seller described, the
 * derivation is the thing that was wrong.
 *
 * ── WHY THE REMATCH CANNOT DO THIS, AND STILL CANNOT ────────────────────────
 *
 * #1790 widened `finishFamilyCollision` in lib/rematch-classify.cjs so the
 * census can SEE this population (it now reads the `hiq:` address from
 * whichever of `cardId` / `hobbyiqCardId` carries one -- 59% of a 5,000-row
 * sample was vendor-keyed and invisible before). It stays REPORT-ONLY inside
 * the rematch, permanently, and this lane does not change that:
 *
 *   - `finishFamilyCollision` sets a TAG and a COUNT. It never sets `writable`.
 *   - SPECIALIZATION-STATED moves `setKey` only, and its L4 leg explicitly
 *     REFUSES any row whose `parallel` axis moves. It cannot express a
 *     parallel change within one product, and loosening it would let a
 *     product-ladder move drag a parallel along.
 *
 * So the fleet neither moves these rows nor is asked to. This is a TARGETED
 * lane over a NAMED scope, with the checklist -- not a heuristic -- as the
 * thing that decides. It reuses the classifier's own title reader rather than
 * re-implementing it, for the reason every one of these lanes states: a second
 * copy of a predicate is a second source of truth that drifts from the first,
 * and the pins would then pin the copy rather than the code the census ran.
 *
 * ── THE FIVE ASSERTIONS, ALL REQUIRED ───────────────────────────────────────
 *
 * A1  THE CLASSIFIER FLAGGED IT. `K.finishFamilyCollision` must return
 *     `qualifies: true` for this row. Not a re-reading of the title here --
 *     THE SAME FUNCTION the census runs, called with the same arguments. Its
 *     evidence (`addressField` / `addressSlug` / `family` / `titleFamilyWords`)
 *     is carried onto the moved row verbatim.
 *
 * A2  ONLY THE FINISH AXES MOVE. The destination is computed from the
 *     CHECKLIST'S OWN parallel name (see A3) through the live
 *     `normalizeParallel` + `computeHobbyIqCardId`, and it must differ from the
 *     stored slug on the `parallel` and `num-` segments ALONE. sport, year,
 *     setKey, subset, cardNumber and the auto flag must be byte-identical. A
 *     destination that moves any of those is a rival reading of WHICH CARD this
 *     is, and this lane has no authority over that question -- SKIP.
 *
 * A3  THE DESTINATION IS CHECKLIST-BACKED. The parallel the title names must be
 *     one this product's checklist LISTS (`checklistParallelForFamily`, the
 *     corpus reader), and the destination slug must carry a catalog row from a
 *     strict checklist source, read cardYear-aware (`year` OR `cardYear` --
 *     CF-CARDYEAR-ABSENT-HIDES-CHECKLISTS, #1769). Either half missing is a
 *     SKIP with the reason named, never a move.
 *
 * A4  THE ROW IS NOT PROTECTED. `K.provenanceTier(row).tier === AUTO`. A
 *     user-verified row, an `ebay-user-purchase`, a row carrying a ruling
 *     marker or a `drew-ruling` relocation reason is REPORT-ONLY FOREVER
 *     (CF-RULED-AND-USER-ROWS-ARE-REPORT-ONLY-FOREVER). The tier comes from the
 *     classifier, not from a local source list, so a source added to the
 *     protected set protects this lane the same day.
 *
 * A5  THE FINISH IS NOT A DIFFERENT CARD FAMILY AT THE SAME NUMBER. A word can
 *     name a PARALLEL of the base card or an INSERT SET that reuses the number.
 *     When the destination product's checklist lists the title's finish word
 *     under a `subsetName` -- i.e. the same (year, setKey, cardNumber) is named
 *     by both a parallel row and a differently-subsetted row -- the two are
 *     different cards and the title does not say which. AMBIGUOUS IS A SKIP.
 *
 * ── WHAT THIS LANE DELIBERATELY WILL NOT DO ─────────────────────────────────
 *
 * It will not move a row whose stored slug's parallel segment carries no
 * COLOUR FAMILY, because `finishFamilyCollision` -- A1 -- does not flag those.
 * Measured on the live pool 2026-09-05, a "Ray Wave" title stored as `base`
 * returns `qualifies: false, family: null`: the predicate is defined as one
 * colour, several parallels, and a base slug names no colour. That population
 * is real (`familyTokensDroppedByDerivation` sees it) and it is NOT this
 * lane's, because the ruling's own evidence -- the classifier's verdict -- does
 * not name it. A lane that quietly widened past its own first assertion would
 * be a lane with four assertions.
 *
 * ── THE WRITE ───────────────────────────────────────────────────────────────
 *
 * relocateSoldComp (upsert the keeper, read it back, THEN delete the old row --
 * CF-A-SALE-IS-NEVER-LOST), both identity fields landed because the exact-pool
 * reader ORs them, the rekeyedFrom/At/Reason ledger with the QUOTED TITLE as
 * evidence, verify-by-read on both keys, and canary anchors asserted
 * write-free in report mode.
 *
 * The pure decision lives HERE so the tests pin the code that runs.
 */
"use strict";

const path = require("path");
const K = require(path.join(__dirname, "rematch-classify.cjs"));

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();

/** The reason string stamped on every moved row and read by the revert lane. */
const REASON = "finish-collision-the-title-wins-when-the-checklist-backs-it";
const REASON_LONG =
  "CF-FINISH-FAMILY-COLLISION (Drew, 2026-09-05): the row's TITLE names a finish the stored slug lacks, "
  + "the title-stated identity is CHECKLIST-BACKED, and the stored row is neither user-verified nor ruled -- "
  + "so the TITLE wins and the sale is refiled onto the card the seller described";

/**
 * The slug segments this lane is ALLOWED to move, by NAME.
 *
 * A slug is `hiq:sport:year:setKey[:sub-X]:cardNumber:parallel:autoFlag[:num-N]`.
 * `parallel` and the `num-` tail describe the FINISH; every other segment names
 * WHICH CARD this is. This set is the whole of A2, and the mutation check
 * reverts exactly it.
 */
const MOVABLE_SEGMENTS = new Set(["parallel", "printRun"]);

/**
 * Decompose an `hiq:` slug into NAMED parts, locating the auto flag by VALUE
 * rather than by index so a `sub-` segment survives. Returns null when the
 * value is not one of our slugs.
 *
 * Deliberately the same shape reslug-ruled-alias uses, and deliberately NOT a
 * fixed length: a subset-bearing slug is a real slug and a lane that refused it
 * silently would under-sweep.
 */
function slugParts(id) {
  const parts = str(id).split(":");
  if (parts.length < 7) return null;
  if (parts[0] !== "hiq") return null;
  if (!parts[1]) return null;
  if (!/^\d{4}$/.test(parts[2])) return null;
  if (!parts[3]) return null;
  const autoAt = parts.findIndex((p, i) => i >= 5 && (p === "auto" || p === "no-auto"));
  if (autoAt < 0) return null;
  const tail = parts.slice(autoAt + 1);
  const numSeg = tail.find((t) => /^num-\d+$/.test(t));
  return {
    sport: parts[1],
    year: parts[2],
    setKey: parts[3],
    // Everything between the setKey and the cardNumber is the subset segment.
    // It is part of the identity and this lane never touches it. The bound is
    // `autoAt - 2` and not `autoAt - 1`: the two segments immediately before
    // the auto flag are the cardNumber and the parallel, and a slice that
    // swallowed the cardNumber would report a cardNumber CHANGE as a subset
    // change -- which A2 also refuses, but under the wrong name.
    subset: parts.slice(4, autoAt - 2).join(":"),
    cardNumber: parts[autoAt - 2],
    parallel: parts[autoAt - 1],
    autoFlag: parts[autoAt],
    printRun: numSeg ? numSeg.slice(4) : "",
    // Any other tail segment (a grade tier, say) is identity too.
    otherTail: tail.filter((t) => !/^num-\d+$/.test(t)).join(":"),
    raw: str(id),
  };
}

/**
 * WHICH NAMED SEGMENTS DIFFER between two slugs. The whole of A2 in one
 * function, so a pin can drive it alone and the mutation check can revert it
 * alone.
 *
 * Returns `{ ok, differing, reason }`. `ok` is true only when at least one
 * segment differs AND every differing segment is in MOVABLE_SEGMENTS -- a
 * destination identical to the stored slug is not a move, and a destination
 * that moves `cardNumber` is a rival reading of the card.
 */
function segmentsThatDiffer(storedSlug, destSlug) {
  const a = slugParts(storedSlug);
  const b = slugParts(destSlug);
  if (!a) return { ok: false, differing: [], reason: "stored-slug-malformed" };
  if (!b) return { ok: false, differing: [], reason: "destination-slug-malformed" };
  const names = ["sport", "year", "setKey", "subset", "cardNumber", "parallel", "autoFlag", "printRun", "otherTail"];
  const differing = names.filter((n) => str(a[n]) !== str(b[n]));
  if (!differing.length) return { ok: false, differing, reason: "destination-equals-stored" };
  const illegal = differing.filter((n) => !MOVABLE_SEGMENTS.has(n));
  if (illegal.length) {
    return { ok: false, differing, reason: `identity-segments-move:${illegal.join(",")}` };
  }
  return { ok: true, differing, reason: null };
}

/**
 * THE CHECKLIST'S OWN NAME for the card the title describes, or null.
 *
 * WHY THIS IS NOT `VOCAB.checklistParallelForFamily`. That function answers a
 * REFUSING question on the IMPROVE side -- "does this product list ANY parallel
 * carrying every family word the title names" -- and it takes the SHORTEST such
 * name, because the corpus's long names are pack-size noise. Its colour test is
 * one-directional: every colour in the NAME must be in the title, so an
 * uncoloured name passes trivially.
 *
 * That is exactly wrong as a DESTINATION. Measured against the live corpus
 * 2026-09-05, the Marconi German title ("Gold Shimmer /50", family `gold`) on
 * 2026 bowman-chrome:
 *
 *   checklistParallelForFamily  ->  "shimmer refractor"      <- the colour gone
 *   this function              ->  "gold shimmer refractor"  <- the card
 *
 * Refiling onto `shimmer-refractor` would move a Gold Shimmer sale into the
 * uncoloured Shimmer pool: one card, still two pools, and now with our
 * fingerprints on it. So the destination name must carry the collision's COLOUR
 * FAMILY as well as every family word the title states, and the shortest name
 * satisfying BOTH is the answer. When no listed name carries both, there is no
 * destination and the row is skipped -- the corpus's silence is a refusal, not
 * a licence to compose a parallel of our own
 * (CF-NO-SYNTHETIC-PARALLELS-ONLY-ACTUALS).
 *
 * `names` is the product's listed parallel names (the caller passes
 * `VOCAB.checklistParallelNamesFor(year, setKey)`, or null when the corpus
 * carries no such product); `family` is the collision's colour;
 * `titleFamilyTokens` the family words the title names
 * (`VOCAB.titleFinishFamilyTokens`); `parallelTokensOf` the same reader applied
 * to a candidate name (`VOCAB.parallelFinishFamilyTokens`), passed in so this
 * module stays free of the corpus and the pins can drive it with a stub.
 */
function checklistNameForCollision({ names, family, titleFamilyTokens, parallelTokensOf, titleWords }) {
  if (!names || !family) return null;
  const want = [...new Set((titleFamilyTokens ?? []).map(lower))];
  if (!want.length) return null;
  const inTitle = new Set((titleWords ?? []).map(lower));
  let best = null;
  for (const n of names) {
    const name = lower(n);
    const words = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
    // THE COLOUR IS REQUIRED, not merely permitted. This is the half
    // `checklistParallelForFamily` deliberately does not have.
    if (!words.has(lower(family))) continue;
    const have = new Set((parallelTokensOf ? parallelTokensOf(n) : []).map(lower));
    if (!want.every((t) => have.has(t))) continue;
    // Any OTHER colour the name states must also be in the title, or a
    // "Gold Shimmer" title would be offered "Gold Green Shimmer".
    const otherColours = [...words].filter((w) => w !== lower(family) && K.FAMILY_COLOURS.has(w));
    if (!otherColours.every((c) => inTitle.has(c))) continue;
    // The SHORTEST match, for the reason the corpus reader states: the long
    // names are pack-size and channel noise suffixed onto the real one.
    if (!best || name.length < lower(best).length) best = n;
  }
  return best;
}

/**
 * A5 -- IS THE TITLE'S FINISH WORD AMBIGUOUS AT THIS NUMBER?
 *
 * THE SHAPE THIS GUARD EXISTS FOR. A finish word can name a PARALLEL of the
 * base card, or an INSERT SET that happens to reuse the number. "Ray Wave" on
 * `topps-chrome #196` is a parallel; a product that also lists a subsetted
 * card at #196 numbers TWO cards under that address, and the title's finish
 * word does not say which of them the seller held. The two have different
 * price curves, so a wrong guess is a wrong FMV in a pool that looks healthy.
 *
 * WHAT IS ASKED, AND WHY IT IS ASKED THIS WAY. `subsettedNamesAtNumber` is the
 * distinct `subsetName`s the product's STRICTLY-SOURCED checklist carries at
 * this cardNumber, with BLANK EXCLUDED -- blank means unknown, never "Base"
 * (CF-EVERY-INGEST-USES-THE-ONE-CHECKLIST-FORMAT). One subsetted row at the
 * number is already enough: a parallel row carries no subsetName, so a
 * subsetted row sharing the number means the number is shared by two card
 * families. That is why ONE is the threshold here and TWO is the threshold in
 * the census's own `clashMap` -- the census compares subsetted rows against
 * each other, this compares them against the unsubsetted parallel the lane is
 * moving a row ONTO.
 *
 * (Asking it this way is also what makes the guard affordable. Reading every
 * catalog row of a product to group them by number is 415,625 rows and 14,666
 * RU on 2025 topps-chrome, measured 2026-09-05; the range predicate
 * `subsetName > ''` that answers the same question is 10,123 rows and 628 RU.
 * CF-FLEET-SCRIPTS-MEASURE-THROUGHPUT-BEFORE-DISPATCH.)
 *
 * `productHasStrictRows` false means the question COULD NOT BE ASKED -- the
 * product has no strictly-sourced checklist rows at all, so "no subsetted row
 * at this number" is not evidence of anything. Unanswered is a REFUSAL,
 * exactly as L5's coverage gate treats it: absent beats wrong. A caller that
 * cannot answer passes false and every row of that product is skipped.
 *
 * Returns `{ ambiguous, reason }`.
 */
function finishIsAmbiguousAtNumber({ subsettedNamesAtNumber, productHasStrictRows }) {
  if (!productHasStrictRows) {
    return { ambiguous: true, reason: "checklist-cannot-answer-subset-clash" };
  }
  const distinct = new Set([...(subsettedNamesAtNumber ?? [])].map(lower).filter(Boolean));
  if (distinct.size >= 1) {
    return { ambiguous: true, reason: `finish-word-names-two-card-families:${[...distinct].sort().slice(0, 3).join("|")}` };
  }
  return { ambiguous: false, reason: null };
}

/**
 * THE WHOLE PER-ROW DECISION, as a pure function, so the pins can drive it
 * without a container and without a Cosmos client.
 *
 * The catalog facts the caller must supply, because this module is pure and
 * must not require dist/ or read Cosmos:
 *
 *   destSlug            the destination, built by the caller from the
 *                       CHECKLIST'S parallel name through the live
 *                       normalizeParallel + computeHobbyIqCardId, or null when
 *                       the checklist names no parallel for the title's family
 *   checklistParallel   the checklist's own NAME for that parallel, quoted in
 *                       the evidence (null when there is none)
 *   destBacked          does the destination slug carry a catalog row from a
 *                       STRICT checklist source (cardYear-aware)?
 *   subsettedNamesAtNumber
 *                       the distinct non-blank subsetNames the product's
 *                       strictly-sourced checklist carries at this cardNumber
 *   productHasStrictRows
 *                       does the product have ANY strictly-sourced checklist
 *                       rows? false means A5 cannot be asked, and that is a
 *                       refusal
 *
 * Returns `{ move, reason, dest, evidence }`. `move: false` always carries the
 * reason the report groups by; there is no silent skip.
 */
function planFinishCollisionRefile({
  row, stored, derived = null, storedSlug = null,
  destSlug = null, checklistParallel = null, destBacked = false,
  subsettedNamesAtNumber = null, productHasStrictRows = false,
}) {
  // A1 -- THE CLASSIFIER'S OWN VERDICT, not a re-reading of the title here.
  const collision = K.finishFamilyCollision({
    row, storedSlug: storedSlug ?? row?.cardId, stored, derived,
  });
  const ev = {
    ...collision.evidence,
    checklistParallel: checklistParallel ? str(checklistParallel) : null,
    rule: REASON_LONG,
  };
  if (!collision.qualifies) {
    return { move: false, reason: "not-a-finish-family-collision", dest: null, evidence: ev };
  }

  // A4 -- PROTECTED IS REPORT-ONLY FOREVER. Asked EARLY, so a protected row can
  // never reach the write shape even if every other assertion holds. The tier
  // comes from the classifier's own predicate, so a source added to the
  // protected set protects this lane the same day.
  const prov = K.provenanceTier(row);
  if (prov.tier !== K.AUTO) {
    return {
      move: false,
      reason: `protected:${prov.reasons.join("+") || "unknown"}`,
      dest: null,
      evidence: { ...ev, provenanceReasons: prov.reasons },
    };
  }

  // A3a -- the CHECKLIST must name a parallel for the title's family. No name,
  // no destination, no move. The corpus is the authority and its silence is a
  // refusal, never a licence to mint a parallel of our own
  // (CF-NO-SYNTHETIC-PARALLELS-ONLY-ACTUALS).
  if (!checklistParallel || !destSlug) {
    return { move: false, reason: "checklist-names-no-parallel-for-this-family", dest: null, evidence: ev };
  }

  // A2 -- ONLY THE FINISH AXES MOVE.
  const seg = segmentsThatDiffer(storedSlug ?? row?.cardId ?? ev.addressSlug, destSlug);
  // The address the collision was quoted against is the one compared, because
  // that is the address the pool reader finds this sale under. `addressSlug`
  // is the classifier's answer to "which field carries the hiq: slug".
  const segFromAddress = segmentsThatDiffer(ev.addressSlug, destSlug);
  const use = segFromAddress.ok || !seg.ok ? segFromAddress : seg;
  if (!use.ok) {
    return { move: false, reason: `axis-refusal:${use.reason}`, dest: null, evidence: { ...ev, differingSegments: use.differing } };
  }

  // A3b -- the DESTINATION must be checklist-backed. A parallel the corpus
  // lists but the catalog does not carry at this exact identity is a slug we
  // would be minting, and a match proves nothing unless checklist-backed.
  if (!destBacked) {
    return { move: false, reason: "destination-not-checklist-backed", dest: destSlug, evidence: ev };
  }

  // A5 -- AMBIGUOUS IS A SKIP.
  const amb = finishIsAmbiguousAtNumber({ subsettedNamesAtNumber, productHasStrictRows });
  if (amb.ambiguous) {
    return { move: false, reason: `ambiguous:${amb.reason}`, dest: destSlug, evidence: ev };
  }

  return {
    move: true,
    reason: null,
    dest: destSlug,
    evidence: { ...ev, differingSegments: use.differing },
  };
}

module.exports = {
  REASON, REASON_LONG, MOVABLE_SEGMENTS,
  slugParts, segmentsThatDiffer, finishIsAmbiguousAtNumber,
  checklistNameForCollision,
  planFinishCollisionRefile,
};
