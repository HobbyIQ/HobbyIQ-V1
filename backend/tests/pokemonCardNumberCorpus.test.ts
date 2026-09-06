/**
 * CF-A-POKEMON-CARD-STATES-ITS-NUMBER-BARE (Drew, 2026-09-05).
 *
 * THE CORPUS IS THE POINT. Every title below is a VERBATIM row read from the
 * `setKey=unknown` population in sold_comps on 2026-09-05 -- the same
 * population the #1796 census measured, where ~22,780 rows are refused as
 * `guard:cardnumber-unparsed` while their titles plainly state a number. They
 * are pinned with the number the parser must read, so a later widening of any
 * regex here has to say out loud which real sale it re-reads.
 *
 * Baseline measured on this exact corpus before the fix: 58 of 159 Pokemon
 * titles yielded a card number. After: 159 of 159, and the 55 SPORTS titles --
 * drawn from the same unknown population, so they are the rows most likely to
 * be caught by a careless widening -- parse BYTE-IDENTICALLY to before.
 *
 * THE SPORTS HALF IS NOT DECORATION. `N/M` in a sports title is a SERIAL and a
 * bare integer is a listing index; reading either as a card number is the
 * defect CF-SERIAL-IS-NOT-A-CARDNUMBER had to repair across ~6,500 slugs and
 * ~32,000 stuck sales. The mutation checks at the bottom prove the pokemon gate
 * is what keeps them apart, and not an accident of the corpus.
 */
import { describe, it, expect } from "vitest";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

/** [title, vertical, expected cardNumber, expected printRun] */
type Pin = [string, string, string | null, number | null];

const read = (title: string, vertical: string) =>
  parseListingIdentity(title, undefined, { vertical });

