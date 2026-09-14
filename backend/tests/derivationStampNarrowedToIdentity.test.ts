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
 *   HASH_DEFINITIONS.v1 (retired, kept in derivation-version.cjs for the
 *   re-label proof below):
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
 * `scripts/lib/rematch-derive-identity.cjs`. HASH_DEFINITIONS.v2 (current)
 * names that file instead of the whole script, so `rematch-sold-comps.cjs`'s
 * worker pool, write ledger, budget clock and finishLane call are OUTSIDE
 * the hash.
 *
 * THE RE-LABEL. Narrowing which files are hashed changes the STAMP VALUE even
 * when the derivation those files decide has not moved a byte --
 * `derivationStamp` hashes `path + "\0" + contents`, so a renamed path is a
 * different preimage regardless of what the bytes say. The reference in
 * `data/rematch-census-shares.json` (measured 2026-09-09, commit e32b8481,
 * #2019) was RE-LABELLED under v2 rather than hand-edited: v2's stamp was
 * computed on a `git show`-reconstructed tree AT e32b8481 itself (the
 * reference's own `measuredUnder.commit`) with `rematch-derive-identity.cjs`'s
 * content rebuilt byte-for-byte from that commit's inline
 * storedIdentity/deriveIdentity, and confirmed equal to v2's stamp on this
 * branch -- both `decbe3f2b1bf6`. Equal stamps under the SAME (new)
 * definition at the OLD and NEW commit is the proof that no derivation file
 * moved between them; a mismatch would have meant a real derivation change
 * happened since #2019 and no re-label would be safe (report which file, not
 * relabel over it). The reference now carries BOTH the new stamp
 * (`measuredUnder.stamp`/`derivation`/`hashDefinition: "v2"`) and the old one
 * it supersedes (`measuredUnder.migratedFrom`), so the migration itself is
 * auditable from the file.
 *
 * THIS FILE PINS THE PROPERTIES THE SPLIT AND THE RE-LABEL EXIST TO PROVE:
 *
 *   1. A counting/plumbing-only change to rematch-sold-comps.cjs -- exactly
 *      the shape of the fix that tripped the alarm -- leaves the stamp
 *      UNCHANGED, because that file is no longer hashed at all.
 *   2. A one-token change to the DERIVER (rematch-derive-identity.cjs) still
 *      moves the stamp, so the split narrowed WHAT is hashed without making
 *      the stamp blind to a real derivation change.
 *   3. v2's stamp AT #2019's commit (e32b8481, reconstructed) equals v2's
 *      stamp NOW equals the RECORDED reference stamp -- the re-label is
 *      provably a re-label, not a laundered regression.
 *   4. A one-token deriver change still moves the stamp AWAY from the
 *      recorded reference, so the re-label did not blunt the alarm.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(backend, "..");
const DV = require_(path.join(backend, "scripts", "lib", "derivation-version.cjs"));
const TABLE = require_(path.join(backend, "data", "rematch-census-shares.json"));

/** The integ/deriver-batch-0913-2 head the 2026-09-14 reference was stamped on
 *  (#2116 #2122 #2125 #2127 #2135 #2138 #2141 on top of main). The re-label
 *  commit sits on top of it and touches no DERIVATION_INPUT, so v2 at this
 *  commit equals v2 now. (`measuredUnder.commit` names something else: the
 *  MAIN tree the verification census artifacts were measured under, b5ab5f74.) */
const REFERENCE_COMMIT = "42eb39da49afceba7a8421fc8545189d77b76eef";

/** Read one file's content AT a commit via `git show <sha>:<path>` -- READ
 *  ONLY, no worktree, no checkout, nothing mutated. `relFromRepoRoot` is the
 *  path git knows the file by (repo-root-relative), which for everything in
 *  HASH_DEFINITIONS.v1 is `backend/<rel>`. */
function gitShow(sha: string, relFromRepoRoot: string): string {
  return execFileSync("git", ["show", `${sha}:${relFromRepoRoot}`], { cwd: repoRoot, encoding: "utf8" });
}

// Until 2026-09-13 the reference commit predated the 2026-09-11 extraction of
// storedIdentity/deriveIdentity out of rematch-sold-comps.cjs, and PROPERTY 3
// reconstructed the deriver byte-for-byte from that inline block. The
// reference now lives at a commit AFTER the extraction, so every v2 input --
// the deriver included -- is a real file at REFERENCE_COMMIT and is read with
// `git show` like the others. No reconstruction, nothing to guess.

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

describe("the re-label: v2-at-the-batch-head == v2-now == the recorded reference", () => {
  /** v2's stamp on a tree read AT REFERENCE_COMMIT: every v2 input (the six
   *  DERIVATION_INPUTS, deriver included) via `git show`, read-only, plus the
   *  pricing contract the stamp also carries. */
  function v2StampAtReference(): string | null {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "derivstamp-v2-at-ref-"));
    for (const rel of DV.HASH_DEFINITIONS.v2 as string[]) {
      const dst = path.join(root, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, gitShow(REFERENCE_COMMIT, `backend/${rel}`));
    }
    const pcRel = path.join("src", "services", "portfolioiq", "pricingContract.ts");
    fs.mkdirSync(path.dirname(path.join(root, pcRel)), { recursive: true });
    fs.writeFileSync(path.join(root, pcRel), gitShow(REFERENCE_COMMIT, `backend/${pcRel.split(path.sep).join("/")}`));
    const stamp = DV.derivationStamp(root, DV.HASH_DEFINITIONS.v2);
    fs.rmSync(root, { recursive: true, force: true });
    return stamp;
  }

  it("PROPERTY 3 — v2 at the batch head equals v2 now equals the recorded reference stamp", () => {
    const v2AtReference = v2StampAtReference();
    const v2Now = DV.derivationStamp(DV.BACKEND_ROOT, DV.HASH_DEFINITIONS.v2);
    expect(v2AtReference).toMatch(/^d[0-9a-f]{12}$/);
    // PROOF: no file in HASH_DEFINITIONS.v2 changed its DERIVATION content
    // between the batch head (d6afd28d) and this branch -- if it had, this
    // equality would fail and the fix would be to report which file, not to
    // relabel.
    expect(v2Now).toBe(v2AtReference);
    // The recorded reference (data/rematch-census-shares.json) was re-baselined
    // by scripts/rebaseline-i9-reference.cjs on exactly this tree -- never
    // hand-typed independently of this proof.
    expect(TABLE.measuredUnder.derivation).toBe(v2AtReference);
    // And the superseded reference (main's decbe3f2b1bf6, measured 2026-09-09,
    // 11.7M rows) is recorded alongside it, so the re-baseline is auditable
    // from the file itself rather than only from git history.
    expect(TABLE.supersedes?.stamp).toMatch(/^d[0-9a-f]{12}\+/);
    expect(TABLE.supersedes?.stamp).not.toBe(TABLE.measuredUnder.stamp);
    expect(TABLE.supersedes?.classifiedTotal).toBeGreaterThan(11_000_000);
  });

  it("PROPERTY 4 — a one-token deriver change still moves the stamp away from the recorded reference (the re-label did not blunt the alarm)", () => {
    const mutated = DV.derivationStamp(snapshotInputs((root) => {
      const deriver = path.join(root, "scripts", "lib", "rematch-derive-identity.cjs");
      fs.appendFileSync(deriver, "\n// a derivation rule changed\n");
    }));
    expect(mutated).not.toBe(TABLE.measuredUnder.derivation);
    const agreement = DV.stampsAgree(TABLE.measuredUnder.stamp, {
      derivation: mutated, contract: TABLE.measuredUnder.contract,
      combined: `${mutated}+${TABLE.measuredUnder.contract}`,
    });
    expect(agreement.comparable).toBe(false);
    expect(agreement.reason).toBe("stamp-changed");
  });
});
