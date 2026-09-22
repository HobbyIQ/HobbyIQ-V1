# acq-2026-09-22-1829-topps-2025-inserts

Staged rows only for cardNumbers that had ZERO strict checklist row (catalogAuthorityOf === "checklist")
under `setKey=topps year=2025` for their `Base` parallel, AND no strict row under any sibling setKey
(cross-key dedup query: `year=2025 AND LOWER(cardNumber)=LOWER(@n)` across all setKeys). Rows that already
had a strict row elsewhere (mostly `topps-series-2`) were excluded — those are wrong-key, not absent;
S1+S2 belong under `topps` per owner ruling but re-keying them is out of scope for this acquisition.

Source: checklistinsider.com, fetched 2026-09-22, browser UA, ≥5s apart.
- https://checklistinsider.com/2025-topps-series-1-baseball/
- https://checklistinsider.com/2025-topps-series-2-baseball/

All four target sections were partially ingested the day before (`checklistinsider-2026-09-21`, part of
the BSA/BSA2/SMLB/CC/CC2/CCAR/CCA2/PPA batch noted in the acquisition brief) — most cardNumbers per
section already carry checklistinsider rows for colored parallels (Blue/Gold/Orange/Black/Red/Platinum),
but a subset of cardNumbers is missing entirely, and many that ARE registered are missing the plain
`Base` parallel row that unbacked sales are keying against. This package sources only that residual gap.

## 90asr/ — "1990 Topps Baseball All-Star Relics Checklist" (Topps Series 2 insert)
URL: https://checklistinsider.com/2025-topps-series-2-baseball/ (section header "1990 Topps Baseball All-Star Relics Checklist", 44 cards.)
Parallels sentence (verbatim): "Blue /150; Gold /50; Orange /25; Black /10; Red /5; Platinum 1/1."
isAuto: false (relic insert, not an autograph).
14 cardNumbers staged (of 44 total; 30 already had a strict Base row somewhere, or fell out during
cross-key dedup). cardNumbers: 90ASR-AB, 90ASR-AJ, 90ASR-AP, 90ASR-BW, 90ASR-CJ, 90ASR-DJ, 90ASR-FTH,
90ASR-MM, 90ASR-MO, 90ASR-MP, 90ASR-MT, 90ASR-RD, 90ASR-SST, 90ASR-VG.
98 rows (14 x 7 parallels).

## cc2-swatch/ — "City Connect Swatch Collection Checklist" (Topps Series 2 insert)
URL: https://checklistinsider.com/2025-topps-series-2-baseball/ (section header "City Connect Swatch
Collection Checklist", 47 cards.) NOTE: a second, unrelated "Companion Cards Checklist" (25 cards) also
uses a `CC2-` prefix but with NUMERIC codes (CC2-1..CC2-25) — excluded, not the same product, verified by
player/card-number shape mismatch against the unbacked sales (which carry alphabetic codes, e.g. CC2-RC,
CC2-DS).
Parallels sentence (verbatim): "Blue /150; Gold /50; Orange /25; Black /10; Red /5; Platinum 1/1."
isAuto: false.
12 cardNumbers staged (of 47 total). cardNumbers: CC2-AM, CC2-AU, CC2-BB, CC2-BE, CC2-BH, CC2-BL, CC2-BS,
CC2-DS, CC2-ET, CC2-FF, CC2-GS, CC2-JR.
84 rows (12 x 7 parallels).

## 90asc/ — "1990 Topps Chrome All-Star Baseball Checklist" (Topps Series 2 insert)
URL: https://checklistinsider.com/2025-topps-series-2-baseball/ (section header "1990 Topps Chrome
All-Star Baseball Checklist", 50 cards, "Hobby/Jumbo Silver Pack exclusive.")
Parallels sentence (verbatim): "Aqua Refractor /199; Blue Refractor /150; Green Refractor /99; Gold
Refractor /50; Orange Refractor /25; Red Refractor /5; SuperFractor 1/1."
isAuto: false.
NOTE: 90ASC-7 is a stated double (David Ortiz AND Ted Williams both print as "90ASC-7" on the source
page) — flagged verbatim, not resolved; staged once per distinct cardNumber if it fell in the missing set
(check cards.csv; if 90ASC-7 appears, only one player name was retained and this is a known open flag).
16 cardNumbers staged (of 50 total).
128 rows (16 x 8 parallels, including Base).

