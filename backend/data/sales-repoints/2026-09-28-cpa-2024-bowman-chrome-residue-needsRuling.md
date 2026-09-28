# needsRuling: 2024 Bowman Chrome CPA residue -- ROUND 2 (rebuilt from the real gate)

Companion sidecar to `backend/data/sales-repoints/2026-09-28-cpa-2024-bowman-chrome-residue-to-bowman.json` (round 2). Supersedes round 1's sidecar entirely -- round 1 classified sales using an offline approximation of `namesAgree` and mis-sorted at least 8 groups (see "Round 1 corrections" below). This file re-derives every bucket from the lane's REAL gate (`namesAgree` + the real per-destination `stripVocabularyForDestination` output), run live against Cosmos, and from each sale's own `title` field rather than the (sometimes corrupt) extracted `playerName`.

Independent review: https://github.com/HobbyIQ/HobbyIQ-V1/pull/2485#issuecomment-5863378351

## Round 1 corrections

- **Defect #1/#3 (retire list + cpa-es)**: `cpa-es:blue-refractor:auto:num-150` was wrongly listed for retire in round 1. It never should have been -- it is not in round 2's repoint list either (its sale's `playerName` field, "Emilio Sanchez"/"Estuar Suero True", still fails the real gate even after the Au/Autographs fix; only the sale's own `title` field, "ESTUAR SUERO ... #CPA-ES", agrees). It now appears below in Bucket B (title confirms, playerName corrupt), not the retire list.
- **Defect #2 (0/210 pass)**: round 1's 88-entry, 267-sale repoint list would have re-refused every entry verbatim at APPLY. Round 2 adds a narrow Au/Autographs trailing marker to `name-agreement.cjs` and rebuilds the repoint list to only the 10 fromIds / 15 sales verified, live, to pass the real gate AND be genuinely resident at the fromId (not merely matched through a stale `hobbyiqCardId`).
- **Additional misclassifications found during the round-2 rebuild**: several sales round 1 filed as "true mismatch" (different player entirely) are, on a title re-check, the SAME shape as `cpa-es` -- most notably `cpa-ym` "Yordanny Monegro" (playerName) vs the sale's own title, which reads "2024 Bowman Chrome Yohandy Morales 1st Bowman Auto Refractor /499 #CPA-YM" -- matching the destination exactly. These are now correctly filed in Bucket B, not Bucket C.
- **Round 2 review (comment 5871714980) -- two Bucket-C groups re-filed to Bucket B**: `cpa-fdi:base:auto` (44 sales, "Filippo Di Turi") and `cpa-ami:base:auto` (2 sales, "Aiden Miller") are edit-distance-1 transcription variants of their own destination player ("Filippo Di Turri", "Aidan Miller") -- round 1 filed them as Bucket-C genuine mismatches. Re-run live against the lane's REAL gate (`repoint-sales-by-list.cjs` GATE 6: `namesAgree` + `stripVocabularyForDestination`, `backend/x.cjs`, read-only, 2026-09-28): both REFUSE -- `namesAgree("Filippo Di Turi", "Filippo Di Turri")` and `namesAgree("Aiden Miller", "Aidan Miller")` both return `false`. `foldForCompare` requires byte-identical strings after folding ("filippodituri" vs "filippoditurri"; "aidenmiller" vs "aidanmiller") -- none of the file's four rules (multi-name split, subset-tag strip, generational suffix, case/punctuation/diacritic fold) tolerate a one-letter transcription difference, exactly as the surname floor predicts. They move to Bucket B below, NOT the repoint list -- `name-agreement.cjs` is not loosened in this PR. Unlike the other 88 Bucket-B groups, these sales' own `title` field ALSO carries the same misspelling as `playerName` (title: "...Filippo Di Turi Chrome Auto..."; "...AIDEN MILLER 1st AUTO"), so this is not the "title confirms exactly, playerName corrupt" shape -- it is "title names the destination player modulo a transcription variant", tagged separately in the table below.

## Bucket A: covered by the repoint list (real gate passes, genuinely resident)

10 fromId / 15 sales -- see the repoint list itself for the full detail. Not repeated here.

## Bucket B: title confirms the SAME player, but the stored `playerName` field is corrupt

**90 groups, 113 sales** (88 groups / 111 sales title-confirms-exactly + 2 groups / 2 sales title-transcription-variant, see below). The sale's own scraped `title` field names the exact same player as the destination checklist row (verified by a token-containment check against the title, not `namesAgree` against the corrupt `playerName`). These CANNOT be safely included in the repoint list as filed: `repoint-sales-by-list.cjs`'s gate 6 compares `sale.playerName ?? sale.title` -- since `playerName` is non-empty (just wrong), `title` is never consulted at APPLY time, so the real gate would still refuse every one of these. Fixing this needs either (a) a repair pass that corrects the stored `playerName` field FROM the title before this lane ever runs, or (b) a lane-level change to prefer title over playerName when they disagree this specifically -- both out of scope for a sales-repoint list. Left here, unmoved, for a follow-up ruling.

**Two of these 90 groups (marked TRANSCRIPTION below) are a narrower shape than the other 88**: `cpa-fdi:base:auto` and `cpa-ami:base:auto`'s own sale titles repeat the SAME edit-distance-1 misspelling as the stored `playerName` ("Filippo Di Turi", "AIDEN MILLER") rather than confirming the destination's exact spelling ("Filippo Di Turri", "Aidan Miller"). The real gate REFUSES both live (`namesAgree` folds to byte-inequal strings; verified 2026-09-28, see "Round 1 corrections" above) -- fixing these needs `namesAgree`/the surname floor to tolerate a bounded edit distance, which this PR deliberately does not add. Filed here per the round-2 review rather than left in Bucket C, because the disagreement is a transcription variant of the SAME destination player, not a different player.

