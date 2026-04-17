"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
console.log("DATABASE_URL:", process.env.DATABASE_URL);
const express_1 = __importDefault(require("express"));
const route_1 = __importDefault(require("./engines/decision/route"));
const route_2 = __importDefault(require("./engines/selliq/route"));
const route_3 = __importDefault(require("./engines/hobbyiq/route"));
const cors_1 = __importDefault(require("cors"));
const compiq_1 = __importDefault(require("./routes/compiq"));
const universal_1 = __importDefault(require("./routes/universal"));
const portfolio_1 = __importDefault(require("./routes/portfolio"));
const protectedFeatures_1 = __importDefault(require("./routes/protectedFeatures"));
const me_1 = __importDefault(require("./routes/me"));
const plans_1 = __importDefault(require("./routes/plans"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const parallelMultipliers_1 = require("./config/parallelMultipliers");
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const search_1 = __importDefault(require("./routes/search"));
const jobs_1 = __importDefault(require("./routes/jobs"));
const subscriptions_1 = __importDefault(require("./routes/subscriptions"));
const providerHealth_1 = __importDefault(require("./routes/providerHealth"));
const learningRoutes_1 = __importDefault(require("./routes/learning/learningRoutes"));
const appConfig_1 = __importDefault(require("./routes/appConfig"));
const apifySoldService_1 = require("./utils/apifySoldService");
const alerts_1 = __importDefault(require("./routes/alerts"));
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Allow frontend dev server CORS
app.use((0, cors_1.default)({
    origin: "http://localhost:5173",
    credentials: true
}));
// SellIQ route
app.use("/api/selliq", route_2.default);
// Unified HobbyIQ analysis route
app.use("/api/hobbyiq", route_3.default);
// Decision Engine route
app.use("/api/decision", route_1.default);
// --- Public GET /api/compiq/trend-test ---
app.get("/api/compiq/trend-test", (req, res) => {
    let { prices, dates } = req.query;
    // Accept both comma-separated string or array
    if (typeof prices === "string")
        prices = prices.split(",");
    if (typeof dates === "string")
        dates = dates.split(",");
    let comps = [];
    if (Array.isArray(prices) && Array.isArray(dates) && prices.length === dates.length && prices.length > 0) {
        comps = prices.map((p, i) => ({ price: Number(p), soldDate: String(dates[i]) }));
    }
    else {
        // Default mock dataset
        comps = [
            { price: 100, soldDate: "2026-04-01" },
            { price: 110, soldDate: "2026-04-03" },
            { price: 125, soldDate: "2026-04-05" },
            { price: 130, soldDate: "2026-04-07" },
            { price: 145, soldDate: "2026-04-09" }
        ];
    }
    const trend = (0, trendEngine_1.analyzeTrend)(comps);
    res.json({
        success: true,
        comps,
        compCount: trend.compCount,
        baseCompFmv: trend.baseCompFmv,
        recentMedian: trend.recentMedian,
        olderMedian: trend.olderMedian,
        trendPct: trend.trendPct,
        trendDirection: trend.trendDirection,
        trendMultiplier: trend.trendMultiplier,
        finalAdjustedFmv: trend.finalAdjustedFmv
    });
});
// Public GET /api/compiq/estimate (no user context, no middleware)
// --- Helper functions for CompIQ parallel pricing ---
function normalizeParallelName(parallel) {
    return (parallel || "base").toLowerCase().replace(/[^a-z0-9 ]/gi, "").replace(/\s+/g, " ").trim();
}
function detectProductFamily(cardSet, isAuto) {
    if (!cardSet)
        return undefined;
    const set = cardSet.toLowerCase();
    if (set.includes("chrome update")) {
        if (isAuto)
            return "Topps Chrome Update Auto";
        return "Topps Chrome Update Non-Auto";
    }
    if (set.includes("chrome")) {
        if (set.includes("bowman")) {
            if (isAuto)
                return "Bowman Chrome Auto";
            return "Bowman Chrome Non-Auto";
        }
        if (isAuto)
            return "Topps Chrome Auto";
        return "Topps Chrome Non-Auto";
    }
    if (set.includes("draft")) {
        if (isAuto)
            return "Bowman Draft Auto";
        return "Bowman Draft Non-Auto";
    }
    if (set.includes("bowman"))
        return "Bowman";
    if (set.includes("flagship"))
        return "Topps Flagship";
    if (set.includes("paper"))
        return "Topps Paper";
    if (set.includes("topps"))
        return "Topps";
    return undefined;
}
function getParallelMultiplier(productFamily, parallel, isAuto) {
    if (!productFamily)
        return 1.0;
    const famKey = productFamily.toLowerCase();
    const config = isAuto ? parallelMultipliers_1.parallelMultipliers.auto[famKey] : parallelMultipliers_1.parallelMultipliers.nonAuto[famKey];
    if (!config)
        return 1.0;
    return config[parallel] ?? 1.0;
}
function roundTo2(val) {
    return Math.round(val * 100) / 100;
}
// --- Serial scarcity multiplier helper ---
function getSerialMultiplier(serial) {
    if (!serial)
        return 1.0;
    const n = typeof serial === "string" ? parseInt(serial, 10) : serial;
    if (isNaN(n))
        return 1.0;
    if (n >= 499)
        return 1.0;
    if (n >= 299)
        return 1.1;
    if (n >= 250)
        return 1.2;
    if (n >= 199)
        return 1.3;
    if (n >= 150)
        return 1.4;
    if (n >= 125)
        return 1.5;
    if (n >= 100)
        return 1.7;
    if (n >= 99)
        return 1.8;
    if (n >= 75)
        return 2.0;
    if (n >= 50)
        return 2.5;
    if (n >= 25)
        return 3.5;
    if (n >= 10)
        return 5.0;
    if (n >= 5)
        return 7.0;
    if (n >= 1)
        return 12.0;
    return 1.0;
}
// --- Trend adjustment helper (modular) ---
const trendEngine_1 = require("./utils/trendEngine");
app.get("/api/compiq/estimate", (req, res) => {
    const { player, cardSet, parallel, rawPrice, isAuto, serial, compPrices, compDates, useTrend } = req.query;
    const price = Number(rawPrice);
    if (Number.isNaN(price)) {
        return res.status(400).json({
            success: false,
            error: "rawPrice must be a number",
        });
    }
    const normalizedParallel = normalizeParallelName(typeof parallel === "string" ? parallel : undefined);
    const isAutoBool = typeof isAuto === "string" ? isAuto.toLowerCase() === "true" : false;
    const productFamily = detectProductFamily(typeof cardSet === "string" ? cardSet : undefined, isAutoBool);
    const parallelMultiplier = getParallelMultiplier(productFamily, normalizedParallel, isAutoBool);
    const serialValue = typeof serial === "string"
        ? serial
        : Array.isArray(serial) && typeof serial[0] === "string"
            ? serial[0]
            : undefined;
    const serialMultiplier = getSerialMultiplier(serialValue);
    let adjustedRaw = price * parallelMultiplier * serialMultiplier;
    let cardType = "Non-Auto";
    if (isAutoBool)
        cardType = "Auto";
    // Trend logic
    let trendFields = {};
    let useTrendBool = typeof useTrend === "string" && useTrend.toLowerCase() === "true";
    let comps = [];
    if (useTrendBool && typeof compPrices === "string" && typeof compDates === "string") {
        const pricesArr = compPrices.split(",");
        const datesArr = compDates.split(",");
        if (pricesArr.length === datesArr.length && pricesArr.length > 0) {
            comps = pricesArr.map((p, i) => ({ price: Number(p), soldDate: String(datesArr[i]) }));
            const trend = (0, trendEngine_1.analyzeTrend)(comps);
            adjustedRaw = adjustedRaw * trend.trendMultiplier;
            trendFields = {
                useTrend: true,
                compCount: trend.compCount,
                baseCompFmv: trend.baseCompFmv !== null ? roundTo2(trend.baseCompFmv) : null,
                recentMedian: trend.recentMedian !== null ? roundTo2(trend.recentMedian) : null,
                olderMedian: trend.olderMedian !== null ? roundTo2(trend.olderMedian) : null,
                trendPct: trend.trendPct !== null ? roundTo2(trend.trendPct) : null,
                trendDirection: trend.trendDirection,
                trendMultiplier: roundTo2(trend.trendMultiplier),
                finalAdjustedFmv: trend.finalAdjustedFmv !== null ? roundTo2(trend.finalAdjustedFmv) : null
            };
        }
    }
    return res.json({
        success: true,
        player,
        cardSet,
        productFamily: productFamily || null,
        parallel,
        normalizedParallel,
        isAuto: isAutoBool,
        cardType,
        rawPrice: roundTo2(price),
        parallelMultiplier: roundTo2(parallelMultiplier),
        serial: serial ?? null,
        serialMultiplier: roundTo2(serialMultiplier),
        adjustedRaw: roundTo2(adjustedRaw),
        estimatedPsa10: roundTo2(adjustedRaw * 2.25),
        estimatedPsa9: roundTo2(adjustedRaw * 1.15),
        estimatedPsa8: roundTo2(adjustedRaw * 0.9),
        ...trendFields
    });
});
app.get("/health", (_req, res) => {
    return res.json({
        success: true,
        status: "ok",
    });
});
app.get("/", (_req, res) => {
    return res.json({
        success: true,
        message: "HobbyIQ API live",
    });
});
// Mount routers and middleware below public routes
app.use("/api/search", search_1.default);
app.use("/api/universal", universal_1.default);
app.use("/api/portfolio", portfolio_1.default);
app.use("/api/protected", protectedFeatures_1.default);
app.use("/api/me", me_1.default);
app.use("/api/plans", plans_1.default);
app.use("/api/notifications", notifications_1.default);
app.use("/api/dashboard", dashboard_1.default);
app.use("/api/jobs", jobs_1.default);
app.use("/api/subscription", subscriptions_1.default);
app.use("/api/provider-health", providerHealth_1.default);
app.use("/api/learning", learningRoutes_1.default);
app.use("/api/app-config", appConfig_1.default);
app.use("/api/compiq", compiq_1.default);
app.use("/api/alerts", alerts_1.default);
// 404 handler (after all routes)
app.use((req, res, next) => {
    res.status(404).json({
        success: false,
        error: {
            code: "NOT_FOUND",
            message: `Route not found: ${req.originalUrl}`
        }
    });
});
// Central error handler
app.use((err, req, res, next) => {
    console.error("[ERROR]", err);
    res.status(500).json({
        success: false,
        error: {
            code: "INTERNAL_SERVER_ERROR",
            message: err?.message || "Unexpected error"
        }
    });
});
const PORT = process.env.PORT && !isNaN(Number(process.env.PORT)) ? Number(process.env.PORT) : 4000;
console.log("\n==============================");
console.log(`Starting HobbyIQ API (env: ${process.env.NODE_ENV || "development"})`);
console.log(`Listening on http://localhost:${PORT}`);
console.log(`Frontend: ${process.env.CLIENT_APP_URL || "(not set)"}`);
console.log(`AI Mode: ${process.env.AI_MODE || "mock"}`);
console.log("==============================\n");
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] HobbyIQ API server ready on port ${PORT}`);
});
// --- Public GET /api/compiq/live-estimate ---
app.get("/api/compiq/live-estimate", async (req, res) => {
    const { player, cardSet, parallel, isAuto, serial } = req.query;
    if (!player || !cardSet) {
        return res.status(400).json({ success: false, error: "player and cardSet are required" });
    }
    const isAutoBool = typeof isAuto === "string" ? isAuto.toLowerCase() === "true" : false;
    const normalizedParallel = normalizeParallelName(typeof parallel === "string" ? parallel : undefined);
    const productFamily = detectProductFamily(typeof cardSet === "string" ? cardSet : undefined, isAutoBool);
    const parallelMultiplier = getParallelMultiplier(productFamily, normalizedParallel, isAutoBool);
    const serialValue = typeof serial === "string" ? serial : Array.isArray(serial) && typeof serial[0] === "string" ? serial[0] : undefined;
    const serialMultiplier = getSerialMultiplier(serialValue);
    // Fetch comps (safe fallback to mock if env missing)
    let comps = [];
    try {
        comps = await (0, apifySoldService_1.fetchSoldComps)({
            player: String(player),
            cardSet: String(cardSet),
            parallel: typeof parallel === "string" ? parallel : undefined,
            isAuto: isAutoBool,
            serial: serialValue
        });
    }
    catch (e) {
        comps = [
            { price: 100, soldDate: "2026-04-01" },
            { price: 110, soldDate: "2026-04-03" },
            { price: 125, soldDate: "2026-04-05" },
            { price: 130, soldDate: "2026-04-07" },
            { price: 145, soldDate: "2026-04-09" }
        ];
    }
    // Trend
    const trend = (0, trendEngine_1.analyzeTrend)(comps);
    const trendMultiplier = trend.trendMultiplier;
    const finalAdjustedFmv = trend.finalAdjustedFmv !== null ? roundTo2(trend.finalAdjustedFmv * parallelMultiplier * serialMultiplier) : null;
    res.json({
        success: true,
        player,
        cardSet,
        parallel,
        isAuto: isAutoBool,
        serial: serialValue,
        comps,
        compCount: trend.compCount,
        baseCompFmv: trend.baseCompFmv !== null ? roundTo2(trend.baseCompFmv) : null,
        trendDirection: trend.trendDirection,
        trendMultiplier: roundTo2(trendMultiplier),
        parallelMultiplier: roundTo2(parallelMultiplier),
        serialMultiplier: roundTo2(serialMultiplier),
        finalAdjustedFmv,
        estimatedPsa10: finalAdjustedFmv !== null ? roundTo2(finalAdjustedFmv * 2.25) : null,
        estimatedPsa9: finalAdjustedFmv !== null ? roundTo2(finalAdjustedFmv * 1.15) : null,
        estimatedPsa8: finalAdjustedFmv !== null ? roundTo2(finalAdjustedFmv * 0.9) : null
    });
});