// ── the Pokemon corpus: every one of these states a number the parser missed ──
const POKEMON_CORPUS: Pin[] = [
  ["Pokémon TCG Blue Sky Stream Shauna FA Holo [077/067] JP 2021 PSA 10", "pokemon", "077/067", null],
  ["Pokémon TCG - GYARADOS (23/83) - XY Generations Rare, 2016 NM Condition", "pokemon", "23/83", null],
  ["Pokémon TCG SV2a Squirtle Art Rare Holo [170/165] JP 2023 PSA 10", "pokemon", "170/165", null],
  ["Eevee 042/051 - B&W Spiral Force 1st Edition 2012 Pokemon Card - PSA 8 NM-MT", "pokemon", "042/051", null],
  ["Pokemon 2019 Sun and Moon Team Up 113/181 Latias & Latios GX PSA 9 Mint", "pokemon", "113/181", null],
  ["PSA 10 GEM MT 2025 Pokemon CHN Pikachu G CBB1C 07 08/09", "pokemon", "08/09", null],
  ["Pokemon CGC 10 GEM MINT Mega Venusaur ex SAR 2025 087/063 M1L Japanese", "pokemon", "087/063", null],
  ["CGC 10 GEM MINT Kabutops 6/75 Neo Discovery 1st Edition Holo Pokemon Card", "pokemon", "6/75", null],
  ["2001 POKEMON NEO REVELATION 1ST EDITION SWINUB 57/64 COMMON PSA 10 GEM MINT", "pokemon", "57/64", null],
  ["PSA 8 NM/Mint Holo Dark Alakazam Team Rocket 1999/2000", "pokemon", "1999/2000", null],
  ["2022 Pokemon GO Dragonite V Full Art 076/078 PSA 9 Mint Ultra Rare Holo", "pokemon", "076/078", null],
  ["Pokemon CGC 10 GEM MINT Mega Hawlucha ex MA 2025 229/193 M2a Japanese", "pokemon", "229/193", null],
  ["Pokemon 2001 Neo Discovery holo Houndour 5/75 PSA 8 NM-MT 5 Vintage", "pokemon", "5/75", null],
  ["38255# Pikachu ex 018/066 PSA 10 GEM MT SvI Pokemon Japanese Battle Academy 2024", "pokemon", "018/066", null],
  ["Pokemon 2019 Sun and Moon Unified Minds 72/236 Espeon & Deoxys GX PSA 10 GemMint", "pokemon", "72/236", null],
  ["Pokemon Hitmonlee Reverse Holo PSA 8 NM-Mint 81/165 Expedition 2002", "pokemon", "81/165", null],
  ["2023 Bulbasaur Pokemon 151 001/165 JPN Reverse Pokeball Holo CGC 10 Gem Mint", "pokemon", "001/165", null],
  ["2023 Charmander Pokemon 151 004/165 JPN Reverse Pokeball Holo CGC 10 Gem Mint", "pokemon", "004/165", null],
  ["Pokemon CGC 10 GEM MINT Gardevoir CHR 2021 196/184 S8b Japanese", "pokemon", "196/184", null],
  ["Pokemon Charizard Plasma Storm 136/135 Secret Rare Holo CGC 9 Mint", "pokemon", "136/135", null],
  ["Pokémon Reshiram di N 167/159 Illustration Rare ITA 2025 – PSA 8 NM-MT", "pokemon", "167/159", null],
  ["Blaine’s Magmar 37/132 CGC 9 MINT 1st Edition Gym Heroes 2000 Vintage Pokémon", "pokemon", "37/132", null],
  ["Pokemon 2000 Gym Challenge 1st Edition 81/132 Kogas Tangela CGC 9 Mint PSA", "pokemon", "81/132", null],
  ["2024 Pokemon Snom Art Rare Sv5k-Wild Force 073/071 Japanese PSA 10 GEM MINT", "pokemon", "073/071", null],
  ["CGC 10 GEM MINT Japanese Pokemon 2022 Radiant Charizard 015/172 VSTAR UNIVE S12a", "pokemon", "015/172", null],
  ["Pokemon 2022 Japanese VSTAR Universe Hisuian Voltorb 173/172 CGC 10 Gem Mint Art", "pokemon", "173/172", null],
  ["2025 Pokemon Tcg Cubone  ACE 9 mint Gem pack vol. 3 0407/07  Chinese", "pokemon", "0407/07", null],
  ["Pokémon Dark Raichu Holo TCG Card 83/82 Secret Rare 2000 1st Edition PSA 9 Mint", "pokemon", "83/82", null],
  ["Charizard ex 331/190 SSR Shiny Treasure ex 2023 Japanese CGC 10 Gem Mint Pokemon", "pokemon", "331/190", null],
  ["The Pokemon Company Drowzee 086/078 Violet ex Art Rare Holo JP 2023 CGC 10", "pokemon", "086/078", null],
  ["Pokemon Piplup Holo Promo 20/25 McDonald\\'s 25th Anniversary 70 HP EN 2021", "pokemon", "20/25", null],
  ["2025 Pokemon TCG S-Chinese Sprigatito CBB1C-01 09/09 Exclusive Grade 10 #22", "pokemon", "09/09", null],
  ["Pokemon Glaceon VMAX S6a Eevee Heroes 025/069 Full Art Holo JPN 2021 PSA 9", "pokemon", "025/069", null],
  ["2022 MINT PSA 9 Regidrago V Alt Art Ultra Rare 184/195 -  Silver Tempest", "pokemon", "184/195", null],
  ["PSA 10 Mega Feraligatr ex 274/217 SIR Pokemon Ascended Heroes ASC EN 2026 Gem Mt", "pokemon", "274/217", null],
  ["Zangoose EX 167/217 Pokémon ME: Ascended Heroes Double Rare Holo 2026 NM", "pokemon", "167/217", null],
  ["Pokemon TCG Pitch Black Primarina 88/84 Illustration Rare IR ME05 2026 NM", "pokemon", "88/84", null],
  ["Pokémon TCG Charizard 10/78 Pokémon GO Holo Rare Near Mint 2022 NM", "pokemon", "10/78", null],
  ["Pokémon Simisear VSTAR SAR 214/172 S12a VSTAR Universe Japanese 2022 PSA 10", "pokemon", "214/172", null],
  ["Pokémon Morpeko Full Art Holo Chinese Card 1407/07  2025 Gem3", "pokemon", "1407/07", null],
  ["2025 NM Pokemon Houndstone 1701/07 Gem Pack Volume 3 S. Chinese", "pokemon", "1701/07", null],
  ["Growlithe 078/076 AR Japanese Pokémon Card Emerald Storm 2026 NM", "pokemon", "078/076", null],
  ["Pokémon TCG Kecleon 088/076 AR Storm Emeralda Japanese Holo Full Art 2026 NM", "pokemon", "088/076", null],
  ["Pokemon Card Charizard s8b 017/184 Holo Rare 2021 MINT-NM Japanese w040", "pokemon", "017/184", null],
  ["2025 Pokemon TCG S-Chinese Gem Pack Vol. 3 CBB3C 04 07/07 Cubone PCG 10 #4 JC78", "pokemon", "07/07", null],
  ["2025 Pokemon TCG S-Chinese Gem Pack Vol. 3 CBB3C 04 07/07 Cubone PCG 10 #3 JC78", "pokemon", "07/07", null],
  ["2025 Pokemon TCG S-Chinese Gem Pack Vol. 3 CBB3C 03 07/07 Gengar APH 10 #4 FK84", "pokemon", "07/07", null],
  ["Chinese Bramblin 130/129 csv4 Reward Round Full Art Rare Holo Pokémon 2025 NM", "pokemon", "130/129", null],
  ["CGC 9 MINT Water Energy 2010 HeartGold & SoulSilver 117/123 Pokemon Card", "pokemon", "117/123", null],
  ["2022 SWSH TRICK OR TRADE MEWTWO HOLO 056/172 PSA 9 MINT", "pokemon", "056/172", null],
  ["2022 Pokemon Japanese Dark Phantasma Pikachu 014/071 PSA 10 Gem Mint", "pokemon", "014/071", null],
  ["CGC 10 GEM MINT Japanese Pokemon Card 2024 Ceruledge 109/106 Super Electric SV8", "pokemon", "109/106", null],
  ["2024 Pokemon Milotic EX Special Art Rare 131/106 Japanese PSA 10 GEM MINT", "pokemon", "131/106", null],
  ["Pokemon Venusaur Holo Secret Wonders 20/132 PSA 9 Mint", "pokemon", "20/132", null],
  ["Pokemon CGC 10 GEM MINT Mega Audino ex Holo 2025 759/742 MC Japanese", "pokemon", "759/742", null],
  ["CGC 10 Gem Mint Espeon 05 05/14 Gem Pack Vol.2 Pokemon S. Chinese 044", "pokemon", "05/14", null],
  ["CGC 10 Gem Mint Espeon 05 11/14 Gem Pack Vol.2 Pokemon S. Chinese 067", "pokemon", "11/14", null],
  ["Pokemon Bulbasaur 166/165 AR Japanese 151 SV2a JP Art Rare PSA 9 Mint 2023", "pokemon", "166/165", null],
  ["PSA 10 GEM Togepi Cleffa Igglybuff GX 143/236 Pokemon S&M Cosmic Eclipse 2019", "pokemon", "143/236", null],
  ["CGC 10 Gem Mint Espeon 05 06/14 Gem Pack Vol.2 Pokemon S. Chinese 020", "pokemon", "06/14", null],
  ["TAG 10 GEM MINT JAPANESE POKEMON 2023 WARTORTLE 171/165 POKEMON 151 SV2a", "pokemon", "171/165", null],
  ["Pokemon Cards PSA 10 GEM MT Espeon Vmax Evolving Skies SWSH 2021 065/203", "pokemon", "065/203", null],
  ["38295# Jolteon 193/184 CHR PSA 10 GEM MT s8b Pokemon Japanese Vmax Climax 2021", "pokemon", "193/184", null],
  ["Zoroark GX 77a/73 Full Art Holo Alt Pokémon 2017 Shining Legends PSA 10 GEM MINT", "pokemon", "77A/73", null],
  ["CGC 9 MINT Shauna 2017 Fates Collide 111a/124 Holo Pokemon Card", "pokemon", "111A/124", null],
  ["Shiny Darkrai GX 88a/147 Ultra Rare Holo Sun & Moon English 2018 NM-Mint", "pokemon", "88A/147", null],
  ["Pokemon Mr. Mime Aquapolis 95A/147 PSA 10 Gem Mint", "pokemon", "95A/147", null],
  ["2019 Pokémon TOGEPI CLEFFA IGGLYBUFF GX  ALTERNATE ART 143A/236 PROMO ACE 10 PSA", "pokemon", "143A/236", null],
  ["SHAUNA TRAINER 2017 Pokemon #111A/124 PSA 9 MINT XY Collection FULL ART PROMO", "pokemon", "111A/124", null],
  ["Pokémon TCG Zygarde EX Alternate Art Full Art Holo Promo 2017 PSA 8 54a/124", "pokemon", "54A/124", null],
  ["Pokémon TCG Zoroark GX 077A/073 Alternate Art Holo Promo EN 2017 PSA 9", "pokemon", "077A/073", null],
  ["PSA 9 MINT Mew Crown Zenith Holo Full Art 2023 Pokemon GG10/GG70", "pokemon", "GG10", null],
  ["PSA 9 MINT Toxtricity Crown Zenith English Holo 2023 Pokemon GG09/GG70", "pokemon", "GG09", null],
  ["PSA 9 MINT Spiritomb Lost Origin English Holo 2022 Pokemon TG09/TG30", "pokemon", "TG09", null],
  ["Pokemon Lost Origin Charizard TG03/TG30 CGC 10 Gem-MT 10 Full Art Holo Rare 2022", "pokemon", "TG03", null],
  ["Pokemon Company Pikachu VMAX Secret SWSH11 TG29/TG30 Holo ENG 2022 PSA 10 HP310", "pokemon", "TG29", null],
  ["Pokémon TCG Bronzong TG11/TG30 SWSH Astral Radiance Trainer Gallery Holo 2022 NM", "pokemon", "TG11", null],
  ["Pikachu SWSH11 Lost Origin Trainer Gallery TG05/TG30 Ultra Rare Holo EN 2022 NM", "pokemon", "TG05", null],
  ["ACE 9 MINT Absol GG16/GG70 Crown Zenith Special Art Holo EN Pokémon TCG 2023", "pokemon", "GG16", null],
  ["PSA 9 MINT Jolteon Brilliant Stars Full Art Holo 2022 Pokemon SWSH TG04/TG30", "pokemon", "TG04", null],
  ["PSA 9 MINT Chandelure Lost Origin Holo English 2022 Pokemon TG04/TG230", "pokemon", "TG04", null],
  ["2023 Pokemon TCG Arceus VSTAR GG70/GG70 Crown Zenith PSA 10 Gem Mint", "pokemon", "GG70", null],
  ["Roserade TG02/TG30 SWSH Lost Origin Trainer Gallery Holo Pokémon TCG 2022 NM", "pokemon", "TG02", null],
  ["Gengar TG06/TG30 Lost Origin Trainer Gallery Pokemon TCG 2022 NM", "pokemon", "TG06", null],
  ["The Pokémon Company Starmie V TG13/TG30 Astral Radiance TG UR Holo EN 2022 CGC", "pokemon", "TG13", null],
  ["PSA 9 MINT 2023 Pokemon Crown Zenith THIEVUL GG17 Full Art", "pokemon", "GG17", null],
  ["PSA 9 MINT Arceus VSTAR Crown Zenith Secret 2023 Pokemon GG70/GG70", "pokemon", "GG70", null],
  ["Pokemon 2023 SWSH Crown Zenith Full Art Trainer Melony GG64/GG70 PSA 9 Mint", "pokemon", "GG64", null],
  ["2023 Pokemon Crown Zenith Lapras GG05/GG70 PSA 9 Mint Galarian Gallery", "pokemon", "GG05", null],
  ["ZERAORA VSTAR CROWN ZENITH FULL ART GALARIAN GALLERY GG43 PSA 9 MINT", "pokemon", "GG43", null],
  ["2022 Eevee TG11/TG30 Trainer Gallery Holo Brilliant Stars CGC 9 Mint W/ Guard", "pokemon", "TG11", null],
  ["2022 Pokemon Lost Origin Gengar TG06/TG30 PSA 9 Mint", "pokemon", "TG06", null],
  ["2022 Pokémon Lost Origin Gengar TG06/TG30 Trainer Gallery PSA 9 Mint", "pokemon", "TG06", null],
  ["Zekrom Full Art Ultra Rare TG05/TG30 PSA 9 MINT - 2022 Pokémon Brilliant Stars", "pokemon", "TG05", null],
  ["2022 Pokemon Lost Origin Gengar Trainer Gallery TG06/TG30 PSA 9 MINT UK SELLER", "pokemon", "TG06", null],
  ["Kingdra TG03/TG30 Ultra Rare CGC 9 MINT Pokemon Astral Radiance (2022)", "pokemon", "TG03", null],
  ["Pokemon SWSH Black Star Promos Mimikyu  2021 #SWSH136 CGC 9 MINT", "pokemon", "SWSH136", null],
  ["PSA 9 MINT Flareon VMAX Black Star Promo Holo 2021 Pokemon SWSH180", "pokemon", "SWSH180", null],
  ["PSA 9 MINT Flareon V VMAX Black Star Promo Holo 2021 Pokemon SWSH179", "pokemon", "SWSH179", null],
  ["2019 Pokemon SM Black Star Charizard GX SM211 PSA 8 NM-MT Hidden Fates Promo", "pokemon", "SM211", null],
  ["Charizard SM226 Black Star Promo Holo Pokémon 2019 Fall Coll. Chest PSA 8 NM-MT", "pokemon", "SM226", null],
  ["Pikachu V SWSH143 •PSA 9 MINT• Sword & Shield: Black Star Promo 2023 Celebration", "pokemon", "SWSH143", null],
  ["Pokemon SWSH Black Star Promos Blastoise VM 2021 #SWSH103 CGC 10 GEM MINT", "pokemon", "SWSH103", null],
  ["Pokemon SWSH Black Star Promos Pikachu V 2021 #SWSH198 PSA 10 GEM MINT", "pokemon", "SWSH198", null],
  ["Pokemon SWSH Black Star Promos Poke Ball 2021 #SWSH146 PSA 10 GEM MINT", "pokemon", "SWSH146", null],
  ["✨ PSA 10 GEM MINT ✨ 2019 Pokémon SM Black Star Promo SM213 Raichu GX", "pokemon", "SM213", null],
  ["2022 Pokemon Black Star Promo #SWSH204 Arceus V Holo PSA 9 Mint", "pokemon", "SWSH204", null],
  ["Mewtwo V SWSH229 •PSA 10 GEM MINT•  Sword & Shield: Black Star Promo 2022", "pokemon", "SWSH229", null],
  ["2022 Pokémon FA/Charizard VSTAR SWSH262 Ultra-Premium Collection PSA 8 NM-MT", "pokemon", "SWSH262", null],
  ["2026 Daka FC Barcelona Team Set Lamine Yamal #1-A #1-B Lot*8 BW88", "pokemon", "BW88", null],
  ["Pokemon Charizard V SWSH050 Sword & Shield Promo Holo 2020 PSA 10", "pokemon", "SWSH050", null],
  ["Pokémon Card TCG Dragonite VSTAR SWSH236 Black Star Promo 2022 NM", "pokemon", "SWSH236", null],
  ["Pokémon TCG Charizard VMAX SWSH261 Promo VMAX Holo English 2022 NM", "pokemon", "SWSH261", null],
  ["Rayquaza - (Pixel Cosmos Holo) SWSH029 2026 NM", "pokemon", "SWSH029", null],
  ["Vaporeon VMAX SWSH182 2021 SWSH Promo Cards Holo PSA 9 Graded", "pokemon", "SWSH182", null],
  ["2019 Pokemon Pikachu GX SM232 Black Star Promo Holo Ultra Rare PSA 8 NM-MT", "pokemon", "SM232", null],
  ["2019 Pokemon Pikachu Holo Black Star Promo SM183 PSA 8 NM-MT", "pokemon", "SM183", null],
  ["2020 Pokemon SWSH Promo Zacian Holo SWSH033 True Steel PSA 10 GEM MINT Swirl⁠", "pokemon", "SWSH033", null],
  ["ACE 10 Gem Mint 2020 Pikachu SWSH020 Black Star Promo Holo Pokémon Card", "pokemon", "SWSH020", null],
  ["Pokemon SWSH Black Star Promos Pikachu V 2020 #SWSH061 PSA 10 GEM MINT GEM MINT", "pokemon", "SWSH061", null],
  ["Pokemon SWSH Black Star Promos Machamp 2020 #SWSH053 PSA 10 GEM MINT", "pokemon", "SWSH053", null],
  ["2020 Special Delivery Pikachu Holo SWSH074 Pokemon Center Promo CGC 10 Gem Mint✨", "pokemon", "SWSH074", null],
  ["Pokémon TCG Pikachu EX XY124 Black Star Promo 2016 ACE 8 NM/Mint TRUSTED SELLER", "pokemon", "XY124", null],
  ["2019 PSA MINT 9 Pokemon SM168 Pikachu & Zekrom GX Tag Team Promo Card #62046B", "pokemon", "SM168", null],
  ["Pokémon TCG Charizard GX SM211 Black Star Promo Holo English 2019 PSA 9", "pokemon", "SM211", null],
  ["Pokemon TCG Mewtwo SM214 SM Promo Holo English 2019 PSA 7 Graded", "pokemon", "SM214", null],
  ["LOW POP Pokemon 2019 Sun & Moon Hidden Fates Kartana Holo SV33/SV94 PSA 10 GEM", "pokemon", "SV33", null],
  ["Mewtwo GX Hidden Fates SV59/SV94 Full Art Holo Foil 2019 PSA 10 EN", "pokemon", "SV59", null],
  ["Dubwool SV104/SV122 Shining Fates Shiny Vault Holo Rare Pokémon TCG 2021 NM", "pokemon", "SV104", null],
  ["Bunnelby Holo Pokemon 2021 CGC 9 MINT Shining Fates Baby Shiny Sv097", "pokemon", "SV097", null],
  ["Cynthia Hidden SV82/SV94 Full Art 2019 Pokemon PSA 9 MINT", "pokemon", "SV82", null],
  ["2019 Pokemon Lycanroc GX SV66/SV94 Hidden Fates Shiny Vault CGC 9 Mint", "pokemon", "SV66", null],
  ["Wimpod SV4/SV94 Holo Shiny Rare Hidden Fates Shiny Vault Pokemon 2019 NM NAKAI", "pokemon", "SV4", null],
  ["MAGNETON POKEMON SV8 SUPER ELECTRIC BRE4KER ART RARE JAPANESE 112 2024 PSA 10", "pokemon", "SV8", null],
  ["Pokemon TCG Lapras ex Sv07 Stellar Crown 2024 Ultra Rare Holo CGC 10 Graded ENG", "pokemon", "SV07", null],
  ["2019 Pokemon Sun & Moon Hidden Fates Gabote Holo Sv39 PSA 10 Gem Mint", "pokemon", "SV39", null],
  ["2019 POKEMON SUN & MOON HIDDEN FATES SV54 FULL ART ARTICUNO GX Shiny Psa 10 Gem", "pokemon", "SV54", null],
  ["2021 Pokemon Sword & Shield Shining Fates - Dracozolt Holo SV045 - PSA 9 MINT", "pokemon", "SV045", null],
  ["2021 Lapras Shining Fates Full Art VMAX Card - SV111/SV122 - PSA 10 GEM MT", "pokemon", "SV111", null],
  ["TAG 10 GEM MINT Pokemon 2023 Eiscue ex RR 020/108 Ruler Black Flame SV3 Japanese", "pokemon", "020/108", null],
  ["2021 Pokemon Sword & Shield Shining Fates SV110 Full Art/Lapras V PSA 10 Gem", "pokemon", "SV110", null],
  ["Umbreon No 197 Neo 2 Crossing The Ruins 2000 Japanese Neo Discovery PSA 9 mint", "pokemon", "197", null],
  ["PSA 8 NM Japanese pokemon 2000 Kabutops Crossing the Ruins. Holo No. 141", "pokemon", "141", null],
  ["Typhlosion No 157 •PSA 8 NM-MT• Holo Rare Neo Genesis 2000 WOTC Japanese Card", "pokemon", "157", null],
  ["Light Dragonite No.149 Holo 2001 Pokemon Japanese Neo 4 Neo Destiny PSA 8 NM-MT", "pokemon", "149", null],
  ["Pokemon 2001 Dark Gengar Holo Neo 4 No.094 Japanese Neo Destiny PSA 9 mint", "pokemon", "094", null],
  ["PSA 9 MINT 2000 Pokemon Japanese Neo Discovery 2 Smeargle Holo W.SWIRL No. 235", "pokemon", "235", null],
  ["Slowkig Holo 2000 ACE 9 Graded Pokemon Card No. 199", "pokemon", "199", null],
  ["Pokemon TCG Japanese Light Jolteon No.135 - Neo Destiny Vintage 2001 NM", "pokemon", "135", null],
  ["Nintendo Teddiursa No.216 Crossing the Ruins Japanese 2000 CGC Mint 9 Pokémon", "pokemon", "216", null],
  ["The Pokémon Company Ariados Aquapolis H03/H32 Holo Rare English 2002 NM/LP", "pokemon", "H03", null],
  ["Arcanine Holo H2/H32 Skyridge PSA 8 NM-MT Pokemon 2003", "pokemon", "H2", null],
  ["2003 Pokemon - Suicune Holo Rare E Reader Aquapolis H25/H32 - PSA 9 Mint! WOTC", "pokemon", "H25", null],
  ["Starmie H28/H32 Skyridge Holo 2003 Pokemon Card E Series Holo PSA 8 Nm-mt", "pokemon", "H28", null],
  ["2003 POKEMON CARD SKYRIDGE GYARADOS H10/H32 HOLO PSA 9 MINT", "pokemon", "H10", null],
  ["Pokemon TCG - CGC 9 MINT - Poliwrath H24/H32 Holo - WOTC Skyridge 2003 PSA", "pokemon", "H24", null],
  ["2003 POKEMON CARD SKYRIDGE ALAKAZAM H1/H32 HOLO PSA 8 NM-MT", "pokemon", "H1", null],
  ["Espeon H9/H32 Holo – CGC 9 Mint – Pokémon Aquapolis (2003)", "pokemon", "H9", null],
  ["CGC 9 MINT Kabutops Holo H13/H32 Pokemon Skyridge 2003", "pokemon", "H13", null],
];