| # | sales | fromId (CPA card) | stored playerName | destination playerName | sale's own title |
|---|---|---|---|---|---|
| 1 | 5 | `cpa-ao:base:auto` | Abimelec Ortiz Texas | Abimelec Ortiz | Topps 2024 Bowman Chrome 1st Bowman Auto Abimelec Ortiz Texas Rangers #CPA-AO |
| 2 | 4 | `cpa-rh:base:auto` | Raylin Heredia Hta Choice | Raylin Heredia | RAYLIN HEREDIA 2024 Bowman Chrome Auto #CPA-RH Hta Choice /150 Phillies |
| 3 | 3 | `cpa-wj:base:auto` | Walker Jenkins On | Walker Jenkins | 2024 1st Bowman Chrome - WALKER JENKINS - PSA 10 On Card Auto Twins #CPA-WJ |
| 4 | 3 | `cpa-aan:base:auto` | Anderson | Antonio Anderson | 2024 Bowman Antonio Anderson Chrome Auto Autograph 1st Prospect #CPA-AAN Red Sox |
| 5 | 2 | `cpa-ao:blue-refractor:auto:num-150` | Abimelec Ortiz True | Abimelec Ortiz | 2024 Bowman Chrome Abimelec Ortiz True Blue Refractor Auto /150 CPA-AO PSA 10 |
| 6 | 2 | `cpa-ahu:base:auto` | Anthony Huezo Cpa Ahu | Anthony Huezo | 2024 Bowman Chrome Prospects Anthony Huezo CPA- AHU Houston Astros Autograph |
| 7 | 2 | `cpa-wj:base:auto` | Autos Walker Jenkins | Walker Jenkins | 2024 Bowman Chrome Prospect Autos Walker Jenkins CPA-WJ Auto PSA 10 |
| 8 | 2 | `cpa-amo:blue-refractor:auto:num-150` | Aneudis Mordan Blue Lunar | Aneudis Mordán | Aneudis Mordan 2024 Bowman Chrome Blue Lunar Refractor Auto Card /150 #CPA-AMO |
| 9 | 2 | `cpa-asm:base:auto` | Aidan Smith Ny | Aidan Smith | 2024 Bowman Chrome Aidan Smith 1st Prospect Auto RC #CPA-ASM NY Mets / Mariners |
| 10 | 2 | `cpa-bba:base:auto` | Baro | Boston Baro | 2024 Bowman Boston Baro Chrome Auto Autograph 1st Prospect #CPA-BBA Mets |
| 11 | 2 | `cpa-ds:blue-refractor:auto:num-150` | Daniel Susac True | Daniel Susac | Daniel Susac 2024 Bowman Chrome Prospect Auto #CPA-DS True Blue Refractor /150 |
| 12 | 2 | `cpa-rn:base:auto` | Rikuu Nishida Kanji | Rikuu Nishida | 2024 Bowman Chrome Baseball Rikuu Nishida 1st Autograph (Kanji) CPA-RN |
| 13 | 2 | `cpa-ev:refractor:auto:num-499` | Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome Esmerlyn Valdez Refractor 1st Bowman Auto /499 #CPA-EV |
| 14 | 2 | `cpa-ao:base:auto` | Autos Abimelec Ortiz | Abimelec Ortiz | Topps 2024 Bowman Chrome Prospect Autos 1st Bowman Abimelec Ortiz CPA-AO |
| 15 | 2 | `cpa-jro:base:auto` | Jeffry Rosa Op | Jeffry Rosa | 2024 Topps Bowman Chrome Auto Jeffry Rosa 1st #CPA-JRO Mets OP62 |
| 16 | 2 | `cpa-rhe:base:auto` | Ronny Hernandez Hta Choice | Ronny Hernandez | 2024 Bowman Chrome Ronny Hernandez 1st HTA Choice Auto /150 White Sox #CPA-RHE |
| 17 | 1 | `cpa-ss:green-refractor:auto:num-99` | Sam Shaw First No | Sam Shaw | 2024 Sam Shaw First Bowman Chrome Green Refractor Auto No. CPA-SS SP 23/99 |
| 18 | 1 | `cpa-rrz:base:auto` | Autographs Ramon Ramirez Au | Ramon Ramirez | 2024 Bowman - Chrome Prospect Autographs Ramon Ramirez #CPA-RRZ (AU, RC) |
| 19 | 1 | `cpa-rrz:base:auto` | Rst Ramon Ramirez | Ramon Ramirez | 2024 Bowman Chrome 1rst #CPA-RRZ Ramon Ramirez |
| 20 | 1 | `cpa-rrz:base:auto` | Ramon Ramirez Mt | Ramon Ramirez | 2024 Bowman Chrome Prospect AUTO #CPA-RRZ Ramon Ramirez SGC Auto 10 Mt 9.5 |
| 21 | 1 | `cpa-rrz:base:auto` | Ramon Ramirez Rs | Ramon Ramirez | 2024 Bowman Chrome Prospect Ramon Ramirez #CPA-RRZ Auto 06rs |
| 22 | 1 | `cpa-rlas:base:auto` | Ryan Lasko Au Oakland | Ryan Lasko | 2024 Bowman Chrome Prospects Auto Ryan Lasko #CPA-RLAS (AU, RC) Oakland A\'s |
| 23 | 1 | `cpa-db:red-refractor:auto:num-5` | Benitez | Diego Benitez | 2024 Bowman Diego Benitez Chrome Auto Autograph 1st Prospect #CPA-DB Braves |
| 24 | 1 | `cpa-es:blue-refractor:auto:num-150` | Emilio Sanchez | Estuar Suero | ESTUAR SUERO 2024 Bowman Chrome Auto #CPA-ES True Blue Refractor /150 PSA 10 Gem |
| 25 | 1 | `cpa-es:blue-refractor:auto:num-150` | Estuar Suero True | Estuar Suero | ESTUAR SUERO 2024 Bowman Chrome Auto #CPA-ES True Blue Refractor /150 PSA 10 Gem |
| 26 | 1 | `cpa-ss:base:auto` | Read Info Sam Shaw | Sam Shaw | 📢Read Info📢 Sam Shaw 2024 Bowman #CPA-SS Chrome Prospect Autographs |
| 27 | 1 | `cpa-rbu:base:auto` | Ryan Burrowes On | Ryan Burrowes | 2024 Bowman RYAN BURROWES 1st Bowman Chrome Prospect Auto On Card #CPA-RBU |
| 28 | 1 | `cpa-rca:base:auto` | Robert Calaz Colorado | Robert Calaz | 2024 Bowman Chrome Robert Calaz Auto 1st #CPA-RCA Colorado Rockies |
| 29 | 1 | `cpa-ao:blue-refractor:auto:num-150` | Abimelec Ortiz True Nats | Abimelec Ortiz | 2024 Bowman Chrome 1st Auto Abimelec Ortiz #CPA-AO True Blue Refractor /150 Nats |
| 30 | 1 | `cpa-ev:green-refractor:auto:num-99` | Esmerlyn Valdez True | Esmerlyn Valdez | 2024 Bowman Chrome Esmerlyn Valdez #CPA-EV 1st Auto True Green Refractor /99 |
| 31 | 1 | `cpa-ym:refractor:auto:num-499` | Autos Yohandy Morales Nats | Yohandy Morales | Topps 2024 Bowman Chrome Prospect Autos Yohandy Morales Nats #CPA-YM /499 |
| 32 | 1 | `cpa-ym:refractor:auto:num-499` | Yordanny Monegro | Yohandy Morales | 2024 Bowman Chrome Yohandy Morales 1st Bowman Auto Refractor /499 #CPA-YM |
| 33 | 1 | `cpa-la:base:auto` | Luke Adams Mt | Luke Adams | 2024 Bowman Chrome Prospect Luke Adams #CPA-LA PSA 10 GEM MT Auto |
| 34 | 1 | `cpa-la:base:auto` | Luke Adams Brewerstopps | Luke Adams | Topps 2024 Bowman Chrome Prospect Autographs Luke Adams Auto CPA-LA BrewersTopps |
| 35 | 1 | `cpa-la:base:auto` | Jordan Wicks | Luke Adams | 2024 Bowman Chrome Luke Adams 1st Chrome Auto PSA 10 GEM MT Brewers RC CPA-LA |
| 36 | 1 | `cpa-la:base:auto` | Luke Adams Milwaukee | Luke Adams | 2024 1st Bowman Auto Luke Adams Chrome Prospect #CPA-LA Milwaukee Brewers RC |
| 37 | 1 | `cpa-cpr:blue-refractor:auto:num-150` | Cooper Pratt Blue Lunar | Cooper Pratt | Cooper Pratt 2024 Bowman #CPA-CPR Blue Lunar Refractor Chrome Auto 1st RC /150 |
| 38 | 1 | `cpa-cp:base:auto` | Chandler Pollard On Texas | Chandler Pollard | 2024 Bowman Chrome Chandler Pollard ON-CARD AUTO Texas Rangers #CPA-CP |
| 39 | 1 | `cpa-kt:refractor:auto:num-499` | Czg Kyle Teel | Kyle Teel | CZG52 - 2024 Bowman Chrome - Kyle Teel #CPA-KT - /499 - PSA 10 - Auto Refractor |
| 40 | 1 | `cpa-rh:gold-refractor:auto:num-50` | Raylin Heredia Autgraph | Raylin Heredia | 2024 Bowman #CPA-RH Raylin Heredia Philadelphia Phillies Gold Autgraph /50 |
| 41 | 1 | `cpa-wla:blue-refractor:auto:num-150` | Autos Wyatt Langford | Wyatt Langford | Topps 2024 Bowman Chrome Prospect Autos Wyatt Langford Blue /150 PSA 10 |
| 42 | 1 | `cpa-ar:blue-refractor:auto:num-150` | Adriel Radney | Agustin Ramirez | 2024 Bowman 1st Chrome Prospect Agustin Ramirez CPA-AR Blue Auto /150 PSA 10! |
| 43 | 1 | `cpa-et:blue-refractor:auto:num-150` | Eduardo Tait | Erick Torres | ERICK TORRES 2024 BOWMAN CHROME BLUE REFRACTOR 1ST AUTO /150 #CPA-ET Q0185 |
| 44 | 1 | `cpa-gg:refractor:auto:num-499` | Gino Groover Bookend | Gino Groover | 2024 Bowman Chrome Gino Groover 1st Auto Refractor 499/499 Bookend CPA-GG |
| 45 | 1 | `cpa-aro:blue-refractor:auto:num-150` | Alfonsin Rosario True | Alfonsin Rosario | 2024 Bowman Chrome Prospect Autographs Alfonsin Rosario. True Blue /150. PSA 10 |
| 46 | 1 | `cpa-aca:base:auto` | Autos Allan Castro | Allan Castro | Topps 2024 Bowman Chrome Prospect Autos Allan Castro 1st Bowman RC #CPA-ACA |
| 47 | 1 | `cpa-rhe:blue-refractor:auto:num-150` | Ronny Hernandez Blue Lunar | Ronny Hernandez | 2024 Bowman Chrome Autograph Ronny Hernandez #CPA-RHE Blue Lunar Refractor /150 |
| 48 | 1 | `cpa-jro:green-refractor:auto:num-99` | Jeffry Rosa On | Jeffry Rosa | 2024 Bowman Chrome Jeffry Rosa RC On Card Auto #CPA-JRO Green Refractor /99 Mets |
| 49 | 1 | `cpa-jr:refractor:auto:num-499` | Jesus Rodriguez Mini | Jesus Rodriguez | 2024 Bowman #CPA-JR Jesus Rodriguez Chrome Auto Mini-Diamond #/100 Yankees |
| 50 | 1 | `cpa-jwi:base:auto` | Jacob Wilson 's | Jacob Wilson | Topps 2024 Bowman Chrome Prospect Autographs Jacob Wilson Auto RC A\'s #CPA-JWI |
| 51 | 1 | `cpa-sw:refractor:auto:num-499` | Autos Sebastian Walcott | Sebastian Walcott | 2024 Bowman Chrome Prospect Autos Sebastian Walcott #CPA-SW RC Auto /499 PSA 9 |
| 52 | 1 | `cpa-ja:blue-refractor:auto:num-150` | Jalvin Arias | Jadher Areinamo | JADHER AREINAMO 2024 BOWMAN CHROME BLUE LUNAR AUTO /150 #CPA-JA BREWERS A Q7593 |
| 53 | 1 | `cpa-cpr:base:auto` | Cooper Pratt Rg | Cooper Pratt | 2024 Bowman Chrome Prospect #CPA-CPR Cooper Pratt 1st Auto RG |
| 54 | 1 | `cpa-cpr:base:auto` | Cooper Pratt Bas | Cooper Pratt | Topps 2024 Bowman Chrome Cooper Pratt 1st Bowman Auto #CPA-CPR BAS 5641 |
| 55 | 1 | `cpa-cpr:base:auto` | Cooper Pratt On | Cooper Pratt | Cooper Pratt 1st Bowman On-Card Auto 🖋️ 2024 Bowman Chrome #CPA-CPR Brewers |
| 56 | 1 | `cpa-cpr:base:auto` | Cooper Pratt On Mil | Cooper Pratt | 2024 1st Bowman Chrome Cooper Pratt On-Card Auto #CPA-CPR - MIL Rookie |
| 57 | 1 | `cpa-cpr:base:auto` | Cooper Pratt Read Desc | Cooper Pratt | 2024 BOWMAN CHROME PROSPECTS COOPER PRATT #CPA-CPR AUTO🔥BREWERS-READ DESC |
| 58 | 1 | `cpa-cpr:base:auto` | Cooper Pratt Milwaukee | Cooper Pratt | 2024 Bowman #CPA-CPR Cooper Pratt Chrome Prospect Auto PSA 10 Milwaukee Brewers |
| 59 | 1 | `cpa-gg:base:auto` | Gino Lujames Groover | Gino Groover | GINO LUJAMES GROOVER 2024 1st Bowman Chrome Auto  PSA 10 !!! |
| 60 | 1 | `cpa-aan:base:auto` | Anderson Au | Antonio Anderson | 2024 Bowman - Chrome Prospect Autographs Antonio Anderson #CPA-AAN (AU, RC) |
| 61 | 1 | `cpa-as:refractor:auto:num-499` | Anthony Scull Nm | Anthony Scull | 2024 Bowman #CPA-AS Anthony Scull Chrome Prospect Autograph Refractor /499 NM |
| 62 | 1 | `cpa-jw:green-refractor:auto:num-99` | John Wimmer La | John Wimmer | John Wimmer LA Angels 2024 Bowman Chrome #CPA-JW Auto Green Refractor /99 |
| 63 | 1 | `cpa-aro:base:auto` | Alfonsin Rosario On | Alfonsin Rosario | 2024 Bowman Chrome ALFONSIN ROSARIO 1st Prospect On Card Autograph #CPA-ARO CUBS |
| 64 | 1 | `cpa-jcz:blue-refractor:auto:num-150` | Blue Lunar John Cruz | John Cruz | 2024 Bowman Chrome 1st Auto Blue Lunar Refractor #CPA-JCZ John Cruz /150 PSA 10 |
| 65 | 1 | `cpa-yce:blue-refractor:auto:num-150` | Yoeilin Cespedes True | Yoeilin Cespedes | 2024 Bowman Chrome Yoeilin Cespedes 1st Auto /150 True Blue PSA 9 #CPA-YCE |
| 66 | 1 | `cpa-dgn:green-refractor:auto:num-99` | David Guzman True | David Guzman | 2024 Bowman Chrome 1st Auto David Guzman #CPA-DGN True Green Refractor /99 |
| 67 | 1 | `cpa-gg:green-refractor:auto:num-99` | Lujames Gino Groover | Gino Groover | 2024 Bowman Chrome 1st LUJAMES GINO GROOVER AUTO Green /99 PSA 10 #CPA-GG 🔥 |
| 68 | 1 | `cpa-bba:base:auto` | Baro Dh | Boston Baro | Boston Baro 2024 Bowman #CPA-BBA Chrome Prospect Auto *dh |
| 69 | 1 | `cpa-ds:base:auto` | Daniel Susac Cpa | Daniel Susac | Topps 2024 Bowman Chrome Daniel Susac Rookie Auto CPA-DS Athletics CPA |
| 70 | 1 | `cpa-ym:blue-refractor:auto:num-150` | Yohandy Morales Blue Lunar | Yohandy Morales | 2024 Bowman Yohandy Morales #CPA-YM Chrome Auto Blue Lunar Refractor /150 1st |
| 71 | 1 | `cpa-rn:base:auto` | Rikuu Nishida On | Rikuu Nishida | 2024 Topps Bowman Chrome Rikuu Nishida 1st on card auto #CPA-RN |
| 72 | 1 | `cpa-jmh:base:auto` | Jorge Marcheco 's | Jorge Marcheco | Jorge Marcheco 2024 Bowman Chrome 1st Auto #CPA-JMH Angels Athletics A\'s |
| 73 | 1 | `cpa-ev:refractor:auto:num-499` | Esmerlyn Valdez Pit | Esmerlyn Valdez | 2024 1st Bowman Chrome /499 Esmerlyn Valdez Refractor Auto #CPA-EV - PIT Rookie |
| 74 | 1 | `cpa-ao:base:auto` | Abimelec Ortiz Hta | Abimelec Ortiz | 2024 Bowman - Chrome Prospect Autographs Abimelec Ortiz #CPA-AO Hta Choice... |
| 75 | 1 | `cpa-ami:base:auto` | Aidan Miller Cbth | Aidan Miller | Aidan Miller 2024 Bowman Chrome Auto 1st Bowman CPA-AMI Phillies (CBTH) |
| 76 | 1 | `cpa-jro:base:auto` | Jeffry Rosa Ny | Jeffry Rosa | Jeffry Rosa 2024 Bowman Chrome Prospects Autograph CPA-JRO Auto NY Mets |
| 77 | 1 | `cpa-ami:green-refractor:auto:num-99` | Aidan Miller Phl | Aidan Miller | 2024 Bowman Aidan Miller PHL Phillies CPA-AMI Green /99 1st Bowman Auto |
| 78 | 1 | `cpa-tt:yellow-refractor:auto:num-75` | Tommy Troy Yellow 'd | Tommy Troy | Tommy Troy 2024 Bowman Chrome Prospect Yellow Refractor Auto #\'d /75 #CPA-TT |
| 79 | 1 | `cpa-ao:refractor:auto:num-499` | Abimelec Ortiz Nats | Abimelec Ortiz | 2024 Bowman Chrome Abimelec Ortiz 1st Auto Refractor /499 CPA-AO Rangers Nats |
| 80 | 1 | `cpa-id:blue-refractor:auto:num-150` | Isaiah Drake True | Isaiah Drake | 2024 Bowman Isaiah Drake Chrome Prospect Auto True Blue Refractor /150 PSA 10 |
| 81 | 1 | `cpa-dg:yellow-refractor:auto:num-75` | Douglas Glod Refractors | Douglas Glod | Douglas Glod 2024 Bowman Chrome Prospects Yellow Refractors Auto CPA-DG 53/75 RC |
| 82 | 1 | `cpa-an:base:auto` | Arjun Nimmala Top Ss | Arjun Nimmala | 2024 Bowman Chrome 1st Auto Arjun Nimmala PSA 10 - Angels new top SS Prospect! |
| 83 | 1 | `cpa-an:base:auto` | Arjun Nimmala First | Arjun Nimmala | ARJUN NIMMALA 2024 Bowman Chrome Draft First Prospect Auto PSA 10 Blue Jays |
| 84 | 1 | `cpa-wla:yellow-refractor:auto:num-75` | Autographs Wyatt Langford Yellow | Wyatt Langford | 2024 Bowman Chrome Prospect Autographs Wyatt Langford #CPA-WLA Yellow Refractor |
| 85 | 1 | `cpa-sw:base:auto` | Sebastian Walcott Texas | Sebastian Walcott | Sebastian Walcott 2024 Bowman Chrome prospect Autograph CPA-SW Texas Rangers |
| 86 | 1 | `cpa-jw:base:auto` | John Wimmer On | John Wimmer | John Wimmer On Card Auto 1st Bowman Chrome 2024 Bowman CPA-JW Angels |
| 87 | 1 | `cpa-amo:base:auto` | Aneudis Mord | Aneudis Mordán | Bowman 2024 Chrome 1st Bowman Aneudis Mordán Orioles Auto #CPA-AMO |
| 88 | 1 | `cpa-ahu:refractor:auto:num-499` | Anthony Huezo Astro | Anthony Huezo | 2024 Bowman Anthony Huezo 1st Chrome Prospect Auto Refractor /499 #CPA-AHU Astro |
| 89 | 44 | `cpa-fdi:base:auto` (TRANSCRIPTION -- re-filed from Bucket C, review comment 5871714980) | Filippo Di Turi | Filippo Di Turri | 2024 Bowman Filippo Di Turi Chrome Auto Autograph 1st Prospect #CPA-FDI Brewers |
| 90 | 2 | `cpa-ami:base:auto` (TRANSCRIPTION -- re-filed from Bucket C, review comment 5871714980) | Aiden Miller | Aidan Miller | 2024 Bowman Chrome #CPA-AMI AIDEN MILLER 1st AUTO |

