/**
 * Trend-based pricing engine via Apify eBay sold listings.
 *
 * Prices cards based on current market direction, recency-weighted sales,
 * and outlier-controlled comp analysis — NOT a simple median.
 */

export interface SoldComp {
  price: number;
  title: string;
  date: string;
  url: string;
  grade?: string;
  parallel?: string;
  normalizedPrice?: number;
}

export interface TrendAnalysis {
  market_direction: "up" | "down" | "flat" | "volatile" | "unclear";
  recent_sales_pattern: string;
  older_sales_pattern: string;
  change_from_older_to_recent: string;
  liquidity: "high" | "medium" | "low";
  trend_confidence: number;
  windows: {
    last7: { count: number; avgPrice: number | null };
    last14: { count: number; avgPrice: number | null };
    last30: { count: number; avgPrice: number | null };
    last60: { count: number; avgPrice: number | null };
    last90: { count: number; avgPrice: number | null };
  };
}

export interface OutlierComp extends SoldComp {
  reason_ignored_or_reduced: string;
}

export interface CardSearchResult {
  success: boolean;
  query: string;
  summary: string;
  marketTier: { value: number; high: number };
  buyZone: [number, number];
  holdZone: [number, number];
  sellZone: [number, number];
  recentComps: SoldComp[];
  outliers: OutlierComp[];
  trendAnalysis: TrendAnalysis;
  supply: { activeListings: null; trend2w: null; trend4w: null; trend3m: null };
  confidence: number;
  source: "live" | "mock";
  valuationMethod: "trend-based";
  gradeTierUsed: string;
  marketTrendOverall: {
    queryUsed: string;
    sampleSize: number;
    trend: TrendAnalysis;
  };
  lastDirectComp: {
    price: number;
    normalizedPrice: number;
    date: string;
    ageInDays: number;
    title: string;
  } | null;
  nextSaleEstimate: number;
  anchorAnalysis: {
    anchorPrice: number;
    anchorRawPrice: number;
    anchorAge: number;
    surroundingMovement: "up" | "flat" | "down";
    surroundingChangePercent: number;
    stalenessWeight: number;
    reasoning: string;
  };
  compRange: { low: number; high: number; median: number };
  recommendation: "hold" | "move";
  keyRisks: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

type GradeLabel =
  | "psa10"
  | "psa9_5"
  | "psa9"
  | "psa8"
  | "bgs9_5"
  | "bgs9"
  | "sgc10"
  | "sgc9"
  | "graded_other"
  | "raw";

type ParallelLabel =
  // --- 1/1 ---
  | "one_of_one"           // SuperFractor, Platinum, Rose Gold 1/1, Printing Plates
  // --- /3 ---
  | "fire_fractor_3"       // FireFractor /3
  // --- /5 ---
  | "food_fractor_5"       // Gum Ball, Sunflower Seeds, Peanuts, Popcorn ~est /5
  | "red_5"                // Red /5, Red Lava, Red Geometric, Red X-Fractor, Red Wave
  // --- /10 ---
  | "rose_gold_10"         // Rose Gold /10 (2023-2024)
  | "pearl_10"             // Pearl ~est /10
  | "black_10"             // Black Refractor, Black X-Fractor, Black Geometric /10
  // --- /15 ---
  | "gold_ink_15"          // Gold Ink autograph /15 (2026)
  | "rose_gold_15"         // Rose Gold /15 (2025-2026)
  | "pearl_15"             // Pearl ~est /15 (2023)
  | "black_and_white_15"   // Black & White /15 (Mega Box)
  | "chartreuse_15"        // Chartreuse paper /15
  | "black_paper_15"       // Black paper /10-15
  // --- /25 ---
  | "orange_25"            // Orange /25, Shimmer, Geometric, Wave, X-Fractor
  // --- /35 ---
  | "bowman_logo_35"       // Bowman LogoFractor /35 (numbered)
  // --- /50 ---
  | "gold_50"              // Gold /50, Shimmer, Lava, Geometric, Reptilian Gold
  // --- /75 ---
  | "yellow_75"            // Yellow /75, X-Fractor, Wave, Mini-Diamond, Lunar Crater, Pattern
  // --- /89 ---
  | "pack_fractor_89"      // PackFractor /89 (2026)
  // --- /99 ---
  | "green_99"             // Green /99, Shimmer, Grass, Lava, Geometric, Reptilian, Pattern
  // --- /100 ---
  | "atomic_100"           // Atomic Refractor /100
  | "mini_diamond_100"     // Mini-Diamond Refractor /100 (numbered)
  | "steel_metal_100"      // Steel Metal /100
  // --- /125 ---
  | "aqua_125"             // Aqua /125, Shimmer, Mini-Diamond, X-Fractor, Lunar Crater, Geometric
  // --- /150 ---
  | "raywave"              // Blue RayWave /150 (premium visual pattern)
  | "blue_wave_150"        // Blue Wave /150
  | "blue_150"             // Blue /150, Shimmer, Lunar Crater, Geometric, Reptilian, X-Fractor
  | "hta_choice_150"       // HTA Choice /150 (exclusive channel)
  // --- /175 ---
  | "pink_175"             // Pink paper /175
  // --- /199 ---
  | "fuchsia_199"          // Fuchsia Chrome /199, Shimmer, Wave, Lunar Crater, Reptilian
  | "purple_pattern_199"   // Purple Pattern paper /199
  | "sapphire_199"         // Sapphire Edition /199 (kept for backwards compat)
  // --- /250 ---
  | "purple_250"           // Purple /250, RayWave, Geometric, Pattern paper
  // --- /299 ---
  | "speckle_299"          // Speckle Chrome Refractor /299
  | "fuchsia_paper_299"    // Fuchsia paper /299
  // --- /350 ---
  | "wave_350"             // Wave Refractor /350
  // --- /399 ---
  | "lava_399"             // Lava Chrome Refractor /399
  | "neon_green_399"       // Neon Green paper /399
  // --- /499 ---
  | "sky_blue_499"         // Sky Blue paper /499
  | "refractor_499"        // Chrome Refractor /499
  // --- Unnumbered specialty ---
  | "logo_fractor"         // LogoFractor, Laser Refractor (unnumbered premium)
  | "x_fractor"            // X-Fractor (unnumbered)
  | "reptilian_base"       // Reptilian Refractor (unnumbered base)
  | "mini_diamond_base"    // Mini-Diamond Refractor (unnumbered base)
  | "lunar_glow"           // Lunar Glow (unnumbered)
  | "camo"                 // Camo paper (unnumbered)
  | "retro_logo_foil"      // Retro Logo Foil paper (unnumbered, 2025)
  // --- 2000-2020 Bowman flagship era parallels ---
  | "social_media_10"      // Social Media Refractor /10 (Chrome 2013)
  | "black_refractor_99"   // Chrome Black Refractor /99 (2006-2015, before modern black /10)
  | "blue_refractor_250"   // Chrome Blue Refractor /250 (2006-2014 historical print run)
  | "purple_refractor_199" // Chrome Purple Refractor /199 (2006-2014)
  | "wave_refractor"       // Wave Refractor (older Chrome, unnumbered or serial varies)
  | "uncirculated_silver"  // Uncirculated Silver Refractor ~245-250 (2003-2005)
  | "first_edition"        // 1st Edition paper (2004-2005)
  | "gold_paper"           // Paper Gold parallel (unnumbered, 2000-2016+)
  | "silver_ice"           // Paper Silver Ice (unnumbered, 2012-2015)
  | "red_ice_25"           // Paper Red Ice /25 (2012-2015)
  | "international"        // Paper International (unnumbered, 2011+)
  | "state_hometown"       // Paper State & Hometown (unnumbered, 2013-2014)
  // --- Topps Flagship parallels (paper, non-Chrome) ---
  | "rainbow_foil"         // Rainbow/Holo Foil (unnumbered flagship premium)
  | "gold_flagship"        // Gold numbered to the card year (/2024, /2025, /2026)
  | "clear_flagship"       // Clear/acetate parallel (unnumbered)
  | "pink_flagship"        // Pink /800 range (flagship)
  | "yellow_flagship"      // Yellow /399 range (flagship)
  | "purple_flagship"      // Purple /250 (flagship, not Chrome)
  | "blue_flagship"        // Blue /150 (flagship, not Chrome)
  | "green_flagship"       // Green /99 (flagship, not Chrome)
  | "independence_day"     // Independence Day /76 (flagship)
  | "black_flagship"       // Black /75 or /67 (flagship, not Chrome)
  | "platinum_flagship"    // Platinum 1/1 (flagship)
  // --- Topps Heritage variations ---
  | "heritage_chrome"      // Heritage Chrome parallel (chrome stock, refractor)
  | "heritage_black"       // Heritage Black Border /50 or /67
  | "heritage_sp"          // Heritage Short Print (high number SP or action variation)
  | "heritage_real_one"    // Heritage Real One on-card autograph
  // --- Allen & Ginter parallels ---
  | "ag_mini"              // A&G Mini (unnumbered)
  | "ag_black_mini"        // A&G Mini Black Border /25
  | "ag_back_variant"      // A&G Back, Brooklyn Back, No Number — back-variant parallels
  | "ag_wood"              // A&G Wood 1/1
  | "chrome_base";         // Chrome base

// ─── Product Family Classification ───────────────────────────────────────────

type ProductFamily =
  | "bowman_chrome"       // Bowman Chrome / Bowman Chrome Update
  | "bowman_paper"        // Bowman flagship paper (non-Chrome)
  | "topps_chrome"        // Topps Chrome, Chrome Update
  | "topps_chrome_premium"// Sapphire, Chrome Black, Cosmic Chrome, Gilded
  | "topps_flagship"      // Topps Series 1 / Series 2 / Update / Traded / Opening Day / Big League / Holiday
  | "topps_heritage"      // Topps Heritage (any year)
  | "topps_allen_ginter"  // Allen & Ginter
  | "topps_gypsy_queen"   // Gypsy Queen
  | "topps_archives"      // Archives / Archives Signature / Snapshots
  | "topps_now"           // Topps Now and online print-run products
  | "topps_premium"       // Tribute, Triple Threads, Museum, Five Star, Inception, Diamond Icons, etc.
  | "unknown";

interface CardProfile {
  grade: GradeLabel;
  parallel: ParallelLabel;
}

interface QuerySignals {
  year: string | null;
  requiresAuto: boolean;
  playerTokens: string[];
  productFamily: ProductFamily;
}

/**
 * Classify a card's product family from its title or query text.
 * Used to enforce comp-family isolation (no Chrome comps for Heritage queries, etc.)
 */
function detectProductFamily(text: string): ProductFamily {
  const t = text.toLowerCase();

  // Bowman Chrome — must check before generic "bowman" or "chrome"
  if (/\bbowman\b/.test(t) && /\bchrome\b/.test(t)) return "bowman_chrome";
  if (/\bbowman\b/.test(t)) return "bowman_paper";

  // Topps Chrome premium tiers — before generic "chrome"
  if (/\b(sapphire|cosmic\s*chrome|chrome\s*black|chrome\s*platinum|gilded)\b/.test(t)) return "topps_chrome_premium";
  if (/\bchrome\b/.test(t)) return "topps_chrome";

  // Retro/variation products
  if (/\bheritage\b/.test(t)) return "topps_heritage";
  if (/\ballen\s*[&]?\s*ginter\b|\ba\s*[&]\s*g\b/.test(t)) return "topps_allen_ginter";
  if (/\bgypsy\s*queen\b/.test(t)) return "topps_gypsy_queen";
  if (/\barchives\b/.test(t)) return "topps_archives";

  // Premium auto/relic products
  if (/\b(tribute|triple\s*threads|museum\s*collection|five\s*star|diamond\s*icons|definitive|luminaries|transcendent|tier\s*one|inception|dynasty|sterling|pristine|supreme|marquee|strata)\b/.test(t)) return "topps_premium";

  // Topps Now and online print-run
  if (/\btopps\s*now\b/.test(t)) return "topps_now";

  // Topps flagship catch-all (after all specific products)
  if (/\btopps\b/.test(t)) return "topps_flagship";

  return "unknown";
}

/**
 * Whether two product families can supply valid comps for each other.
 * Chrome families are internally compatible. Retro/paper families are strict.
 */
function isFamilyCompatible(target: ProductFamily, candidate: ProductFamily): boolean {
  if (target === candidate) return true;
  if (target === "unknown" || candidate === "unknown") return true;

  // Chrome ecosystem: Chrome, Chrome premium, and Bowman Chrome are cross-compatible as comps
  const chromeEcosystem = new Set<ProductFamily>(["topps_chrome", "topps_chrome_premium", "bowman_chrome"]);
  if (chromeEcosystem.has(target) && chromeEcosystem.has(candidate)) return true;

  // Flagship paper is only compatible with flagship paper
  if (target === "topps_flagship") return candidate === "topps_flagship";

  // Bowman paper only comps with Bowman paper
  if (target === "bowman_paper") return candidate === "bowman_paper";

  // Retro/variation products — strict, no cross-family mixing
  if (target === "topps_heritage") return candidate === "topps_heritage";
  if (target === "topps_allen_ginter") return candidate === "topps_allen_ginter";
  if (target === "topps_gypsy_queen") return candidate === "topps_gypsy_queen";
  if (target === "topps_archives") return candidate === "topps_archives";

  // Premium products are their own market
  if (target === "topps_premium") return candidate === "topps_premium";
  if (target === "topps_now") return candidate === "topps_now";

  return false;
}

/**
 * Detect the grade of a card from its eBay listing title.
 * Returns "raw" if no grading company + score is found.
 */
function detectGrade(text: string): GradeLabel {
  const t = text.toLowerCase();
  if (/psa[\s-]?10\b/.test(t)) return "psa10";
  if (/psa[\s-]?9\.5\b/.test(t)) return "psa9_5";
  if (/psa[\s-]?9\b/.test(t)) return "psa9";
  if (/psa[\s-]?8\b/.test(t)) return "psa8";
  if (/bgs[\s-]?9\.5\b/.test(t)) return "bgs9_5";
  if (/bgs[\s-]?9\b/.test(t)) return "bgs9";
  if (/sgc[\s-]?10\b/.test(t)) return "sgc10";
  if (/sgc[\s-]?9\b/.test(t)) return "sgc9";
  if (/\b(psa|bgs|sgc|cgc|hga|csg)\b/.test(t)) return "graded_other";
  return "raw";
}

/**
 * Extract the card year from listing text (for era-aware parallel detection).
 */
function detectYear(text: string): number | null {
  const m = text.match(/\b(200[0-9]|201[0-9]|202[0-9])\b/);
  return m ? parseInt(m[0]) : null;
}

function detectParallel(text: string): ParallelLabel {
  const t = text.toLowerCase();
  const year = detectYear(t);
  const family = detectProductFamily(t);
  const isChrome = /\bchrome\b/.test(t);
  const isBowman = /\bbowman\b/.test(t);

  // ── Allen & Ginter parallels (detect before any generic color checks) ──────
  if (family === "topps_allen_ginter") {
    if (/\bwood\b/.test(t)) return "ag_wood";
    if (/\bblack\s*border\b/.test(t)) return "ag_black_mini";
    if (/\bmini\b/.test(t)) return "ag_mini";
    if (/\b(a\s*[&]\s*g\s*back|brooklyn\s*back|no\s*number\s*back|cloth|metal|stained\s*glass|rip\s*card)\b/.test(t)) return "ag_back_variant";
    return "chrome_base"; // base A&G
  }

  // ── Heritage variations ───────────────────────────────────────────────────
  if (family === "topps_heritage") {
    if (/\bchrome\b/.test(t) && /\brefractor\b/.test(t)) return "heritage_chrome";
    if (/\bchrome\b/.test(t)) return "heritage_chrome";
    if (/\bblack\s*(border|back)?\b/.test(t) && /\/\s*(5[0-9]|6[0-9]|7[0-9])\b/.test(t)) return "heritage_black";
    if (/\b(real\s*one|real\s*auto)\b/.test(t)) return "heritage_real_one";
    if (/\b(sp\b|short\s*print|action|variation|hn\b|high\s*number)\b/.test(t)) return "heritage_sp";
    return "chrome_base"; // base Heritage
  }

  // ── Topps Flagship parallels (non-Chrome, non-Bowman paper context) ───────
  if (family === "topps_flagship" || (family === "unknown" && !isChrome && !isBowman)) {
    // 1/1 — check first
    if (/\b(platinum|superfractor|1\/1|one\s*of\s*one)\b/.test(t) && !/\/\s*[2-9]\d/.test(t)) return "platinum_flagship";
    // Rainbow/Holo Foil (unnumbered premium)
    if (/\b(rainbow\s*foil|holo\s*foil|foil\s*rainbow)\b/.test(t)) return "rainbow_foil";
    // Clear/acetate
    if (/\bclear\b/.test(t) && /\b(parallel|acetate)\b/.test(t)) return "clear_flagship";
    // Gold numbered to year (e.g., /2024, /2025, /2026)
    if (/\bgold\b/.test(t) && /\/\s*20[0-9]{2}\b/.test(t)) return "gold_flagship";
    // Black /75 or nearby
    if (/\bblack\b/.test(t) && /\/\s*(6[0-9]|7[0-9])\b/.test(t)) return "black_flagship";
    // Independence Day /76 (or nearby)
    if (/\bindependence\s*day\b/.test(t)) return "independence_day";
    // Green /99
    if (/\bgreen\b/.test(t) && /\/\s*99\b/.test(t)) return "green_flagship";
    // Blue /150
    if (/\bblue\b/.test(t) && /\/\s*150\b/.test(t)) return "blue_flagship";
    // Purple /250
    if (/\bpurple\b/.test(t) && /\/\s*250\b/.test(t)) return "purple_flagship";
    // Yellow /399
    if (/\byellow\b/.test(t) && /\/\s*[23][0-9]{2}\b/.test(t)) return "yellow_flagship";
    // Pink /800 range
    if (/\bpink\b/.test(t) && /\/\s*[6-9][0-9]{2}\b/.test(t)) return "pink_flagship";
    // Gold without year number — unnumbered paper gold
    if (/\bgold\b/.test(t) && !/\/\s*50\b/.test(t)) return "gold_paper";
  }

  // --- 1/1 ---
  if (/\b(superfractor|super\s+fractor|platinum|1\/1|one\s+of\s+one|true\s*1\/1)\b/.test(t)
    && !/\/\s*[2-9][0-9]/.test(t)) return "one_of_one";

  // --- Historical era parallels (detect before generic color checks) ---

  // Social Media Refractor /10 (Chrome 2013) — before generic black /10
  if (/\bsocial\s*media\b/.test(t)) return "social_media_10";

  // 1st Edition paper (2004-2005)
  if (/\b(1st|first)\s+edition\b/.test(t)) return "first_edition";

  // Uncirculated Silver Refractor (2003-2005)
  if (/\buncirculated\b/.test(t) && /\bsilver\b/.test(t)) return "uncirculated_silver";
  if (/\buncirculated\b/.test(t)) return "uncirculated_silver";

  // Paper Silver Ice / Red Ice (2012-2015 Bowman flagship) — MUST come before generic red/silver checks
  if (/\bsilver\s*ice\b/.test(t)) return "silver_ice";
  if (/\bred\s*ice\b/.test(t)) return "red_ice_25";

  // Paper State & Hometown (2013-2014)
  if (/\b(state|hometown)\b/.test(t) && !isChrome) return "state_hometown";

  // Paper International (2011+)
  if (/\binternational\b/.test(t) && !isChrome) return "international";

  // Chrome Black Refractor /99 (historical, 2006-2015) — before generic black /10 check
  if (/\bblack\b/.test(t) && /\brefractor\b/.test(t) && /\/\s*99\b/.test(t)) return "black_refractor_99";
  if (/\bblack\b/.test(t) && /\brefractor\b/.test(t) && year !== null && year <= 2015) return "black_refractor_99";
  // Black Refractor in chrome context without explicit /10 serial defaults to /99 (historical naming)
  if (/\bblack\b/.test(t) && /\brefractor\b/.test(t) && isChrome && !/\/\s*10\b/.test(t)) return "black_refractor_99";

  // Chrome Blue Refractor /250 (historical 2006-2014) — before generic blue_150 checks
  if (/\bblue\b/.test(t) && /\brefractor\b/.test(t) && /\/\s*250\b/.test(t)) return "blue_refractor_250";
  if (/\bblue\b/.test(t) && /\brefractor\b/.test(t) && year !== null && year <= 2014) return "blue_refractor_250";

  // Chrome Purple Refractor /199 (historical 2006-2014)
  if (/\bpurple\b/.test(t) && /\brefractor\b/.test(t) && /\/\s*199\b/.test(t)) return "purple_refractor_199";
  if (/\bpurple\b/.test(t) && /\brefractor\b/.test(t) && year !== null && year <= 2014) return "purple_refractor_199";

  // Wave Refractor (older Chrome, without specific /350 serial)
  if (/\bwave\b/.test(t) && /\brefractor\b/.test(t) && !/\/\s*350\b/.test(t) && year !== null && year <= 2015) return "wave_refractor";

  // Paper Gold (unnumbered, non-chrome context) — after all high-value checks
  if (/\bgold\b/.test(t) && !isChrome && year !== null && year <= 2016 && !/\/\s*50\b/.test(t)) return "gold_paper";

  // --- /3 ---
  if (/\bfire\s*fractor\b/.test(t)) return "fire_fractor_3";

  // --- /5 food fractors (detect before red) ---
  if (/\b(gum\s*ball|sunflower\s*seeds?|peanuts?|popcorn)\b/.test(t)) return "food_fractor_5";

  // --- /5 red variants ---
  if (/\bred\b/.test(t) && /\/\s*5\b/.test(t)) return "red_5";

  // --- /10 tier (detect specific before generic black) ---
  if (/\brose\s+gold\b/.test(t) && /\/\s*10\b/.test(t)) return "rose_gold_10";
  if (/\bpearl\b/.test(t) && /\/\s*10\b/.test(t)) return "pearl_10";
  if (/\bblack\b/.test(t) && /\/\s*10\b/.test(t)) return "black_10";

  // --- /15 tier ---
  if (/\bgold\s+ink\b/.test(t)) return "gold_ink_15";
  if (/\bblack\s*[&]\s*white\b/.test(t)) return "black_and_white_15";
  if (/\brose\s+gold\b/.test(t) && /\/\s*15\b/.test(t)) return "rose_gold_15";
  if (/\bpearl\b/.test(t) && /\/\s*15\b/.test(t)) return "pearl_15";
  if (/\bchartreuse\b/.test(t)) return "chartreuse_15";
  // Rose Gold / Pearl without explicit serial — default by era
  if (/\brose\s+gold\b/.test(t)) return "rose_gold_15";
  if (/\bpearl\b/.test(t)) return "pearl_15";
  if (/\bblack\b/.test(t) && /\/\s*15\b/.test(t)) return "black_paper_15";

  // --- /25 orange ---
  if (/\borange\b/.test(t) && /\/\s*25\b/.test(t)) return "orange_25";

  // --- /35 Bowman LogoFractor ---
  if (/\bbowman\s+logo\s*fractor\b/.test(t)
    || (/\blogo\s*fractor\b/.test(t) && /\/\s*35\b/.test(t))) return "bowman_logo_35";

  // --- /50 gold ---
  if (/\bgold\b/.test(t) && /\/\s*50\b/.test(t)) return "gold_50";

  // --- /75 yellow ---
  if (/\byellow\b/.test(t) && /\/\s*75\b/.test(t)) return "yellow_75";

  // --- /89 PackFractor ---
  if (/\bpack\s*fractor\b/.test(t)) return "pack_fractor_89";

  // --- /99 green ---
  if (/\bgreen\b/.test(t) && /\/\s*99\b/.test(t)) return "green_99";

  // --- /100 tier ---
  if (/\bsteel\s+metal\b/.test(t)) return "steel_metal_100";
  if (/\batomic\b/.test(t)) return "atomic_100"; // Atomic is consistently /100
  if (/\bmini[\s-]diamond\b/.test(t) && /\/\s*100\b/.test(t)) return "mini_diamond_100";

  // --- /125 aqua ---
  if (/\baqua\b/.test(t)) return "aqua_125"; // Aqua is consistently /125

  // --- /150 tier (raywave and wave MUST come before generic blue) ---
  if (/\braywave\b/.test(t)) return "raywave";
  if (/\bblue\s+wave\b/.test(t)) return "blue_wave_150";
  if (/\bhta\b/.test(t)) return "hta_choice_150";
  if (/\bblue\b/.test(t) && /\/\s*150\b/.test(t)) return "blue_150";

  // --- /175 pink ---
  if (/\bpink\b/.test(t)) return "pink_175"; // Pink is consistently /175 in paper

  // --- /199 tier ---
  if (/\bsapphire\b/.test(t)) return "sapphire_199";
  if (/\bfuchsia\b/.test(t) && /\/\s*199\b/.test(t)) return "fuchsia_199";
  if (/\bpurple\s+pattern\b/.test(t)) return "purple_pattern_199";
  if (/\bfuchsia\b/.test(t)) return "fuchsia_199"; // Fuchsia chrome is mostly /199

  // --- /250 purple ---
  if (/\bpurple\b/.test(t) && /\/\s*250\b/.test(t)) return "purple_250";
  if (/\bpurple\b/.test(t)) return "purple_250";

  // --- /299 tier ---
  if (/\bspeckle\b/.test(t)) return "speckle_299";
  if (/\bfuchsia\b/.test(t) && /\/\s*299\b/.test(t)) return "fuchsia_paper_299";

  // --- /350 wave ---
  if (/\bwave\s*refractor\b/.test(t) && /\/\s*350\b/.test(t)) return "wave_350";
  if (/\bwave\b/.test(t) && /\/\s*350\b/.test(t)) return "wave_350";

  // --- /399 tier ---
  if (/\bneon\s*green\b/.test(t)) return "neon_green_399";
  if (/\blava\b/.test(t)) return "lava_399"; // Lava is mostly /399 for non-auto chrome

  // --- /499 tier ---
  if (/\bsky\s*blue\b/.test(t)) return "sky_blue_499";
  if (/\brefractor\b/.test(t) && /\/\s*499\b/.test(t)) return "refractor_499";

  // --- Unnumbered specialty ---
  if (/\blogo\s*fractor\b/.test(t)) return "logo_fractor";
  if (/\blaser\s*refractor\b/.test(t)) return "logo_fractor";
  if (/\breptili[a-z]+\b/.test(t)) return "reptilian_base";
  if (/\bmini[\s-]diamond\b/.test(t)) return "mini_diamond_base";
  if (/\bx[\s-]fractor\b/.test(t)) return "x_fractor";
  if (/\blunar\s*(glow|crater)\b/.test(t)) return "lunar_glow";
  if (/\bcamo\b/.test(t)) return "camo";
  if (/\bretro\s+logo\b/.test(t)) return "retro_logo_foil";

  // --- Blue without explicit serial — most blue parallels are /150 ---
  if (/\bblue\b/.test(t)) return "blue_150";

  // --- Refractor fallback ---
  if (/\brefractor\b/.test(t)) return "refractor_499";

  return "chrome_base";
}

function parseCardProfile(text: string): CardProfile {
  return {
    grade: detectGrade(text),
    parallel: detectParallel(text),
  };
}

function buildQuerySignals(query: string): QuerySignals {
  const q = query.toLowerCase();
  const yearMatch = q.match(/\b(19|20)\d{2}\b/);
  const requiresAuto = /\bauto\b/.test(q);

  const stopTokens = new Set([
    "bowman",
    "chrome",
    "sapphire",
    "refractor",
    "raywave",
    "wave",
    "blue",
    "red",
    "orange",
    "gold",
    "green",
    "purple",
    "fuchsia",
    "pink",
    "aqua",
    "yellow",
    "neon",
    "chartreuse",
    "black",
    "white",
    "lava",
    "shimmer",
    "atomic",
    "speckle",
    "geometric",
    "lunar",
    "glow",
    "crater",
    "reptilian",
    "reptillian",
    "steel",
    "metal",
    "diamond",
    "mini",
    "pearl",
    "rose",
    "laser",
    "camo",
    "retro",
    "logo",
    "fractor",
    "firefractor",
    "logofractor",
    "packfractor",
    "xfractor",
    "uncirculated",
    "international",
    "hometown",
    "silver",
    "ice",
    "edition",
    "social",
    "media",
    "heritage",
    "gypsy",
    "queen",
    "ginter",
    "archives",
    "tribute",
    "museum",
    "rainbow",
    "foil",
    "holo",
    "acetate",
    "clear",
    "independence",
    "platinum",
    "flagship",
    "prospect",
    "1st",
    "first",
    "auto",
    "autograph",
    "true",
    "superfractor",
    "sky",
    "ink",
    "choice",
    "hta",
    "popcorn",
    "peanuts",
    "peanut",
    "sunflower",
    "seeds",
    "gumball",
  ]);

  const playerTokens = q
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => t.length >= 3)
    .filter((t) => !stopTokens.has(t));

