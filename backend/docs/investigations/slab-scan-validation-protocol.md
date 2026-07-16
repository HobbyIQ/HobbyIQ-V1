# Slab-Scan Cert-OCR Validation Protocol — BGS / SGC / CGC

**Status:** Protocol authored 2026-07-16. Data collection open. Ship gate below.
**Owner:** Drew runs the scans; engine team reviews the aggregate before B3 launch.
**Related memory:** [[grader-validation-iou]] — Cardsight grading.company on BGS/SGC/CGC is unvalidated pre-launch.

## Purpose

`/api/compiq/scan` with `hint: "graded"` or `"auto"` runs Cardsight's cert-OCR pipeline, which was calibrated against PSA slabs. Every non-PSA grader is unknown territory. Before iOS lets a user pick "BGS", "SGC", or "CGC" from the scan flow's grader picker, the pipeline must clear a per-grader accuracy bar on real slabs.

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

A grader ships in the scan flow's grader picker when **both** conditions hold on its per-grader aggregate:

1. **Match rate ≥ 85%** of scans return `matchConfidence ≥ 0.7` AND `correctCard === true`.
2. **Zero false-positives at high confidence** — no scan with `matchConfidence ≥ 0.8` AND `correctCard === false`. A confidently-wrong match is worse than a null; the user trusts it.

Additional soft rules:

- **Cert-OCR path must reach ≥ 60% of the sample.** If cert-OCR consistently fails cold and `image-match` picks up the slack, cert prefill (grader/grade auto-fill in the add-holding form) doesn't fire, and the UX degrades to raw-card level.
- **`correctGrade` ≥ 90% among successful matches.** Wrong grade prefill wastes the flow — user has to fix it every time.

## Failure paths

- **Fails match rate:** grader is hidden from the scan picker. Manual add-holding grade picker keeps it. Log a follow-up: escalate to CH's OCR training team.
- **Fails false-positive bar:** same as above, plus a threshold tightener — drop `matchConfidence` acceptance for that grader to 0.85 in iOS (client-side gate; backend still returns).
- **Small sample (< 10 slabs):** grader ships as **"beta"** with a caption in the picker: "Cert-OCR accuracy is being validated for this grader. Expect misses." Track match rate on the first 30 production scans, re-evaluate.

## Where the data goes

- Raw CSV: `backend/docs/investigations/slab-scan-validation-<YYYY-MM-DD>.csv` (single file per session; append rows).
- Aggregate report: `backend/docs/investigations/slab-scan-validation-<YYYY-MM-DD>.md` — per-grader table with match rate, cert-OCR reach, correctGrade rate, notes.
- **Not Cosmos.** This is one-off validation, not ongoing telemetry. Live telemetry from `/api/compiq/scan` is a separate CF (see Follow-up).

## Follow-up (not this session)

- Emit a `compiq_scan_attempt` App Insights event with `{grader, matchPath, matchConfidence, hadCertInfo}` — no image content. Lets us catch calibration drift on the live scan flow after launch.
- Once telemetry runs, retire this manual CSV; the KQL query replaces it.
