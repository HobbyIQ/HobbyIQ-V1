"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EbayCompsProvider = void 0;
class EbayCompsProvider {
    async getComps(query) {
        // TODO: Integrate with eBay API
        throw new Error("EbayCompsProvider not implemented");
    }
    async health() {
        // TODO: Implement real health check (e.g., test eBay API credentials)
        return { status: "unhealthy", details: "Not implemented" };
    }
}
exports.EbayCompsProvider = EbayCompsProvider;