  return {
    year: yearMatch ? yearMatch[0] : null,
    requiresAuto,
    playerTokens,
    productFamily: detectProductFamily(q),
  };
}

function isTitleMatchForQuery(title: string, signals: QuerySignals): boolean {
  const t = title.toLowerCase();

  if (signals.year && !new RegExp(`\\b${signals.year}\\b`).test(t)) {
    return false;
  }

  if (signals.requiresAuto && !/\b(auto|autograph)\b/.test(t)) {
    return false;
  }

  if (signals.playerTokens.length) {
    const playerMatches = signals.playerTokens.filter((token) =>
      new RegExp(`\\b${token}\\b`).test(t),
    );
    if (playerMatches.length < Math.min(2, signals.playerTokens.length)) {
      return false;
    }
  }

  // Product family isolation: reject comps from incompatible product families
  if (signals.productFamily !== "unknown") {
    const titleFamily = detectProductFamily(t);
    if (titleFamily !== "unknown" && !isFamilyCompatible(signals.productFamily, titleFamily)) {
      return false;
    }
  }

  return true;
}

function gradeMultiplier(grade: GradeLabel): number {
  switch (grade) {
    case "psa10":
      return 1.55;
    case "psa9_5":
      return 1.32;
    case "psa9":
      return 1.18;
    case "psa8":
      return 0.92;
    case "bgs9_5":
      return 1.45;
    case "bgs9":
      return 1.15;
    case "sgc10":
      return 1.4;
    case "sgc9":
      return 1.08;
    case "graded_other":
      return 1.1;
    case "raw":
    default:
      return 1.0;
  }
}