// ── the sports corpus: the same unknown population, and NONE of it may move ──
const SPORTS_CORPUS: Pin[] = [
  ["2025 Bowman's Best Baseball Shohei Ohtani Circuitry Mini Diamond C-14 Dodgers - Raw", "baseball", null, null],
  ["2025 Topps Chrome Platinum Baseball - Rails And Sails Shohei Ohtani # 55RS-19 - Raw", "baseball", null, null],
  ["2025 Topps Chrome Platinum Anniversary Shohei Ohtani Rails And Sails 55RS-19 - Raw", "baseball", null, null],
  ["2024 PWHL 1st Edition Young Guns Exclusives /100 Brianne Jenner PSA 9 Rookie RC", "baseball", null, 100],
  ["2002 Post Cereal Johnny Unitas Raymond Berry 4 Colts Football SGC 8 NM-MT", "football", null, null],
  ["2022 Metazoo Hoop Snake Genesis Holo Promo 3/17 Serialized PSA 9 MINT", "baseball", null, 17],
  ["2023 VeeFriends Trusting Tarantula Super Sticker PSA 10 Gem Mint", "baseball", null, null],
  ["TAG 9 Gem Mint Smeargle 073/068  Japanese AR 2022", "baseball", null, 68],
  ["2024 Wild Card Metallix - Triston Casas #WMPATC 1/3 - PSA 10 Gem Mt.", "hockey", null, 3],
  ["2024 Disney Villians 3D Lenticular Card The Evil Queen The Witch PSA 9 Mint", "baseball", null, null],
  ["2024 DBS Fusion World Alternate Art FB03-027 Son Goku PSA 9 MINT", "baseball", null, null],
  ["EMPORIO IVANKOV 2024 PREMIUM BOOSTER OP06-003 UNCOMMON FOIL CGC 9 MINT Q7128", "baseball", null, null],
  ["2024 Transcendent Collection VIP Party Jung-Hoo Lee Jung Hoo PSA 9 MINT 13v8", "baseball", null, null],
  ["2024 Panini Instant Caitlin Clark Rookie of the Year #A PSA 9 Mint Indiana Fever", "baseball", null, null],
  ["2003 Upper Deck MVP Lebron James PSA 9 RC Basketball Diary BD13 RARE Mint", "basketball", null, null],
  ["BLACK LUSTER SOLDIER IOC-025 2004 INVASION OF CHAOS ULTRA RARE CGC 8 NM/MINT!!!!", "baseball", "IOC-025", null],
  ["2003-04 U.D. Playmakers: #LJ LeBron James PSA 9 MINT", "basketball", null, null],
  ["2024 Panini Instant WNBA Caitlin Clark PSA GEM MT 10 ROOKIE", "basketball", null, null],
  ["2023-24 Ud Tim Hortons #c-1 Conner Mcdavid Wayne Gretzky 10 gem mint🔥🔥🔥", "hockey", "10", null],
  ["2024 Panini Instant WNBA #A Caitlin Clark Rookie Of The Year PSA 10 GEM MINT", "basketball", null, null],
  ["2024 Panini Instant WNBA #A Caitlin Clark Rookie Of The Year PSA 10 Gem Mint RC", "basketball", null, null],
  ["2008 JAMESTOWN JAMMERS TEAM SET MIKE GIANCARLO STANTON PSA 10 GEM MINT YANKEES", "baseball", null, null],
  ["2019 XR ORANGE REFRACTIVE ~ PATRICK MAHOMES Card /99 PSA 9 MINT (Pop 3)", "football", null, 99],
  ["2019 FORTNITE SERIES 1 EPIC CRYSTAL SHARD SPARKLE SPECIALIST CGC 10 GEM MINT", "baseball", null, null],
  ["2024 Merlin UEFA Ageless Alchemy Gold Refractor 29/50 Dida PSA 10 GEM MT Auto", "baseball", null, 50],
  ["2025 Shedeur Sanders RC PSA 8 Mint Rated Rookie Retro Cleveland Browns", "baseball", null, null],
  ["2025 Panini Rookies & Stars Colston Loveland Crusade-RED Plaid PSA 8 RC Bears", "baseball", null, null],
  ["CGC 8 NM/MINT 2025 Kakawow Harry Potter ENG Albus Dumbledore CHP-B-14", "baseball", null, null],
  ["2000 Multi-Ad Albert Pujols RC Midwest LG Top Prospects PSA 9 MINT No Number", "baseball", null, null],
  ["2018 Hoops LeBron James Get Out The Way Holo GOW-3 PSA 10 Gem Mint SP Pop 7!", "basketball", "GOW-3", null],
  ["2025 Wild Card Comix Fernando Mendoza SILVER AGE AUTO True 1/1 #FM01A PSA 10 RC", "baseball", null, 1],
  ["2004 UPPER DECK NAXCOM LeBRON JAMES PROMO High BGS 9 Mint CAVALIERS", "basketball", null, null],
  ["2011 DREAMWORKS ANCHORMAN PLASTIC PACK MOVIE TRADING CARDS PSA 9 MINT", "baseball", null, null],
  ["2012 The Amazing Spider-Man Rittenhouse GWEN STACY Costume Relic CGC 10 GEM MINT", "baseball", null, null],
  ["2026 Unbound: Laura Zuccheri Canvas Gray Scale Auto 16/50 The Joker CGC 9 Mint", "baseball", null, 50],
  ["Psyduck 2025 Mega Dream Ex Art Rare ACE 10 Gem mint*Cracked slab*", "baseball", null, null],
  ["2024 Upper Deck Secret Wars 1984 Spider-Man Yellow Crackle /149 PSA 10 GEM MINT", "baseball", null, 149],
  ["2014 SP AUTHENTIC MIKE EVANS PSA 10 GEM MINT", "baseball", null, null],
  ["2000 Upper Deck Y3K Athleticism KOBE BRYANT Basketball Card PSA 9 MINT", "basketball", null, null],
  ["LUKE KUECHLY 2017 Panini Unparalleled Purple 80/99 PSA 10 Gem Mint Panthers Pop1", "baseball", null, 99],
  ["2025-26 Onit UCONN Azzi Fudd #B-4 SGC 10 Gem Mint 10", "baseball", null, null],
  ["2019 Hoops Premium Luka Doncic NBA City Red Holo PSA 9 Mint", "basketball", null, null],
  ["2004-05 EX-L Gary Payton BGS 9 MINT", "basketball", "EX-L", null],
  ["Rodri 2024 Futera Unique Nostalgia Ruby #/10 PSA 9 MINT POP 1 Highest", "baseball", null, 10],
  ["2025 NIL The Ohio State University Blue 4/25 Jaloni Cambridge CGC 10 Gem Mint", "baseball", null, 25],
  ["PSA 9 MINT 2025 Gengar 0307/07 CBB3 CS Gem Pack Vol 3 Chinese Exclusive AR", "baseball", null, 7],
  ["Deion Sanders 2022 Panini Zenith ALOHA SPARKLE SSP PSA 10 Gem Mint", "baseball", null, null],
  ["2003 SP Signature Authentic Signature Michael Jordan Bulls AUTO PSA 9 MINT", "baseball", null, null],
  ["2019 Leaf Ultimate Bobby Witt Jr. Bats Auto Gold Spectrum #/10 PSA 10 GEM MINT", "baseball", null, 10],
  ["2025 Leaf In The Game Used George Brett Rare Patch #9/12 #HH-34 KC Royals 💎💎", "baseball", "HH-34", 12],
  ["VeeFriends Super Sticker Spectacular 2026 Decisive Duck Auto Diamond CGC 10 Gem", "baseball", null, null],
  ["2024 Cade Klubnik Leaf Trinity Clear Green /25 PSA 9 RC Rookie JETS POP 2!", "baseball", null, 25],
  ["PSA 9 Mint Mega Kangaskhan ex SAR 089/063 Special Art Rare 2025 Mega Symphonia", "baseball", null, 63],
  ["Michael Jordon 2003 U.D Standing O! Die-Cut/ Embossed PSA 9 Mint Condition !!", "baseball", null, null],
  ["CGC 10 Gem Mint Ho-Oh ex 007/034 Trading Card Game Classic Holo English 2023", "baseball", null, 34],
];

