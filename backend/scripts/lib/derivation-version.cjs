/**
 * derivation-version.cjs — the DERIVATION STAMP. Pure: no I/O beyond reading
 * the files it hashes, no Cosmos, no clock.
 *
 * CF-A-REFERENCE-MUST-SAY-WHAT-IT-WAS-MEASURED-UNDER (2026-09-07, I9 P1).
 *
 * WHY THIS EXISTS, IN ONE MORNING'S EVIDENCE. On 2026-09-07 I9 breached:
 *
 *     vintage  CONFLICT 62.2% vs its census 31.9%   (+30.3pp)
 *     modern   CONFLICT 59.3% vs its census 41.8%   (+17.5pp)
 *
 * and the audit could not say whether the corpus had regressed overnight or
 * whether the REFERENCE had gone stale underneath it. Both produce the same
 * digest line, and only one of them is somebody's problem.
 *
 * It was the reference. `data/rematch-census-shares.json` was measured in the
 * window 2026-09-05T04:20Z..2026-09-06T02:49Z. Between that window closing and
 * the breaching run, EIGHT commits changed the classifier the census is
 * measured BY, and eleven more changed the parser and set-key vocabulary it
 * derives THROUGH:
 *
 *   #1886  an absent year folds to `same` instead of `changed:cardYear`
 *   #1897  three ruled scopes + the grade re-key            (607 lines)
 *   #1914  a Chrome Draft sale is a Bowman Draft card
 *   #1918  a league release is not its flagship
 *   #1923  the parser's alias IS the statement (soccer keys)
 *   #1926  the sport predicate
 *   #1934  a Halloween release is not the flagship
 *   #1950  a scoped apply
 *
 * Every one of those is an INTENDED change to what a re-derivation says. A
 * reference measured before them is not a worse-or-better yardstick — it is a
 * yardstick with different units, and comparing today's sample to it is not a
 * comparison at all.
 *
 * WHAT A STAMP IS. The stamp is a content hash of the files that DECIDE a
 * derivation, plus the pricing contract version. It answers exactly one
 * question: "would these two measurements have been produced by the same
 * code?" It is deliberately NOT a semantic version — nobody remembers to bump
 * one, and the defect this exists to prevent is precisely the one a forgotten
 * bump creates.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not silence a regression. A
 * reference at the CURRENT stamp is compared exactly as before, and a class
 * over its threshold breaches exactly as before. The stamp only decides
 * whether the two numbers are COMPARABLE; when they are not, the drift is
 * reported as a FINDING that names the re-baseline, and the alarm stays quiet
 * because it has nothing it can honestly say — not because the number was
 * small.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * THE FILES THAT DECIDE A DERIVATION.
 *
 * A row's class is decided by: the CLASSIFIER (which axes count as a
 * disagreement), the DERIVER (which identity the title produces), and the
 * vocabulary services both call through. Change any of them and the same row
 * can legitimately move class.
 *
 * `.ts` sources rather than `dist/`: dist is a build artifact whose bytes move
 * with the compiler, and a stamp that changes when tsc is upgraded would
 * re-baseline on noise. The source is what a human changed.
 *
 * ADDING A FILE HERE IS A DELIBERATE ACT. A file that can change a verdict and
 * is not listed makes the stamp lie by omission — which is the failure mode
 * this module exists to remove, so `derivationInputsPresent()` refuses a
 * missing path loudly rather than hashing around it.
 */
