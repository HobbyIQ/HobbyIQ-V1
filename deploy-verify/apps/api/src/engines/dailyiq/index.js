"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDailyIQBrief = handleDailyIQBrief;
const service_1 = require("./service");
async function handleDailyIQBrief() {
    return (0, service_1.getDailyIQBrief)();
}
