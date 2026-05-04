"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyMarketTemperature = classifyMarketTemperature;
function classifyMarketTemperature(context) {
    // TODO: Use real trend and supply/demand data
    return {
        label: "warming",
        score: 0.7,
        explanation: ["Recent price acceleration and tightening supply."]
    };
}
