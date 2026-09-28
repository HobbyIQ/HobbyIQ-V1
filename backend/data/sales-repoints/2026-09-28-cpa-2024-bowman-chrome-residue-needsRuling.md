# needsRuling: 2024 Bowman Chrome CPA residue -- 560 sales, no bowman checklist row names the player

Companion sidecar to `backend/data/sales-repoints/2026-09-28-cpa-2024-bowman-chrome-residue-to-bowman.json`.

These 99 groups (560 sales, 63 distinct fromId addresses) were part of List 1's (run 36364997706) 827 namesAgree name-disagreement refusals. Unlike the 267 sales this PR repoints (name-shape noise or a single-character/diacritic transcription variant of the SAME player), every sale in this file was checked against its own scraped title (not just the extracted `playerName` field) and the title repeatedly, consistently, and unambiguously names a DIFFERENT full name than the destination bowman checklist row -- under the exact same CPA card number.

**No bowman cpa checklist row (87 distinct players, 1,385 rows at the bowman address) names any of these sale-title players either.** This is not an initials collision resolvable by re-routing to a sibling CPA number -- it looks like the checklist source (checklistcenter-2026-08-29 / checklistinsider-2026-08-27 / beckett-checklist) mistranscribed the player's name for that specific CPA number, and the sale titles (mostly cardsight, tca-ebay and cardhedge scrapes of the physical card) are more likely correct. Fixing a checklist row's `playerName` is out of scope for a sales-repoint list, so these sales stay at their current address, unmoved, pending a ruling on which name is actually printed on the card.

## Method

For each of the 827 List 1 name-disagreement refusals, grouped by (saleName, destPlayer, toId): `namesAgree()`, a token-containment check, and a small-edit-distance check (all three passed = same-player noise, repointed in the companion list) were run first. The 99 groups below failed all three. A sample sale doc's own `title` field was then point-read for each group -- shown below -- to confirm the mismatch is not an artefact of a lossy `playerName` extraction.

## Groups (99, sorted by sale count)

