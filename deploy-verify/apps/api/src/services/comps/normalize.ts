import type { RawApifyListing, NormalizedComp } from "../../types/comps";


// Helper: Extract player name and set name from title using heuristics
// Enhanced: Extract player name and set name from title using robust heuristics
function extractPlayerAndSet(title: string): { playerName: string | null; cardSet: string | null } {
  // Remove grading, parallel, and extraneous info for cleaner parsing
  let cleanTitle = title
    .replace(/\b(PSA|BGS|SGC|CSG|HGA|CGC|GAI|KSA|Beckett|GMA|ISA|PGI|RCG|ACE)\b/gi, "")
    .replace(/\b(\d{1,2}\/\d{1,4}|#\s?\w+|No\.?\s?\w+)\b/gi, "")
    .replace(/\b(auto(graph)?|refractor|prizm|parallel|numbered|raw|mint|gem|authentic|rookie|rc|variation|insert|sp|ssp|case hit|short print|pop|pop1|pop 1|pop2|pop 2|error|variation|lot|set|team|jersey|patch|auto|autograph|signed|signature|sig|on card|sticker|graded|ungraded|uncirculated|encased|slabbed|bounty|buyback|promo|sample|test)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Remove year
  cleanTitle = cleanTitle.replace(/\b(19|20)\d{2}\b/, "").trim();

  // Try to extract set and player using heuristics
  // Heuristic 1: [Set Name] [Player Name] (Player is usually last 2-3 words)
  const words = cleanTitle.split(" ");
  let playerName: string | null = null;
  let cardSet: string | null = null;
  if (words.length >= 3) {
    // Try last 2 or 3 words as player name
    for (let n = 3; n >= 2; n--) {
      const candidate = words.slice(-n).join(" ");
      // Player name: at least one capitalized word, not all uppercase
      if (/([A-Z][a-z]+\s?){1,3}/.test(candidate) && !/^[A-Z\s]+$/.test(candidate)) {
        playerName = candidate.trim();
        cardSet = words.slice(0, -n).join(" ").trim();
        break;
      }
    }
  }
  // Fallback: if not found, try to use all but first word as player, first as set
  if (!playerName && words.length >= 2) {
    playerName = words.slice(1).join(" ").trim();
    cardSet = typeof words[0] === "string" ? words[0] : null;
    if (typeof cardSet === 'undefined') cardSet = null;
  }
  // Fallback: if still not found, return nulls
  if (!playerName || !cardSet) {
    playerName = null;
    cardSet = null;
  }
  return { playerName, cardSet };
}

// Helper: Detect grader from title or listing fields (expanded)
// Expanded: Detect grader from title or listing fields (modular)
const GRADERS = [
  "PSA", "BGS", "SGC", "CSG", "HGA", "CGC", "GAI", "KSA", "Beckett", "GMA", "ISA", "PGI", "RCG", "ACE"
];
function detectGrader(title: string): string | null {
  for (const grader of GRADERS) {
    if (new RegExp(`\\b${grader}\\b`, "i").test(title)) return grader.toUpperCase();
  }
  // Heuristic: "raw", "ungraded", "authentic", "hand cut", "altered"
  if (/\b(raw|ungraded|authentic|hand ?cut|altered)\b/i.test(title)) return "RAW";
  return null;
}

// Helper: Detect grade from title (expanded)
// Expanded: Detect grade from title (modular, ambiguous cases)
function detectGrade(title: string): string | null {
  // Support: PSA 10, BGS 9.5, SGC 10, CSG 9, HGA 10, etc.
  const match = title.match(/(PSA|BGS|SGC|CSG|HGA|CGC|GAI|KSA|Beckett|GMA|ISA|PGI|RCG|ACE)[ -]?(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1|AUTH|A|NM|MT|MINT|GEM|PRISTINE|EX|VG|GOOD|FAIR|POOR)/i);
  if (match) {
    // Normalize: "PSA 10", "BGS 9.5", etc.
    return match[0].replace(/-/g, " ").toUpperCase();
  }
  // Heuristic: "raw", "ungraded", "authentic", "hand cut", "altered"
  if (/\b(raw|ungraded|authentic|hand ?cut|altered)\b/i.test(title)) return "RAW";
  // Heuristic: "NM-MT", "GEM MINT", "PRISTINE", "EX", "VG", etc.
  const text = title.toUpperCase();
  if (/\bGEM ?MINT\b/.test(text)) return "GEM MINT";
  if (/\bPRISTINE\b/.test(text)) return "PRISTINE";
  if (/\bNM[- ]?MT\b/.test(text)) return "NM-MT";
  if (/\bEX[- ]?MT\b/.test(text)) return "EX-MT";
  if (/\bEX\b/.test(text)) return "EX";
  if (/\bVG\b/.test(text)) return "VG";
  if (/\bGOOD\b/.test(text)) return "GOOD";
  if (/\bFAIR\b/.test(text)) return "FAIR";
  if (/\bPOOR\b/.test(text)) return "POOR";
  return null;
}

// Helper: Detect if card is an autograph.
function detectIsAuto(title: string): boolean {
  return /\bauto(graph)?\b/i.test(title);
}

// Helper: Detect if card is numbered (e.g., /99, /25).
function detectIsNumbered(title: string): boolean {
  return /\/\d{1,4}/.test(title);
}

// Helper: Extract serial number if present (e.g., 12/99).
function detectSerialNumber(title: string): string | null {
  const match = title.match(/(\d{1,4}\/\d{1,4})/);
  return match ? match[0] : null;
}

// Helper: Attempt to parse year (e.g., 2019, 2020).
function detectYear(title: string): number | null {
  const match = title.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

// Helper: Attempt to parse card number (e.g., #123, No. 45).
function detectCardNumber(title: string): string | null {
  const match = title.match(/#\s?(\w+)|No\.?\s?(\w+)/i);
  if (match) return match[1] || match[2] || null;
  return null;
}

// Helper: Detect parallel/color/variant keywords (modular, extensible)
export const PARALLELS: string[] = [
  // Colors
  "blue", "red", "green", "gold", "orange", "purple", "pink", "yellow", "bronze", "silver", "black", "white", "aqua", "teal", "fuchsia", "ruby", "rose", "sepia", "platinum", "carbon",
  // Patterns/Effects
  "refractor", "prizm", "prism", "mojo", "shimmer", "raywave", "speckle", "mini diamond", "crystal", "ice", "wave", "checkerboard", "checker", "zebra", "tiger", "leopard", "plaid", "dots", "bubbles", "confetti", "diamond", "star", "stars", "galactic", "nebula", "cosmic", "holo", "hologram", "rainbow", "cracked ice", "mosaic", "swirl", "scope", "pulsar", "sunburst", "flash", "laser", "optic", "velocity", "hyper", "atomic", "chrome",
  // Serial/Numbered
  "numbered", "serial", "1/1", "one of one", "/5", "/10", "/25", "/50", "/99", "/100", "/199", "/250", "/499", "/999",
  // Special
  "sapphire", "lunar", "lava", "fire", "orange ice", "blue wave", "red wave", "green wave", "black gold", "gold vinyl", "black finite", "white sparkle", "red shimmer", "blue shimmer", "green shimmer", "pink velocity", "blue velocity", "red velocity", "purple velocity", "case hit", "sp", "ssp", "variation", "insert", "promo", "sample", "test", "buyback", "bounty", "encased", "uncirculated", "slabbed", "on card", "sticker"
];
/**
 * Detects the first matching parallel/variant in the title. Case-insensitive, flexible spacing.
 */
export function detectParallel(title: string): string | null {
  for (const p of PARALLELS) {
    const pattern = new RegExp(`\\b${p.replace(/[- /]/g, "[- /]?")}\\b`, "i");
    if (pattern.test(title)) {
      // Normalize: Title Case
      return p.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    }
  }
  return null;
}

// Helper: Compute a simple match score (0-100) for a comp.
function computeMatchScore(comp: NormalizedComp, query?: string): number {
  let score = 0;
  if (query) {
    const words = query.toLowerCase().split(/\s+/);
    const title = comp.title.toLowerCase();
    score += words.filter(w => title.includes(w)).length * 10;
  }
  if (comp.isAuto) score += 10;
  if (comp.grader && comp.grade) score += 10;
  if (comp.parallel) score += 10;
  if (score > 100) score = 100;
  return score;
}

// Normalize a single raw Apify listing to NormalizedComp.
export function normalizeComp(raw: RawApifyListing): NormalizedComp | null {
  if (!raw || typeof raw !== "object") return null;
  const title = (raw.title || "").toString().trim();
  if (!title) return null;

  const price = typeof raw.price === "number" ? raw.price : 0;
  const shipping = typeof raw.shipping === "number" ? raw.shipping : 0;
  if (price <= 0) return null;

  const grader = detectGrader(title);
  const grade = detectGrade(title);
  const isAuto = detectIsAuto(title);
  const isNumbered = detectIsNumbered(title);
  const serialNumber = detectSerialNumber(title);
  const year = detectYear(title);
  const cardNumber = detectCardNumber(title);
  const parallel = detectParallel(title);

  // Improved player/set extraction
  let { playerName, cardSet } = extractPlayerAndSet(title);
  cardSet = cardSet !== undefined ? cardSet : null;

  const normalized: NormalizedComp = {
    title,
    playerName,
    cardSet,
    year,
    parallel,
    cardNumber,
    grade,
    grader,
    isAuto,
    isNumbered,
    serialNumber,
    price,
    shipping,
    totalPrice: price + shipping,
    soldDate: raw.soldDate ? String(raw.soldDate) : null,
    source: "apify-ebay",
    sourceUrl: raw.url ? String(raw.url) : null,
    imageUrl: raw.imageUrl ? String(raw.imageUrl) : null,
    matchScore: 0, // set below
  };

  return normalized;
}

// Normalize an array of raw Apify listings.
export function normalizeComps(rawItems: RawApifyListing[], query?: string): NormalizedComp[] {
  return rawItems
    .map(raw => {
      const comp = normalizeComp(raw);
      if (!comp) return null;
      comp.matchScore = computeMatchScore(comp, query);
      return comp;
    })
    .filter((c): c is NormalizedComp => !!c);
}
// ...existing code...