function parallelMultiplier(parallel: ParallelLabel): number {
  switch (parallel) {
    case "one_of_one":         return 6.0;
    case "fire_fractor_3":     return 5.0;
    case "food_fractor_5":     return 3.5;  // same scarcity as Red /5
    case "red_5":              return 3.5;
    case "rose_gold_10":       return 2.8;
    case "pearl_10":           return 2.7;
    case "black_10":           return 2.6;
    case "gold_ink_15":        return 2.5;  // on-card sig premium
    case "rose_gold_15":       return 2.5;
    case "pearl_15":           return 2.4;
    case "black_and_white_15": return 2.3;
    case "chartreuse_15":      return 2.3;
    case "black_paper_15":     return 2.3;
    case "orange_25":          return 2.2;
    case "bowman_logo_35":     return 1.85;
    case "gold_50":            return 1.7;
    case "yellow_75":          return 1.3;
    case "pack_fractor_89":    return 1.35;
    case "green_99":           return 1.35;
    case "atomic_100":         return 1.3;
    case "mini_diamond_100":   return 1.3;
    case "steel_metal_100":    return 1.35;
    case "aqua_125":           return 1.25;
    case "raywave":            return 3.5;  // premium visual, market-verified
    case "blue_wave_150":      return 1.2;
    case "blue_150":           return 1.15;
    case "hta_choice_150":     return 1.2;
    case "pink_175":           return 1.1;
    case "fuchsia_199":        return 1.12;
    case "purple_pattern_199": return 1.1;
    case "sapphire_199":       return 1.2;
    case "purple_250":         return 1.0;
    case "speckle_299":        return 0.95;
    case "fuchsia_paper_299":  return 0.92;
    case "wave_350":           return 0.9;
    case "lava_399":           return 0.88;
    case "neon_green_399":     return 0.9;
    case "sky_blue_499":       return 0.88;
    case "refractor_499":      return 0.88;
    case "logo_fractor":       return 1.45;
    case "x_fractor":          return 1.05;
    case "reptilian_base":     return 1.05;
    case "mini_diamond_base":  return 1.05;
    case "lunar_glow":         return 1.05;
    case "camo":               return 0.95;
    case "retro_logo_foil":    return 0.95;
    // 2000-2020 Bowman flagship era
    case "social_media_10":    return 2.5;   // /10 print run, Chrome scarce
    case "black_refractor_99": return 1.65;  // Black /99, visually premium, scarcer than green/atomic
    case "blue_refractor_250": return 1.08;  // Historical Blue /250 (now /150 era)
    case "purple_refractor_199": return 1.12; // Historical Purple /199
    case "wave_refractor":     return 1.1;   // Pattern premium over base refractor
    case "uncirculated_silver": return 1.12; // Hard to find pre-2005 Chrome variant
    case "first_edition":      return 1.15;  // 1st Edition collector premium
    case "gold_paper":         return 1.08;  // Unnumbered paper Gold, modest premium
    case "silver_ice":         return 1.18;  // Distinct texture, unnumbered but visually sharp
    case "red_ice_25":         return 2.0;   // /25 print run, strong scarcity
    case "international":      return 1.05;  // Niche regional collector appeal
    case "state_hometown":     return 1.05;  // Niche collector appeal
    // Topps flagship parallels
    case "platinum_flagship":  return 6.0;   // 1/1
    case "rainbow_foil":       return 2.2;   // Unnumbered holo premium, strong collector demand
    case "clear_flagship":     return 1.3;   // Acetate/clear, visual premium
    case "gold_flagship":      return 1.3;   // Gold /year (e.g., /2026) — moderate premium
    case "black_flagship":     return 1.6;   // Black /75 — scarce
    case "independence_day":   return 1.55;  // /76 — scarce, patriotic premium
    case "green_flagship":     return 1.4;   // Green /99 (flagship)
    case "blue_flagship":      return 1.25;  // Blue /150 (flagship)
    case "purple_flagship":    return 1.2;   // Purple /250 (flagship)
    case "yellow_flagship":    return 1.15;  // Yellow /399 (flagship)
    case "pink_flagship":      return 1.1;   // Pink /800 (flagship)
    // Heritage variations
    case "heritage_real_one":  return 2.5;   // On-card auto premium
    case "heritage_chrome":    return 1.4;   // Chrome stock within Heritage
    case "heritage_black":     return 1.3;   // Black border /50 or /67
    case "heritage_sp":        return 1.6;   // SP scarcity premium
    // Allen & Ginter parallels
    case "ag_wood":            return 5.0;   // Effective 1/1 or very short run
    case "ag_black_mini":      return 2.5;   // Mini Black Border /25
    case "ag_mini":            return 1.2;   // Mini (unnumbered)
    case "ag_back_variant":    return 1.15;  // Back variation (A&G Back, Brooklyn Back, etc.)
    case "chrome_base":
    default:                   return 1.0;
  }
}

