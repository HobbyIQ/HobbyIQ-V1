// @ts-nocheck
export {};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDailyMLB = getDailyMLB;
exports.getDailyMiLB = getDailyMiLB;
exports.buildPersonalizedHighlights = buildPersonalizedHighlights;
exports.getWatchPlayerFeed = getWatchPlayerFeed;
exports.buildDailyIQSummary = buildDailyIQSummary;
exports.refreshDailyRealData = refreshDailyRealData;
const portfolioRepository_1 = require("../repositories/portfolioRepository");
const watchPlayersRepository_1 = require("../repositories/watchPlayersRepository");
const mlbStatsApiService_1 = require("./mlbStatsApiService");
const dailyLiveCache = {
    date: "",
    mlb: [],
    milb: [],
    lastRefreshIso: null,
};
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Mock daily data (replaced with real API feed when available) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function getMockMLBStats() {
    return [
        {
            playerName: "Paul Skenes",
            team: "PIT",
            level: "MLB",
            position: "SP",
            statLine: "7 IP, 1 ER, 11 K, 2 BB",
            performanceNote: "Dominant outing Ã¢â‚¬â€ command was elite",
            trend: "hot",
            hr: 0, hits: 0, rbi: 0, strikeouts: 11, era: 1.28,
            isProspect: false, buySignal: true,
        },
        {
            playerName: "Jackson Chourio",
            team: "MIL",
            level: "MLB",
            position: "OF",
            statLine: "3/4, 2 HR, 4 RBI",
            performanceNote: "Back-to-back multi-HR games",
            trend: "hot",
            hr: 2, hits: 3, rbi: 4, strikeouts: 0, era: null,
            isProspect: false, buySignal: true,
        },
        {
            playerName: "Gunnar Henderson",
            team: "BAL",
            level: "MLB",
            position: "SS",
            statLine: "2/5, HR, 2 RBI",
            performanceNote: "Steady production, on pace for 35+ HR",
            trend: "up",
            hr: 1, hits: 2, rbi: 2, strikeouts: 0, era: null,
            isProspect: false, buySignal: false,
        },
        {
            playerName: "Elly De La Cruz",
            team: "CIN",
            level: "MLB",
            position: "SS",
            statLine: "1/4, K, SB",
            performanceNote: "Quiet night offensively",
            trend: "flat",
            hr: 0, hits: 1, rbi: 0, strikeouts: 1, era: null,
            isProspect: false, buySignal: false,
        },
        {
            playerName: "Yoshinobu Yamamoto",
            team: "LAD",
            level: "MLB",
            position: "SP",
            statLine: "6 IP, 0 ER, 8 K",
            performanceNote: "Shutout frames through 6 Ã¢â‚¬â€ vintage stuff",
            trend: "up",
            hr: 0, hits: 0, rbi: 0, strikeouts: 8, era: 2.10,
            isProspect: false, buySignal: false,
        },
    ];
}
function getMockMiLBStats() {
    return [
        {
            playerName: "Sebastian Walcott",
            team: "TEX",
            level: "MiLB",
            position: "SS",
            statLine: "3/4, HR, 2 RBI",
            performanceNote: "Hot streak continues Ã¢â‚¬â€ contact + power combo",
            trend: "hot",
            hr: 1, hits: 3, rbi: 2, strikeouts: 0, era: null,
            isProspect: true, buySignal: true,
        },
        {
            playerName: "Bryce Rainer",
            team: "NYY",
            level: "MiLB",
            position: "OF",
            statLine: "2/4, 2B, RBI",
            performanceNote: "Gap power showing up early",
            trend: "up",
            hr: 0, hits: 2, rbi: 1, strikeouts: 0, era: null,
            isProspect: true, buySignal: false,
        },
        {
            playerName: "Cam Collier",
            team: "CIN",
            level: "MiLB",
            position: "3B",
            statLine: "2/3, HR, 3 RBI, BB",
            performanceNote: "Best game of the year Ã¢â‚¬â€ power breakout",
            trend: "hot",
            hr: 1, hits: 2, rbi: 3, strikeouts: 0, era: null,
            isProspect: true, buySignal: true,
        },
        {
            playerName: "Chase Dollander",
            team: "COL",
            level: "MiLB",
            position: "SP",
            statLine: "6 IP, 1 ER, 9 K",
            performanceNote: "Fastball-slider combo looking sharper this week",
            trend: "up",
            hr: 0, hits: 0, rbi: 0, strikeouts: 9, era: 3.12,
            isProspect: true, buySignal: true,
        },
        {
            playerName: "Wyatt Langford",
            team: "TEX",
            level: "MiLB",
            position: "OF",
            statLine: "0/4, 2 K",
            performanceNote: "Cold night Ã¢â‚¬â€ slumping over last 7 games",
            trend: "cold",
            hr: 0, hits: 0, rbi: 0, strikeouts: 2, era: null,
            isProspect: true, buySignal: false,
        },
    ];
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Impact + signal engine Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function deriveCardImpact(stat) {
    if (stat.trend === "hot" || (stat.hr >= 2) || (stat.hits >= 3 && stat.rbi >= 2))
        return "Hot";
    if (stat.trend === "up" || stat.hr >= 1 || stat.hits >= 2)
        return "Rising";
    if (stat.trend === "cold" || stat.trend === "down")
        return "Cooling";
    return "Neutral";
}
function deriveMarketSignal(stat, impact) {
    if (stat.strikeouts >= 10 && (stat.era ?? 99) < 2.5)
        return "Dominant Pitching";
    if (stat.hr >= 2)
        return "Power Surge";
    if (stat.hits >= 3 && stat.trend === "hot")
        return "Hot Streak";
    if (impact === "Hot" && stat.isProspect)
        return "Prospect Rising";
    if (impact === "Hot")
        return "Breakout Performance";
    if (impact === "Rising" && stat.isProspect)
        return "Prospect Rising";
    if (impact === "Rising")
        return "Steady Production";
    if (impact === "Cooling" && stat.trend === "cold")
        return "Cold Streak";
    if (impact === "Cooling")
        return "Slump Watch";
    return "Steady Production";
}
function derivePortfolioAction(impact, signal, confidence) {
    if (impact === "Hot" && confidence >= 0.70) {
        if (signal === "Hype Cycle Peak") {
            return { action: "Trim Position", rationale: "Peak hype Ã¢â‚¬â€ market may cool. Lock in partial gains before demand fades." };
        }
        return { action: "Sell Now", rationale: "Strong performance + high confidence. Market demand is at a peak Ã¢â‚¬â€ ideal time to exit at max value." };
    }
    if (impact === "Hot" && confidence < 0.70) {
        return { action: "Watch", rationale: "Big game but single-game sample. Watch for a second strong outing before deciding to sell." };
    }
    if (impact === "Rising" && signal === "Steady Production") {
        return { action: "Hold", rationale: "Consistent production supports current value. No urgent action needed Ã¢â‚¬â€ let the card appreciate." };
    }
    if (impact === "Rising") {
        return { action: "Hold", rationale: "Trending up. Hold and monitor Ã¢â‚¬â€ upside still in play." };
    }
    if (impact === "Cooling" && signal === "Cold Streak") {
        return { action: "Trim Position", rationale: "Extended cold streak reducing demand. Consider trimming before value drops further." };
    }
    if (impact === "Cooling") {
        return { action: "Watch", rationale: "Recent slump creating short-term headwinds. Watch next 2Ã¢â‚¬â€œ3 games before acting." };
    }
    return { action: "Hold", rationale: "No significant signal today. Hold and monitor." };
}
function deriveImpactPct(impact) {
    switch (impact) {
        case "Hot": return 0.075;
        case "Rising": return 0.035;
        case "Neutral": return 0;
        case "Cooling": return -0.05;
    }
}
function formatInventoryImpact(impactPct, currentValue) {
    const dollars = impactPct * currentValue;
    if (dollars === 0)
        return "No change estimated";
    const sign = dollars > 0 ? "+" : "";
    return `${sign}$${Math.abs(dollars).toFixed(0)} estimated`;
}
function deriveConfidence(impact, stat) {
    if (impact === "Hot")
        return 0.75;
    if (impact === "Rising" && stat.isProspect)
        return 0.60;
    if (impact === "Rising")
        return 0.65;
    if (impact === "Cooling")
        return 0.55;
    return 0.40;
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Buy target engine Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function deriveBuyScore(stat) {
    let score = 0;
    if (stat.trend === "hot")
        score += 35;
    if (stat.trend === "up")
        score += 20;
    if (stat.buySignal)
        score += 20;
    if (stat.hr >= 2)
        score += 15;
    if (stat.hr >= 1)
        score += 8;
    if (stat.hits >= 3)
        score += 10;
    if (stat.strikeouts >= 10)
        score += 12;
    if (stat.isProspect)
        score += 10; // prospects = more upside
    return Math.min(score, 100);
}
function deriveBuyUrgency(buyScore, trend) {
    if (buyScore >= 70 || trend === "hot")
        return "Act Today";
    if (buyScore >= 45 || trend === "up")
        return "Watch This Week";
    return "Monitor";
}
function deriveBuyReason(stat, signal) {
    if (signal === "Dominant Pitching")
        return `${stat.strikeouts}K outing could trigger a significant market spike. Buy before the box score noise peaks.`;
    if (signal === "Power Surge")
        return `${stat.hr} home run${stat.hr > 1 ? "s" : ""} today Ã¢â‚¬â€ power upside is now visible to the broader market.`;
    if (signal === "Prospect Rising")
        return "Prospect putting up numbers that will attract new buyers. Low supply + rising demand = window to enter now.";
    if (signal === "Hot Streak")
        return "Multi-game hot streak. Market typically reacts 24Ã¢â‚¬â€œ48 hrs after. Get in before the wave.";
    if (signal === "Breakout Performance")
        return "Elite performance in a high-visibility spot. Expect short-term demand spike.";
    return "Positive trend aligning with solid fundamentals. Monitor closely for entry.";
}
function deriveSuggestedMaxBuy(stat, buyScore) {
    if (stat.level === "MiLB" && buyScore >= 70)
        return "Under $75 Ã¢â‚¬â€ prospect hype fades fast; don't overpay";
    if (stat.level === "MiLB")
        return "Under $40 Ã¢â‚¬â€ watch for sustained performance before committing more";
    if (buyScore >= 80)
        return "Fair market value or below Ã¢â‚¬â€ strong signal, but don't chase";
    if (buyScore >= 60)
        return "Up to 10% above recent comps Ã¢â‚¬â€ trending up, small premium justified";
    return "At or below recent comps Ã¢â‚¬â€ no urgency, just monitoring";
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Normalize player name for matching Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function normalizeName(name) {
    return name.toLowerCase().trim();
}
function getYesterdayDateStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
}
async function refreshDailyRealData(force = false) {
    const targetDate = getYesterdayDateStr();
    if (!force && dailyLiveCache.date === targetDate && (dailyLiveCache.mlb.length > 0 || dailyLiveCache.milb.length > 0)) {
        return { ...dailyLiveCache, source: "cache" };
    }
    try {
        const [mlb, milb] = await Promise.all([
            (0, mlbStatsApiService_1.getTopPerformersBySportIds)(targetDate, [1], "MLB", 50),
            (0, mlbStatsApiService_1.getTopPerformersBySportIds)(targetDate, [11, 12, 13, 14], "MiLB", 80),
        ]);
        dailyLiveCache.date = targetDate;
        dailyLiveCache.mlb = mlb;
        dailyLiveCache.milb = milb;
        dailyLiveCache.lastRefreshIso = new Date().toISOString();
        return { ...dailyLiveCache, source: "live" };
    }
    catch (err) {
        console.error("[dailyiq] refreshDailyRealData error:", err);
        return {
            ...dailyLiveCache,
            source: "error",
        };
    }
}
function performanceScore(stat) {
    let score = 0;
    score += (stat.hr ?? 0) * 6;
    score += (stat.hits ?? 0) * 2;
    score += (stat.rbi ?? 0) * 2;
    score += (stat.strikeouts ?? 0) * 1.5;
    if (stat.trend === "hot")
        score += 8;
    if (stat.trend === "up")
        score += 4;
    return score;
}
function selectBestPerformers(stats, limit = 5) {
    return stats
        .filter((s) => s.trend === "hot" || s.trend === "up" || (s.hr ?? 0) >= 1 || (s.hits ?? 0) >= 2 || (s.strikeouts ?? 0) >= 7)
        .sort((a, b) => performanceScore(b) - performanceScore(a))
        .slice(0, limit)
        .map((s) => ({
        playerName: s.playerName,
        team: s.team,
        level: s.level,
        position: s.position,
        statLine: s.statLine,
        trend: s.trend,
        performanceNote: s.performanceNote,
        score: performanceScore(s),
    }));
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Public functions Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function getDailyMLB() {
    return dailyLiveCache.date === getYesterdayDateStr() && dailyLiveCache.mlb.length > 0
        ? dailyLiveCache.mlb
        : getMockMLBStats();
}
function getDailyMiLB() {
    return dailyLiveCache.date === getYesterdayDateStr() && dailyLiveCache.milb.length > 0
        ? dailyLiveCache.milb
        : getMockMiLBStats();
}
function buildPersonalizedHighlights(userId) {
    const today = new Date().toISOString().split("T")[0];
    // 1. Load user inventory
    const inventory = portfolioRepository_1.portfolioRepository.getActiveInventory(userId);
    // 2. Build lookup: normalizedPlayerName Ã¢â€ â€™ total current value across all their cards
    const inventoryValueMap = new Map();
    for (const card of inventory) {
        const key = normalizeName(card.playerName);
        const existing = inventoryValueMap.get(key) ?? 0;
        inventoryValueMap.set(key, existing + (card.currentValue ?? card.cost ?? 0));
    }
    // 3. Fetch all daily stats
    const mlbStats = getMockMLBStats();
    const milbStats = getMockMiLBStats();
    const allStats = [...mlbStats, ...milbStats];
    // 4. Build portfolio highlights for players the user owns
    const portfolioHighlights = [];
    const portfolioPlayerKeys = new Set();
    for (const stat of allStats) {
        const key = normalizeName(stat.playerName);
        if (!inventoryValueMap.has(key))
            continue;
        portfolioPlayerKeys.add(key);
        const currentValue = inventoryValueMap.get(key) ?? 0;
        const cardImpact = deriveCardImpact(stat);
        const marketSignal = deriveMarketSignal(stat, cardImpact);
        const confidence = deriveConfidence(cardImpact, stat);
        const impactPct = deriveImpactPct(cardImpact);
        const { action, rationale } = derivePortfolioAction(cardImpact, marketSignal, confidence);
        portfolioHighlights.push({
            playerName: stat.playerName,
            team: stat.team,
            level: stat.level,
            statLine: stat.statLine,
            performanceNote: stat.performanceNote,
            cardImpact,
            marketSignal,
            action,
            actionRationale: rationale,
            inventoryImpact: formatInventoryImpact(impactPct, currentValue),
            confidence,
        });
    }
    // Sort: Hot Ã¢â€ â€™ Rising Ã¢â€ â€™ Neutral Ã¢â€ â€™ Cooling; within same bucket, higher confidence first
    const impactOrder = { Hot: 0, Rising: 1, Neutral: 2, Cooling: 3 };
    portfolioHighlights.sort((a, b) => {
        const bucketDiff = impactOrder[a.cardImpact] - impactOrder[b.cardImpact];
        return bucketDiff !== 0 ? bucketDiff : b.confidence - a.confidence;
    });
    // 5. Build buy targets Ã¢â‚¬â€ players NOT in the user's portfolio with positive signals
    const buyTargets = [];
    for (const stat of allStats) {
        const key = normalizeName(stat.playerName);
        if (portfolioPlayerKeys.has(key))
            continue; // already own Ã¢â‚¬â€ skip
        if (stat.trend === "cold" || stat.trend === "down")
            continue; // not a buy
        const buyScore = deriveBuyScore(stat);
        if (buyScore < 30)
            continue; // below minimum threshold
        const cardImpact = deriveCardImpact(stat);
        const marketSignal = deriveMarketSignal(stat, cardImpact);
        const confidence = deriveConfidence(cardImpact, stat);
        const urgency = deriveBuyUrgency(buyScore, stat.trend);
        buyTargets.push({
            playerName: stat.playerName,
            team: stat.team,
            level: stat.level,
            position: stat.position,
            statLine: stat.statLine,
            reason: deriveBuyReason(stat, marketSignal),
            marketSignal,
            buyScore,
            urgency,
            suggestedMaxBuy: deriveSuggestedMaxBuy(stat, buyScore),
            confidence,
        });
    }
    // Sort buy targets: highest buyScore first, then urgency
    const urgencyOrder = { "Act Today": 0, "Watch This Week": 1, "Monitor": 2 };
    buyTargets.sort((a, b) => {
        const scoreDiff = b.buyScore - a.buyScore;
        return scoreDiff !== 0 ? scoreDiff : urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    });
    // 6. Top MLB: hot/up hitters and pitchers
    const topMLB = mlbStats
        .filter((s) => s.trend === "hot" || s.trend === "up")
        .sort((a, b) => (b.hr + b.hits) - (a.hr + a.hits))
        .slice(0, 3);
    // 7. Top MiLB: top prospects with positive trend
    const topMiLB = milbStats
        .filter((s) => s.isProspect && (s.trend === "hot" || s.trend === "up"))
        .sort((a, b) => (b.hr + b.hits + b.rbi) - (a.hr + a.hits + a.rbi))
        .slice(0, 3);
    // 8. Backward-compat topBuy Ã¢â‚¬â€ first buy target's raw stat or best buySignal
    const topBuy = allStats.find((s) => s.buySignal && s.trend === "hot") ?? null;
    // 9. Hot players list
    const hotPlayers = allStats
        .filter((s) => s.trend === "hot")
        .map((s) => s.playerName);
    return {
        date: today,
        portfolioHighlights,
        buyTargets: buyTargets.slice(0, 5), // top 5 buy targets
        topMLB,
        topMiLB,
        topBuy,
        hotPlayers,
    };
}
async function buildDailyIQSummary(userId) {
    await refreshDailyRealData(false);
    const date = getYesterdayDateStr();
    const mlbBestPerformers = selectBestPerformers(getDailyMLB(), 5);
    const milbBestPerformers = selectBestPerformers(getDailyMiLB(), 5);
    const watchlist = await getWatchPlayerFeed(userId);
    return {
        date,
        mlbBestPerformers,
        milbBestPerformers,
        watchlist,
    };
}
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Watch Players feed Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
/**
 * For each player on the user's watch list, returns their most recent game stat.
 * Priority: today's DailyIQ feed Ã¢â€ â€™ MLB Stats API live lookup Ã¢â€ â€™ "Not Found" state.
 * If a player has no game in either source, returns played: false with noGameMessage.
 */
async function getWatchPlayerFeed(userId) {
    const watchList = watchPlayersRepository_1.watchPlayersRepository.getList(userId);
    if (watchList.length === 0)
        return [];
    // Build a lookup from yesterday's daily stats keyed by normalized name
    const allStats = [...getMockMLBStats(), ...getMockMiLBStats()];
    const statsByName = new Map();
    for (const s of allStats) {
        statsByName.set(normalizeName(s.playerName), s);
    }
    const yesterdayStr = getYesterdayDateStr();
    const results = await Promise.all(watchList.map(async (entry) => {
        const key = normalizeName(entry.playerName);
        const dailyMatch = statsByName.get(key);
        // 1. Found in yesterday's DailyIQ feed
        if (dailyMatch) {
            return {
                playerName: entry.playerName,
                lastGameDate: yesterdayStr,
                statLine: dailyMatch.statLine,
                played: true,
                trend: dailyMatch.trend,
                buySignal: dailyMatch.buySignal,
                performanceNote: dailyMatch.performanceNote,
                team: dailyMatch.team,
                position: dailyMatch.position,
                level: dailyMatch.level,
            };
        }
        // 2. Not in yesterday's feed Ã¢â‚¬â€ hit the MLB Stats API
        const live = await (0, mlbStatsApiService_1.getLastGameStat)(entry.playerName);
        if (live && live.played && live.date === yesterdayStr) {
            return {
                playerName: entry.playerName,
                lastGameDate: live.date,
                statLine: live.statLine,
                played: true,
                team: live.team,
                position: live.position,
                level: "MLB",
            };
        }
        // 3. No game found
        return {
            playerName: entry.playerName,
            lastGameDate: null,
            statLine: null,
            played: false,
            noGameMessage: `No Games Played on ${yesterdayStr}`,
        };
    }));
    return results;
}