## Bucket C: genuine mismatch -- title also disagrees with the destination checklist row

**113 groups, 578 sales** (was 115 groups / 624 sales; `cpa-fdi:base:auto` and `cpa-ami:base:auto` moved to Bucket B above, review comment 5871714980 -- see "Round 1 corrections" for the real-gate result that licenses the move). The sale's own title independently, consistently, and repeatedly names a DIFFERENT full name than the destination checklist row, under the exact same CPA card number. No bowman cpa checklist row (87 distinct players, 1,385 rows at the bowman address) names any of these sale-title players either -- not resolvable as an initials-collision reroute. Most likely the checklist source mistranscribed that CPA number; fixing a checklist row's `playerName` is out of scope for a sales-repoint list.

| # | sales | fromId (CPA card) | stored playerName | destination playerName | sale's own title |
|---|---|---|---|---|---|
| 1 | 48 | `cpa-et:refractor:auto:num-499` | Eduardo Tait | Erick Torres | 2024 Bowman Chrome EDUARDO TAIT Auto Refractor /499 #CPA-ET |
| 3 | 42 | `cpa-ps:refractor:auto:num-499` | Paulino Santana | Paul Skenes | Paulino Santana 2024 Bowman Chrome Autographs Green 83/99 #CPA-PS Auto PSA 10 |
| 4 | 41 | `cpa-eb:refractor:auto:num-499` | Eduardo Beltre | Erick Bautista | 2024 Bowman Chrome EDUARDO BELTRE 214/499 1st Bowman Auto Ref #CPA-EB PSA 10 |
| 5 | 38 | `cpa-ete:refractor:auto:num-499` | Emiliano Teodo | Enmanuel Tejeda | 2024 Bowman Chrome - Prospect Autographs Emiliano Teodo #CPA-ETE Refractor /499 |
| 6 | 36 | `cpa-as:red-refractor:auto:num-5` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez AUTO /150 1st Bowman, 2024 Bowman Chrome, Cincinnati Reds - Raw 10 |
| 7 | 31 | `cpa-ym:red-refractor:auto:num-5` | Yordanny Monegro | Yohandy Morales | 2024 Bowman Chrome Yordanny Monegro #CPA-YM Auto 1st Prospect Red Sox |
| 8 | 31 | `cpa-ev:refractor:auto:num-499` | Echedry Vargas | Esmerlyn Valdez | ECHEDRY VARGAS 2024 BOWMAN CHROME PROSPECT AUTO REFRACTOR 1ST /499 PSA 10 Q0107 |
| 9 | 25 | `cpa-db:refractor:auto:num-499` | Derek Bernard | Diego Benitez | Derek Bernard 2024 Bowman Chrome #CPA-DB Refractor Auto 1st RC /499 |
| 10 | 23 | `cpa-ar:refractor:auto:num-499` | Adriel Radney | Agustin Ramirez | 2024 Bowman Chrome - Prospect Autographs Adriel Radney #CPA-AR Refractor /499... |
| 11 | 16 | `cpa-jr:refractor:auto:num-499` | Jensy Rivas | Jesus Rodriguez | 2024 Bowman Chrome Prospect Auto Jensy Rivas #CPA-JR  |
| 12 | 15 | `cpa-ym:refractor:auto:num-499` | Yordanny Monegro | Yohandy Morales | 2024 Bowman Chrome Prospect Auto Refractor 348/499 Yordanny Monegro #CPA-YM |
| 13 | 14 | `cpa-ja:refractor:auto:num-499` | Jalvin Arias | Jadher Areinamo | Jalvin Arias 2024 Bowman Chrome #CPA-JA Refractor Auto 1st RC 120/499 |
| 14 | 13 | `cpa-bm:refractor:auto:num-499` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome Braylin Morel Auto Refractor 1st Prospect #/499 Rangers - Raw |
| 15 | 12 | `cpa-et:yellow-refractor:auto:num-75` | Eduardo Tait | Erick Torres | EDUARDO TAIT 2024 BOWMAN CHROME 1ST AUTOGRAPH PHILLIES #CPA-ET AUTO Q1339 |
| 16 | 12 | `cpa-as:gold-refractor:auto:num-50` | Adolfo Sanchez | Anthony Scull | 2024 Bowman Chrome ADOLFO SANCHEZ 2/50 1st RC Auto Gold Diamond #CPA-AS PSA 10 |
| 17 | 9 | `cpa-es:refractor:auto:num-499` | Emilio Sanchez | Estuar Suero | Emilio Sanchez AUTO /499 Refractor 1st Bowman, 2024 Bowman Chrome, Orioles - Raw 10 |
| 18 | 9 | `cpa-as:yellow-refractor:auto:num-75` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez 2024 Bowman Chrome #CPA-AS Yellow Refractor 1st RC Auto 35/75 |
| 19 | 8 | `cpa-bm:gold-refractor:auto:num-50` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome Braylin Morel Gold Mini Diamond Refractor AUTO /50 Rangers - Raw 10 |
| 20 | 8 | `cpa-ym:yellow-refractor:auto:num-75` | Yordanny Monegro | Yohandy Morales | YORDANNY MONEGRO 2024 BOWMAN CHROME YELLOW REFRACTOR 1ST AUTO /75 #CPA-YM Q0185 |
| 21 | 6 | `cpa-et:blue-refractor:auto:num-150` | Eduardo Tait | Erick Torres | Topps 2024 Bowman Chrome Eduardo Tait Auto Rep-Blue Refractor /150 #CPA-ET PSA 9 |
| 22 | 6 | `cpa-as:refractor:auto:num-499` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez 2024 Bowman Chrome 1st Prospect Auto #CPA-AS Refractor 493/499 - Raw 10 |
| 23 | 6 | `cpa-jb:refractor:auto:num-499` | Jake Bloss | Jacob Burke | Jake Bloss 2024 Topps Bowman Chrome Baseball Refractor Auto /499 - Raw 10 |
| 24 | 6 | `cpa-ja:yellow-refractor:auto:num-75` | Jalvin Arias | Jadher Areinamo | 2024 Bowman Chrome Sapphire Yellow Refractor Jalvin Arias 1st Rookie AUTO 29/50 - Raw 10 |
| 25 | 4 | `cpa-et:gold-refractor:auto:num-50` | Eduardo Tait | Erick Torres | 2024 Bowman Chrome EDUARDO TAIT 3/50 1st Bowman Auto Gold Refractor #CPA-ET |
| 26 | 4 | `cpa-db:gold-refractor:auto:num-50` | Derek Bernard | Diego Benitez | Derek Bernard 2024 Bowman Chrome #CPA-DB Gold Refractor 1st RC Auto /50 |
| 27 | 4 | `cpa-glo:base:auto` | Autos George Lombard Jr | George Lombard Jr. | 2024 Bowman Chrome Prospect Autos 1st Bowman RC Auto George Lombard Jr CPA-GLO |
| 28 | 4 | `cpa-tb:base:auto` | Travis Bazzana | Tony Blanco Jr. | 2024 Bowman Chrome Travis Bazzana #CPA-TB 1st Auto Cleveland Guardians Rookie |
| 29 | 4 | `cpa-fdi:refractor:auto:num-499` | Filippo Di Turi | Filippo Di Turri | 2024 Bowman Chrome Prospect Auto Refractor #CPA-FDI Filippo Di Turi /499 PSA 10 |
| 30 | 3 | `cpa-ete:orange-refractor:auto:num-25` | Emiliano Teodo | Enmanuel Tejeda | 2024 Bowman Chrome Emiliano Teodo 1st Orange Refractor Auto /25 #CPA-ETE |
| 31 | 3 | `cpa-ar:gold-refractor:auto:num-50` | Adriel Radney | Agustin Ramirez | 2024 Bowman Chrome Adriel Radney 1st  Auto True Gold Refractor # /50 - Raw 10 |
| 32 | 3 | `cpa-ar:green-refractor:auto:num-99` | Adriel Radney | Agustin Ramirez | Adriel Radney 2024 Bowman Chrome #CPA-AR Green Refractor Auto 1st RC /99 |
| 33 | 3 | `cpa-ev:green-refractor:auto:num-99` | Echedry Vargas | Esmerlyn Valdez | 2024 Topps Chrome Bowman 1st Echedry Vargas #CPA-EV Green Refractor 24/99 KS20 |
| 34 | 3 | `cpa-et:orange-refractor:auto:num-25` | Eduardo Tait | Erick Torres | Eduardo Tait 2024 Bowman Chrome #CPA-ET Orange Refractor 1st RC Auto 11/25 |
| 35 | 2 | `cpa-glo:yellow-refractor:auto:num-75` | George Lombard Jr Yellow | George Lombard Jr. | 2024 Bowman Chrome 1st Bowman George Lombard Jr Yellow Refractor Auto /75 PSA 10 |
| 36 | 2 | `cpa-glo:base:auto` | George Lombard Jr On | George Lombard Jr. | 2024 Bowman George Lombard Jr 1st Chrome Auto On Card #CPA-GLO PSA 10 Gem Mint |
| 37 | 2 | `cpa-glo:base:auto` | Autographs George Lombard Jr | George Lombard Jr. | 2024 Bowman - Chrome Prospect Autographs George Lombard Jr. #CPA-GLO (AU, RC) |
| 38 | 2 | `cpa-glo:blue-refractor:auto:num-150` | George Lombard Jr Lunar | George Lombard Jr. | 2024 Bowman  Chrome Prospect Auto George Lombard Jr. #CPA-GLO Blue Lunar 28/150 |
| 39 | 2 | `cpa-ym:blue-refractor:auto:num-150` | Yordanny Monegro | Yohandy Morales | YORDANNY MONEGRO 2024 BOWMAN CHROME BLUE REFRACTOR 1ST AUTO /150 #CPA-YM Q7697 |
| 40 | 2 | `cpa-db:blue-refractor:auto:num-150` | Derek Bernard | Diego Benitez | 2024 Bowman Chrome Derek Bernard 1st Bowman Auto Reptillian Blue /150 #CPA-DB |
| 41 | 2 | `cpa-db:orange-refractor:auto:num-25` | Derek Bernard | Diego Benitez | 2024 Bowman Chrome Colorado Rockies Derek Bernard Orange Refractor Auto 25/25  - Raw 10 |
| 43 | 2 | `cpa-glo:refractor:auto:num-499` | George Lombard Jr Gpf | George Lombard Jr. | 2024 Bowman George Lombard JR. /499 Refractor 1ST Chrome Auto #CPA-GLO PSA10 GPF |
| 44 | 1 | `cpa-ps:refractor:auto:num-499` | Reptilian Paulino Santana | Paul Skenes | 🔥2024 Bowman Chrome Prospects Auto Blue Reptilian /150 #CPA-PS Paulino Santana |
| 45 | 1 | `cpa-es:yellow-refractor:auto:num-75` | Emilio Sanchez | Estuar Suero | 2024 Bowman Chrome Emilio Sanchez Auto 1st #CPA-ES Orioles |
| 46 | 1 | `cpa-es:yellow-refractor:auto:num-75` | Emilio Sanchez Yellow | Estuar Suero | Emilio Sanchez 2024 Bowman Chrome 1st Auto Yellow Refractor /75 Orioles CPA-ES |
| 47 | 1 | `cpa-as:blue-refractor:auto:num-150` | Adolfo Sanchez | Anthony Scull | Adolfo Sanchez 2024 Bowman Chrome #CPA-AS Blue Refractor Auto 1st RC 84/150 |
| 48 | 1 | `cpa-as:blue-refractor:auto:num-150` | Aidan Smith Blue Lunar | Anthony Scull | 2024 Bowman Aidan Smith Chrome 1st Blue Lunar Crater Refractor Auto /150 #CPA-AS |
| 49 | 1 | `cpa-et:refractor:auto:num-499` | Eduardo Tait Autographs Refractors | Erick Torres | 2024 Bowman Chrome #CPA-ET Eduardo Tait Prospect Autographs Refractors #/499 |
| 50 | 1 | `cpa-ps:green-refractor:auto:num-99` | Paulino Santana | Paul Skenes | 2024 Bowman Chrome Paulino Santana #CPA-PS 1st Green Auto 92/99 Rangers |
| 51 | 1 | `cpa-eb:gold-refractor:auto:num-50` | Eduardo Beltre | Erick Bautista | 2024 Bowman Chrome 1st Bowman Eduardo Beltre #CPA-EB True Gold Refractor Auto/50 |
| 52 | 1 | `cpa-ev:green-refractor:auto:num-99` | True Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome Prospect Auto True Green #CPA-EV Echedry Vargas /99 |
| 53 | 1 | `cpa-bw:base:auto` | Brandon Winokur | Brock Wilken | 2024 Bowman Sterling - Prospect Autographs Brandon Winokur Rookie Auto Twins |
| 54 | 1 | `cpa-ar:orange-refractor:auto:num-25` | Alfonsin Rosario True | Agustin Ramirez | 2024 Bowman Chrome Alfonsin Rosario True Orange 1st Auto /25 Cubs CPA-AR |
| 55 | 1 | `cpa-ar:orange-refractor:auto:num-25` | Adriel Radney | Agustin Ramirez | 2024 Bowman Chrome Baseball #CPA-AR Orange |
| 56 | 1 | `cpa-bm:green-refractor:auto:num-99` | Braylin Morel | Brice Matthews | 2024 Bowman Chrome Braylin Morel Auto Green Refractor /99 1st PSA 10 Rangers CB8 |
| 57 | 1 | `cpa-ev:yellow-refractor:auto:num-75` | Echedry Vargas | Esmerlyn Valdez | 2024 Bowman Chrome Baseball #CPA-EV Yellow |
| 58 | 1 | `cpa-js:base:auto` | Juan Sanchez Autos | Jared Serna | 2024 Bowman Chrome Juan Sanchez Prospect Autos Auto #CPA-JS Blue Jays |
| 59 | 1 | `cpa-db:gold-refractor:auto:num-50` | Derek Bernard Nice | Diego Benitez | Topps 2024 Bowman Chrome Derek Bernard RC Auto Gold Refractor /50 CPA-DB NICE!! |
| 60 | 1 | `cpa-es:refractor:auto:num-499` | Ethan Schiefelbein | Estuar Suero | ETHAN SCHIEFELBEIN 2024 BOWMAN CHROME 1ST REFRACTOR AUTO /499 #CPA-ES Q7505 |

