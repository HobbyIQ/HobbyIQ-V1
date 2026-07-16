# Slab-Scan Cert-OCR Validation Protocol — BGS / SGC / CGC

**Status:** Protocol authored 2026-07-16. Data collection open. Ship gate below.
**Owner:** Drew runs the scans; engine team reviews the aggregate before B3 launch.
**Related memory:** [[grader-validation-iou]] — Cardsight grading.company on BGS/SGC/CGC is unvalidated pre-launch.

## Purpose

`/api/compiq/scan` with `hint: "auto"` runs Cardsight's cert-OCR pipeline, which was calibrated against PSA slabs. Every non-PSA grader is unknown territory. There is **no pre-scan grader picker** — cert-OCR reads whatever's on the slab label — so what gets gated per grader is the **auto-prefill silent-navigate behavior**: when cert-OCR returns a validated grader, iOS pre-fills and auto-navigates to the price screen; when it returns an unvalidated grader, iOS falls back to a one-tap "Verify grade" confirmation sheet before proceeding.

## Method

1. Enumerate the non-PSA slabs Drew has in hand. For each grader (BGS, SGC, CGC), aim for **≥ 10 slabs**; if fewer are available, the grader ships as "beta" (below).
2. For each slab, capture one scan under **default iOS lighting** — no lightbox, no adjusted white balance. If the user needs a controlled setup to make it work, we shipped the wrong feature.
3. Record per slab in the CSV (schema below): grader (ground truth), grade (ground truth), cardId (ground truth if known, else "unknown"), returned `matchPath`, `matchConfidence`, returned `certInfo.grader`, returned `certInfo.grade`, returned `cardId`, boolean `correctCard`, boolean `correctGrader`, boolean `correctGrade`, free-text `notes`.
4. After each scan, do NOT retake for a better shot. One-shot per slab reflects real user behavior.

## Data schema

Save to `backend/docs/investigations/slab-scan-validation-<YYYY-MM-DD>.csv`. Header row:

```
grader,grade,cardId,scannedAt,matchPath,matchConfidence,returnedGrader,returnedGrade,returnedCardId,correctCard,correctGrader,correctGrade,notes
```

Example rows:

```
BGS,10,1670..x123..,2026-07-16T14:12:00Z,cert-ocr,0.94,BGS,10,1670..x123..,true,true,true,
BGS,9.5,,2026-07-16T14:15:00Z,cert-ocr,0.62,BGS,10,,,false,true,false,cert digits smudged; scanner read "10" for "9.5"
SGC,10,,2026-07-16T14:19:00Z,image-match,0.71,,,1671..x999..,true,false,false,cert-OCR failed cold; image-match returned card w/ no cert prefill
CGC,9,,2026-07-16T14:23:00Z,,,null,null,null,false,false,false,no match; retake would help but rule = one-shot
```

## Ship gate — per grader

A grader unlocks **PSA-parity silent-navigate behavior** (cert-OCR result pre-fills the add-holding form and auto-navigates to the price screen) when **both** conditions hold on its per-grader aggregate:

1. **Match rate ≥ 85%** of scans return `matchConfidence ≥ 0.7` AND `correctCard === true`.
2. **Zero false-positives at high confidence** — no scan with `matchConfidence ≥ 0.8` AND `correctCard === false`. A confidently-wrong match is worse than a null; the user trusts it.

Additional soft rules:

- **Cert-OCR path must reach ≥ 60% of the sample.** If cert-OCR consistently fails cold and `image-match` picks up the slack, cert prefill (grader/grade auto-fill in the add-holding form) doesn't fire, and the UX degrades to raw-card level.
- **`correctGrade` ≥ 90% among successful matches.** Wrong grade prefill wastes the flow — user has to fix it every time.

## Failure paths

- **Fails match rate:** iOS keeps the "Verify grade" confirmation sheet in the scan flow for that grader (no silent-navigate). Manual add-holding grade picker is untouched — all graders are always selectable there. Log a follow-up: escalate to CH's OCR training team.
- **Fails false-positive bar:** same as above, plus tighten the client-side confidence gate for that grader (drop `matchConfidence` silent-navigate threshold to `≥ 0.85`; backend still returns everything).
- **Small sample (< 10 slabs):** stay in the "Verify grade" confirmation path for that grader by default. Track match rate on the first 30 production scans, re-evaluate.

## What iOS does before + after a grader clears

**Before any grader clears (initial ship state):**

- PSA: pre-cleared. Cert-OCR PSA result → silent pre-fill + auto-nav.
- BGS / SGC / CGC: cert-OCR result → "Verify grade" one-tap sheet ("Cert reads BGS 10 — confirm?") → then price screen. Pre-filled fields carry into the next surface if the user taps Confirm; user can also edit before confirming.

**After a grader clears the ship gate:**

- Drop it from the "Verify grade" fallback set. Same behavior as PSA.

**Never — regardless of ship-gate state:**

- Do NOT hide any grader from the manual add-holding grade picker. Users must always be able to add a BGS slab manually even if BGS hasn't cleared the scan-flow gate.

## Where the data goes

- Raw CSV: `backend/docs/investigations/slab-scan-validation-<YYYY-MM-DD>.csv` (single file per session; append rows).
- Aggregate report: `backend/docs/investigations/slab-scan-validation-<YYYY-MM-DD>.md` — per-grader table with match rate, cert-OCR reach, correctGrade rate, notes.
- **Not Cosmos.** This is one-off validation, not ongoing telemetry. Live telemetry from `/api/compiq/scan` is a separate CF (see Follow-up).

## Follow-up (not this session)

- Emit a `compiq_scan_attempt` App Insights event with `{grader, matchPath, matchConfidence, hadCertInfo}` — no image content. Lets us catch calibration drift on the live scan flow after launch.
- Once telemetry runs, retire this manual CSV; the KQL query replaces it.
