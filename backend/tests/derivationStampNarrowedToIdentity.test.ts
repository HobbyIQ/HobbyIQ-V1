/**
 * THE DERIVATION STAMP HASHES DERIVATION, NOT PLUMBING (2026-09-11, run
 * 34360565942 follow-up).
 *
 * WHAT HAPPENED. Fixing the apply-improve worker pool's "not reached"
 * overcount and the swallowed reconciliation exit code (both pure counting /
 * process-exit plumbing in `scripts/rematch-sold-comps.cjs`, neither of which
 * touches what class a row gets or what slug it derives to) tripped
 * `tests/i9ReferenceStamp.test.ts`'s "and that stamp IS this tree's" pin,
 * because `derivation-version.cjs`'s DERIVATION_INPUTS used to name
 * `scripts/rematch-sold-comps.cjs` WHOLE:
 *
 *   OLD DERIVATION_INPUTS (what this test replaces):
 *     "scripts/lib/rematch-classify.cjs"
 *     "scripts/rematch-sold-comps.cjs"                        <- the WHOLE file
 *     "src/services/portfolioiq/parseTitleIdentity.service.ts"
 *     "src/services/portfolioiq/hobbyIqCardId.service.ts"
 *     "src/services/portfolioiq/slugGuard.service.ts"
 *     "src/services/portfolioiq/slugRederivation.service.ts"
 *
 * So ANY byte in that file moving the hash was indistinguishable from a
 * changed VERDICT, even a worker-pool concurrency fix with zero effect on
 * AGREE/IMPROVE/CONFLICT/UNDERIVABLE or on the slug a row derives to.
 *
 * THE FIX. `storedIdentity` and `deriveIdentity` -- the two functions that
 * actually decide a derivation (what the row's own fields say; what today's
 * parser + matcher would say from its title) -- were extracted, pure, to
 * `scripts/lib/rematch-derive-identity.cjs`. DERIVATION_INPUTS now names that
 * file instead of the whole script, so `rematch-sold-comps.cjs`'s worker
 * pool, write ledger, budget clock and finishLane call are OUTSIDE the hash.
 *
 * THIS FILE PINS THE TWO PROPERTIES THE SPLIT EXISTS TO PROVE:
 *
 *   1. A counting/plumbing-only change to rematch-sold-comps.cjs -- exactly
 *      the shape of the fix that tripped the alarm -- leaves the stamp
 *      UNCHANGED, because that file is no longer hashed at all.
 *   2. A one-token change to the DERIVER (rematch-derive-identity.cjs) still
 *      moves the stamp, so the split narrowed WHAT is hashed without making
 *      the stamp blind to a real derivation change.
 *
 * The stamp's recorded VALUE in data/rematch-census-shares.json is never
 * hand-edited by this file or by the fix it accompanies -- narrowing
 * DERIVATION_INPUTS (a path rename in the hash's own preimage) is a
 * structural, one-time re-baseline trigger by itself, separate from and
 * unrelated to whether any PLUMBING content in rematch-sold-comps.cjs
 * changes; a fresh re-baseline against real census data is a follow-up,
 * exactly as it was for #1888, #1964 and #2019.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DV = require_(path.join(backend, "scripts", "lib", "derivation-version.cjs"));

/** Copies DV.DERIVATION_INPUTS (plus pricingContract.ts, which currentStamp
 *  also reads) into a fresh temp tree, so a mutation there can never touch
 *  the real checkout. Returns the temp root. */
function snapshotInputs(mutate?: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "derivstamp-"));
  for (const rel of DV.DERIVATION_INPUTS as string[]) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(backend, rel), dst);
  }
  const pcRel = path.join("src", "services", "portfolioiq", "pricingContract.ts");
  fs.mkdirSync(path.dirname(path.join(root, pcRel)), { recursive: true });
  fs.copyFileSync(path.join(backend, pcRel), path.join(root, pcRel));
  // rematch-sold-comps.cjs is NOT in DERIVATION_INPUTS any more, but it is
  // still a real file relative to `root` for test 1 below to mutate and
  // prove irrelevant -- copy it too, alongside the hashed set, at the same
  // relative path a plumbing edit would actually land on.
  const plumbingRel = path.join("scripts", "rematch-sold-comps.cjs");
  fs.mkdirSync(path.dirname(path.join(root, plumbingRel)), { recursive: true });
  fs.copyFileSync(path.join(backend, plumbingRel), path.join(root, plumbingRel));
  if (mutate) mutate(root);
  return root;
}

describe("DERIVATION_INPUTS no longer names the whole rematch-sold-comps.cjs script", () => {
  it("names the extracted deriver, not the plumbing file", () => {
    expect(DV.DERIVATION_INPUTS).toContain("scripts/lib/rematch-derive-identity.cjs");
    expect(DV.DERIVATION_INPUTS).not.toContain("scripts/rematch-sold-comps.cjs");
    // storedIdentity/deriveIdentity's actual source moved out of the script.
    const script = fs.readFileSync(path.join(backend, "scripts", "rematch-sold-comps.cjs"), "utf8");
    expect(script).not.toContain("function storedIdentity(row, deps)");
    expect(script).not.toContain("function deriveIdentity(row, deps)");
    const lib = fs.readFileSync(path.join(backend, "scripts", "lib", "rematch-derive-identity.cjs"), "utf8");
    expect(lib).toContain("function storedIdentity(row, deps)");
    expect(lib).toContain("function deriveIdentity(row, deps)");
  });

  it("PROPERTY 1 — a counting/plumbing-only change to rematch-sold-comps.cjs leaves the stamp unchanged", () => {
    const before = DV.derivationStamp(snapshotInputs());
    expect(before).toMatch(/^d[0-9a-f]{12}$/);

    // The exact shape of the fix that originally tripped the alarm: a
    // worker-pool counting change and a finishLane exit-code change, both
    // pure plumbing with no effect on any row's derived identity.
    const after = DV.derivationStamp(snapshotInputs((root) => {
      const plumbing = path.join(root, "scripts", "rematch-sold-comps.cjs");
      fs.appendFileSync(
        plumbing,
        "\n// counting-only edit: stats.notReached++ instead of += tail; "
        + "finishLane(process.exitCode || 0, ctx) instead of finishLane(0, ctx)\n",
      );
    }));
    expect(after).toBe(before);
  });

  it("PROPERTY 2 — a one-token change to the deriver still moves the stamp", () => {
    const before = DV.derivationStamp(snapshotInputs());
    const after = DV.derivationStamp(snapshotInputs((root) => {
      const deriver = path.join(root, "scripts", "lib", "rematch-derive-identity.cjs");
      fs.appendFileSync(deriver, "\n// a derivation rule changed\n");
    }));
    expect(after).not.toBe(before);
  });

  it("PROPERTY 2b — a one-token change to the classifier (already hashed) still moves the stamp", () => {
    // Unchanged behaviour, re-pinned alongside 1/2 so the three together
    // describe the whole boundary: classifier in, deriver in, plumbing out.
    const before = DV.derivationStamp(snapshotInputs());
    const after = DV.derivationStamp(snapshotInputs((root) => {
      const classifier = path.join(root, "scripts", "lib", "rematch-classify.cjs");
      fs.appendFileSync(classifier, "\n// a rule changed\n");
    }));
    expect(after).not.toBe(before);
  });
});
