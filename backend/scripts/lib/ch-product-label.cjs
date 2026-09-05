"use strict";
/**
 * ch-product-label.cjs -- the rule that says "this sale wears its PRODUCT's
 * label, and its own title never agreed".
 *
 * CF-THE-ENGINE-CONSUMES-CH-SALES-NOT-CH-PRODUCT-FIELDS, at the keying step.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * CardHedge's catalog labels product 1778540428361x447194681698603460 "Black &
 * White Red Ink". Our historical backfill fetched every SALE of that product
 * and stamped the PRODUCT's label onto each one, then slugged hobbyiqCardId
 * from the stamped label. So 56 plain base-auto sales -- titles like "2026
 * Bowman Victor Figueroa Chrome Auto Autograph 1st Prospect #CPA-VF Orioles -
 * Raw", median $10, not one of them saying red ink, shimmer or B&W, two of
 * them saying BASE outright -- carry
 *
 *     hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto
 *
 * exactPoolReader ORs cardId and hobbyiqCardId, so those $10 base autos price
 * the same card as Drew's genuine $270 Red Ink purchase. One card, two
 * readings, one pool.
 *
 * ── WHY THE REMATCH CANNOT REPAIR THEM ──────────────────────────────────────
 *
 * The rematch classifier derives all 56 to ...:cpa-vf:base:auto -- correctly,
 * and that destination is checklist-backed with 101 rows -- and then lands
 * CONFLICT / writable:false. Base-eviction guard 2
 * (stored-parallel-names-a-finish) is DOING ITS JOB: the stored parallel field
 * says "Black & White Red Ink", which is a finish, and a populated stored
 * parallel is exactly what guard 2 defends. No armed class writes CONFLICT.
 *
 * That guard is not loosened here, and must not be. It protects the general
 * case -- a row whose stored parallel is a real finish somebody entered. What
 * this lane adds is a NARROWER predicate that guard 2 has no way to see: the
 * stored parallel is not somebody's reading of this sale at all, it is the
 * VENDOR PRODUCT's label, copied onto every sale of that product by a writer
 * that never read the title. Five assertions, all required, all named.
 *
 * ── THE ROOT CAUSE IS ALREADY CLOSED ────────────────────────────────────────
 *
 * historicalBackfill.service.ts learned `parallelForVendorSale` in 797376b
 * (2026-09-04 19:29 EDT), and chRowToSoldComp.ts learned the same rule on the
 * CH-daily path before it. Verified against the live rows: every one of the 56
 * was written at or before 2026-09-04T16:58Z, six and a half hours BEFORE that
 * commit existed, and prod deployed it at 2026-09-05T00:04Z. So this is STORED
 * damage from a root that is shut, not an ongoing leak -- which is why the
 * lane is a one-off repair and not a guard.
 *
 * Run `parallelTheTitleAllows` over the 56 titles today and it returns
 * `parallel: null` (i.e. Base) with `vendorTagOverruled: "Black & White Red
 * Ink"` for every one. The write-time rule and this repair agree; the repair
 * exists only because the fixed rule cannot reach a row already written.
 *
 * ── THE FIVE ASSERTIONS ─────────────────────────────────────────────────────
 *
 * A row is REKEYABLE only when ALL of these hold. Any one failing leaves it
 * reported and untouched, and the census names the leg that failed.
 *
 *   1. SOURCE      the row's `source` is `cardhedge`. (Measured on the live
 *                  rows: `source` is the field; `sourceSystem` does not exist
 *                  on sold_comps.)
 *   2. SCOPE       the row's CH product id is in the dispatched scope. The
 *                  product id is not in a field of its own -- `vendorCardId`
 *                  is null on every one of these rows -- it is the first
 *                  segment of the composite key the backfill mints:
 *                    id               cardhedge::<product>::<date>::<cents>::<grade>
 *                    sourceExternalId <product>::<date>::<cents>::<grade>
 *                  `ch-daily::<id>` rows are a DIFFERENT writer with no
 *                  product id in the key, and are never in scope.
 *   3. LABEL       the stored parallel slugs to the same thing the stored
 *                  slug's parallel segment says. This is what makes the row
 *                  "wearing the product's label" rather than merely
 *                  mis-slugged: field and slug agree with each other and both
 *                  disagree with the title.
 *   4. NO WITNESS  the title carries NO witness for that parallel. The witness
 *                  test is `titleEchoesSlugParallel` from the rematch
 *                  classifier -- the slug is the claim, the title is the
 *                  witness, and no vocabulary is consulted, so a product whose
 *                  parallel names we do not hold is not thereby convicted.
 *                  A title that says "Red Ink" is SKIPPED here, and that is
 *                  the assertion the mutation check removes.
 *   5. DESTINATION the derived slug is checklist-backed AND differs from the
 *                  stored one. A row is never moved onto a slug the checklist
 *                  does not list -- the same rule base-eviction already
 *                  applies to its own destination.
 *
 * Pure. No Cosmos, no env, no clock: assertions 1-4 are decided from the row
 * itself, and 5 is decided from the caller's own catalog verdict, which is
 * where the read belongs. The tests drive this directly with real row shapes.
 */

