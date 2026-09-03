# Adversarial verification — PR #1678 (census throughput)

Independent clone off fresh `origin/main`; sample pulled from **slot 19** (the builder profiled
slot 0, and I confirmed zero row overlap). Cosmos **READ-ONLY**, connection string piped straight
into env, never to disk or stdout. No dispatches.

## Result: READY

| check | result |
|---|---|
| throughput, old vs fixed — same 2,000 rows, uncontended | **4.7 → 3,410 rows/s (726x)** |
| throughput, 1,200 phrase-reaching rows | **29.1 → 1,388 rows/s (48x)** |
| verdict diff, 2,000 slot-19 rows (48 distinct verdicts) | **0** |
| verdict diff, 1,200 phrase-reaching rows (237 distinct verdicts) | **0** |
| index ≡ brute force, 178,072 adversarial titles | **0 mismatches** |
| relaunch step under `bash -e -o pipefail` with a census banner | old **exit 1, aborts before dispatch**; new **reaches dispatch, N=0** |
| mutation — bypass the phrase index | throughput pin **RED** (444,601 ms vs its 10,000 ms ceiling) |
| mutation — remove the `vocabularyFor` memo | memo pin **RED** |
| `tsc --noEmit` | clean |
| `rematchCensusThroughput` + `rematchShardingAndCanary` | **40/40 pass** |
| `rematchTrustLadder` 2 failures | **pre-existing** — reproduce with the pre-fix vocab; the PR touches neither that test nor the canary machinery |
| new `workflow_dispatch` inputs | **none** — 24 inputs, byte-identical to main |
| grep-extraction assignments guarded | **56/56** (`\|\| true`, or `\|\| echo 0` inside arithmetic) |

The old side is *slower* on ordinary rows (4.7/s) than on phrase-reaching ones (29/s), which is
the mechanism showing itself: a matching title short-circuits the linear scan, while a
non-matching one pays all 16,187 regex compilations.

## Checks beyond the builder's claims

- **The `.expected.json` baseline is authentic.** I replayed the 200 recorded verdicts against the
  genuine pre-fix classifier (`73a4fe25`, checked out into a separate lib tree): **0 diffs**. The
  file was recorded pre-fix, not regenerated from the new code — which is what makes the equality
  pin worth anything.
- **Fixture provenance.** 5000/5000 and 200/200 fixture rows really are slot 0, with **zero**
  overlap with my slot 19.
- **The anchor claim.** All 16,187 phrases are indexed exactly once across 1,901 buckets, max
  bucket **79** — against the 701 that first-word bucketing would leave under `rookie`.
- **The six steps that needed the fix.** Only 6 relaunch steps lacked `set +e`; line 1116 — the
  census step that actually failed in the field — is one of them.

## Note for the reviewer — a latent fragility, not a present bug

The index anchors each phrase on one of its words, and a title opens that bucket only if it can
produce the anchor as a key. Title keys are `titleWords(t)` plus hyphen-split parts, so a
**pure-alphanumeric** anchor is always producible — an anchor containing a separator is not.

The divergence is real when you can create one. Give the index the phrase `"tie-dye refractor"`
and the title `tie-dye-refractor` tokenises to a single word yielding keys `tie`/`dye`/`refractor`;
the anchor `tie-dye` is never produced, the bucket never opens, and the index returns **false
where the linear scan returns true** (145 of 400 fuzzed cases across several such phrases).

**It is not reachable today, and I verified that rather than assuming it.** Corpus phrases are
normalised with `[^a-z0-9]+ -> " "`, so their words are always alphanumeric, and the two
unnormalised entry points — `HAND_PHRASES` and multi-word `HAND_SPELLINGS`, added with `lower()`
only — carry no non-alphanumeric entries. Measured over the real corpus: **0 of 16,187 phrase
words** and **0 of 1,901 anchors** are non-alphanumeric.

So nothing is broken, and this does not block the merge. But the index's correctness currently
rests on an invariant held only by the corpus data, and a single hand phrase written with a hyphen
would silently switch a finish test off — the quiet direction. The cheap durable guard is a test
asserting every anchor matches `/^[a-z0-9]+$/`, or normalising at the two `phrases.add` sites. I
left it out on purpose: this PR is scoped to the regression, and that is a separate ruling.