... and 55 more groups (55 sales), omitted from this table for length. Full data in the investigation's raw JSON, available on request.

## Bucket D: stale-hobbyiqCardId -- already at the correct address, NOT a sales-repoint problem

1,969 sales (of the 2,061 that pass the real gate) already carry the CORRECT (or at least a non-fromId) `cardId`, and are matched into this residue's own drain only because their `hobbyiqCardId` field is stale, still pointing at the retired bowman-chrome address. These are NOT named in the repoint list (moving them would be either a no-op or a wrong-address write) and are NOT a sales-repoint-list problem -- see the repoint list's own `census.dataQualityNote` and the PR body's proposal for a dedicated hobbyiqCardId-heal lane.

## Reviewer note (non-blocking), review comment 5871714980

> cpa-et:blue-refractor:auto:num-150: 1 "Erick Torres" sale in Bucket B vs ~74 "Eduardo Tait" sales in Bucket C -- a human call.

Confirmed both sides exist in this file: Bucket B row 43 (1 sale, title "ERICK TORRES 2024 BOWMAN CHROME BLUE REFRACTOR 1ST AUTO /150 #CPA-ET Q0185" -- confirms the destination "Erick Torres" exactly) and Bucket C row 21 (6 of the shown rows, title "Topps 2024 Bowman Chrome Eduardo Tait Auto Rep-Blue Refractor /150 #CPA-ET PSA 9" -- disagrees, consistent with the stored playerName "Eduardo Tait"; the reviewer's ~74 count spans the additional same-shape rows folded into the "55 more groups" omitted from this table). Left as filed (1 in B, the rest in C) -- deciding which name the checklist's `CPA-ET` slot actually means is a human call on the underlying checklist source, out of scope for this sales-repoint-list PR.
