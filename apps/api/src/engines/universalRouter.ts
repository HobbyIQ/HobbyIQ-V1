import type { UniversalSearchRequest, UniversalSearchResult, UniversalSearchIntent } from "../types/universal";
import { classifyIntent } from "../utils/intentClassifier";
import { compiqEngine } from "./compiq";
// Import other engines as needed

export async function routeUniversalSearch(req: UniversalSearchRequest): Promise<UniversalSearchResult> {
  const intent = classifyIntent(req.query);
  // Route to the correct engine
  switch (intent) {
    case "comp":
      return compiqEngine(req);
    // Add other cases for sell, hold, show, etc.
    default:
      return {
        intent: "unknown",
        directAnswer: "Sorry, I couldn't understand your question.",
        action: "Try rephrasing your search.",
        keyNumbers: {},
        why: ["No matching engine found for your query."],
        tags: ["unknown"],
        expandable: {},
        engine: "universalRouter",
      };
  }
}