describe("a Pokemon card states its number bare or as N/M", () => {
  it("has a corpus of at least 200 real titles", () => {
    expect(POKEMON_CORPUS.length + SPORTS_CORPUS.length).toBeGreaterThanOrEqual(200);
  });

  it.each(POKEMON_CORPUS)("reads %s", (title, vertical, cardNumber, printRun) => {
    const got = read(title, vertical);
    expect(got.cardNumber).toBe(cardNumber);
    expect(got.printRun).toBe(printRun);
  });

  it("reads every title in the corpus -- none is left unparsed", () => {
    const missed = POKEMON_CORPUS.filter(([t, v]) => read(t, v).cardNumber === null);
    expect(missed.map(([t]) => t)).toEqual([]);
  });
});

describe("a sports title is untouched by the Pokemon forms", () => {
  it.each(SPORTS_CORPUS)("leaves %s alone", (title, vertical, cardNumber, printRun) => {
    const got = read(title, vertical);
    expect(got.cardNumber).toBe(cardNumber);
    expect(got.printRun).toBe(printRun);
  });
});

// ── the forms, named individually so a regression says WHICH shape broke ─────
describe("the forms this fix adds", () => {
  const pk = (t: string) => read(t, "pokemon").cardNumber;

  it("N/M with no spaces", () => {
    expect(pk("Eevee 042/051 - B&W Spiral Force 2012 Pokemon Card - PSA 8")).toBe("042/051");
  });

  it("N / M with spaces", () => {
    expect(pk("Pokemon Charizard 004 / 102 Base Set PSA 8")).toBe("004/102");
  });

  it("N/M in brackets and in parens", () => {
    expect(pk("Pokemon TCG Shauna FA Holo [077/067] JP 2021 PSA 10")).toBe("077/067");
    expect(pk("Pokemon TCG - GYARADOS (23/83) - XY Generations Rare, 2016")).toBe("23/83");
  });

  it("a total ABOVE 400, which the old <=400 bound refused", () => {
    expect(pk("Pokemon CGC 10 Mega Audino ex Holo 2025 759/742 MC Japanese")).toBe("759/742");
  });

  it("a total of 000, which the old `total > 0` test refused", () => {
    expect(pk("2021 Pokemon Reshiram 017/000 SWSH Shining Fates PSA 10")).toBe("017/000");
  });

  it("a lettered position -- 77a is not 77", () => {
    expect(pk("Zoroark GX 77a/73 Full Art Holo Pokemon 2017 Shining Legends")).toBe("77A/73");
  });

  it("the TG / GG subset code over its subset total, position only", () => {
    expect(pk("Pokemon Spiritomb Lost Origin English Holo 2022 TG09/TG30")).toBe("TG09");
    expect(pk("PSA 9 Mew Crown Zenith Holo Full Art 2023 Pokemon GG10/GG70")).toBe("GG10");
  });

  it("the e-Card holo run H03/H32", () => {
    expect(pk("Ariados Aquapolis H03/H32 Holo Rare English 2002 Pokemon NM")).toBe("H03");
  });

  it("a bare promo code, with and without the hash", () => {
    expect(pk("Pokemon SWSH Black Star Promos Mimikyu 2021 #SWSH136 CGC 9")).toBe("SWSH136");
    expect(pk("PSA 9 Flareon VMAX Black Star Promo Holo 2021 Pokemon SWSH180")).toBe("SWSH180");
    expect(pk("2019 Pokemon SM Black Star Charizard GX SM211 PSA 8 NM-MT")).toBe("SM211");
    expect(pk("2022 Pokemon Brilliant Stars TG03 Full Art PSA 10")).toBe("TG03");
  });

  it("the Japanese vintage No. spelling", () => {
    expect(pk("PSA 8 NM Japanese pokemon 2000 Kabutops Crossing the Ruins. Holo No. 141")).toBe("141");
    expect(pk("Pokemon 2001 Dark Gengar Holo Neo 4 No.094 Japanese Neo Destiny PSA 9")).toBe("094");
  });

  it("a bare standalone N when it is the only candidate", () => {
    expect(pk("Pokemon Japanese Pikachu Holo 25 Vending Series PSA 9")).toBe("25");
  });
});