const path = require("path");
const K = require(path.join(__dirname, "rematch-classify.cjs"));

const str = (v) => String(v ?? "").trim();

/**
 * Slug a parallel display name the way a slug segment spells it.
 * "Black & White Red Ink" -> "black-white-red-ink".
 *
 * Deliberately NOT a general canonicalizer: it does not know that this
 * product's finish is a Refractor, which is why assertion 3 compares on the
 * PREFIX relation below rather than on equality.
 */
function parallelLabelSlug(parallel) {
  return str(parallel)
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The CardHedge PRODUCT id this row's key was minted from, or null.
 *
 * Both spellings the historical backfill writes are accepted, because the two
 * fields are the same composite with and without the `cardhedge::` prefix and
 * a row can be handed to this function either way:
 *
 *   id                cardhedge::1778540428361x447194681698603460::2026-08-04T02:22:00.000Z::1100::Raw
 *   sourceExternalId  1778540428361x447194681698603460::2026-08-04T02:22:00.000Z::1010::Raw
 *
 * A CH-daily row (`ch-daily::<price_history_id>`) carries NO product id and
 * returns null -- it is a different writer, which read the title, and it is
 * never in this lane's scope. `ch-fill` is likewise not a product id.
 *
 * The shape is asserted, never assumed: a CH product id is Bubble's
 * `<digits>x<digits>`. Anything else returns null rather than being treated as
 * a product, so a key format that changes underneath us fails closed.
 */
function chProductIdOf(row) {
  const ext = str(row?.sourceExternalId);
  const id = str(row?.id);
  const candidate = ext || id.replace(/^cardhedge::/, "");
  const head = candidate.split("::")[0];
  if (!head) return null;
  if (!/^\d+x\d+$/.test(head)) return null;
  return head;
}

/** The parallel segment of a hiq slug, or null for a non-hiq id. */
function slugParallel(slug) {
  return K.slugParallelSegment(str(slug));
}

/**
 * ASSERTION 3, on its own so a test can drive it.
 *
 * The stored parallel FIELD and the stored slug's parallel SEGMENT have to be
 * the same claim. They are compared on the prefix relation rather than on
 * equality because the slug composer appends the finish family: the field
 * "Black & White Red Ink" slugs to `black-white-red-ink` while the slug
 * segment reads `black-white-red-ink-refractor`. Requiring equality would miss
 * every refractor-family row, which is most of them; requiring only that one
 * contain the other would let `base` match `base-refractor`, so the generic
 * segments are refused outright by titleEchoesSlugParallel's own list, and a
 * blank field is refused here.
 */
function storedLabelMatchesSlug(row) {
  const field = parallelLabelSlug(row?.parallel);
  const seg = str(slugParallel(row?.hobbyiqCardId ?? row?.cardId)).toLowerCase();
  if (!field || !seg) return false;
  return seg === field || seg.startsWith(`${field}-`) || field.startsWith(`${seg}-`);
}

/**
 * The five-assertion verdict for one row.
 *
 * @param {object}  row              the sold_comps row, verbatim
 * @param {object}  opts
 * @param {Set|null} opts.productIds  the dispatched product-id scope. REQUIRED
 *                                    to be non-empty by the CALLER -- a scope
 *                                    nobody named is refused at the entrypoint,
 *                                    not silently widened here.
 * @param {string|null} opts.derivedSlug   the caller's derived destination
 * @param {boolean} opts.derivedBacked     is that destination checklist-backed
 *
 * @returns {{ rekeyable: boolean, failed: string|null, productId: string|null,
 *             storedSlug: string, storedParallel: string, witness: string|null }}
 *
 * `failed` names the FIRST assertion that failed, in the order above, and is
 * the census's audit product: "how many rows are one leg away, and which leg"
 * is the only question a report can be read for.
 */
function chProductLabelVerdict(row, opts = {}) {
  const { productIds = null, derivedSlug = null, derivedBacked = false } = opts;
  const storedSlug = str(row?.hobbyiqCardId ?? row?.cardId);
  const storedParallel = str(row?.parallel);
  const productId = chProductIdOf(row);
  const out = {
    rekeyable: false, failed: null, productId,
    storedSlug, storedParallel, witness: null,
  };

  // 1. SOURCE
  if (str(row?.source).toLowerCase() !== "cardhedge") { out.failed = "source"; return out; }

  // 2. SCOPE. A null product id is a different writer, not a widened scope.
  if (!productId) { out.failed = "no-product-id"; return out; }
  if (!productIds || productIds.size === 0) { out.failed = "no-scope"; return out; }
  if (!productIds.has(productId)) { out.failed = "out-of-scope"; return out; }

  // 3. LABEL: the field and the slug are the same claim.
  if (!storedLabelMatchesSlug(row)) { out.failed = "label-not-the-slug"; return out; }

  // 4. NO WITNESS. The slug is the claim, the title is the witness.
  //
  // BOTH SPELLINGS OF THE CLAIM ARE PUT TO THE WITNESS, and a witness for
  // EITHER acquits the row. `titleEchoesSlugParallel` requires every word of
  // the claim to be present, so the slug segment alone under-detects exactly
  // where it matters here: this product's segment is
  // `black-white-red-ink-refractor`, and a seller who writes "Black White Red
  // Ink" -- naming the finish in full, just not the family -- fails the
  // all-words test on `refractor` and would be re-keyed as though the title
  // had been silent. That is the one outcome this lane must never produce, so
  // the stored FIELD's own slug (`black-white-red-ink`, no family suffix) is
  // tested as well.
  //
  // Asymmetry is deliberate: a witness for either spelling is a refusal, while
  // a re-key needs both to be silent. The guard is allowed to be conservative;
  // it is not allowed to be wrong.
  const title = str(row?.title);
  const claims = [slugParallel(storedSlug), parallelLabelSlug(storedParallel)];
  for (const claim of claims) {
    const witness = claim ? K.titleEchoesSlugParallel(title, claim) : null;
    if (witness) { out.witness = witness; out.failed = "title-witnesses-the-parallel"; return out; }
  }

  // AND THE BACKSTOP: a title that names ANY finish is not a silent title.
  //
  // The two exact tests above ask "does the title repeat THIS claim". They
  // cannot answer "does the title name some OTHER finish", and for this
  // product that gap is not hypothetical. Drew ruled on 2026-08-30 that Red
  // Ink IS the B&W Shimmer SSP -- one card, one row -- so a seller writing
  // "B&W Shimmer" is naming this very card by its other name. Neither exact
  // test sees it: `black-white-shimmer` shares no full phrase with
  // `black-white-red-ink-refractor`, and "B&W" does not tokenise to
  // `black white`.
  //
  // A row whose title names a finish is, whatever finish it is, NOT the
  // silent base sale this lane exists to move. It is reported and left for a
  // human. Using titleNamesFinish here -- the classifier's own vocabulary,
  // no new words -- costs a small number of conservative skips and closes the
  // only path by which this repair could move a genuine parallel sale onto
  // the base pool.
  //
  // THE SETKEY CONTEXT IS LOAD-BEARING, and omitting it is not a smaller
  // version of this guard -- it is a different, broken one. Called bare,
  // `titleNamesFinish` reads the word "Chrome" in "2026 Bowman Victor Figueroa
  // Chrome Auto ... #CPA-VF" as a finish, when it is the SET's own name.
  // Measured on the 56 live rows: bare, this backstop refused 55 of them;
  // given the slug's own setKey (`bowman-chrome`), it refuses none, and still
  // refuses every finish-naming title above. The classifier's own call sites
  // pass the same context for the same reason.
  const setKeyOfSlug = String(storedSlug).split(":")[3] || null;
  const yearOfSlug = Number(String(storedSlug).split(":")[2]) || null;
  if (K.titleNamesFinish(title, { year: yearOfSlug, setKey: setKeyOfSlug })) {
    out.failed = "title-names-some-finish";
    return out;
  }

  // 5. DESTINATION: checklist-backed, and actually different.
  const dest = str(derivedSlug);
  if (!dest) { out.failed = "no-derived-slug"; return out; }
  if (dest === storedSlug) { out.failed = "destination-is-the-stored-slug"; return out; }
  if (!derivedBacked) { out.failed = "destination-not-checklist-backed"; return out; }

  out.rekeyable = true;
  return out;
}

module.exports = {
  parallelLabelSlug,
  chProductIdOf,
  slugParallel,
  storedLabelMatchesSlug,
  chProductLabelVerdict,
};