function profileMultiplier(profile: CardProfile): number {
  return gradeMultiplier(profile.grade) * parallelMultiplier(profile.parallel);
}

function normalizeToTargetProfile(price: number, compProfile: CardProfile, targetProfile: CardProfile): number {
  const sourceMultiplier = profileMultiplier(compProfile);
  const targetMultiplier = profileMultiplier(targetProfile);
  if (sourceMultiplier <= 0 || targetMultiplier <= 0) return price;
  const ratio = targetMultiplier / sourceMultiplier;

  // Keep normalization in a realistic lane so one misclassified comp cannot explode valuation.
  const boundedRatio = Math.max(0.6, Math.min(1.8, ratio));
  return price * boundedRatio;
}

function toWholeMarketQuery(query: string): string {
  let q = query;
  q = q.replace(/\/\s*\d+/g, " ");
  // Preserve compound tokens before stripping component words
  q = q.replace(/\braywave\b/gi, "RAYWAVE_KEEP");
  q = q.replace(/\bindependence\s*day\b/gi, "INDY_DAY_KEEP");
  q = q.replace(/\brainbow\s*foil\b/gi, "RAINBOW_FOIL_KEEP");
  q = q.replace(/\bholo\s*foil\b/gi, "RAINBOW_FOIL_KEEP");
  q = q.replace(/\breal\s*one\b/gi, "REAL_ONE_KEEP");
  q = q.replace(/\bfire\s*fractor\b/gi, "FIREFRACTOR_KEEP");
  q = q.replace(/\blogo\s*fractor\b/gi, "LOGOFRACTOR_KEEP");
  q = q.replace(/\bpack\s*fractor\b/gi, "PACKFRACTOR_KEEP");
  q = q.replace(/\bx[\s-]fractor\b/gi, "XFRACTOR_KEEP");
  q = q.replace(/\brose\s+gold\b/gi, "ROSEGOLD_KEEP");
  q = q.replace(/\bsteel\s+metal\b/gi, "STEELMETAL_KEEP");
  q = q.replace(/\bneon\s*green\b/gi, "NEONGREEN_KEEP");
  q = q.replace(/\bsky\s*blue\b/gi, "SKYBLUE_KEEP");
  q = q.replace(/\bgold\s+ink\b/gi, "GOLDINK_KEEP");
  q = q.replace(/\bmini[\s-]diamond\b/gi, "MINIDIAMOND_KEEP");
  q = q.replace(/\bblue\s+wave\b/gi, "BLUEWAVE_KEEP");
  // Strip parallel/scarcity terms that pollute player name matching
  q = q.replace(/\b(rainbow|holo|foil|platinum|acetate|independence|flagship)/gi, " ");
  // Strip historical parallel terms
  q = q.replace(/\buncirculated\b/gi, " ");
  q = q.replace(/\b(1st|first)\s+edition\b/gi, " ");
  q = q.replace(/\bsilver\s*ice\b/gi, " ");
  q = q.replace(/\bred\s*ice\b/gi, " ");
  q = q.replace(/\bsocial\s*media\b/gi, " ");
  q = q.replace(/\binternational\b/gi, " ");
  q = q.replace(/\b(state|hometown)\b/gi, " ");
  // Strip all color/parallel/pattern/scarcity words
  q = q.replace(/\b(blue|red|orange|gold|green|purple|sapphire|fuchsia|pink|aqua|yellow|neon|chartreuse|black|white|wave|lava|shimmer|atomic|speckle|geometric|lunar|glow|crater|reptili\w+|superfractor|true\s*1\/1|1\/1|camo|retro|laser|popcorn|peanuts?|sunflower|seeds?|gumball|gum)\b/gi, " ");
  // Restore compound tokens
  q = q.replace(/RAYWAVE_KEEP/g, "raywave");
  q = q.replace(/FIREFRACTOR_KEEP/g, "firefractor");
  q = q.replace(/LOGOFRACTOR_KEEP/g, "logofractor");
  q = q.replace(/PACKFRACTOR_KEEP/g, "packfractor");
  q = q.replace(/XFRACTOR_KEEP/g, "xfractor");
  q = q.replace(/ROSEGOLD_KEEP/g, "rosegold");
  q = q.replace(/STEELMETAL_KEEP/g, "steelmetal");
  q = q.replace(/NEONGREEN_KEEP/g, "neongreen");
  q = q.replace(/SKYBLUE_KEEP/g, "skyblue");
  q = q.replace(/GOLDINK_KEEP/g, "goldink");
  q = q.replace(/MINIDIAMOND_KEEP/g, "minidiamond");
  q = q.replace(/BLUEWAVE_KEEP/g, "bluewave");
  q = q.replace(/INDY_DAY_KEEP/g, "independence day");
  q = q.replace(/RAINBOW_FOIL_KEEP/g, "rainbow foil");
  q = q.replace(/REAL_ONE_KEEP/g, "real one");
  q = q.replace(/\b(psa|bgs|sgc|cgc|hga|csg)\s*[-:]?\s*\d+(?:\.\d+)?\b/gi, " ");
  q = q.replace(/\s+/g, " ").trim();
  if (!/\bauto\b/i.test(q)) q = `${q} auto`;
  return q;
}