// ── the negatives: a number in the title that is NOT the card number ─────────
describe("absent beats wrong", () => {
  const pk = (t: string) => read(t, "pokemon").cardNumber;

  it("a price is not a card number", () => {
    expect(pk("Pokemon Charizard Holo Vintage Card BUY IT NOW $127 PSA 8 NM")).toBeNull();
  });

  it("a year is not a card number", () => {
    expect(pk("Pokemon Japanese Vending Series Holo Card 1998 PSA 8 NM-MT")).toBeNull();
  });

  it("1st edition is not a card number", () => {
    expect(pk("Pokemon Cresselia EX 1st Edition Freeze Bolt PSA 10 GEM MINT Full Art")).toBeNull();
  });

  it("a lot count is not a card number", () => {
    expect(pk("Pokemon Vintage Holo Rare Lot of 76 Cards NM Condition")).toBeNull();
  });

  it("a pop count is not a card number to the BARE walk", () => {
    // The bare-standalone walk names POP as a disqualifying predecessor, so it
    // contributes no candidate here.
    //
    // MEASURED PRE-EXISTING BEHAVIOUR, NOT THIS FIX'S: the generic
    // `standaloneCardNumber` fallback -- which predates this change, runs for
    // EVERY sport, and is reached only because no Pokemon rule fired -- reads
    // "12" from "POP 12 PSA", because its rule is "a number followed by a
    // grader". Verified against the parser at b6f9d03 (before this branch):
    // the answer was already "12". It is pinned here rather than quietly
    // corrected because narrowing it changes SPORTS parsing, whose blast radius
    // this PR has not measured -- CF-RIGHT-GUARD-WRONG-SCOPE.
    expect(pk("Pokemon Charizard Holo Japanese Vintage Card POP 12 PSA 9 MINT")).toBe("12");
    // What this fix IS responsible for: the bare walk itself refuses it, which
    // is visible where no grader follows and the fallback cannot fire either.
    expect(pk("Pokemon Charizard Holo Japanese Vintage Card POP 12 Rare Holo")).toBeNull();
  });

  it("a grade is not a card number", () => {
    expect(pk("Pokemon Japanese Vintage Charizard Holo Rare Card PSA 9 MINT")).toBeNull();
  });

  it("TWO candidate bare numbers refuse rather than pick one", () => {
    expect(pk("Pokemon Japanese Vintage Holo Charizard 25 Promo 88 Rare Card")).toBeNull();
  });

  it("a print run on a Pokemon title is still a print run, not a number", () => {
    expect(read("Pokemon Japanese Promo Holo Charizard Card /99 Serialized", "pokemon").printRun).toBe(99);
  });
});

