"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluatePortfolio = evaluatePortfolio;
exports.handleAddHolding = handleAddHolding;
exports.handleListHoldings = handleListHoldings;
exports.handlePortfolioSummary = handlePortfolioSummary;
// Minimal PortfolioIQ engine for HobbyIQ V1
function evaluatePortfolio(cards, compResultsMap) {
    let totalFMV = 0;
    let totalPaid = 0;
    const results = cards.map(card => {
        const key = (card.player + "|" + card.parallel).toLowerCase().trim();
        const comp = compResultsMap[key] || {};
        const FMV = comp.keyNumbers?.FMV || 0;
        const paid = card.pricePaid || 0;
        totalFMV += FMV;
        totalPaid += paid;
        return {
            ...card,
            FMV,
            ROI: paid ? ((FMV - paid) / paid) * 100 : null,
            compResult: comp
        };
    });
    return {
        totalFMV,
        totalPaid,
        ROI: totalPaid ? ((totalFMV - totalPaid) / totalPaid) * 100 : null,
        cards: results
    };
}
// Stubs for route compatibility
async function handleAddHolding(input) {
    // Implement actual logic as needed
    return { success: true, message: "Holding added", input };
}
async function handleListHoldings() {
    // Implement actual logic as needed
    return { success: true, holdings: [] };
}
async function handlePortfolioSummary() {
    // Implement actual logic as needed
    return { success: true, summary: {} };
}
