"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealSupplyProvider = void 0;
class RealSupplyProvider {
    async getSupply(cardId) {
        // TODO: Integrate with real supply/listings API
        throw new Error("RealSupplyProvider not implemented");
    }
    async health() {
        // TODO: Implement real health check (e.g., test supply API credentials)
        return { status: "unhealthy", details: "Not implemented" };
    }
}
exports.RealSupplyProvider = RealSupplyProvider;
