# 2023 Topps Green Foil consolidation — 68 pairs held for Drew's ruling (2026-09-28)

Companion to `2026-09-28-topps-2023-green-foil-vacant-reslug.json` (3 rows) and
`2026-09-28-topps-2023-green-foil-duplicate-retire.json` (589 rows). Neither
list file touches any row named below — these 68 pairs are occupancy refusals
the `relocate-catalog-rows-by-list.cjs` lane's own `occupancyRefusal` rule
would produce if a reslug were attempted onto them, so they were never put in
either list. Both spellings ("Green Foil Board" #1–330, "Green Rainbow Foil"
#331–660, both source `beckett-s3-2026-09-20`) are the MOVER; the existing
`baseballcardpedia-ladders-2026-08-28/29` "Green Foil" row is the OCCUPANT.

## 61 name-superset pairs

One name is the other plus a suffix (Jr./Sr., a "RC"/"FS"/"RCup"/"UER" tag, a
combo-card qualifier, a diacritic). `occupancyRefusal` refuses these because a
superset needs a checklist lookup to say whether the suffix is a different card
or the same one abbreviated — not a call this lane makes. Every pair below sits
at the same card number under both the mover and the occupant.

| # | id (mover, Beckett) | mover playerName | occupant playerName (existing "Green Foil" row) |
|---|---|---|---|
| 7 | `hiq:baseball:2023:topps:7:green-foil-board:no-auto:num-499` | Bobby Witt Jr. | Bobby Witt |
| 23 | `hiq:baseball:2023:topps:23:green-foil-board:no-auto:num-499` | Fernando Tatis Jr. | Fernando Tatis |
| 35 | `hiq:baseball:2023:topps:35:green-foil-board:no-auto:num-499` | CJ Abrams | CJ Abrams FS |
| 43 | `hiq:baseball:2023:topps:43:green-foil-board:no-auto:num-499` | Paul Goldschmidt / Freddie Freeman / Jeff McNeil | Paul Goldschmidt / Freddie Freeman / Jeff McNeil LL NL AVG |
| 82 | `hiq:baseball:2023:topps:82:green-foil-board:no-auto:num-499` | Framber Valdez / Justin Verlander / Alek Manoah | Framber Valdez / Justin Verlander / Alek Manoah LL AL W |
| 116 | `hiq:baseball:2023:topps:116:green-foil-board:no-auto:num-499` | Steven Kwan | Steven Kwan RCup |
| 143 | `hiq:baseball:2023:topps:143:green-foil-board:no-auto:num-499` | Nestor Cortes | Nestor Cortes UER: Called "Nelson" on back. |
| 149 | `hiq:baseball:2023:topps:149:green-foil-board:no-auto:num-499` | Josiah Gray | Josiah Gray FS |
| 150 | `hiq:baseball:2023:topps:150:green-foil-board:no-auto:num-499` | Ronald Acuña Jr. | Ronald Acuña |
| 155 | `hiq:baseball:2023:topps:155:green-foil-board:no-auto:num-499` | Hunter Greene | Hunter Greene FS |
| 160 | `hiq:baseball:2023:topps:160:green-foil-board:no-auto:num-499` | Cal Raleigh | Cal Raleigh FS |
| 172 | `hiq:baseball:2023:topps:172:green-foil-board:no-auto:num-499` | Jazz Chisholm Jr. | Jazz Chisholm |
| 174 | `hiq:baseball:2023:topps:174:green-foil-board:no-auto:num-499` | Julio Rodríguez | Julio Rodríguez / Abraham Toro "Celebration in Seattle" |
| 178 | `hiq:baseball:2023:topps:178:green-foil-board:no-auto:num-499` | Austin Riley/Kyle Schwarber/Pete Alonso | Austin Riley / Kyle Schwarber / Pete Alonso LL NL HR |
| 183 | `hiq:baseball:2023:topps:183:green-foil-board:no-auto:num-499` | Seiya Suzuki | Seiya Suzuki UER: Stats are from Japan |
| 190 | `hiq:baseball:2023:topps:190:green-foil-board:no-auto:num-499` | Pete Alonso | Pete Alonso / Mark Canha "Bro Time" |
| 195 | `hiq:baseball:2023:topps:195:green-foil-board:no-auto:num-499` | George Kirby | George Kirby FS |
| 211 | `hiq:baseball:2023:topps:211:green-foil-board:no-auto:num-499` | Max Fried / Sandy Alcantara / Julio Urías | Max Fried / Sandy Alcantara / Julio Urías LL NL ERA |
| 215 | `hiq:baseball:2023:topps:215:green-foil-board:no-auto:num-499` | Wander Franco | Wander Franco FS |
| 216 | `hiq:baseball:2023:topps:216:green-foil-board:no-auto:num-499` | Vladimir Guerrero Jr. | Vladimir Guerrero |
| 226 | `hiq:baseball:2023:topps:226:green-foil-board:no-auto:num-499` | Michael Harris II | Michael Harris II RC RCup |
| 237 | `hiq:baseball:2023:topps:237:green-foil-board:no-auto:num-499` | Brandon Marsh | Brandon Marsh FS |
| 240 | `hiq:baseball:2023:topps:240:green-foil-board:no-auto:num-499` | Paul Goldschmidt / Pete Alonso / Francisco Lindor | Paul Goldschmidt / Pete Alonso / Francisco Lindor LL NL RBI |
| 241 | `hiq:baseball:2023:topps:241:green-foil-board:no-auto:num-499` | Kyle Tucker / José Ramírez / Aaron Judge | Kyle Tucker / José Ramírez / Aaron Judge LL AL RBI |
| 242 | `hiq:baseball:2023:topps:242:green-foil-board:no-auto:num-499` | Jarren Duran | Jarren Duran FS |
| 246 | `hiq:baseball:2023:topps:246:green-foil-board:no-auto:num-499` | Aaron Judge / Mike Trout / Yordan Alvarez | Aaron Judge / Mike Trout / Yordan Alvarez LL AL HR |
| 250 | `hiq:baseball:2023:topps:250:green-foil-board:no-auto:num-499` | Adley Rutschman | Adley Rutschman (RC) RCup |
| 284 | `hiq:baseball:2023:topps:284:green-foil-board:no-auto:num-499` | Yu Darvish / Julio Urías / Kyle Wright | Yu Darvish / Julio Urías / Kyle Wright LL NL W |
| 285 | `hiq:baseball:2023:topps:285:green-foil-board:no-auto:num-499` | Oneil Cruz | Oneil Cruz FS |
| 289 | `hiq:baseball:2023:topps:289:green-foil-board:no-auto:num-499` | Luis Arraez / Aaron Judge / Xander Bogaerts | Luis Arraez / Aaron Judge / Xander Bogaerts LL AL AVG |
| 295 | `hiq:baseball:2023:topps:295:green-foil-board:no-auto:num-499` | Bryson Stott | Bryson Stott FS |
| 300 | `hiq:baseball:2023:topps:300:green-foil-board:no-auto:num-499` | Vladimir Guerrero Jr. | Vladimir Guerrero |
| 302 | `hiq:baseball:2023:topps:302:green-foil-board:no-auto:num-499` | Vinnie Pasquantino | Vinnie Pasquantino RC RCup |
| 303 | `hiq:baseball:2023:topps:303:green-foil-board:no-auto:num-499` | Jorge Alfaro | Jorge Alfaro "Wild West" |
| 311 | `hiq:baseball:2023:topps:311:green-foil-board:no-auto:num-499` | Alek Manoah / Justin Verlander / Dylan Cease | Alek Manoah / Justin Verlander / Dylan Cease LL AL ERA |
| 326 | `hiq:baseball:2023:topps:326:green-foil-board:no-auto:num-499` | Byron Buxton | Byron Buxton "Walk-Off Waterfall" |
| 330 | `hiq:baseball:2023:topps:330:green-foil-board:no-auto:num-499` | Julio Rodríguez | Julio Rodríguez RCup |
| 339 | `hiq:baseball:2023:topps:339:green-rainbow-foil:no-auto:num-499` | Will Benson | Will Benson RC UER: Atlanta mispelled "Altanta" |
| 347 | `hiq:baseball:2023:topps:347:green-rainbow-foil:no-auto:num-499` | Jeremy Peña | Jeremy Peña RCup |
| 365 | `hiq:baseball:2023:topps:365:green-rainbow-foil:no-auto:num-499` | Spencer Torkelson | Spencer Torkelson FS |
| 369 | `hiq:baseball:2023:topps:369:green-rainbow-foil:no-auto:num-499` | Alexis Díaz | Alexis Díaz RCup |
| 376 | `hiq:baseball:2023:topps:376:green-rainbow-foil:no-auto:num-499` | Christopher Morel | Christopher Morel / Nelson Velazquez "Rookie Takeover" |
| 396 | `hiq:baseball:2023:topps:396:green-rainbow-foil:no-auto:num-499` | Mike Trout | Mike Trout / Vladimir Guerrero |
| 406 | `hiq:baseball:2023:topps:406:green-rainbow-foil:no-auto:num-499` | Nick Lodolo | Nick Lodolo FS |
| 410 | `hiq:baseball:2023:topps:410:green-rainbow-foil:no-auto:num-499` | Jackie Bradley Jr. | Jackie Bradley |
| 422 | `hiq:baseball:2023:topps:422:green-rainbow-foil:no-auto:num-499` | Jake McCarthy | Jake McCarthy FS |
| 432 | `hiq:baseball:2023:topps:432:green-rainbow-foil:no-auto:num-499` | Bryce Harper | Bryce Harper / Brandon Marsh "Postseason Optimists" |
| 451 | `hiq:baseball:2023:topps:451:green-rainbow-foil:no-auto:num-499` | Royce Lewis | Royce Lewis FS |
| 455 | `hiq:baseball:2023:topps:455:green-rainbow-foil:no-auto:num-499` | Lars Nootbaar | Lars Nootbaar FS |
| 470 | `hiq:baseball:2023:topps:470:green-rainbow-foil:no-auto:num-499` | Joey Meneses | Joey Meneses RC RCup |
| 499 | `hiq:baseball:2023:topps:499:green-rainbow-foil:no-auto:num-499` | Ryan McKenna | Ryan McKenna / Austin Hays "Slam Dunk Win" |
| 505 | `hiq:baseball:2023:topps:505:green-rainbow-foil:no-auto:num-499` | José Miranda | José Miranda FS |
| 540 | `hiq:baseball:2023:topps:540:green-rainbow-foil:no-auto:num-499` | Alek Manoah | Alek Manoah UER: Juan Guzman referred to as "Jose" |
| 559 | `hiq:baseball:2023:topps:559:green-rainbow-foil:no-auto:num-499` | Roansy Contreras | Roansy Contreras FS |
| 568 | `hiq:baseball:2023:topps:568:green-rainbow-foil:no-auto:num-499` | Alek Thomas | Alek Thomas FS |
| 579 | `hiq:baseball:2023:topps:579:green-rainbow-foil:no-auto:num-499` | Lourdes Gurriel Jr. | Lourdes Gurriel |
| 584 | `hiq:baseball:2023:topps:584:green-rainbow-foil:no-auto:num-499` | Brendan Donovan | Brendan Donovan RCup |
| 587 | `hiq:baseball:2023:topps:587:green-rainbow-foil:no-auto:num-499` | MJ Melendez | MJ Melendez FS |
| 602 | `hiq:baseball:2023:topps:602:green-rainbow-foil:no-auto:num-499` | Spencer Strider | Spencer Strider RCup |
| 629 | `hiq:baseball:2023:topps:629:green-rainbow-foil:no-auto:num-499` | MacKenzie Gore | MacKenzie Gore FS |
| 645 | `hiq:baseball:2023:topps:645:green-rainbow-foil:no-auto:num-499` | Reid Detmers | Reid Detmers RCup |

## 7 different-player collisions

Two different names at one address — a genuine numbering disagreement between
the Beckett scrape and the baseballcardpedia-ladders checklist transcription,
never a spelling variant. All 7 are award/combo cards (two or three players on
one number) where the Beckett row names only ONE of the players the checklist
row's combo title lists. `occupancyRefusal` refuses these outright: a
collision is reported, never routed around.

| # | id (mover, Beckett) | mover playerName | occupant playerName (existing "Green Foil" row) | occupant source |
|---|---|---|---|---|
| 210 | `hiq:baseball:2023:topps:210:green-foil-board:no-auto:num-499` | Riley Greene | Miguel Cabrera / Riley Greene "Not Bad Rook" | baseballcardpedia-ladders-2026-08-29 |
| 245 | `hiq:baseball:2023:topps:245:green-foil-board:no-auto:num-499` | Aaron Judge | Matt Carpenter / Aaron Judge "Judgement Day" | baseballcardpedia-ladders-2026-08-28 |
| 334 | `hiq:baseball:2023:topps:334:green-rainbow-foil:no-auto:num-499` | Bobby Witt Jr. | MJ Melendez / Bobby Witt | baseballcardpedia-ladders-2026-08-29 |
| 405 | `hiq:baseball:2023:topps:405:green-rainbow-foil:no-auto:num-499` | Juan Soto | Manny Machado / Juan Soto "Pitcher's Nightmare" | baseballcardpedia-ladders-2026-08-29 |
| 457 | `hiq:baseball:2023:topps:457:green-rainbow-foil:no-auto:num-499` | Rowdy Tellez | Willie Adames / Rowdy Tellez "Brewers Get Rowdy" | baseballcardpedia-ladders-2026-08-28 |
| 464 | `hiq:baseball:2023:topps:464:green-rainbow-foil:no-auto:num-499` | Alek Thomas | Geraldo Perdomo / Alek Thomas "Celebratory High-Five" | baseballcardpedia-ladders-2026-08-28 |
| 574 | `hiq:baseball:2023:topps:574:green-rainbow-foil:no-auto:num-499` | Jeremy Peña | Jose Altuve / Jeremy Peña "Champs!" | baseballcardpedia-ladders-2026-08-28 |

## What this needs from Drew

- **Supersets (61):** confirm whether the Beckett mover's bare name is the same
  card as the occupant's suffixed name (most look like it — e.g. "Vladimir
  Guerrero Jr." vs "Vladimir Guerrero" — but a few carry an error-card tag
  ("UER") that could denote a genuinely distinct variation card). If confirmed
  same-card, these fold into a follow-up `retire` list identical in shape to
  the 589-row list. If any are genuinely distinct, they stay as separate rows
  under their own (non-"Green Foil") name.
- **Collisions (7):** these are combo/award cards where the checklist names
  2–3 players sharing one card number and the Beckett scrape (which only ever
  recorded one player) landed a single-player row on the same number. Likely
  resolution is that the Beckett row is itself a mis-transcription of the combo
  card (same card, incomplete player field) rather than a true different card —
  but that needs the checklist confirmed per pair, not assumed.
- Neither group is priced or moved by this PR; sales at these 68 old-id
  addresses (if any) are unaffected until a follow-up list is written.
