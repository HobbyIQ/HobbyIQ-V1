"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCompIQInput = parseCompIQInput;
// Basic parsing logic for CompIQ input
function parseCompIQInput(input) {
    const warnings = [];
    let player = input.player || null;
    let cardSet = input.set || null;
    let parallel = input.parallel || null;
    let gradeTarget = input.gradeTarget || null;
    let isAuto = !!input.isAuto;
    let cardType = null;
    let productFamily = null;
    let normalizedParallel = null;
    // If query is present, try to parse fields from it
    if (input.query) {
        // Example: "LeBron James 2019 Prizm Silver PSA 10 Auto"
        const q = input.query.toLowerCase();
        if (!player) {
            const match = q.match(/([a-zA-Z\-\' ]+)\s+\d{4}/);
            if (match)
                player = match[1].trim();
        }
        if (!cardSet) {
            const match = q.match(/\d{4}\s+([a-zA-Z0-9 ]+)/);
            if (match)
                cardSet = match[1].trim();
        }
        if (!parallel) {
            const match = q.match(/silver|gold|red|blue|green|black|cracked ice|mojo|wave|auto|base/);
            if (match)
                parallel = match[0];
        }
        if (!gradeTarget) {
            const match = q.match(/psa ?(\d{1,2})/);
            if (match)
                gradeTarget = `PSA ${match[1]}`;
        }
        if (!isAuto) {
            isAuto = /auto/.test(q);
        }
    }
    // Normalize parallel
    normalizedParallel = parallel ? parallel.toLowerCase().replace(/\s+/g, "-") : null;
    // Card type logic
    if (isAuto)
        cardType = "Auto";
    else
        cardType = "Base";
    // Product family logic (simple example)
    if (cardSet) {
        if (/prizm/i.test(cardSet))
            productFamily = "Prizm";
        else if (/optic/i.test(cardSet))
            productFamily = "Optic";
        else if (/select/i.test(cardSet))
            productFamily = "Select";
        else
            productFamily = null;
    }
    // Warnings for missing fields
    if (!player)
        warnings.push("Player not detected");
    if (!cardSet)
        warnings.push("Set not detected");
    if (!parallel)
        warnings.push("Parallel not detected");
    return {
        player,
        cardSet,
        productFamily,
        parallel,
        normalizedParallel,
        isAuto,
        cardType,
        gradeTarget,
        warnings,
    };
}
