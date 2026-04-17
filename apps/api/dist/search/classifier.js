"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifySearchRequest = classifySearchRequest;
const intentClassifier_1 = require("../utils/intentClassifier");
/**
 * Classifies a search request into a SearchIntent.
 * @param req The search request object
 * @returns The classified intent
 */
function classifySearchRequest(req) {
    return (0, intentClassifier_1.classifyIntent)(req.query);
}
