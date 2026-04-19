"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useDecision = useDecision;
const react_query_1 = require("react-query");
const decisions_api_1 = require("../api/decisions.api");
function useDecision(entityType, entityKey) {
    return (0, react_query_1.useQuery)(["decision", entityType, entityKey], () => (0, decisions_api_1.getDecision)(entityType, entityKey));
}