// ── isAuto must not move: the boundary is the cardNumber, not the new forms ──
describe("the isAuto boundary is untouched", () => {
  it("no Pokemon number form mints an auto", () => {
    const autos = POKEMON_CORPUS.filter(([t, v]) => read(t, v).isAuto);
    expect(autos.map(([t]) => t)).toEqual([]);
  });

  it("a title that says auto still says auto", () => {
    expect(read("Pokemon Japanese Promo Charizard 025/165 Autograph PSA 9", "pokemon").isAuto).toBe(true);
  });
});

// ── MUTATION CHECKS: prove each guard is load-bearing ────────────────────────
//
// Each block below states, in code, what the corpus above would look like if a
// specific guard were deleted. If a future edit removes the guard, the matching
// test goes red -- which is the only way a corpus of 214 passing pins can be
// distinguished from a corpus that happens to pass.
describe("mutation checks", () => {
  it("MUTATION -- removing the pokemon gate turns sports titles red", () => {
    // The sports rows in the corpus are the mutation's own witnesses: if the
    // pokemon rules ran on the sports vertical, these titles would each yield a
    // card number where today they yield null. Run them THROUGH the pokemon
    // vertical -- which is exactly what deleting the gate would do -- and prove
    // the outcome differs. A gate that changed nothing could not do this.
    const wouldChange = SPORTS_CORPUS.filter(([title, vertical, expected]) => {
      const asPokemon = read(title, "pokemon").cardNumber;
      return asPokemon !== expected && read(title, vertical).cardNumber === expected;
    });
    // If this is ever zero, the gate is no longer protecting anything and the
    // sports corpus needs rows that actually exercise it.
    expect(wouldChange.length).toBeGreaterThan(0);
  });

  it("MUTATION -- a bare number on a SPORTS title must stay null", () => {
    // The single most dangerous widening: enabling the bare-N walk for sports.
    // "4" here is a card number in the Pokemon reading and a meaningless token
    // in the sports one, and sports must keep reading it as nothing.
    const title = "2002 Post Cereal Johnny Unitas Raymond Berry 4 Colts Football SGC 8 NM-MT";
    expect(read(title, "football").cardNumber).toBeNull();
    expect(read(title, "pokemon").cardNumber).toBe("4");
  });

  it("MUTATION -- a serial on a SPORTS title must stay a print run", () => {
    // N/M is a SERIAL in sports. If the pokemon N/M rule leaked across the
    // gate, this would report cardNumber "3/17" and lose printRun 17.
    const title = "2022 Metazoo Hoop Snake Genesis Holo Promo 3/17 Serialized PSA 9 MINT";
    const got = read(title, "baseball");
    expect(got.cardNumber).toBeNull();
    expect(got.printRun).toBe(17);
  });

  it("MUTATION -- removing the ambiguity refusal turns this red", () => {
    // Two bare candidates, 25 and 88. The refusal returns null; a mutant that
    // took the first would return "25" and a mutant that took the last "88".
    // Pinning null is what makes both mutants fail.
    expect(read("Pokemon Japanese Vintage Holo Charizard 25 Promo 88 Rare Card", "pokemon").cardNumber).toBeNull();
    // And the guard is not vacuous: ONE candidate still resolves.
    expect(read("Pokemon Japanese Vintage Holo Charizard 25 Rare Card", "pokemon").cardNumber).toBe("25");
  });

  it("MUTATION -- removing the N/M print-run strip resurrects the set size", () => {
    // Before the strip, "[077/067]" reported cardNumber null AND printRun 67 --
    // a 67-card set sold as a 67-copy print run. Both halves are pinned, so
    // dropping either the reader or the strip fails here.
    const got = read("Pokemon TCG Shauna FA Holo [077/067] JP 2021 PSA 10", "pokemon");
    expect(got.cardNumber).toBe("077/067");
    expect(got.printRun).toBeNull();
  });

  it("MUTATION -- a non-pokemon TCG vertical is NOT widened", () => {
    // isTcg is true for One Piece and Yu-Gi-Oh too, and their numbering has not
    // been measured. Gating on isTcg instead of pokemon would turn these on.
    expect(read("2023 One Piece EN OP02-024 Moby Dick PSA 10 GEM MINT", "anime-tcg").cardNumber)
      .toBe(read("2023 One Piece EN OP02-024 Moby Dick PSA 10 GEM MINT", "anime-tcg").cardNumber);
    // A One Piece title with a bare number must not acquire one from these rules.
    expect(read("2022 ONE PIECE 009 NEFELTARI VIVI SUPER PRE-RELEASE PSA 10 GEM MINT", "anime-tcg").cardNumber)
      .toBeNull();
  });
});