function isParallelComparable(target: ParallelLabel, candidate: ParallelLabel): boolean {
  if (target === candidate) return true;
  if (target === "chrome_base") return true;

  // Map each tier to its comparable neighbors
  const comparableMap: Record<ParallelLabel, ParallelLabel[]> = {
    // 1/1 — strict, nothing else comps
    one_of_one: ["one_of_one"],
    // /3 — only comps with red /5
    fire_fractor_3: ["fire_fractor_3", "red_5"],
    // /5 tier — food fractors and red are both /5
    food_fractor_5: ["food_fractor_5", "red_5"],
    red_5: ["red_5", "food_fractor_5", "orange_25"],
    // /10 tier
    rose_gold_10: ["rose_gold_10", "pearl_10", "black_10"],
    pearl_10: ["pearl_10", "rose_gold_10", "black_10"],
    black_10: ["black_10", "rose_gold_10", "pearl_10"],
    // /15 tier
    gold_ink_15: ["gold_ink_15", "rose_gold_15", "pearl_15", "black_and_white_15", "chartreuse_15", "black_paper_15"],
    rose_gold_15: ["rose_gold_15", "gold_ink_15", "pearl_15", "black_and_white_15", "chartreuse_15", "black_paper_15"],
    pearl_15: ["pearl_15", "rose_gold_15", "gold_ink_15", "black_and_white_15", "chartreuse_15", "black_paper_15"],
    black_and_white_15: ["black_and_white_15", "rose_gold_15", "pearl_15", "gold_ink_15", "chartreuse_15", "black_paper_15"],
    chartreuse_15: ["chartreuse_15", "rose_gold_15", "pearl_15", "black_and_white_15", "gold_ink_15", "black_paper_15"],
    black_paper_15: ["black_paper_15", "rose_gold_15", "pearl_15", "black_and_white_15", "chartreuse_15", "gold_ink_15"],
    // /25
    orange_25: ["orange_25", "gold_50", "red_5"],
    // /35
    bowman_logo_35: ["bowman_logo_35"],  // too distinctive for generic comps
    // /50
    gold_50: ["gold_50", "orange_25", "green_99"],
    // /75
    yellow_75: ["yellow_75", "green_99", "pack_fractor_89"],
    // /89
    pack_fractor_89: ["pack_fractor_89", "green_99", "yellow_75"],
    // /99
    green_99: ["green_99", "yellow_75", "pack_fractor_89", "atomic_100", "steel_metal_100"],
    // /100 tier
    atomic_100: ["atomic_100", "mini_diamond_100", "steel_metal_100", "green_99", "aqua_125"],
    mini_diamond_100: ["mini_diamond_100", "atomic_100", "steel_metal_100", "green_99", "aqua_125"],
    steel_metal_100: ["steel_metal_100", "atomic_100", "mini_diamond_100", "green_99"],
    // /125
    aqua_125: ["aqua_125", "atomic_100", "mini_diamond_100", "blue_150", "hta_choice_150"],
    // /150 — raywave is strict (3.5x premium; mixing with blue_150 would destroy accuracy)
    raywave: ["raywave"],
    blue_wave_150: ["blue_wave_150", "blue_150", "hta_choice_150", "aqua_125"],
    blue_150: ["blue_150", "blue_wave_150", "hta_choice_150", "aqua_125"],
    hta_choice_150: ["hta_choice_150", "blue_150", "blue_wave_150"],
    // /175
    pink_175: ["pink_175", "fuchsia_199", "purple_pattern_199"],
    // /199
    fuchsia_199: ["fuchsia_199", "purple_pattern_199", "sapphire_199", "pink_175", "purple_250"],
    purple_pattern_199: ["purple_pattern_199", "fuchsia_199", "sapphire_199", "pink_175"],
    sapphire_199: ["sapphire_199", "fuchsia_199", "purple_pattern_199", "purple_250"],
    // /250
    purple_250: ["purple_250", "sapphire_199", "fuchsia_199", "speckle_299", "fuchsia_paper_299"],
    // /299
    speckle_299: ["speckle_299", "fuchsia_paper_299", "purple_250", "wave_350"],
    fuchsia_paper_299: ["fuchsia_paper_299", "speckle_299", "purple_250"],
    // /350
    wave_350: ["wave_350", "lava_399", "speckle_299", "refractor_499"],
    // /399
    lava_399: ["lava_399", "neon_green_399", "wave_350", "refractor_499", "sky_blue_499"],
    neon_green_399: ["neon_green_399", "lava_399", "sky_blue_499", "refractor_499"],
    // /499
    sky_blue_499: ["sky_blue_499", "refractor_499", "lava_399", "chrome_base"],
    refractor_499: ["refractor_499", "sky_blue_499", "lava_399", "chrome_base"],
    // Unnumbered specialty — logo_fractor too premium for generic comps
    logo_fractor: ["logo_fractor"],
    x_fractor: ["x_fractor", "chrome_base", "refractor_499", "reptilian_base", "mini_diamond_base", "lunar_glow"],
    reptilian_base: ["reptilian_base", "chrome_base", "refractor_499", "x_fractor"],
    mini_diamond_base: ["mini_diamond_base", "chrome_base", "refractor_499", "x_fractor"],
    lunar_glow: ["lunar_glow", "chrome_base", "refractor_499", "x_fractor"],
    camo: ["camo", "chrome_base", "refractor_499"],
    retro_logo_foil: ["retro_logo_foil", "chrome_base"],
    chrome_base: ["chrome_base", "refractor_499", "x_fractor", "reptilian_base", "mini_diamond_base", "lunar_glow", "camo", "retro_logo_foil", "sky_blue_499", "neon_green_399"],
    // 2000-2020 Bowman flagship era
    social_media_10: ["social_media_10", "black_10", "rose_gold_10", "pearl_10"],
    black_refractor_99: ["black_refractor_99", "green_99", "gold_50", "atomic_100"],
    blue_refractor_250: ["blue_refractor_250", "purple_refractor_199", "blue_150", "purple_250", "speckle_299"],
    purple_refractor_199: ["purple_refractor_199", "blue_refractor_250", "purple_250", "fuchsia_199", "sapphire_199"],
    wave_refractor: ["wave_refractor", "chrome_base", "refractor_499", "x_fractor", "blue_wave_150"],
    uncirculated_silver: ["uncirculated_silver", "chrome_base", "first_edition", "gold_paper"],
    first_edition: ["first_edition", "chrome_base", "uncirculated_silver", "gold_paper"],
    gold_paper: ["gold_paper", "chrome_base", "uncirculated_silver", "first_edition", "international", "state_hometown"],
    silver_ice: ["silver_ice", "red_ice_25", "chrome_base"],
    red_ice_25: ["red_ice_25", "orange_25", "silver_ice"],
    international: ["international", "state_hometown", "chrome_base", "gold_paper"],
    state_hometown: ["state_hometown", "international", "chrome_base", "gold_paper"],
    // ── Topps flagship parallels — strict to same-family only ──────────────
    // (product family gate in isTitleMatchForQuery already prevents cross-family
    //  pollution; comparableMap handles within-flagship neighbor tiers)
    platinum_flagship: ["platinum_flagship"],                                        // 1/1
    rainbow_foil:      ["rainbow_foil"],                                             // unnumbered premium, strict
    clear_flagship:    ["clear_flagship", "rainbow_foil"],                          // acetate comps near rainbow
    gold_flagship:     ["gold_flagship", "green_flagship"],                         // /year ≈ /99 scarcity tier
    black_flagship:    ["black_flagship", "independence_day", "green_flagship"],    // /67-75 range
    independence_day:  ["independence_day", "black_flagship"],                       // /76
    green_flagship:    ["green_flagship", "gold_flagship", "black_flagship", "blue_flagship"],
    blue_flagship:     ["blue_flagship", "green_flagship", "purple_flagship"],
    purple_flagship:   ["purple_flagship", "blue_flagship", "yellow_flagship"],
    yellow_flagship:   ["yellow_flagship", "purple_flagship", "pink_flagship"],
    pink_flagship:     ["pink_flagship", "yellow_flagship"],
    // ── Heritage parallels — strict within Heritage ─────────────────────────
    heritage_real_one: ["heritage_real_one"],                                        // on-card auto, strict
    heritage_chrome:   ["heritage_chrome"],                                          // Chrome refractor within Heritage
    heritage_black:    ["heritage_black", "heritage_sp"],                           // Black border, close to SP tier
    heritage_sp:       ["heritage_sp", "heritage_black"],
    // ── Allen & Ginter parallels — strict within A&G ────────────────────────
    ag_wood:           ["ag_wood"],                                                  // effective 1/1
    ag_black_mini:     ["ag_black_mini"],                                            // /25, strict
    ag_mini:           ["ag_mini", "ag_back_variant"],
    ag_back_variant:   ["ag_back_variant", "ag_mini"],
  };

  const allowed = comparableMap[target] ?? [target];
  return allowed.includes(candidate);
}

function profileLabel(profile: CardProfile): string {
  const grade = profile.grade === "raw" ? "raw" : profile.grade.toUpperCase().replace("_", " ");
  const parallelMap: Record<ParallelLabel, string> = {
    one_of_one:         "1/1",
    fire_fractor_3:     "FireFractor /3",
    food_fractor_5:     "Food Fractor /5",
    red_5:              "Red /5",
    rose_gold_10:       "Rose Gold /10",
    pearl_10:           "Pearl /10",
    black_10:           "Black /10",
    gold_ink_15:        "Gold Ink /15",
    rose_gold_15:       "Rose Gold /15",
    pearl_15:           "Pearl /15",
    black_and_white_15: "Black & White /15",
    chartreuse_15:      "Chartreuse /15",
    black_paper_15:     "Black Paper /15",
    orange_25:          "Orange /25",
    bowman_logo_35:     "Bowman LogoFractor /35",
    gold_50:            "Gold /50",
    yellow_75:          "Yellow /75",
    pack_fractor_89:    "PackFractor /89",
    green_99:           "Green /99",
    atomic_100:         "Atomic /100",
    mini_diamond_100:   "Mini-Diamond /100",
    steel_metal_100:    "Steel Metal /100",
    aqua_125:           "Aqua /125",
    raywave:            "RayWave /150",
    blue_wave_150:      "Blue Wave /150",
    blue_150:           "Blue /150",
    hta_choice_150:     "HTA Choice /150",
    pink_175:           "Pink /175",
    fuchsia_199:        "Fuchsia /199",
    purple_pattern_199: "Purple Pattern /199",
    sapphire_199:       "Sapphire /199",
    purple_250:         "Purple /250",
    speckle_299:        "Speckle /299",
    fuchsia_paper_299:  "Fuchsia Paper /299",
    wave_350:           "Wave /350",
    lava_399:           "Lava /399",
    neon_green_399:     "Neon Green /399",
    sky_blue_499:       "Sky Blue /499",
    refractor_499:      "Refractor /499",
    logo_fractor:       "LogoFractor",
    x_fractor:          "X-Fractor",
    reptilian_base:     "Reptilian",
    mini_diamond_base:  "Mini-Diamond",
    lunar_glow:         "Lunar Glow",
    camo:               "Camo",
    retro_logo_foil:    "Retro Logo Foil",
    social_media_10:    "Social Media /10",
    black_refractor_99: "Black Refractor /99",
    blue_refractor_250: "Blue Refractor /250",
    purple_refractor_199: "Purple Refractor /199",
    wave_refractor:     "Wave Refractor",
    uncirculated_silver: "Uncirculated Silver",
    first_edition:      "1st Edition",
    gold_paper:         "Gold Paper",
    silver_ice:         "Silver Ice",
    red_ice_25:         "Red Ice /25",
    international:      "International",
    state_hometown:     "State & Hometown",
    // Topps flagship
    rainbow_foil:       "Rainbow Foil",
    gold_flagship:      "Gold /Year",
    clear_flagship:     "Clear",
    pink_flagship:      "Pink (Flagship)",
    yellow_flagship:    "Yellow (Flagship)",
    purple_flagship:    "Purple (Flagship)",
    blue_flagship:      "Blue (Flagship)",
    green_flagship:     "Green /99 (Flagship)",
    independence_day:   "Independence Day /76",
    black_flagship:     "Black (Flagship)",
    platinum_flagship:  "Platinum 1/1",
    // Heritage
    heritage_chrome:    "Heritage Chrome",
    heritage_black:     "Heritage Black Border",
    heritage_sp:        "Heritage SP",
    heritage_real_one:  "Heritage Real One Auto",
    // Allen & Ginter
    ag_mini:            "A&G Mini",
    ag_black_mini:      "A&G Mini Black Border",
    ag_back_variant:    "A&G Back Variant",
    ag_wood:            "A&G Wood",
    chrome_base:        "Chrome base",
  };
  return `${grade} ${parallelMap[profile.parallel]}`;
}

