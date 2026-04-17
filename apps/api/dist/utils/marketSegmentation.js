"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarketSegment = getMarketSegment;
/**
 * Assigns a card to a market segment for learning.
 * This logic is intentionally simple and explainable.
 */
function getMarketSegment(card) {
    if (card.isAuto && card.isNumbered && card.serialNumber) {
        const serial = parseInt(card.serialNumber, 10);
        if (serial <= 10)
            return "ultra_low_serial";
        if (serial <= 25)
            return "auto_low_numbered";
        if (serial <= 99)
            return "auto_mid_numbered";
        return "auto_non_numbered";
    }
    if (card.parallel && card.parallel.toLowerCase().includes("sapphire"))
        return "sapphire";
    if (card.set.toLowerCase().includes("bowman") && card.isAuto)
        return "bowman_1st_auto";
    if (card.set.toLowerCase().includes("topps chrome") && card.rookie)
        return "topps_chrome_rookie";
    if (card.grade === "PSA 10")
        return "psa10_base";
    if (card.grade === "PSA 9")
        return "psa9_base";
    if (!card.grade || card.grade === "RAW")
        return "raw_base";
    if (card.prospect)
        return "prospect_hype";
    if (card.mlb)
        return "mlb_established";
    return "raw_base";
}