## bsa2/ — "Baseball Stars Autographs Checklist" (Topps Series 2 insert, S2 twin of Series 1's BSA-)
URL: https://checklistinsider.com/2025-topps-series-2-baseball/ (section header "Baseball Stars
Autographs Checklist", page states "105 cards.")
Parallels sentence (verbatim): "Blue /150; Gold /50; Orange /25; Black /10; Red /5; Platinum 1/1."
isAuto: true (autograph insert).
KNOWN GAP: the page's own list under this header only prints 80 distinct BSA2- cardNumbers, 25 short of
its own stated "105 cards" caption. Not a nested-list/dedupe artifact (grep found exactly 80 unique lines
between this header and the next "BSA-" (Series 1) block). Staged verbatim from what actually printed;
the 25-card shortfall is unsourceable from this fetch and is NOT staged — flagging for a follow-up fetch
or an alternate source (cardboardconnection.com was not reachable for this product at the time of this
acquisition).
18 cardNumbers staged (of the 80 confirmed-printed; some of the 80 already had strict rows or fell to
cross-key dedup under topps-series-2). cardNumbers: BSA2-AG, BSA2-AP, BSA2-AS, BSA2-BG, BSA2-CM, BSA2-FM,
BSA2-HB, BSA2-JBA, BSA2-JF, BSA2-KM, BSA2-MM, BSA2-NS, BSA2-PA, BSA2-RA, BSA2-RJ, BSA2-RS, BSA2-TGE,
BSA2-YD.
126 rows (18 x 7 parallels).

## Dedupe / registration
- setKey `topps` is already registered (124k+ existing rows for the bowman-chrome/topps family observed
  during diagnosis; `topps` itself carries the CC2/BSA2/90ASR/90ASC cardNumbers already ingested
  2026-09-21). No new setKey created.
- Cross-key dedupe performed via Cosmos query `SELECT c.setKey, c.source, c.parallel FROM c WHERE
  c.year=2025 AND LOWER(c.cardNumber)=LOWER(@cardNumber)` for every candidate cardNumber, filtered to
  `catalogAuthorityOf(source) === "checklist"` rows only (mirroring
  backend/src/services/catalog/catalogAuthority.service.ts). 93 of the original 153 candidate rows were
  excluded this way (already strict-backed under `topps-series-2`).
- 0 exact-duplicate CSV lines in each of the four cards.csv files (verified: `sort | uniq -d` empty).

## What this package does NOT fix
- The `topps-series-2` vs `topps` filing split itself (owner ruling: S1+S2 both belong under `topps`) —
  a re-key migration, out of scope here.
- The spelling/rung mismatches measured in STEP 1 for `topps`/`topps-chrome`/`bowman-chrome` (e.g.
  "Refractor" sold vs "Autographs Refractor" registered on CPA- Chrome Prospect Autographs; "Sepia
  Refractor" mismatches on Chrome Update numbers) — reported, not sourced, per the brief.
- `USC-` (topps-chrome, wrong-key: belongs under `topps-chrome-update-series`) — reported, not sourced.
- Bowman Chrome CPA-/BCP- Base-parallel gaps measured in STEP 1 (bowman-chrome 2025) — these were found
  to be almost entirely spelling/rung mismatches against already-registered checklist rows for OTHER
  parallels of the same cardNumber (e.g. CPA-ZC has strict rows for Autographs Refractor, Green
  Geometric Refractor, etc., but not bare Base) — reported, not sourced in this package; a dedicated
  bowman-chrome package would be needed and was not built here due to time.
