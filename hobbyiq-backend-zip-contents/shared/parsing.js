"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCardQuery = parseCardQuery;
// Card query parsing for CompIQ
function parseCardQuery(query) {
    // Very basic parsing logic for demo; replace with real NLP as needed
    const lower = query.toLowerCase();
    const isAuto = /auto/.test(lower);
    const playerMatch = query.match(/^[^\d]+/);
    const player = playerMatch ? playerMatch[0].replace(/auto|psa|bgs|sgc|\d+/gi, "").trim() : null;
    const cardSetMatch = query.match(/\d{4} [^\d]+/);
    const cardSet = cardSetMatch ? cardSetMatch[0].trim() : null;
    const parallelMatch = query.match(/silver|gold|red|blue|green|base|auto/i);
    const parallel = parallelMatch ? parallelMatch[0] : null;
    const productFamily = cardSet ? cardSet.split(" ")[1] : null;
    const gradeTargetMatch = query.match(/psa ?(\d{1,2})/i);
    const gradeTarget = gradeTargetMatch ? gradeTargetMatch[1] : null;
    return {
        player,
        cardSet,
        productFamily,
        parallel,
        normalizedParallel: parallel ? parallel.toLowerCase() : null,
        isAuto,
        gradeTarget
    };
}