| # | sales | fromId (CPA card) | sale playerName | destination checklist playerName | sample title |
|---|---|---|---|---|---|
| 1 | 48 | `cpa-et:refractor:auto:num-499` | Eduardo Tait | Erick Torres | 2024 Bowman Chrome EDUARDO TAIT Auto Refractor /499 #CPA-ET |
| 2 | 42 | `cpa-ps:refractor:auto:num-499` | Paulino Santana | Paul Skenes | Paulino Santana 2024 Bowman Chrome Autographs Green 83/99 #CPA-PS Auto PSA 10 |
| 3 | 41 | `cpa-eb:refractor:auto:num-499` | Eduardo Beltre | Erick Bautista | 2024 Bowman Chrome EDUARDO BELTRE 214/499 1st Bowman Auto Ref #CPA-EB PSA 10 |
| 4 | 38 | `cpa-ete:refractor:auto:num-499` | Emiliano Teodo | Enmanuel Tejeda | 2024 Bowman Chrome - Prospect Autographs Emiliano Teodo #CPA-ETE Refractor /499 |
| 5 | 36 | `cpa-as:red-refractor:auto:num-5` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez AUTO /150 1st Bowman, 2024 Bowman Chrome, Cincinnati Reds - Raw 10 |
| 6 | 33 | `cpa-ev:refractor:auto:num-499` | Echedry Vargas | Esmerlyn Valdez | ECHEDRY VARGAS 2024 BOWMAN CHROME PROSPECT AUTO REFRACTOR 1ST /499 PSA 10 Q0107 |
| 7 | 31 | `cpa-ym:red-refractor:auto:num-5` | Yordanny Monegro | Yohandy Morales | 2024 Bowman Chrome Yordanny Monegro #CPA-YM Auto 1st Prospect Red Sox |
| 8 | 25 | `cpa-db:refractor:auto:num-499` | Derek Bernard | Diego Benitez | Derek Bernard 2024 Bowman Chrome #CPA-DB Refractor Auto 1st RC /499 |
| 9 | 23 | `cpa-ar:refractor:auto:num-499` | Adriel Radney | Agustin Ramirez | 2024 Bowman Chrome - Prospect Autographs Adriel Radney #CPA-AR Refractor /499... |
| 10 | 16 | `cpa-ym:refractor:auto:num-499` | Yordanny Monegro | Yohandy Morales | 2024 Bowman Chrome Prospect Auto Refractor 348/499 Yordanny Monegro #CPA-YM |
| 11 | 16 | `cpa-jr:refractor:auto:num-499` | Jensy Rivas | Jesus Rodriguez | 2024 Bowman Chrome Prospect Auto Jensy Rivas #CPA-JR  |
| 12 | 14 | `cpa-ja:refractor:auto:num-499` | Jalvin Arias | Jadher Areinamo | Jalvin Arias 2024 Bowman Chrome #CPA-JA Refractor Auto 1st RC 120/499 |
| 13 | 12 | `cpa-et:yellow-refractor:auto:num-75` | Eduardo Tait | Erick Torres | EDUARDO TAIT 2024 BOWMAN CHROME 1ST AUTOGRAPH PHILLIES #CPA-ET AUTO Q1339 |
| 14 | 12 | `cpa-as:gold-refractor:auto:num-50` | Adolfo Sanchez | Anthony Scull | 2024 Bowman Chrome ADOLFO SANCHEZ 2/50 1st RC Auto Gold Diamond #CPA-AS PSA 10 |
| 15 | 12 | `cpa-bm:refractor:auto:num-499` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome Refractor Braylin Morel Rangers RC Rookie AUTO /499 PSA 9 |
| 16 | 9 | `cpa-es:refractor:auto:num-499` | Emilio Sanchez | Estuar Suero | Emilio Sanchez AUTO /499 Refractor 1st Bowman, 2024 Bowman Chrome, Orioles - Raw 10 |
| 17 | 9 | `cpa-as:yellow-refractor:auto:num-75` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez 2024 Bowman Chrome #CPA-AS Yellow Refractor 1st RC Auto 35/75 |
| 18 | 8 | `cpa-bm:gold-refractor:auto:num-50` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome Braylin Morel Gold Mini Diamond Refractor AUTO /50 Rangers - Raw 10 |
| 19 | 8 | `cpa-ym:yellow-refractor:auto:num-75` | Yordanny Monegro | Yohandy Morales | YORDANNY MONEGRO 2024 BOWMAN CHROME YELLOW REFRACTOR 1ST AUTO /75 #CPA-YM Q0185 |
| 20 | 7 | `cpa-et:blue-refractor:auto:num-150` | Eduardo Tait | Erick Torres | Topps 2024 Bowman Chrome Eduardo Tait Auto Rep-Blue Refractor /150 #CPA-ET PSA 9 |
| 21 | 6 | `cpa-as:refractor:auto:num-499` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez 2024 Bowman Chrome 1st Prospect Auto #CPA-AS Refractor 493/499 - Raw 10 |
| 22 | 6 | `cpa-jb:refractor:auto:num-499` | Jake Bloss | Jacob Burke | Jake Bloss 2024 Topps Bowman Chrome Baseball Refractor Auto /499 - Raw 10 |
| 23 | 6 | `cpa-ja:yellow-refractor:auto:num-75` | Jalvin Arias | Jadher Areinamo | 2024 Bowman Chrome Sapphire Yellow Refractor Jalvin Arias 1st Rookie AUTO 29/50 - Raw 10 |
| 24 | 4 | `cpa-et:gold-refractor:auto:num-50` | Eduardo Tait | Erick Torres | 2024 Bowman Chrome EDUARDO TAIT 3/50 1st Bowman Auto Gold Refractor #CPA-ET |
| 25 | 4 | `cpa-db:gold-refractor:auto:num-50` | Derek Bernard | Diego Benitez | Derek Bernard 2024 Bowman Chrome #CPA-DB Gold Refractor 1st RC Auto /50 |
| 26 | 4 | `cpa-tb:base:auto` | Travis Bazzana | Tony Blanco Jr. | 2024 Bowman Chrome Travis Bazzana #CPA-TB 1st Auto Cleveland Guardians Rookie |
| 27 | 3 | `cpa-ete:orange-refractor:auto:num-25` | Emiliano Teodo | Enmanuel Tejeda | 2024 Bowman Chrome Emiliano Teodo 1st Orange Refractor Auto /25 #CPA-ETE |
| 28 | 3 | `cpa-ar:gold-refractor:auto:num-50` | Adriel Radney | Agustin Ramirez | 2024 Bowman Chrome Adriel Radney 1st  Auto True Gold Refractor # /50 - Raw 10 |
| 29 | 3 | `cpa-ar:green-refractor:auto:num-99` | Adriel Radney | Agustin Ramirez | Adriel Radney 2024 Bowman Chrome #CPA-AR Green Refractor Auto 1st RC /99 |
| 30 | 3 | `cpa-ev:green-refractor:auto:num-99` | Echedry Vargas | Esmerlyn Valdez | 2024 Topps Chrome Bowman 1st Echedry Vargas #CPA-EV Green Refractor 24/99 KS20 |
| 31 | 3 | `cpa-et:orange-refractor:auto:num-25` | Eduardo Tait | Erick Torres | Eduardo Tait 2024 Bowman Chrome #CPA-ET Orange Refractor 1st RC Auto 11/25 |
| 32 | 3 | `cpa-aan:base:auto` | Anderson | Antonio Anderson | 2024 Bowman Antonio Anderson Chrome Auto Autograph 1st Prospect #CPA-AAN Red Sox |
| 33 | 2 | `cpa-ja:blue-refractor:auto:num-150` | Jalvin Arias | Jadher Areinamo | JALVIN ARIAS 2024 BOWMAN CHROME 1ST BLUE REFRACTOR AUTO /150 #CPA-JA Q0566 |
| 34 | 2 | `cpa-bba:base:auto` | Baro | Boston Baro | 2024 Bowman Boston Baro Chrome Auto Autograph 1st Prospect #CPA-BBA Mets |
| 35 | 2 | `cpa-ym:blue-refractor:auto:num-150` | Yordanny Monegro | Yohandy Morales | YORDANNY MONEGRO 2024 BOWMAN CHROME BLUE REFRACTOR 1ST AUTO /150 #CPA-YM Q7697 |
| 36 | 2 | `cpa-db:blue-refractor:auto:num-150` | Derek Bernard | Diego Benitez | 2024 Bowman Chrome Derek Bernard 1st Bowman Auto Reptillian Blue /150 #CPA-DB |
| 37 | 2 | `cpa-db:orange-refractor:auto:num-25` | Derek Bernard | Diego Benitez | 2024 Bowman Chrome Colorado Rockies Derek Bernard Orange Refractor Auto 25/25  - Raw 10 |
| 38 | 1 | `cpa-ps:refractor:auto:num-499` | Reptilian Paulino Santana | Paul Skenes | 🔥2024 Bowman Chrome Prospects Auto Blue Reptilian /150 #CPA-PS Paulino Santana |
| 39 | 1 | `cpa-db:red-refractor:auto:num-5` | Benitez | Diego Benitez | 2024 Bowman Diego Benitez Chrome Auto Autograph 1st Prospect #CPA-DB Braves |
| 40 | 1 | `cpa-es:blue-refractor:auto:num-150` | Emilio Sanchez | Estuar Suero | ESTUAR SUERO 2024 Bowman Chrome Auto #CPA-ES True Blue Refractor /150 PSA 10 Gem |
| 41 | 1 | `cpa-es:yellow-refractor:auto:num-75` | Emilio Sanchez | Estuar Suero | 2024 Bowman Chrome Emilio Sanchez Auto 1st #CPA-ES Orioles |
| 42 | 1 | `cpa-es:yellow-refractor:auto:num-75` | Emilio Sanchez Yellow | Estuar Suero | Emilio Sanchez 2024 Bowman Chrome 1st Auto Yellow Refractor /75 Orioles CPA-ES |
| 43 | 1 | `cpa-as:blue-refractor:auto:num-150` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez 2024 Bowman Chrome #CPA-AS Blue Refractor Auto 1st RC 84/150 |
| 44 | 1 | `cpa-as:blue-refractor:auto:num-150` | Aidan Smith Blue Lunar | Anthony Scull | 2024 Bowman Aidan Smith Chrome 1st Blue Lunar Crater Refractor Auto /150 #CPA-AS |
| 45 | 1 | `cpa-et:refractor:auto:num-499` | Eduardo Tait Autographs Refractors | Erick Torres | 2024 Bowman Chrome #CPA-ET Eduardo Tait Prospect Autographs Refractors #/499 |
| 46 | 1 | `cpa-ps:green-refractor:auto:num-99` | Paulino Santana | Paul Skenes | 2024 Bowman Chrome Paulino Santana #CPA-PS 1st Green Auto 92/99 Rangers |
| 47 | 1 | `cpa-eb:gold-refractor:auto:num-50` | Eduardo Beltre | Erick Bautista | 2024 Bowman Chrome 1st Bowman Eduardo Beltre #CPA-EB True Gold Refractor Auto/50 |
| 48 | 1 | `cpa-ev:green-refractor:auto:num-99` | True Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome Prospect Auto True Green #CPA-EV Echedry Vargas /99 |
| 49 | 1 | `cpa-bw:base:auto` | Brandon Winokur | Brock Wilken | 2024 Bowman Sterling - Prospect Autographs Brandon Winokur Rookie Auto Twins |
| 50 | 1 | `cpa-ar:orange-refractor:auto:num-25` | Alfonsin Rosario True | Agustin Ramirez | 2024 Bowman Chrome Alfonsin Rosario True Orange 1st Auto /25 Cubs CPA-AR |
| 51 | 1 | `cpa-ar:orange-refractor:auto:num-25` | Adriel Radney | Agustin Ramirez | 2024 Bowman Chrome Baseball #CPA-AR Orange |
| 52 | 1 | `cpa-bm:green-refractor:auto:num-99` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome Braylin Morel Auto Green Refractor /99 1st PSA 10 Rangers CB8 |
| 53 | 1 | `cpa-ev:yellow-refractor:auto:num-75` | Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome Baseball #CPA-EV Yellow |
| 54 | 1 | `cpa-la:base:auto` | Jordan Wicks | Luke Adams | 2024 Bowman Chrome Luke Adams 1st Chrome Auto PSA 10 GEM MT Brewers RC CPA-LA |
| 55 | 1 | `cpa-js:base:auto` | Juan Sanchez Autos | Jared Serna | 2024 Bowman Chrome Juan Sanchez Prospect Autos Auto #CPA-JS Blue Jays |
| 56 | 1 | `cpa-ar:blue-refractor:auto:num-150` | Adriel Radney | Agustin Ramirez | 2024 Bowman 1st Chrome Prospect Agustin Ramirez CPA-AR Blue Auto /150 PSA 10! |
| 57 | 1 | `cpa-db:gold-refractor:auto:num-50` | Derek Bernard Nice | Diego Benitez | Topps 2024 Bowman Chrome Derek Bernard RC Auto Gold Refractor /50 CPA-DB NICE!! |
| 58 | 1 | `cpa-es:refractor:auto:num-499` | Ethan Schiefelbein | Estuar Suero | ETHAN SCHIEFELBEIN 2024 BOWMAN CHROME 1ST REFRACTOR AUTO /499 #CPA-ES Q7505 |
| 59 | 1 | `cpa-es:refractor:auto:num-499` | Eli Serrano | Estuar Suero | 2024 Bowman Draft Chrome Prospect Refractor /499 Eli Serrano Auto Autograph Mets |
| 60 | 1 | `cpa-et:blue-refractor:auto:num-150` | Eduardo Tait My First | Erick Torres | 2024 Bowman Eduardo Tait #CPA-ET My 1st Bowman Auto Blue 1/150 PSA 10 First |
| 61 | 1 | `cpa-jb:green-refractor:auto:num-99` | Jake Bloss True | Jacob Burke | 2024 Bowman Chrome Prospect Auto 1st Jake Bloss #CPA-JB True Green Refractor /99 |
| 62 | 1 | `cpa-ms:base:auto` | Mike Sirota Au | Matt Shaw | 2024 Bowman Chrome Auto Mike Sirota #CPA-MS (AU, RC) 1st Gem Mint PSA 10 |
| 63 | 1 | `cpa-ms:base:auto` | Mike Sirota | Matt Shaw | 2024 Bowman Chrome #CPA-MS Mike Sirota Cincinnati Reds 1st Auto (c) |
| 64 | 1 | `cpa-eb:yellow-refractor:auto:num-75` | Eduardo Beltre | Erick Bautista | 2024 Bowman Chrome EDUARDO BELTRE 15/75 1st Bowman Auto Yellow Ref #CPA-EB PSA 9 |
| 65 | 1 | `cpa-ete:gold-refractor:auto:num-50` | Emiliano Teodo | Enmanuel Tejeda | 2024 Bowman Chrome - Prospect Autographs Emiliano Teodo #CPA-ETE Gold 10/50 |
| 66 | 1 | `cpa-jb:blue-refractor:auto:num-150` | Jake Bloss | Jacob Burke | 2024 Bowman Chrome - Prospect Autographs Jake Bloss #CPA-JB Blue Refractor /150 |
| 67 | 1 | `cpa-bm:blue-refractor:auto:num-150` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome - Prospect 1st Auto Braylin Morel #CPA-BM Blue /150 PSA 10 |
| 68 | 1 | `cpa-et:green-refractor:auto:num-99` | Eduardo Tait | Erick Torres | 2024 Bowman Chrome EDUARDO TAIT 97/99 1st Bowman Auto Green Ref #CPA-ET PSA 9 |
| 69 | 1 | `cpa-jr:gold-refractor:auto:num-50` | Jensy Rivas | Jesus Rodriguez | 2024 Bowman Chrome Jensy Rivas 1st gold mini diamond Refractor Auto 47 /50 - Raw 10 |
| 70 | 1 | `cpa-es:superfractor:auto:num-1` | Emilio Sanchez | Estuar Suero | 2024 BOWMAN CHROME Emilio Sanchez SUPERFRACTOR AUTO AUTOGRAPH 1st 1/1 ONE OF ONE - Raw 10 |
| 71 | 1 | `cpa-ete:yellow-refractor:auto:num-75` | Yellow Emiliano Teodo | Enmanuel Tejeda | 2024 Bowman Chrome Prospect Yellow Refractor 63/75 Emiliano Teodo #CPA-ETE Auto |
| 72 | 1 | `cpa-ete:yellow-refractor:auto:num-75` | Emiliano Teodo | Enmanuel Tejeda | EMILIANO TEODO 2024 Bowman Chrome 1st Yellow Parallel AUTO /75 Rangers - Raw |
| 73 | 1 | `cpa-aan:base:auto` | Anderson Au | Antonio Anderson | 2024 Bowman - Chrome Prospect Autographs Antonio Anderson #CPA-AAN (AU, RC) |
| 74 | 1 | `cpa-eb:green-refractor:auto:num-99` | Eduardo Beltre | Erick Bautista | 2024 Bowman Chrome Prospect Auto Eduardo Beltre #CPA-EB Green Refractor /99 RC |
| 75 | 1 | `cpa-ev:blue-refractor:auto:num-150` | Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome ECHEDRY VARGAS Auto Blue Refractor /150 #CPA-EV |
| 76 | 1 | `cpa-ev:blue-refractor:auto:num-150` | Echedry Vargas True | Esmerlyn Valdez | Echedry Vargas 2024 1st Bowman Chrome Auto True Blue /150 Marlins #CPA-EV |
| 77 | 1 | `cpa-bba:base:auto` | Baro Dh | Boston Baro | Boston Baro 2024 Bowman #CPA-BBA Chrome Prospect Auto *dh |
| 78 | 1 | `cpa-bba:base:auto` | Brett Bateman | Boston Baro | Topps 2024 Bowman Chrome 1st Bowman Auto Brett Bateman CPA-BBA Cubs MLB |
| 79 | 1 | `cpa-ete:superfractor:auto:num-1` | Emiliano Teodo | Enmanuel Tejeda | 2024 Bowman Chrome Emiliano Teodo SUPERFRACTOR Auto 1/1  Texas Rangers - Raw 10 |
| 80 | 1 | `cpa-rn:base:auto` | Riley Nelson | Rikuu Nishida | Topps Bowman Chrome 2024 1st Bowman Riley Nelson Auto CPA-RN Guardians |
| 81 | 1 | `cpa-dg:base:auto` | Darison Garcia | Douglas Glod | Topps 2024 Bowman Chrome 1st Bowman Auto Darison Garcia Royals CPA-DG |
| 82 | 1 | `cpa-ev:refractor:auto:num-499` | Echedry Vargas Autographs Refractors | Esmerlyn Valdez | Echedry Vargas 2024 Bowman Chrome #CPA-EV Prospect Autographs Refractors 131/499 |
| 83 | 1 | `cpa-ev:refractor:auto:num-499` | Autographs Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome - Prospect Autographs Echedry Vargas #CPA-EV Refractor /499 |
| 84 | 1 | `cpa-rca:refractor:auto:num-499` | Ryan Campos | Robert Calaz | Ryan Campos - 2024 Bowman Chrome Auto #CPA-RCA - Refractor /499 |
| 85 | 1 | `cpa-ym:green-refractor:auto:num-99` | Yordanny Monegro | Yohandy Morales | 2024 Bowman Chrome - Prospect Auto Yordanny Monegro #CPA-YM Green Refractor /99 |
| 86 | 1 | `cpa-ym:orange-refractor:auto:num-25` | Yordanny Monegro | Yohandy Morales | 2024 Bowman Chrome Yordanny Monegro 1st True Orange Auto 14/25 CPA-YM  - Raw 10 |
| 87 | 1 | `cpa-rh:green-refractor:auto:num-99` | Ronny Hernandez True White | Raylin Heredia | 2024 1st Bowman - Chrome Prospect Ronny Hernandez True Green Auto /99 White Sox |
| 88 | 1 | `cpa-jgo:base:auto` | Gonzalez Au | J.D. Gonzalez | 2024 Bowman - Chrome Prospect Autographs J.D. Gonzalez #CPA-JGO (AU, RC) |
| 89 | 1 | `cpa-jgo:base:auto` | Gonzalez | J.D. Gonzalez | 2024 Bowman J.D. Gonzalez Chrome Auto 1st Prospect #CPA-JGO Padres PSA 10 |
| 90 | 1 | `cpa-ev:gold-refractor:auto:num-50` | Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome Gold Mini-Diamond Refractor 12/50 Echedry Vargas #CPA-EV Auto |
| 91 | 1 | `cpa-bm:yellow-refractor:auto:num-75` | Braden Montgomery | Brice Matthews | 2024 1st Bowman Chrome Braden Montgomery Yellow Refractor Auto /75 PSA 8 |
| 92 | 1 | `cpa-bm:yellow-refractor:auto:num-75` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome Braylin Morel Prospect Auto Yellow Refractor 1st #/75 - Raw 10 |
| 93 | 1 | `cpa-jb:red-refractor:auto:num-5` | Jake Bloss | Jacob Burke | 2024 BOWMAN CHROME PROSPECT AUTO TRUE RED #CPAJB JAKE BLOSS 2/5 - Raw 10 |
| 94 | 1 | `cpa-jr:yellow-refractor:auto:num-75` | Jensy Rivas Yellow Au | Jesus Rodriguez | 2024 Bowman Chrome 1st Auto Jensy Rivas #CPA-JR Yellow Refractor /75 (AU, RC) |
| 95 | 1 | `cpa-ps:yellow-refractor:auto:num-75` | Paulino Santana | Paul Skenes | 2024 Bowman Chrome PAULINO SANTANA /75 1st Bowman Auto Yellow Ref #CPA-PS PSA 10 |
| 96 | 1 | `cpa-ss:refractor:auto:num-499` | Autos Sammy Stafura | Sam Shaw | Topps 2024 Bowman Chrome Prospect Autos Sammy Stafura RC 1st /499 #CPA-SS |
| 97 | 1 | `cpa-ar:yellow-refractor:auto:num-75` | Adriel Radney | Agustin Ramirez | 2024 Bowman Chrome Adriel Radney Auto 1st Bowman Yellow Refractor 01/75 #CPA-AR |
| 98 | 1 | `cpa-ms:yellow-refractor:auto:num-75` | Mike Sirota Yellow | Matt Shaw | Mike Sirota 2024 Bowman 1st Chrome Auto /75 Yellow Refractor #CPA-MS Dodgers |
| 99 | 1 | `cpa-eb:blue-refractor:auto:num-150` | Eduardo Beltre | Erick Bautista | 2024 Bowman Chrome EDUARDO BELTRE 121/150 1st Bowman Auto Blue #CPA-EB PSA 10 |

