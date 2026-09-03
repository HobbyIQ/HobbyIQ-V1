# Search acceptance: the misses that are NOT search

CF-SEARCH-A-LISTING-IS-NOT-A-NAME (2026-09-03). Produced while pushing the
identity-triangulation number. Read-only measurement, 200-card baseball
sample, seed 7, `SAMPLE=200 SPORT=baseball YEAR_MIN=2016`.

The search-side fixes shipped in the same PR. **These did not**, because
hacking search to hide them would price the wrong card. They belong to the
universe / gap lanes.

## 1. The sale is keyed to a card it is not (94 of 200)

The single biggest finding, and it caps the harness. For 94 of the 200
sampled cards the pooled sale `sold_comps.hobbyiqCardId` points at a
checklist card whose player the sale title never names — a different
player, often a different sport. The harness then asks search to find a
Kyle Tucker baseball card from a One Piece Luffy title, and counts the
correct refusal as a miss.

Restricting the same run to the 106 rows whose input is coherent:

```
            all 200 rows      106 coherent rows
  sale         77.5%              73.6%
  holding      92.5%              90.6%
  search       42.0%              49.1%
  ALL THREE    35.0%              41.5%
```

So ~6.5 points of the acceptance gap is pool mis-keying, not search. Until
these rows are re-derived (GREAT REMATCH), the harness cannot exceed ~53%
no matter what search does.

### The rows

| cardId | checklist player | sale title |
| --- | --- | --- |
| `hiq:baseball:2020:panini-chronicles:9:base:auto` | Michael King | 2020 Chronicles Draft Picks Donruss Jeremy Chinn RC Rated Rookie Auto  |
| `hiq:baseball:2024:topps-chrome-sapphire:658:base:no-auto` | Weston Wilson | CONNOR WONG SIGNED 2024 TOPPS HERITAGE TRADING CARD #658 RED SOX |
| `hiq:baseball:2023:panini-chronicles:72:base:no-auto` | Deyvison De Los Santos | PANINI 2023 Chronicles Spectra Baseball Jackson Holliday #72 Red Donut |
| `hiq:baseball:2024:bowman-chrome:bcp-187:base:no-auto` | Blake Dunn | 2024 Bowman Chrome Prospects Baseball #BCP-187 Base |
| `hiq:baseball:2020:bowman:btp-30:base:no-auto` | Drew Waters | 2020 Bowman Baseball #BTP-30 Base |
| `hiq:baseball:2024:topps-stadium-club:176:red-foil:no-auto` | Pete Alonso | 2024 Topps Stadium Club Baseball #176 Red Foil |
| `hiq:baseball:2024:topps-stadium-club:160:pink-foil:no-auto` | Kyle Manzardo | 2024 Topps Stadium Club Baseball #160 Pink Foil |
| `hiq:baseball:2025:topps-chrome-platinum:55ws-6:base:no-auto` | Sandy Koufax | 2025 Topps Chrome Platinum Baseball #55WS-6 Base |
| `hiq:baseball:2023:topps-heritage:ccr-js:base:no-auto` | Juan Soto | 2023 Topps Heritage Baseball #CCR-JS Base |
| `hiq:baseball:2025:topps-pro-debut:pdc-200:base:no-auto` | Marcelo Mayer | 2025 Topps Pro Debut Baseball #PDC-200 Base |
| `hiq:baseball:2024:topps-stadium-club:119:red-foil:no-auto` | Kyle Tucker | PSA 10 Monkey D. Luffy (119) OP09-119 Emperors in the New World Foil J |
| `hiq:baseball:2025:topps-pristine:238:base:no-auto` | Grant McCray | 2025-26 Upper Deck Series 1 Ryan Leonard Young Guns Clear Cut #238 |
| `hiq:baseball:2026:topps-heritage:138:red-bordered:no-auto` | Tyler Stephenson | 2026 Topps Heritage Baseball #138 Red Bordered |
| `hiq:baseball:2026:bowman:bcp-49:base:no-auto` | Aidan Miller | 2026 Bowman Baseball #BCP-49 Base |
| `hiq:baseball:2025:bowman-chrome:bcp-190:base:no-auto:num-499` | Kenny Fenelon | 2025 Bowman Chrome Prospects Baseball #BCP-190 Base |
| `hiq:baseball:2024:panini-boys-of-summer:28:base:no-auto:num-99` | Hurston Waldrep | 2024 Panini Boys of Summer - Druw Jones #28 Blue /99 (RC) |
| `hiq:baseball:2024:panini-prizm:294:base:no-auto` | Jim Palmer | 2024-25 Panini Prizm Black Jason Williams #294 Silver Sacramento Kings |
| `hiq:baseball:2025:panini-prizm:17:base:auto` | Austin Wells | 2025 Panini Prizm Black Mark Brunell Flashback Signatures Auto #17 Jag |
| `hiq:baseball:2026:topps-heritage:17:dark-gray-bordered:no-auto` | Jacob Wilson | 2026 Topps Heritage Baseball #17 Dark Gray Bordered |
| `hiq:baseball:2025:panini-crusade:79:base:no-auto` | Tink Hence | Panini 2025 Crusade Insert PJ Morlando #79 Miami Marlins Baseball Card |
| `hiq:baseball:2022:bowman-draft:cda-js:blue-wave:auto` | Jordan Sprinkle | 2022 Bowman Draft Baseball #CDA-JS Blue Wave |
| `hiq:baseball:2022:bowman-draft:cda-af:black-and-white-ray-wave:auto` | Alex Freeland | 2022 Bowman Draft Baseball #CDA-AF Black and White Raywave |
| `hiq:baseball:2025:topps-chrome:131:sepia-refractor:no-auto` | Dustin Harris RC | 2025 Topps Chrome Baseball #131 Sepia Refractor |
| `hiq:baseball:2025:bowman:14:base:no-auto` | Lawrence Butler | 2025 Prospect Edition - TRAVIS BAZZANA - Prepping for the Pros #14/25 |
| `hiq:baseball:2023:topps-big-league:244:uncommon-foil:no-auto` | Aaron Nola | 2023 Topps Big League Baseball #244 Uncommon Foil |
| `hiq:baseball:2024:panini-prospect-edition:164:base:no-auto:num-10` | Dalton Rushing | Riley Greene  - 2024 Topps Triple Threads #164 Pink /125 Tigers |
| `hiq:baseball:2026:topps-heritage:163:dark-gray-bordered:no-auto` | Mike Trout | 2026 Topps Heritage Baseball #163 Dark Gray Bordered |
| `hiq:baseball:2025:panini-prizm:226:base:no-auto` | Colin Houck | 2025 Panini Select Cam Ward #226 Club Level Orange Shock Prizm /399 RC |
| `hiq:baseball:2023:topps-heritage:224:base:no-auto` | Daulton Varsho | 2023 Topps Heritage - 1974 Topps Originals Buybacks Roger Metzger #224 |
| `hiq:baseball:2025:panini-boys-of-summer:68:base:no-auto:num-249` | Jack Leiter | 2025 Panini Boys of Summer #68 George Lombard Jr. 215/249 ROOKIE YANKE |
| `hiq:baseball:2022:topps-chrome:208:prism-refractor:no-auto` | Shane Bieber | 2022 Topps Chrome Platinum Anniversary #208 Harold Baines Prism Refrac |
| `hiq:baseball:2026:topps-chrome:208:negative-refractor:no-auto` | Dylan Cease | 2026 Topps Chrome Trea Turner #208 Green RayWave Refractor 82/99 |
| `hiq:baseball:2022:bowman-draft:cda-nsz:blue-wave:auto` | Noah Schultz | 2022 Bowman Draft Baseball #CDA-NSZ Base |
| `hiq:baseball:2020:panini-contenders:66:base:no-auto` | Cody Bellinger | 2020-21 Panini Contenders #66 DeMar DeRozan Conference Finals Ticket # |
| `hiq:baseball:2026:topps-heritage:77:deckle-edge:no-auto` | Mark Vientos | 2026 Topps Heritage Baseball #77 Deckle Edge |
| `hiq:baseball:2024:panini-prizm:249:base:no-auto` | Jackson Jobe | 2024-25 Panini Select Premier League #249 Didier Drogba Purple Mojo |
| `hiq:baseball:2023:panini-prizm:153:prizm-purple-ice:no-auto` | Sterlin Thompson | 2023-24 Panini Select FIFA - Mezzanine Jorrel Hato #153 Orange Prizm / |
| `hiq:baseball:2022:bowman-draft:cda-eg:blue:auto` | Elijah Green | 2022 Bowman Draft Baseball #CDA-EG Blue |
| `hiq:baseball:2024:topps-stadium-club:286:pink-foil:no-auto` | Jose Canseco | Rutschman Kimbrel 2024 Topps Update Series Veteran Combo Purple Foil # |
| `hiq:baseball:2024:topps-museum-collection:77:base:no-auto` | Mark McGwire | Chase Hampton 2024 Panini Select Diamond Level #77 New York Yankees |