/**
 * HASH DEFINITION VERSIONS (2026-09-11, run 34360565942 follow-up).
 *
 * CF-A-NARROWED-HASH-IS-A-RE-LABEL-NOT-A-REGRESSION. Narrowing which files
 * are hashed changes the STAMP VALUE even when the DERIVATION those files
 * decide has not moved a byte -- `derivationStamp` hashes `path + "\0" +
 * contents` per input, so a renamed/removed path is a different preimage no
 * matter what the bytes say. Bumping the hash definition and re-labelling the
 * reference under the NEW definition -- once proven byte-identical to what
 * the OLD definition saw at the commit the reference was measured under -- is
 * therefore the legitimate move, not a hand-edited stamp.
 *
 * v1 (retired) hashed `scripts/rematch-sold-comps.cjs` WHOLE: the derivation
 * (storedIdentity/deriveIdentity) plus that script's worker pool, write
 * ledger, budget clock and finishLane exit-code handling -- none of which
 * decide a row's verdict. A plumbing-only change (e.g. a worker-pool
 * counting fix) moved the v1 stamp exactly as if the derivation itself had
 * changed.
 *
 * v2 (current) replaces that entry with scripts/lib/rematch-derive-identity
 * .cjs, the file storedIdentity/deriveIdentity were extracted to, pure and
 * alone. Every other entry is unchanged between v1 and v2.
 *
 * HASH_DEFINITIONS is keyed by version so a stamp can be recomputed under
 * EITHER definition, at any commit, for exactly the re-label proof this
 * exists for: v2's stamp on the file set as it stood at the commit that
 * measured the current reference must equal v2's stamp now, or the
 * derivation moved between then and now and no re-label is safe.
 */
const HASH_DEFINITIONS = Object.freeze({
  v1: Object.freeze([
    "scripts/lib/rematch-classify.cjs",
    "scripts/rematch-sold-comps.cjs",
    "src/services/portfolioiq/parseTitleIdentity.service.ts",
    "src/services/portfolioiq/hobbyIqCardId.service.ts",
    "src/services/portfolioiq/slugGuard.service.ts",
    "src/services/portfolioiq/slugRederivation.service.ts",
  ]),
  v2: Object.freeze([
    "scripts/lib/rematch-classify.cjs",
    "scripts/lib/rematch-derive-identity.cjs",
    "src/services/portfolioiq/parseTitleIdentity.service.ts",
    "src/services/portfolioiq/hobbyIqCardId.service.ts",
    "src/services/portfolioiq/slugGuard.service.ts",
    "src/services/portfolioiq/slugRederivation.service.ts",
  ]),
});

/** The hash definition every NEW stamp is computed and recorded under. */
const HASH_DEFINITION_VERSION = "v2";

/** THE FILES THAT DECIDE A DERIVATION, under the current hash definition.
 *  Kept as its own export -- unchanged shape -- so `derivationInputsPresent`
 *  and every existing caller that reads `DERIVATION_INPUTS` directly (tests
 *  included) keeps working without knowing hash definitions exist. */
const DERIVATION_INPUTS = HASH_DEFINITIONS[HASH_DEFINITION_VERSION];

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/** Absolute path of one declared input, under the backend root. */
function inputPath(rel, root = BACKEND_ROOT) {
  return path.join(root, rel);
}

/**
 * Which declared inputs are missing. A stamp computed over a missing file
 * would be a DIFFERENT stamp that looks like a real one, so the caller must be
 * able to refuse rather than publish a hash it cannot stand behind.
 *
 * `inputs` defaults to the CURRENT hash definition's list; pass one of
 * `HASH_DEFINITIONS.v1` / `.v2` explicitly to check a specific, named
 * definition against a specific root (e.g. an old commit's worktree).
 */
function missingInputs(root = BACKEND_ROOT, inputs = DERIVATION_INPUTS) {
  return inputs.filter((rel) => !fs.existsSync(inputPath(rel, root)));
}

/**
 * The derivation stamp: `d<12 hex>` over the declared inputs' bytes, in the
 * declared order, each preceded by its path so a rename is a change.
 *
 * Normalises CRLF -> LF so a Windows checkout and a Linux runner agree; the
 * runner is where the nightly measures and the laptop is where a re-baseline
 * is usually computed, and a stamp that differs between them would re-baseline
 * every single night.
 *
 * Returns null when any declared input is missing — never a hash over what
 * happened to be there.
 *
 * `inputs` defaults to the CURRENT hash definition (`DERIVATION_INPUTS`, i.e.
 * `HASH_DEFINITIONS[HASH_DEFINITION_VERSION]`). Passing `HASH_DEFINITIONS.v1`
 * or `.v2` explicitly computes THAT definition's stamp regardless of which
 * one is current — the one operation a hash-definition bump needs: proving
 * the NEW definition's stamp is unchanged between the commit the reference
 * was measured under and now, before re-labelling the reference to it.
 */
