"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeTrend = analyzeTrend;
function median(arr) {
    if (!arr.length)
        return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function analyzeTrend(sales, opts) {
    const minComps = opts?.minComps ?? 5;
    const recentCount = opts?.recentCount ?? 4;
    const round = opts?.round ?? ((n) => Math.round(n * 100) / 100);
    if (!Array.isArray(sales) || sales.length < minComps) {
        return {
            compCount: sales.length,
            baseCompFmv: null,
            recentMedian: null,
            olderMedian: null,
            trendPct: null,
            trendDirection: "insufficient_data",
            trendMultiplier: 1.0,
            finalAdjustedFmv: null
        };
    }
    // Sort by soldDate descending
    const sorted = [...sales].sort((a, b) => new Date(b.soldDate).getTime() - new Date(a.soldDate).getTime());
    // Recent comps
    const recent = sorted.slice(0, recentCount);
    const older = sorted.slice(recentCount);
    const recentMedian = median(recent.map(c => c.price));
    const olderMedian = median(older.map(c => c.price));
    const baseCompFmv = median(sorted.map(c => c.price));
    let trendPct = null;
    let trendDirection = "flat";
    let trendMultiplier = 1.0;
    if (olderMedian && recentMedian) {
        trendPct = round(((recentMedian - olderMedian) / olderMedian) * 100);
        if (trendPct <= -20) {
            trendMultiplier = 0.88;
            trendDirection = "down";
        }
        else if (trendPct > -20 && trendPct <= -10) {
            trendMultiplier = 0.93;
            trendDirection = "down";
        }
        else if (trendPct > -10 && trendPct < 5) {
            trendMultiplier = 1.0;
            trendDirection = "flat";
        }
        else if (trendPct >= 5 && trendPct < 10) {
            trendMultiplier = 1.03;
            trendDirection = "up";
        }
        else if (trendPct >= 10 && trendPct < 20) {
            trendMultiplier = 1.07;
            trendDirection = "up";
        }
        else if (trendPct >= 20 && trendPct < 35) {
            trendMultiplier = 1.12;
            trendDirection = "up";
        }
        else if (trendPct >= 35) {
            trendMultiplier = 1.18;
            trendDirection = "up";
        }
    }
    else {
        trendDirection = "insufficient_data";
        trendMultiplier = 1.0;
    }
    const finalAdjustedFmv = baseCompFmv && trendMultiplier ? round(baseCompFmv * trendMultiplier) : null;
    return {
        compCount: sales.length,
        baseCompFmv: baseCompFmv ? round(baseCompFmv) : null,
        recentMedian: recentMedian ? round(recentMedian) : null,
        olderMedian: olderMedian ? round(olderMedian) : null,
        trendPct,
        trendDirection,
        trendMultiplier: round(trendMultiplier),
        finalAdjustedFmv
    };
}
