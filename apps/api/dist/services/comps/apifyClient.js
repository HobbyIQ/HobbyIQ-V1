"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchApifySoldComps = fetchApifySoldComps;
const axios_1 = __importDefault(require("axios"));
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
async function fetchApifySoldComps(query, maxResults = 40) {
    if (!APIFY_TOKEN)
        throw new Error("Missing APIFY_TOKEN");
    const url = `https://api.apify.com/v2/acts/caffein.dev~ebay-sold-listings/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
    const payload = { search: query, maxItems: maxResults };
    const res = await axios_1.default.post(url, payload, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
    if (!Array.isArray(res.data))
        throw new Error("Invalid Apify response");
    return res.data;
}
