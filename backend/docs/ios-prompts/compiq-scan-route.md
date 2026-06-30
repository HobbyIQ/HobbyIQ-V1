# iOS Slab Scanning — `/api/compiq/scan` Contract

**Status:** Backend shipped (PR #214 wrappers + PR #215 route). iOS implementation TODO.

CF-COMPIQ-SCAN-ROUTE (2026-06-30). Replaces the "type in the card details" UX with "take a photo." Two paths in one endpoint: graded slab scanning AND raw card identification.

## Endpoint

```http
POST /api/compiq/scan
Content-Type: application/json
x-session-id: <session>
```

**Auth:** standard session. **Rate limit:** consumes 1 `priceChecksPerDay` slot (same budget as `/price` and `/price-by-id`).

## Request body

```json
{
  "imageUrl": "https://...",      // OPTIONAL: public URL of the photo
  "imageBase64": "iVBORw0K...",   // OPTIONAL: base64-encoded image bytes
  "hint": "auto"                  // OPTIONAL: "raw" | "graded" | "auto" (default "auto")
}
```

**At least one of `imageUrl` / `imageBase64` is required.** Backend returns `400` if both missing.

**Which to use:**

- **`imageUrl` (preferred)** — if the iOS app already uploaded the photo via the existing `photoStorage` pipeline, pass the URL. Backend caches per-URL for 10 min, so a user tapping the same blob twice is free.
- **`imageBase64`** — when iOS hasn't uploaded yet and wants a one-shot scan with no upload round-trip. Bypasses cache (each base64 is unique).

**`hint`** drives backend routing:

| Hint | Behavior |
|---|---|
| `"graded"` | Tries cert-OCR only. Faster + cheaper when iOS knows it's a slab. |
| `"raw"` | Tries AI image-match only. Faster when iOS knows it's not slabbed. |
| `"auto"` (default) | Tries cert-OCR first; if no card_id resolved, falls back to image-match. Recommend this unless iOS has a strong signal. |

## Response shape

```json
{
  "success": true,
  "cardId": "1605711600415x817320852227883000",
  "player": "Mike Trout",
  "set": "2011 Topps Update Baseball",
  "number": "US175",
  "variant": "Base",
  "matchPath": "cert-ocr",
  "matchConfidence": 0.95,
  "certInfo": {
    "certNumber": "12345678",
    "grader": "PSA",
    "grade": "10"
  }
}
```

**Field semantics:**

- **`cardId`** — pass this to `/api/compiq/price-by-id` for pricing. **Null when neither path resolved a card.**
- **`matchPath`** — `"cert-ocr"` (slab label OCR) or `"image-match"` (visual AI). Null when nothing matched.
- **`matchConfidence`** — 0.0-1.0. iOS may want to warn the user when below 0.7.
- **`certInfo`** — present only when `matchPath = "cert-ocr"`. Contains the OCR'd cert number + grader + grade. iOS can pre-fill the user's holding form.

## Flows iOS implements

### Flow 1 — Raw card scan

1. User taps "Scan card" → camera opens → captures photo
2. iOS optionally uploads to photoStorage, gets back a URL (or keeps as base64)
3. `POST /api/compiq/scan` with `{ imageUrl, hint: "raw" }`
4. On `cardId !== null`: navigate to result screen, immediately call `POST /api/compiq/price-by-id { cardId }`
5. On `cardId === null`: show "couldn't match — try a clearer photo / fall back to text search" UI

### Flow 2 — Graded slab scan

1. User taps "Scan slab" → camera with grading-label framing guide → captures photo
2. `POST /api/compiq/scan` with `{ imageUrl, hint: "graded" }`
3. Pre-fill the "add holding" form with `certInfo.grader` + `certInfo.grade` + the card identity
4. Continue with `/price-by-id` for current pricing

### Flow 3 — Auto / mixed (default)

Use this when iOS doesn't know if the photo is a slab. Backend tries cert-OCR first (fast no-op when raw card) then falls back to image-match.

## Error / edge cases

| Backend response | iOS handles |
|---|---|
| `400 Missing image` | Validation bug — log + show generic "scan failed" |
| `200 success=true, cardId=null` | "Couldn't match — try a clearer photo" UI |
| `200 success=true, matchConfidence < 0.7` | "Low confidence — is this right?" disambiguation UI |
| `200 success=true, matchConfidence < 0.5` (consider) | Same as null match — likely wrong card |
| `429 Rate limited` | Standard rate-limit handling |
| `500 Internal` | Standard error toast + retry button |

## Privacy / telemetry

- **Backend does NOT log image content** — neither base64 bytes nor URL query strings (they may contain SAS signatures).
- **iOS** should similarly avoid logging full image URLs in analytics events.
- Future telemetry CF: backend can emit a `compiq_scan_attempt` event with `{matchPath, matchConfidence, hadCertInfo}` — no image content. Useful for tuning the cert-OCR-vs-image-match threshold.

## Related

- [[grader-validation-iou]] — once the scan flow is live, run BGS / SGC / CGC slabs to validate the cert-OCR pipeline across non-PSA graders. Currently only PSA is well-tested in CH's spec.
- [[card-hedge-api-key-location]] — `CARD_HEDGE_API_KEY` powers the underlying wrappers; already provisioned in HobbyIQ3.
- Existing photo upload: `photoStorage.service.ts` → SAS URLs.
