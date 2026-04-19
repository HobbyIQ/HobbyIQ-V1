"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCompsProvider = createCompsProvider;
exports.createSupplyProvider = createSupplyProvider;
exports.createPlayerPerformanceProvider = createPlayerPerformanceProvider;
const env_1 = require("../utils/env");
const mockCompsProvider_1 = require("./mockCompsProvider");
const ebayCompsProvider_1 = require("./real/ebayCompsProvider");
const mockSupplyProvider_1 = require("./mockSupplyProvider");
const supplyProvider_1 = require("./real/supplyProvider");
const mockPlayerPerformanceProvider_1 = require("./mockPlayerPerformanceProvider");
const playerPerformanceProvider_1 = require("./real/playerPerformanceProvider");
function createCompsProvider() {
    return (0, env_1.isMockMode)() ? new mockCompsProvider_1.MockCompsProvider() : new ebayCompsProvider_1.EbayCompsProvider();
}
function createSupplyProvider() {
    return (0, env_1.isMockMode)() ? new mockSupplyProvider_1.MockSupplyProvider() : new supplyProvider_1.RealSupplyProvider();
}
function createPlayerPerformanceProvider() {
    return (0, env_1.isMockMode)() ? new mockPlayerPerformanceProvider_1.MockPlayerPerformanceProvider() : new playerPerformanceProvider_1.RealPlayerPerformanceProvider();
}
