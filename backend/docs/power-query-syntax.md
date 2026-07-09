# HobbyIQ Power Query Syntax

**Who this is for:** power users who want deterministic search results. The regular free-text search is lenient — it forgives typos, word order, and casing. Following these rules guarantees the engine parses your query the way you intended.

**Non-goal:** this is not the required syntax. Every query the engine accepts today keeps working. This is the shortest, most reliable way to describe a card.

---

## The 10 rules

### 1. Year first, four digits

```
✅ 2026 Bowman Chrome Owen Carey
❌ Owen Carey Bowman 2026 26
```

Anywhere in the query works, but leading with the year makes the parse deterministic and easier for you to eyeball.

### 2. Full brand + set, in the order they appear on the card

```
✅ 2026 Bowman Chrome Prospects Owen Carey
❌ 2026 BC Prospects Owen Carey     (no brand abbreviations)
❌ 2026 Prospects Chrome Bowman     (wrong word order)
```

Recognized sets include: Bowman, Bowman Chrome, Bowman Draft Chrome, Bowman Sapphire, Bowman Draft Sapphire, Topps, Topps Chrome, Topps Update, Topps Chrome Update, Topps Heritage, Bowman's Best, Bowman Sterling. If your set isn't here we fall back to the brand.

### 3. Player name last, spelled fully

```
✅ 2026 Bowman Chrome Owen Carey
❌ 2026 Bowman Chrome O Carey        (no first-name initials)
❌ Owen Carey 2026 Bowman Chrome     (player-first works but less deterministic)
```

**Special case — hyphens and apostrophes are preserved:**

```
✅ Leo De Vries       Ke'Bryan Hayes       Julio Rodriguez-Rodriguez
```

### 4. Card numbers with the hyphen and any prefix

```
✅ BCP-69       CPA-OC       BDC-135       US175       #BCP-69
❌ BCP69        bcp 69       #69
```

Case-insensitive is fine (`bcp-69` parses the same as `BCP-69`). The hash prefix is optional.

### 5. Parallel names — spell out the color AND the suffix

```
✅ Red Refractor            Black X-Fractor
✅ Blue RayWave             Padparadscha Sapphire
✅ Orange Shimmer           Gum Ball Refractor
❌ Red                      (ambiguous: Red /5 base? Red Refractor? Red Sapphire?)
```

Bare colors are recognized for the common cases but multi-word parallels give a definitive parse. See §11 below for the full parallel vocabulary.

### 6. Auto = `auto` or `autograph` after the parallel

```
✅ 2026 Bowman Chrome Red Refractor Auto Owen Carey
❌ 2026 Bowman Chrome Red Refractor Autographed Owen Carey    (works but "auto" is safer)
```

If the card number carries an auto prefix (CPA-, HSA-, BDPA-, etc.) the engine infers auto automatically — you don't need to say it twice.

### 7. Grade — grader THEN grade number, space between

```
✅ PSA 10       BGS 9.5       SGC 9       CGC 8.5
❌ PSA10        PSA-10        10 PSA
```

Un-graded / raw cards: don't include a grade at all. `raw` is accepted but redundant.

### 8. Print run — write `/5`, `/25`, `/150` if the card is numbered

```
✅ 2025 Bowman Chrome Red Refractor Auto /5 Ethan Salas
❌ 5/5     05/5     out of 5
```

The engine also infers print run from the parallel name (Red Refractor → /5), so this is optional for well-known parallels. Include it when the parallel is ambiguous or unusual.

### 9. One parallel per query

```
✅ Red Refractor Auto        (one parallel + auto flag)
❌ Red Refractor Sapphire    (two parallels — engine picks one, may be wrong)
```

If you mean "Red Sapphire" (a single Sapphire product parallel), write it as one token. Same for "Black X-Fractor" or "Gum Ball Refractor" — the multi-word combinations are the parallel name, not two parallels chained.

### 10. Cert numbers stand alone

```
✅ PSA 157815694
✅ BGS 0016567678
✅ SGC 2451254
✅ CGC 5223829087
```

For a cert lookup use `POST /api/compiq/lookup-by-cert` (or the cert-scan flow) — the free-text search won't try to resolve certs.

---

## §11 — Recognized parallels