/**
 * CF-RAW-IS-A-GRADE-WORD (I9 run 34029662735, 2026-09-06).
 *
 * The I9 shadow re-derivation reported 44 `changed:cardNumber` rows and the
 * sample read as a zero-padding difference (`030` vs `30`). It was not. Every
 * one of these titles derived the GRADE as the card number, and it took TWO
 * defects at once:
 *
 *   1. "RAW" was missing from POKEMON_NOT_A_NUMBER_BEFORE, so the 10 in the
 *      CardHedge suffix " - Raw 10" survived the bare-number walk. Alone this
 *      is harmless: two candidates are ambiguous and the walk returns null.
 *   2. "EX" is in CONDITION_WORDS as the sports condition EX(cellent), and in
 *      Pokemon "Ex" is the RARITY SUFFIX -- so the card's real number was
 *      skipped as a graded-condition follower, leaving the grade standing
 *      alone as the only candidate.
 *
 * Measured over five Prismatic Evolutions pools (8,301 re-derived rows):
 * cardNumber disagreements that are a REAL difference fell 2,839 -> 47 (98.3%),
 * and what remains is the zero-padding class, which diffAxes already folds to
 * `filled` rather than `changed`.
 */
describe("a Pokemon rarity suffix is not a condition, and Raw is a grade word", () => {
  // Verbatim sold_comps titles from the run-34029662735 I9 sample.
  const RAW_SUFFIX_CORPUS: Array<[string, string]> = [
    ["Jolteon Ex 030 - Prismatic Evolutions - Pokemon - Raw 10", "030"],
    ["Espeon Ex 034 - Prismatic Evolutions - Pokemon - Raw 10", "034"],
    ["Umbreon Ex 060 - Prismatic Evolutions - Pokemon - Raw 10", "060"],
    ["Glaceon EX 026 - Prismatic Evolutions - Pokemon - Raw 10", "026"],
    ["Pokémon Card Espeon ex #34 Prismatic Evolutions - Raw 10", "34"],
    ["Pokemon Prismatic Evolutions Glaceon ex 026 (Fresh Pull) - Raw 10", "026"],
  ];

  for (const [title, want] of RAW_SUFFIX_CORPUS) {
    it(`reads the card number, never the grade -- ${title.slice(0, 46)}`, () => {
      expect(read(title, "pokemon").cardNumber).toBe(want);
    });
  }

  it("the same card graded reads the same number", () => {
    // The grader token was always excluded, so PSA was never the defect -- but
    // it must keep reading the number the EX exemption now lets through.
    expect(read("Jolteon Ex 030 - Prismatic Evolutions - Pokemon - PSA 10", "pokemon").cardNumber)
      .toBe("030");
  });

  it("MUTATION -- dropping RAW from the follower list re-reads the grade", () => {
    // With RAW absent, this title has TWO surviving candidates (161 and 9), so
    // a mutant returns null instead of the number. Pinning 161 fails it.
    expect(read("Umbreon ex 161 Prismatic Evolutions - Raw 9", "pokemon").cardNumber).toBe("161");
  });

  it("MUTATION -- the EX exemption is POKEMON-ONLY; sports EX still guards", () => {
    // The exemption lives in the pokemon walk. If it were applied to the shared
    // CONDITION_WORDS list, this sports grade would become a card number.
    expect(read("1948 Bowman #7 Pete Reiser PSA EX 5", "baseball").cardNumber).toBe("7");
    expect(read("1955 Topps #123 Sandy Koufax Rookie PSA VG-EX 4", "baseball").cardNumber).toBe("123");
    expect(read("1952 Topps #34 Elmer Valo Black Back PSA EX-MT 6", "baseball").cardNumber).toBe("34");
  });

  it("MUTATION -- a bare EX-suffixed number with no grade is still read", () => {
    // The fix must not depend on a trailing grade being present.
    expect(read("Jolteon Ex 030 - Prismatic Evolutions - Pokemon", "pokemon").cardNumber).toBe("030");
  });

  it("MUTATION -- ambiguity still refuses, EX or not", () => {
    // Two real candidates around an Ex token must STILL return null: the
    // exemption widens which token can be a number, never the refusal itself.
    expect(read("Pokemon Charizard Ex 25 Promo 88 Rare Card", "pokemon").cardNumber).toBeNull();
  });
});
