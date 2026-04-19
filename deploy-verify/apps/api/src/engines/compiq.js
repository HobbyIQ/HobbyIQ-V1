"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compiqEngine = compiqEngine;
const ebaySold_1 = require("../services/ebaySold");
// CompIQ engine using real eBay sold data
async function compiqEngine(req) {
    // 1. Fetch eBay sold stats
    let stats;
    try {
        stats = await (0, ebaySold_1.getEbaySoldStats)(req.query);
    }
    catch (e) {
        // Service unavailable or slow
        return {
            intent: "comp",
            directAnswer: "Sold comp data unavailable or slow.",
            action: "No Data",
            keyNumbers: {},
            why: ["Sold comp data service unavailable or slow."],
            tags: ["No Data"],
            expandable: { comps: [], logic: "Sold comp data fetch failed.", signals: {} },
            engine: "CompIQ"
        };
    }
    const { weightedMedianFMV, compRange, trend, liquidity, listings } = stats;
    const compCount = listings.length;
    const hasData = compCount > 0 && weightedMedianFMV;
    // Confidence: based on comp count, recency, and price variance
    let confidence = 0;
    if (compCount === 0)
        confidence = 0;
    else if (compCount === 1)
        confidence = 0.2;
    else if (compCount < 4)
        confidence = 0.4;
    else if (compCount < 8)
        confidence = 0.6;
    else
        confidence = 0.8;
    // Penalize if comps are old or range is wide
    if (compCount > 0) {
        const now = Date.now();
        const mostRecent = Math.max(...listings.map(l => new Date(l.date).getTime()));
        const daysAgo = (now - mostRecent) / (1000 * 60 * 60 * 24);
        if (daysAgo > 30)
            confidence *= 0.7;
        if (compRange && compRange.high && compRange.low && weightedMedianFMV && compRange.high - compRange.low > weightedMedianFMV * 0.5)
            confidence *= 0.7;
    }
    confidence = Math.max(0, Math.min(1, confidence));
    // 3. Build key numbers
    const keyNumbers = {
        FMV: weightedMedianFMV,
        Range: compRange.low !== null && compRange.high !== null ? `$${compRange.low}-$${compRange.high}` : undefined,
        Confidence: confidence === 0 ? "None" : confidence > 0.7 ? "High" : confidence > 0.4 ? "Medium" : "Low",
        Trend: trend !== null ? `${trend > 0 ? "+" : ""}${trend.toFixed(1)}%/wk` : undefined,
        Liquidity: liquidity !== null ? `${liquidity.toFixed(1)} sales/wk` : undefined
    };
    // 4. Compose bullets
    const why = [];
    if (hasData) {
        why.push(`Weighted median FMV: $${weightedMedianFMV}`);
        if (keyNumbers.Range)
            why.push(`Comp range: ${keyNumbers.Range}`);
        if (keyNumbers.Trend)
            why.push(`Recency-weighted trend: ${keyNumbers.Trend}`);
        if (keyNumbers.Liquidity)
            why.push(`Liquidity: ${keyNumbers.Liquidity}`);
        why.push(`Sample size: ${compCount} recent sales.`);
        if (confidence < 0.5)
            why.push("Low confidence: few or messy comps, or wide price range.");
    }
    else {
        why.push("No recent or relevant eBay sales found for this query.");
    }
    // 5. Compose result
    return {
        intent: "comp",
        directAnswer: hasData ? `Estimated FMV: $${weightedMedianFMV}` : "No FMV available.",
        action: hasData ? (trend && trend > 5 ? "Uptrend" : trend && trend < -5 ? "Downtrend" : "Stable") : "No Data",
        keyNumbers,
        why,
        tags: [hasData ? "eBay Sold" : "No Data"],
        expandable: {
            comps: listings.map(l => ({ price: l.price, date: l.date, title: l.title, url: l.url })),
            logic: "Stats computed from recent eBay sold listings via Apify.",
            signals: { liquidity, trend, confidence }
        },
        engine: "CompIQ"
    };
}