_(94 total; first 40 shown. Full list regenerable from the harness.)_

## 2. A subset name stored in the parallel field (8 observed)

The checklist row for an insert lands with the SECTION HEADING as its
parallel, so the product carries two rows for one card: the real `Base`
row, and a duplicate under the insert name. A query naming the card
("Bowman Scouts Top 100 #BTP-5") then legitimately matches the duplicate,
and the pool splits — one card, two rows, two pools, and the FMV of
whichever the sale lands on.

This is [[one-card-one-row-one-pool]], not a ranking bug: no scoring change
can be correct while both rows exist, because the query really does name
the words on the duplicate.

| cardId (the real row) | duplicated as parallel |
| --- | --- |
| `hiq:baseball:2025:bowman:btp-5:base:no-auto` | `bowman-scouts-top-100` |
| `hiq:baseball:2026:bowman:btp-30:base:no-auto` | `bowman-scouts-top-100` |
| `hiq:baseball:2026:bowman:bcp-125:base:no-auto` | `chrome-prospects` |
| `hiq:baseball:2025:bowman-chrome:it-1:base:no-auto` | `it-came-to-the-league-refractor` |
| `hiq:baseball:2021:bowman-chrome:ba-13:base:auto` | `bowman-ascensions-refractor` |
| `hiq:baseball:2025:panini-three-and-two:18:base:no-auto:num-99` | `award-winning` |
| `hiq:baseball:2026:bowman:bp-98:base:no-auto` | `bowman-logo-pattern` |
| `hiq:baseball:2024:panini-three-and-two:17:base:no-auto` | `downtown` |

2024 Panini Three and Two is the worst case seen: `beckett-checklist`
wrote rows whose parallel is literally `"48 cards."`, `"41 cards."`,
`"32 cards."` — the checklist’s own section counts, minted as parallels.

## 3. Generic stub titles (18 observed) — NOT a defect

18 sampled sales carry a synthesized title of the shape
`"2025 Bowman Draft Baseball #BD-188 Base"` with no player at all. Search
still landed the exact card on 17 of the 18, so these are recorded only so
the next reader does not re-investigate them.