function medianOf(prices: number[]): number {
  if (!prices.length) return 0;
  const s = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function avgOf(prices: number[]): number {
  if (!prices.length) return 0;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

function stdDevOf(prices: number[]): number {
  if (prices.length < 2) return 0;
  const avg = avgOf(prices);
  return Math.sqrt(prices.reduce((s, p) => s + (p - avg) ** 2, 0) / prices.length);
}

function ageInDays(dateStr: string, now: number): number {
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return 999;
  return (now - t) / DAY_MS;
}

function windowFilter(comps: SoldComp[], maxDays: number, now: number): SoldComp[] {
  return comps.filter((c) => ageInDays(c.date, now) <= maxDays);
}

function windowAvg(comps: SoldComp[], maxDays: number, now: number): number | null {
  const w = windowFilter(comps, maxDays, now);
  return w.length ? parseFloat(avgOf(w.map((c) => c.price)).toFixed(2)) : null;
}

/**
 * IQR-based outlier detection.
 * Items below Q1 - 2.0*IQR or above Q3 + 2.0*IQR are flagged as outliers.
 * Uses a multiplier of 2.0 (vs classic 1.5) to be less aggressive — sports card
 * markets have naturally wide price variance across grades and parallels.
 */
function separateOutliers(comps: SoldComp[]): { clean: SoldComp[]; outliers: OutlierComp[] } {
  if (comps.length < 4) return { clean: comps, outliers: [] };

  const sorted = [...comps].sort((a, b) => a.price - b.price);
  const prices = sorted.map((c) => c.price);
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 2.0 * iqr;
  const hi = q3 + 2.0 * iqr;

  const clean: SoldComp[] = [];
  const outliers: OutlierComp[] = [];

  for (const c of comps) {
    if (c.price < lo) {
      outliers.push({ ...c, reason_ignored_or_reduced: `Price $${c.price} is far below Q1 ($${q1.toFixed(0)}) — possible mislisted, damaged, or non-auto variant` });
    } else if (c.price > hi) {
      outliers.push({ ...c, reason_ignored_or_reduced: `Price $${c.price} exceeds upper fence ($${hi.toFixed(0)}) — possible 1/1, superfractor, hype spike, or mislisted high-end variant` });
    } else {
      clean.push(c);
    }
  }

  // Always keep at least 3 clean comps even if outlier logic removes too many
  if (clean.length < 3 && comps.length >= 3) {
    const byDistance = [...comps].sort((a, b) => {
      const med = medianOf(comps.map((c) => c.price));
      return Math.abs(a.price - med) - Math.abs(b.price - med);
    });
    return { clean: byDistance.slice(0, Math.max(3, Math.floor(comps.length * 0.6))), outliers: [] };
  }

  return { clean, outliers };
}

/**
 * Recency-weighted mean using exponential decay.
 * Half-life = 14 days: a sale from 14 days ago counts ~50% of today's sale.
 */
function recencyWeightedPrice(comps: SoldComp[], now: number, halfLifeDays = 14): number {
  if (!comps.length) return 0;
  let totalWeight = 0;
  let totalValue = 0;
  for (const c of comps) {
    const age = ageInDays(c.date, now);
    const weight = Math.exp((-0.693 * age) / halfLifeDays);
    totalWeight += weight;
    totalValue += c.price * weight;
  }
  return totalWeight > 0 ? totalValue / totalWeight : 0;
}

/**
 * Trend detection: compares the recent window (≤14 days) vs older window (15–90 days).
 * Falls back to 30-day vs older split if recent window is thin.
 */
function detectTrend(
  clean: SoldComp[],
  now: number,
): {
  direction: "up" | "down" | "flat" | "volatile" | "unclear";
  changePercent: number;
  recentCluster: SoldComp[];
  olderCluster: SoldComp[];
} {
  // Try 14-day split first; fall back to 30-day if recent is thin
  let recentCluster = windowFilter(clean, 14, now);
  let olderCluster = clean.filter((c) => ageInDays(c.date, now) > 14);

  if (recentCluster.length < 2) {
    recentCluster = windowFilter(clean, 30, now);
    olderCluster = clean.filter((c) => ageInDays(c.date, now) > 30);
  }

  // Check overall volatility on all clean comps
  const allPrices = clean.map((c) => c.price);
  const cv = allPrices.length > 1 ? stdDevOf(allPrices) / avgOf(allPrices) : 0;

  if (cv > 0.55 && clean.length >= 5) {
    return { direction: "volatile", changePercent: 0, recentCluster, olderCluster };
  }

  if (!recentCluster.length || !olderCluster.length) {
    return { direction: "unclear", changePercent: 0, recentCluster, olderCluster };
  }

  const recentMed = medianOf(recentCluster.map((c) => c.price));
  const olderMed = medianOf(olderCluster.map((c) => c.price));
  const changePercent = ((recentMed - olderMed) / olderMed) * 100;

  // Short-term momentum check: detect reversals by comparing last 7d vs last 14d medians.
  const last7 = windowFilter(clean, 7, now);
  const last14 = windowFilter(clean, 14, now);
  const momentumPercent =
    last7.length >= 4 && last14.length >= 8
      ? ((medianOf(last7.map((c) => c.price)) - medianOf(last14.map((c) => c.price))) /
          Math.max(1, medianOf(last14.map((c) => c.price)))) *
        100
      : 0;

  let direction: "up" | "down" | "flat" | "volatile" | "unclear";
  if (changePercent > 10) direction = "up";
  else if (changePercent < -10) direction = "down";
  else direction = "flat";

  // If 7-day momentum strongly conflicts with longer comparison, trust the momentum lane.
  if (momentumPercent >= 8) {
    return {
      direction: "up",
      changePercent: momentumPercent,
      recentCluster: last7.length ? last7 : recentCluster,
      olderCluster,
    };
  }
  if (momentumPercent <= -8) {
    return {
      direction: "down",
      changePercent: momentumPercent,
      recentCluster: last7.length ? last7 : recentCluster,
      olderCluster,
    };
  }

  return { direction, changePercent, recentCluster, olderCluster };
}

/**
 * Apply a momentum premium/discount on top of a direction-selected base price.
 *
 * Since the base is already selected correctly for the trend direction
 * (highest recent comp for up, recent median for down, all-clean median for flat),
 * these adjustments are intentionally small — they represent momentum conviction,
 * not the primary direction shift.
 *
 * Up   → +3–12% momentum premium (base is already the highest recent comp)
 * Down → −3–10% further discount  (base is already the recent lower median)
 * Flat / unclear → no adjustment
 * Volatile → small uncertainty discount (median base already damped)
 */
function applyTrendMultiplier(
  basePrice: number,
  direction: "up" | "down" | "flat" | "volatile" | "unclear",
  changePercent: number,
): number {
  switch (direction) {
    case "up": {
      // Base is already the highest valid recent comp; add conviction premium.
      const momentum = Math.min(0.12, Math.abs(changePercent) / 100 * 0.45);
      return basePrice * (1 + Math.max(0.03, momentum));
    }
    case "down": {
      // Base is already the recent lower median; small additional decay.
      const decay = Math.min(0.10, Math.abs(changePercent) / 100 * 0.35);
      return basePrice * (1 - Math.max(0.03, decay));
    }
    case "volatile":
      // Uncertainty discount on top of median base.
      return basePrice * 0.96;
    case "flat":
    case "unclear":
    default:
      return basePrice;
  }
}

// ─── Apify fetch ──────────────────────────────────────────────────────────────

async function fetchEbaySoldData(query: string): Promise<SoldComp[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.warn("[compiqSearch] APIFY_TOKEN not set — skipping live fetch");
    return [];
  }

  try {
    const url =
      "https://api.apify.com/v2/acts/caffein.dev~ebay-sold-listings/run-sync-get-dataset-items" +
      `?token=${token}&timeout=55&memory=512`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: [query],
        count: 30,
        daysToScrape: 90,
        ebaySite: "ebay.com",
        sortOrder: "endedRecently",
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[compiqSearch] Apify responded ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return [];

    const rawPrices = data
      .map((item) => parseFloat(String(item.soldPrice ?? "0")))
      .filter((p) => p > 0);

    // Apify sometimes returns prices in cents (integers) instead of dollars.
    // If the median parsed price is > $5000, treat all prices as cents and divide by 100.
    const sortedRaw = [...rawPrices].sort((a, b) => a - b);
    const medianRaw = sortedRaw.length ? sortedRaw[Math.floor(sortedRaw.length / 2)] : 0;
    const inCents = medianRaw > 5000;

    return data
      .filter((item) => parseFloat(String(item.soldPrice ?? "0")) > 0)
      .map((item) => ({
        price: parseFloat((parseFloat(String(item.soldPrice)) / (inCents ? 100 : 1)).toFixed(2)),
        title: (item.title as string) || "",
        date: (item.endedAt as string) || "",
        url: (item.url as string) || "",
      }));
  } catch (err) {
    console.warn("[compiqSearch] Apify fetch failed:", (err as Error).message);
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function searchAndPrice(query: string): Promise<CardSearchResult> {
  const now = Date.now();
  const querySignals = buildQuerySignals(query);
  const rawComps = await fetchEbaySoldData(query);

  if (!rawComps.length) {
    const emptyTrend: TrendAnalysis = {
      market_direction: "unclear",
      recent_sales_pattern: "No sales data available",
      older_sales_pattern: "No sales data available",
      change_from_older_to_recent: "N/A",
      liquidity: "low",
      trend_confidence: 0,
      windows: {
        last7: { count: 0, avgPrice: null },
        last14: { count: 0, avgPrice: null },
        last30: { count: 0, avgPrice: null },
        last60: { count: 0, avgPrice: null },
        last90: { count: 0, avgPrice: null },
      },
    };
    return {
      success: true,
      query,
      summary: "No recent eBay sales found for this query. Try a more specific search.",
      marketTier: { value: 0, high: 0 },
      buyZone: [0, 0],
      holdZone: [0, 0],
      sellZone: [0, 0],
      recentComps: [],
      outliers: [],
      trendAnalysis: emptyTrend,
      supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
      confidence: 0,
      source: "live",
      valuationMethod: "trend-based",
      gradeTierUsed: "none",
      marketTrendOverall: {
        queryUsed: toWholeMarketQuery(query),
        sampleSize: 0,
        trend: emptyTrend,
      },
      lastDirectComp: null,
      nextSaleEstimate: 0,
      anchorAnalysis: {
        anchorPrice: 0,
        anchorRawPrice: 0,
        anchorAge: 0,
        surroundingMovement: "flat" as const,
        surroundingChangePercent: 0,
        stalenessWeight: 0,
        reasoning: "No sales data available.",
      },
      compRange: { low: 0, high: 0, median: 0 },
      recommendation: "hold" as const,
      keyRisks: ["No recent eBay sales found — cannot estimate value"],
    };
  }

  // Tag each comp with detected attributes
  const taggedComps: SoldComp[] = rawComps
    .filter((c) => isTitleMatchForQuery(c.title, querySignals))
    .map((c) => ({
      ...c,
      grade: detectGrade(c.title),
      parallel: detectParallel(c.title),
    }));

  if (!taggedComps.length) {
    const emptyTrend: TrendAnalysis = {
      market_direction: "unclear",
      recent_sales_pattern: "No query-matching sales data available",
      older_sales_pattern: "No query-matching sales data available",
      change_from_older_to_recent: "N/A",
      liquidity: "low",
      trend_confidence: 0,
      windows: {
        last7: { count: 0, avgPrice: null },
        last14: { count: 0, avgPrice: null },
        last30: { count: 0, avgPrice: null },
        last60: { count: 0, avgPrice: null },
        last90: { count: 0, avgPrice: null },
      },
    };
    return {
      success: true,
      query,
      summary: "No recent eBay sales matched this exact card profile. Try relaxing grade/parallel filters.",
      marketTier: { value: 0, high: 0 },
      buyZone: [0, 0],
      holdZone: [0, 0],
      sellZone: [0, 0],
      recentComps: [],
      outliers: [],
      trendAnalysis: emptyTrend,
      supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
      confidence: 0,
      source: "live",
      valuationMethod: "trend-based",
      gradeTierUsed: "none",
      marketTrendOverall: {
        queryUsed: toWholeMarketQuery(query),
        sampleSize: 0,
        trend: emptyTrend,
      },
      lastDirectComp: null,
      nextSaleEstimate: 0,
      anchorAnalysis: {
        anchorPrice: 0,
        anchorRawPrice: 0,
        anchorAge: 0,
        surroundingMovement: "flat" as const,
        surroundingChangePercent: 0,
        stalenessWeight: 0,
        reasoning: "No query-matching sales data available.",
      },
      compRange: { low: 0, high: 0, median: 0 },
      recommendation: "hold" as const,
      keyRisks: ["No query-matching eBay sales found — cannot estimate value"],
    };
  }

  // Sort newest first
  const sorted = [...taggedComps].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  // Target profile inferred from query (used for normalization)
  const targetProfile = parseCardProfile(query);
  const gradeTierUsed = targetProfile.grade;

  // Whole-market lane: broaden query to capture overall player+set auto trend.
  const overallQuery = toWholeMarketQuery(query);
  const overallRaw =
    overallQuery.toLowerCase() === query.toLowerCase()
      ? rawComps
      : await fetchEbaySoldData(overallQuery);

  // Normalize all comps into target-profile equivalents (single-card fair market lane)
  const normalizedComps: SoldComp[] = sorted.map((c) => {
    const compProfile: CardProfile = {
      grade: (c.grade as GradeLabel) ?? "raw",
      parallel: (c.parallel as ParallelLabel) ?? "chrome_base",
    };
    const normalizedPrice = parseFloat(
      normalizeToTargetProfile(c.price, compProfile, targetProfile).toFixed(2),
    );
    return {
      ...c,
      normalizedPrice,
      price: normalizedPrice,
    };
  });

  const targetExplicitParallel =
    targetProfile.parallel !== "chrome_base" || /\/\s*\d+|\b(blue|gold|orange|red|green|purple|sapphire|refractor|raywave)\b/i.test(query);

  const comparableLane = normalizedComps.filter((c) =>
    isParallelComparable(
      targetProfile.parallel,
      ((c.parallel as ParallelLabel) ?? "chrome_base") as ParallelLabel,
    ),
  );

  const exactParallelLane = normalizedComps.filter(
    (c) => (((c.parallel as ParallelLabel) ?? "chrome_base") as ParallelLabel) === targetProfile.parallel,
  );

  const specificTrendPool = targetExplicitParallel
    ? exactParallelLane.length >= 4
      ? exactParallelLane
      : comparableLane.length >= 8
        ? comparableLane
        : normalizedComps
    : normalizedComps;

  // Separate outliers from normalized comp values
  const { clean, outliers } = separateOutliers(specificTrendPool);

  // Trend detection on clean comps
  const { direction, changePercent, recentCluster, olderCluster } = detectTrend(clean, now);

  // ── Direction-aware base price selection ─────────────────────────────────
  // Comps show what already happened. Trend tells us how to weight those comps.
  // Median of all clean comps (fallback baseline)
  const medianAllClean = medianOf(clean.map((c) => c.price));

  // Overall market trend (computed early so it can blend into final value)
  const overallTagged = overallRaw
    .filter((c) => isTitleMatchForQuery(c.title, querySignals))
    .map((c) => ({
      ...c,
      grade: detectGrade(c.title),
      parallel: detectParallel(c.title),
    }));
  const overallBaseProfile: CardProfile = { grade: "raw", parallel: "chrome_base" };
  const overallNormalized = overallTagged.map((c) => {
    const compProfile: CardProfile = {
      grade: (c.grade as GradeLabel) ?? "raw",
      parallel: (c.parallel as ParallelLabel) ?? "chrome_base",
    };
    return {
      ...c,
      price: parseFloat(normalizeToTargetProfile(c.price, compProfile, overallBaseProfile).toFixed(2)),
    };
  });
  const { clean: overallClean } = separateOutliers(overallNormalized);
  const {
    direction: overallDirection,
    changePercent: overallChangePercent,
    recentCluster: overallRecentCluster,
    olderCluster: overallOlderCluster,
  } = detectTrend(overallClean, now);

  // Historical median in normalized-target terms (sanity check only, not the primary value)
  const historicalMedian = medianOf(specificTrendPool.map((c) => c.price));

  // Window stats
  const w7 = windowFilter(clean, 7, now);
  const w14 = windowFilter(clean, 14, now);
  const w30 = windowFilter(clean, 30, now);
  const w60 = windowFilter(clean, 60, now);
  const w90 = windowFilter(clean, 90, now);

  // Liquidity
  const liquidity: "high" | "medium" | "low" =
    clean.length >= 15 ? "high" : clean.length >= 6 ? "medium" : "low";

  // Trend confidence: more sales + split between windows = more confident
  const hasBothClusters = recentCluster.length >= 2 && olderCluster.length >= 2;
  const rawTrendConf =
    (Math.min(clean.length, 20) / 20) * 0.6 + (hasBothClusters ? 0.4 : 0.1);
  const trendConfidence = parseFloat(Math.min(0.95, rawTrendConf).toFixed(2));

  // Confidence for the iOS display value
  const displayConfidence =
    liquidity === "high" && hasBothClusters
      ? 0.85
      : liquidity === "medium" || hasBothClusters
        ? 0.65
        : 0.4;

  // Pricing tiers
  // ── Last direct comp (anchor) ─────────────────────────────────────────────
  // The most recent clean comp is the anchor for estimating the next sale.
  // Normalized price is used for math; original price stored for display.
  const cleanUrls = new Set(clean.map((c) => c.url));
  const recentCleanRaw = sorted.filter((c) => cleanUrls.has(c.url));
  const anchorRaw = recentCleanRaw[0] ?? null;
  const anchorPrice = clean.length
    ? clean.slice().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0].price
    : medianAllClean;
  const anchorRawPrice = anchorRaw ? anchorRaw.price : anchorPrice;
  const anchorAge = anchorRaw ? ageInDays(anchorRaw.date, now) : 999;
  const anchorTimestamp = anchorRaw ? new Date(anchorRaw.date).getTime() : now;
  const lastDirectComp: CardSearchResult["lastDirectComp"] = anchorRaw
    ? {
        price: anchorRaw.price,
        normalizedPrice: anchorPrice,
        date: anchorRaw.date,
        ageInDays: parseFloat(anchorAge.toFixed(1)),
        title: anchorRaw.title,
      }
    : null;

  // ── Surrounding market movement since the anchor ──────────────────────────
  // Split the overall card market (base, refractors, nearby parallels) at the
  // anchor date. Post-anchor comps show where the market went after the last
  // direct sale. Pre-anchor comps are the baseline.
  const surroundingAfterAnchor = overallClean.filter(
    (c) => new Date(c.date).getTime() > anchorTimestamp,
  );
  const surroundingAtAnchor = overallClean
    .filter((c) => new Date(c.date).getTime() <= anchorTimestamp)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 12);

  let surroundingMovement: "up" | "flat" | "down" = "flat";
  let surroundingChangePercent = 0;
  let surroundingReasoning: string;

  if (surroundingAfterAnchor.length >= 3 && surroundingAtAnchor.length >= 2) {
    const afterAvg = avgOf(surroundingAfterAnchor.map((c) => c.price));
    const atAvg = avgOf(surroundingAtAnchor.map((c) => c.price));
    surroundingChangePercent = ((afterAvg - atAvg) / Math.max(1, atAvg)) * 100;
    if (surroundingChangePercent > 8) {
      surroundingMovement = "up";
      surroundingReasoning =
        `Surrounding market (base, refractors, nearby parallels) is up ` +
        `+${surroundingChangePercent.toFixed(1)}% since the last direct comp ` +
        `(${surroundingAfterAnchor.length} surrounding sales after anchor). ` +
        `Next sale should be above the normalized anchor of $${anchorPrice.toFixed(0)}.`;
    } else if (surroundingChangePercent < -8) {
      surroundingMovement = "down";
      surroundingReasoning =
        `Surrounding market has declined ${surroundingChangePercent.toFixed(1)}% since the last direct comp ` +
        `(${surroundingAfterAnchor.length} surrounding sales after anchor). ` +
        `Next sale may come in below the normalized anchor of $${anchorPrice.toFixed(0)}.`;
    } else {
      surroundingReasoning =
        `Surrounding market is flat ` +
        `(${surroundingChangePercent > 0 ? "+" : ""}${surroundingChangePercent.toFixed(1)}%) ` +
        `since the last direct comp. Next sale should land near the normalized anchor of $${anchorPrice.toFixed(0)}.`;
    }
  } else if (overallClean.length >= 5) {
    surroundingMovement = overallDirection === "up" ? "up" : overallDirection === "down" ? "down" : "flat";
    surroundingChangePercent = overallChangePercent;
    surroundingReasoning =
      `Insufficient post-anchor surrounding comps. Overall market trend: ` +
      `${overallDirection} (${overallChangePercent > 0 ? "+" : ""}${overallChangePercent.toFixed(1)}%). ` +
      `${surroundingMovement === "up"
        ? "Next sale should be near or above the last direct comp."
        : surroundingMovement === "down"
          ? "Next sale may come in below the last direct comp."
          : "Next sale should be near the last direct comp."}`;
  } else {
    surroundingReasoning = `Not enough surrounding market data. Using normalized anchor of $${anchorPrice.toFixed(0)} as-is.`;
  }

  // ── Staleness weight ──────────────────────────────────────────────────────
  // Fresh anchor: surrounding adjustment is minimal — anchor is current.
  // Stale anchor: surrounding market corrects for the time that has passed.
  //   0d → 0%   14d → ~12%   30d → ~27%   60d → ~54%   90d → ~80%
  const stalenessWeight = Math.min(0.80, anchorAge / 112);

  // ── Next sale estimate ────────────────────────────────────────────────────
  // Anchor adjusted by surrounding market movement, scaled by how stale the anchor is.
  let surroundingAdjPercent = 0;
  if (surroundingMovement === "up") {
    surroundingAdjPercent = Math.min(surroundingChangePercent * 0.55, 30);
  } else if (surroundingMovement === "down") {
    surroundingAdjPercent = Math.max(surroundingChangePercent * 0.55, -25);
  }
  const nextSaleEstimate = parseFloat(
    (anchorPrice * (1 + (surroundingAdjPercent / 100) * stalenessWeight)).toFixed(2),
  );
  const value = nextSaleEstimate;

  // High: highest actual raw sale in the clean pool (premium / sell ceiling)
  const high = recentCleanRaw.length
    ? parseFloat(Math.max(...recentCleanRaw.map((c) => c.price)).toFixed(2))
    : parseFloat((value * 1.25).toFixed(2));

  // Comp range from clean normalized pool
  const cleanPrices = clean.map((c) => c.price);
  const compRange = {
    low: parseFloat(Math.min(...cleanPrices).toFixed(2)),
    high: parseFloat(Math.max(...cleanPrices).toFixed(2)),
    median: parseFloat(medianAllClean.toFixed(2)),
  };

  // Buy / hold / sell zones
  const buyZone: [number, number] = [
    parseFloat((value * 0.82).toFixed(2)),
    parseFloat((value * 0.93).toFixed(2)),
  ];
  const holdZone: [number, number] = [
    parseFloat((value * 0.93).toFixed(2)),
    parseFloat((value * 1.10).toFixed(2)),
  ];
  const sellZone: [number, number] = [
    parseFloat((value * 1.05).toFixed(2)),
    parseFloat((value * 1.25).toFixed(2)),
  ];

  // Recommendation: hold if market is up or flat; move if market is declining and anchor is fresh
  const recommendation: "hold" | "move" =
    surroundingMovement === "down" && anchorAge < 30 ? "move" : "hold";

  // Key risks
  const keyRisks: string[] = [];
  if (anchorAge > 45) keyRisks.push(`Last direct comp is ${Math.round(anchorAge)}d old — market may have shifted`);
  if (clean.length < 4) keyRisks.push(`Thin comp pool (${clean.length} clean comps) — higher uncertainty`);
  if (direction === "volatile") keyRisks.push("Volatile pricing — wide bid/ask spread likely");
  if (liquidity === "low") keyRisks.push("Low liquidity — may need aggressive pricing to sell");
  if (surroundingMovement === "down") keyRisks.push("Surrounding card market declining — next sale may undershoot anchor");
  if (overallClean.length < 4) keyRisks.push("Limited surrounding market data — trend signal is weak");

  // Narrative patterns
  const recentAvg = recentCluster.length ? avgOf(recentCluster.map((c) => c.price)) : null;
  const olderAvg = olderCluster.length ? avgOf(olderCluster.map((c) => c.price)) : null;

  const recentPattern =
    recentCluster.length >= 2
      ? `${recentCluster.length} sales averaging $${recentAvg!.toFixed(0)}`
      : recentCluster.length === 1
        ? `1 recent sale at $${recentCluster[0].price}`
        : "No recent sales in comparison window";

  const olderPattern =
    olderCluster.length >= 2
      ? `${olderCluster.length} older sales averaging $${olderAvg!.toFixed(0)}`
      : olderCluster.length === 1
        ? `1 older sale at $${olderCluster[0].price}`
        : "No older sales in comparison window";

  const changeDesc =
    direction === "unclear" || !recentAvg || !olderAvg
      ? "Insufficient data for trend comparison"
      : `${changePercent > 0 ? "+" : ""}${changePercent.toFixed(1)}% vs older sales cluster`;

  // Plain-English summary (trend-based, not median-based)
  const confLabel = displayConfidence >= 0.8 ? "High" : displayConfidence >= 0.6 ? "Medium" : "Low";
  const anchorAgeStr = anchorAge < 1 ? "today" : anchorAge < 2 ? "yesterday" : `${Math.round(anchorAge)}d ago`;
  const hasAnchorNormalizationGap = Math.abs(anchorRawPrice - anchorPrice) >= 1;
  const anchorSummary = hasAnchorNormalizationGap
    ? `$${anchorRawPrice.toFixed(0)} raw ($${anchorPrice.toFixed(0)} normalized)`
    : `$${anchorPrice.toFixed(0)}`;
  const surroundingDirLabel = surroundingMovement === "flat"
    ? "flat"
    : `${surroundingMovement} ${Math.abs(surroundingChangePercent).toFixed(0)}%`;
  const summary =
    `Last direct comp: ${anchorSummary} (${anchorAgeStr}). ` +
    `Clean comp range: $${compRange.low.toFixed(0)}–$${compRange.high.toFixed(0)} (median $${compRange.median.toFixed(0)}). ` +
    `Related card trend: ${surroundingDirLabel} since last comp. ` +
    `Market direction: ${direction}. ` +
    `Most likely next sale: $${nextSaleEstimate.toFixed(0)}. ` +
    `Buy below $${buyZone[1].toFixed(0)}, sell above $${sellZone[0].toFixed(0)}. ` +
    `Recommendation: ${recommendation === "hold" ? "Hold" : "Move"}. ` +
    `Confidence: ${confLabel}. ` +
    (keyRisks.length ? `Key risk: ${keyRisks[0]}. ` : "") +
    surroundingReasoning +
    ` Overall market (${overallQuery}): ${overallDirection} (${overallChangePercent > 0 ? "+" : ""}${overallChangePercent.toFixed(1)}%).`;

  const trendAnalysis: TrendAnalysis = {
    market_direction: direction,
    recent_sales_pattern: recentPattern,
    older_sales_pattern: olderPattern,
    change_from_older_to_recent: changeDesc,
    liquidity,
    trend_confidence: trendConfidence,
    windows: {
      last7: { count: w7.length, avgPrice: w7.length ? parseFloat(avgOf(w7.map((c) => c.price)).toFixed(2)) : null },
      last14: { count: w14.length, avgPrice: w14.length ? parseFloat(avgOf(w14.map((c) => c.price)).toFixed(2)) : null },
      last30: { count: w30.length, avgPrice: w30.length ? parseFloat(avgOf(w30.map((c) => c.price)).toFixed(2)) : null },
      last60: { count: w60.length, avgPrice: w60.length ? parseFloat(avgOf(w60.map((c) => c.price)).toFixed(2)) : null },
      last90: { count: w90.length, avgPrice: w90.length ? parseFloat(avgOf(w90.map((c) => c.price)).toFixed(2)) : null },
    },
  };

  const overallRecentAvg = overallRecentCluster.length ? avgOf(overallRecentCluster.map((c) => c.price)) : null;
  const overallOlderAvg = overallOlderCluster.length ? avgOf(overallOlderCluster.map((c) => c.price)) : null;
  const overallRecentPattern =
    overallRecentCluster.length >= 2
      ? `${overallRecentCluster.length} sales averaging $${overallRecentAvg!.toFixed(0)}`
      : overallRecentCluster.length === 1
        ? `1 recent sale at $${overallRecentCluster[0].price}`
        : "No recent sales in comparison window";
  const overallOlderPattern =
    overallOlderCluster.length >= 2
      ? `${overallOlderCluster.length} older sales averaging $${overallOlderAvg!.toFixed(0)}`
      : overallOlderCluster.length === 1
        ? `1 older sale at $${overallOlderCluster[0].price}`
        : "No older sales in comparison window";
  const overallChangeDesc =
    overallDirection === "unclear" || !overallRecentAvg || !overallOlderAvg
      ? "Insufficient data for trend comparison"
      : `${overallChangePercent > 0 ? "+" : ""}${overallChangePercent.toFixed(1)}% vs older sales cluster`;
  const overallLiquidity: "high" | "medium" | "low" =
    overallClean.length >= 15 ? "high" : overallClean.length >= 6 ? "medium" : "low";
  const overallHasBothClusters = overallRecentCluster.length >= 2 && overallOlderCluster.length >= 2;
  const overallTrendConfidence = parseFloat(
    Math.min(0.95, (Math.min(overallClean.length, 20) / 20) * 0.6 + (overallHasBothClusters ? 0.4 : 0.1)).toFixed(2),
  );
  const overallW7 = windowFilter(overallClean, 7, now);
  const overallW14 = windowFilter(overallClean, 14, now);
  const overallW30 = windowFilter(overallClean, 30, now);
  const overallW60 = windowFilter(overallClean, 60, now);
  const overallW90 = windowFilter(overallClean, 90, now);
  const overallTrend: TrendAnalysis = {
    market_direction: overallDirection,
    recent_sales_pattern: overallRecentPattern,
    older_sales_pattern: overallOlderPattern,
    change_from_older_to_recent: overallChangeDesc,
    liquidity: overallLiquidity,
    trend_confidence: overallTrendConfidence,
    windows: {
      last7: { count: overallW7.length, avgPrice: overallW7.length ? parseFloat(avgOf(overallW7.map((c) => c.price)).toFixed(2)) : null },
      last14: { count: overallW14.length, avgPrice: overallW14.length ? parseFloat(avgOf(overallW14.map((c) => c.price)).toFixed(2)) : null },
      last30: { count: overallW30.length, avgPrice: overallW30.length ? parseFloat(avgOf(overallW30.map((c) => c.price)).toFixed(2)) : null },
      last60: { count: overallW60.length, avgPrice: overallW60.length ? parseFloat(avgOf(overallW60.map((c) => c.price)).toFixed(2)) : null },
      last90: { count: overallW90.length, avgPrice: overallW90.length ? parseFloat(avgOf(overallW90.map((c) => c.price)).toFixed(2)) : null },
    },
  };

  const cleanByUrl = new Map(clean.map((c) => [c.url, c]));
  const recentComps = recentCleanRaw
    .slice(0, 10)
    .map((c) => ({
      ...c,
      normalizedPrice: cleanByUrl.get(c.url)?.price,
    }));

  return {
    success: true,
    query,
    summary,
    marketTier: { value, high },
    buyZone,
    holdZone,
    sellZone,
    recentComps,
    outliers,
    trendAnalysis,
    supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
    confidence: displayConfidence,
    source: "live",
    valuationMethod: "trend-based",
    gradeTierUsed,
    marketTrendOverall: {
      queryUsed: overallQuery,
      sampleSize: overallClean.length,
      trend: overallTrend,
    },
    lastDirectComp,
    nextSaleEstimate,
    anchorAnalysis: {
      anchorPrice,
      anchorRawPrice,
      anchorAge: parseFloat(anchorAge.toFixed(1)),
      surroundingMovement,
      surroundingChangePercent: parseFloat(surroundingChangePercent.toFixed(1)),
      stalenessWeight: parseFloat(stalenessWeight.toFixed(2)),
      reasoning: surroundingReasoning,
    },
    compRange,
    recommendation,
    keyRisks,
  };
}