## Candidate resolution paths considered and rejected

- **Route to a sibling CPA number whose checklist player matches the sale name** -- checked against all 87 distinct players across the 1,385 bowman-address cpa auto checklist rows; zero matches for any of the 99 sale-title names (namesAgree against every player, not just the row's own destination).
- **Treat as an OCR/extraction artefact of the destination name** -- rejected: the sale's own `title` field (not the derived `playerName`) independently and consistently names the same different player across every sale in a group (e.g. all 48 "Eduardo Tait" sales' titles read "EDUARDO TAIT", never a corrupted rendering of "Erick Torres"), and the CPA card number in the title matches the fromId's own number exactly.
- **Leave the sale at the bowman-chrome duplicate address rather than move it blind** -- the path taken here. These sales are excluded from both this PR's repoint list and its retire list; the rows they sit on (where zero OTHER sales remain) are correspondingly excluded from the retire list too, so no row is deleted out from under a still-resident, unresolved sale.

## Recommended next step (not actioned by this PR)

A checklist-vs-sale-title audit scoped to just these 63 CPA numbers, checking whether checklistcenter-2026-08-29 / checklistinsider-2026-08-27 mistranscribed the player name at ingest (the leading hypothesis, given how consistently the sale titles agree with each other and disagree with the checklist row) versus the sale titles themselves sharing a scrape-time defect (checked against 3 different source vendors per the largest groups -- cardsight, tca-ebay, cardhedge all agree with each other and disagree with the checklist, which weighs against a single vendor's scrape defect).
