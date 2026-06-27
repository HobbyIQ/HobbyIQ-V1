// CF-UNIFIED-SEARCH-AND-CERT v1 W3 — unified search module surface.
//
// Re-exports the dispatcher + adapter helpers so the W3 route file
// (and any future internal consumers) can import everything from one
// path, matching the W2 certGraders/index.ts pattern.
//
// Importing this module also triggers the cert-grader registry's
// side-effect grader registration via `./certGraders/index.js`. The
// dispatcher depends on at least PSA being registered to function in
// cert mode; this re-export chain ensures route-file imports get the
// registered registry without the route having to know about the
// W2 side-effect contract.

// Side-effect: ensures certGraders registry is populated at
// module-load time. Removing this import would defer registration to
// first explicit grader access, which would surface as empty
// findRecognizingGraders() results on the first dispatch call. Keep.
import "../certGraders/index.js";

export { dispatchSearch } from "./dispatcher.js";
export type {
  UnifiedSearchMode,
  UnifiedSearchResponse,
} from "../../types/unifiedSearch.js";