The complete list the parser knows. Anything not here still parses (falls to the base card) but doesn't get a parallel floor.

### 1/1 tier
- Superfractor
- Printing Plate
- Padparadscha Sapphire
- Nebula Prizm (Panini)
- Black Finite / Black Prizm (Panini)

### /5 tier
- Red / Red Refractor / Red X-Fractor
- Gum Ball / Bubblegum / Snackpack (retail)
- Peanuts / Sunflower Seeds Refractor (retail)
- Red Shimmer Refractor
- Red Sapphire
- Fanimation
- Gold Vinyl (Panini)

### /10 tier
- Black / Black Refractor / Black X-Fractor
- Orange Shimmer
- Gold Prizm (Panini)

### /25 tier
- Orange / Orange Refractor / Orange X-Fractor
- Camo Prizm / Mojo Prizm (Panini)

### /35 tier
- Bowman Logofractor

### /50 tier
- Gold / Gold Refractor / Gold X-Fractor
- Gold Sapphire
- Gold Shimmer Refractor
- Shimmer Refractor (bare — falls to /50 as a middle-ground catch-all)

### /75 tier
- Aqua
- Blue Sapphire / Green Sapphire / Yellow Sapphire / Orange Sapphire
- Blue Shimmer Refractor / Aqua Shimmer Refractor / Sky Blue Shimmer Refractor
- Blue Ice / Purple Prizm (Panini)

### /99 tier
- Green (auto)
- Green Shimmer Refractor

### /100 tier
- Mini-Diamond / Mini Diamond Refractor

### /150 tier
- Blue / Blue Refractor / Blue X-Fractor

### /250 tier
- Purple (auto) / Purple Refractor / Purple X-Fractor

### /299 tier
- Sparkle / Sparkle Refractor
- Speckle / Speckle Refractor
- Red Prizm (Panini)

### /499 tier
- Green Refractor / Green X-Fractor

### /500 tier
- Silver Prizm / Green Prizm (Panini)

---

## Query-preview endpoint

For iOS clients that want to render "here's what the engine parsed" before running a full search, hit:

```
POST /api/compiq/parse-preview
{ "query": "2026 bowman chrome owen carey black bcp-69" }
```

Returns:

```json
{
  "success": true,
  "query": "2026 bowman chrome owen carey black bcp-69",
  "parsed": {
    "playerName": "Owen Carey",
    "year": 2026,
    "brand": "Bowman",
    "set": "Bowman Chrome",
    "parallel": "Black",
    "isAuto": false,
    "cardNumber": "BCP-69",
    "grade": null,
    "gradingCompany": null,
    "confidence": 0.9
  },
  "chips": [
    { "label": "Player", "value": "Owen Carey" },
    { "label": "Year", "value": "2026" },
    { "label": "Brand", "value": "Bowman" },
    { "label": "Set", "value": "Bowman Chrome" },
    { "label": "Parallel", "value": "Black" },
    { "label": "#", "value": "BCP-69" }
  ],
  "confidence": 0.9
}
```

No pricing engine load, no CH calls — this is pure local math. Safe to call on every keystroke during typeahead.

---

## Non-goals / anti-patterns

**Don't include team, series, or subset when the card number captures it.** Redundant tokens don't help disambiguation and occasionally trip the noise filter:

```
❌ 2026 Bowman Chrome Prospects Owen Carey Braves Rookie Card RC #BCP-69 SP
✅ 2026 Bowman Chrome Owen Carey BCP-69
```

Team name and "RC" get stripped as noise anyway. "SP" (short print) can confuse the parallel field.

**Don't include colloquial abbreviations** — "chrome refractor" is fine but "chromed" isn't.

**Don't chain multiple grades.** One grade per query. If you own the same card in multiple grades, run them as separate queries.

---

## What if the engine misparses?

1. Run `POST /parse-preview` first and eyeball the `chips` output.
2. If a field is wrong (e.g. player name absorbed a color word), rearrange the query or use hyphens: `Owen-Carey` will lock the player as a single token.
3. File a parser gap with the query + expected parse in `[[ch-catalog-gaps-2026-07-01]]` — pattern gaps in the parser get folded into the PARALLEL_PATTERNS or NOISE lists on the next release.
