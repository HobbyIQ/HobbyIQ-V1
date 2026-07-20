# Suggester quality audit — 2026-07-20

Scan of Drew's 39 holdings surfaced 19 (~49%) with suggester issues.
Documented here for a follow-up fix session; not shipped tonight
because the fixes touch identity-parser logic that needs its own
test suite and is entangled with the retag sweep currently running.

## Real patterns (by severity)

### Pattern 1 — player-name pollution (parser bug)

Parallel-color tokens are leaking into the extracted `playerName`
field:
- `playerName: "Sapphire Owen Carey"` (should be `Owen Carey`)
- `playerName: "Refractors Eric Hartman"` (should be `Eric Hartman`)

Root cause: title tokens like "Numbered Sapphire Owen Carey" are
being tokenized and the color word gets folded into the name span.
The parser should strip a leading BARE_COLOR / distinctive-parallel
token when it precedes what looks like a real first-last name.

Fix location: `services/portfolioiq/holdingFieldNormalizer.service.ts`
(or wherever playerName extraction lives). Add a normalizer that
peels leading parallel-color prefixes before saving playerName.

### Pattern 2 — wrong-parallel candidates picked

Suggester ranks candidates by field-match count but doesn't require
parallel to match. Examples from Drew's inventory:
- Title "2026 Bowman Chrome Orange Eric Hartman" → picked candidate
  "Green Shimmer Refractor"
- Title "2026 Bowman Chrome Xfractor Owen Carey" → picked candidate
  "Yellow X-Fractor"
- Title "2025 Bowman Draft Josiah Hartshorn True" → picked candidate
  "Blue Wave"

Root cause: the confidence tier is "medium" (4/5 fields matched)
even when parallel is the mismatched field. But parallel is the
STRONGEST identity signal for a numbered SKU — mismatching it should
knock the tier to "low" or reject.

Fix location: `services/portfolioiq/cardIdSuggester.service.ts` —
weight `mismatchedFields.includes("parallel")` as a hard penalty
(shift tier down by 1 level minimum). Existing tier logic can stay;
add the penalty as a post-processing step.

### Pattern 3 — cardYear mismatch not caught

Title "1991 Topps Andy Van Slyke Pittsburgh #91A-AVS" → picked
candidate "2026 Topps Baseball Base #91A-AVS". Year off by 35 years.

Root cause: the cardYear filter is soft — a matching cardNumber can
override a mismatched year. But for a vintage card, year is decisive.

Fix location: cardIdSuggester — when `|title.year - candidate.year|
> 3` AND both are present, reject the candidate outright.

### Pattern 4 — missing cardId despite viable suggestion

Title "2026 Bowman Chrome Refractor Brailyn Antunez" — candidate
present ("Blue X-Fractor"), confidence 0.59, `cardId: MISSING`. If
the confidence is high enough for the suggester to have a candidate,
the confirm flow should either apply the suggestion OR require user
review, not leave cardId null.

Fix location: the confirm path — when `suggestionConfidence >= 0.55`
AND `cardId` is missing, either auto-apply or push to review queue.

## Non-issues (looked broken, actually working correctly)

- `suggConf=0.76 tier=medium` with parallel mismatch — expected
  behavior when the pool has an alternative parallel candidate;
  medium confidence + user gets a review prompt in iOS. Ship the
  Pattern 2 fix and this cluster gets sharper.

## Ship as separate PR

None of these need to ship tonight. Each is a real fix with real
tests required. Batch them into a `fix/suggester-quality-audit` PR
next session. Fixes are independent — can ship as 4 small PRs or
one bundle.