function derivationStamp(root = BACKEND_ROOT, inputs = DERIVATION_INPUTS) {
  if (missingInputs(root, inputs).length) return null;
  const h = crypto.createHash("sha256");
  for (const rel of inputs) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(inputPath(rel, root), "utf8").replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return `d${h.digest("hex").slice(0, 12)}`;
}

/**
 * The pricing contract version, read out of its TypeScript source.
 *
 * Read rather than imported: this module is CommonJS in `scripts/`, the
 * constant is a `.ts` export, and requiring dist/ would make the stamp depend
 * on a build having been run. The regex is pinned by a test that fails if the
 * declaration shape changes, so the read cannot silently start returning null.
 */
function pricingContractVersion(root = BACKEND_ROOT) {
  try {
    const src = fs.readFileSync(
      path.join(root, "src", "services", "portfolioiq", "pricingContract.ts"), "utf8",
    );
    const m = src.match(/export\s+const\s+PRICING_CONTRACT_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * The full stamp a measurement is recorded under, and an alarm compares by.
 *
 * `{ derivation, contract, combined, hashDefinition }` — `combined` is the
 * one string a reference carries and an equality test reads. Null
 * `derivation` propagates, so a stamp that could not be computed never
 * compares EQUAL to anything. `hashDefinition` names WHICH version of
 * DERIVATION_INPUTS produced `derivation`, so a reference can say what it was
 * hashed under even after the list itself is narrowed again later.
 *
 * `inputs`/`hashDefinition` let a caller compute a NAMED definition's stamp
 * (e.g. `HASH_DEFINITIONS.v2`) rather than whatever is current — the re-label
 * proof needs exactly this: v2's stamp at an old commit vs v2's stamp now.
 */
function currentStamp(root = BACKEND_ROOT, inputs = DERIVATION_INPUTS, hashDefinition = HASH_DEFINITION_VERSION) {
  const derivation = derivationStamp(root, inputs);
  const contract = pricingContractVersion(root);
  return {
    derivation,
    contract,
    combined: derivation ? `${derivation}+${contract ?? "no-contract"}` : null,
    hashDefinition,
  };
}

/**
 * Do a reference and the current code agree about what a derivation MEANS?
 *
 * Returns `{ comparable, reason, referenceStamp, currentStamp }`. `comparable`
 * is true ONLY on an exact match of a non-null stamp: an unstamped reference
 * (every reference written before this module) is NOT comparable, because the
 * whole point is that its units are unknown.
 *
 * A NULL CURRENT STAMP IS NOT COMPARABLE EITHER. When the declared inputs
 * cannot be read the honest answer is "I don't know what this was measured
 * under", and an alarm must not fire on a comparison it cannot justify.
 */
function stampsAgree(referenceStamp, current = currentStamp()) {
  const ref = typeof referenceStamp === "string" && referenceStamp ? referenceStamp : null;
  const cur = current?.combined ?? null;
  if (!ref) {
    return { comparable: false, reason: "reference-unstamped", referenceStamp: ref, currentStamp: cur };
  }
  if (!cur) {
    return { comparable: false, reason: "current-stamp-unavailable", referenceStamp: ref, currentStamp: cur };
  }
  if (ref !== cur) {
    return { comparable: false, reason: "stamp-changed", referenceStamp: ref, currentStamp: cur };
  }
  return { comparable: true, reason: null, referenceStamp: ref, currentStamp: cur };
}

module.exports = {
  DERIVATION_INPUTS, BACKEND_ROOT,
  HASH_DEFINITIONS, HASH_DEFINITION_VERSION,
  inputPath, missingInputs,
  derivationStamp, pricingContractVersion, currentStamp, stampsAgree,
};
