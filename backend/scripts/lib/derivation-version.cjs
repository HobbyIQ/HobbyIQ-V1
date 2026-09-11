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
// CF-A-DERIVATION-STAMP-MUST-NOT-HASH-PLUMBING (2026-09-11, run 34360565942
// follow-up). This list used to name "scripts/rematch-sold-comps.cjs" -- the
// WHOLE file -- so a change to that script's worker pool, write ledger,
// budget clock or exit-code handling (none of which decide a row's verdict)
// invalidated the I9 reference exactly as if the derivation itself had
// changed. `storedIdentity` and `deriveIdentity` -- the two functions that
// actually decide what a row's stored fields say and what its title would
// derive to -- were extracted, pure and alone, to
// scripts/lib/rematch-derive-identity.cjs, and THAT is what is hashed below
// instead. See that file's header and tests/derivationStampNarrowedToIdentity
// .test.ts for the two properties the split exists to prove: a plumbing-only
// change to rematch-sold-comps.cjs no longer moves the stamp, and a
// one-token change to the deriver still does.
const DERIVATION_INPUTS = Object.freeze([
  "scripts/lib/rematch-classify.cjs",
  "scripts/lib/rematch-derive-identity.cjs",
  "src/services/portfolioiq/parseTitleIdentity.service.ts",
  "src/services/portfolioiq/hobbyIqCardId.service.ts",
  "src/services/portfolioiq/slugGuard.service.ts",
  "src/services/portfolioiq/slugRederivation.service.ts",
]);

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/** Absolute path of one declared input, under the backend root. */
function inputPath(rel, root = BACKEND_ROOT) {
  return path.join(root, rel);
}

/**
 * Which declared inputs are missing. A stamp computed over a missing file
 * would be a DIFFERENT stamp that looks like a real one, so the caller must be
 * able to refuse rather than publish a hash it cannot stand behind.
 */
function missingInputs(root = BACKEND_ROOT) {
  return DERIVATION_INPUTS.filter((rel) => !fs.existsSync(inputPath(rel, root)));
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
 */
function derivationStamp(root = BACKEND_ROOT) {
  if (missingInputs(root).length) return null;
  const h = crypto.createHash("sha256");
  for (const rel of DERIVATION_INPUTS) {
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
 * `{ derivation, contract, combined }` — `combined` is the one string a
 * reference carries and an equality test reads. Null `derivation` propagates,
 * so a stamp that could not be computed never compares EQUAL to anything.
 */
function currentStamp(root = BACKEND_ROOT) {
  const derivation = derivationStamp(root);
  const contract = pricingContractVersion(root);
  return {
    derivation,
    contract,
    combined: derivation ? `${derivation}+${contract ?? "no-contract"}` : null,
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
  inputPath, missingInputs,
  derivationStamp, pricingContractVersion, currentStamp, stampsAgree,
};
