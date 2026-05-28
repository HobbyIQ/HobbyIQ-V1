// CF-UNIFIED-SEARCH-AND-CERT v1 W2 — cert-grader registration index.
//
// Per design doc 23038d7 §1. Importing this module triggers the
// side-effect registration of every shipped grader. v1 registers only
// PSA. v1.5 grader CFs each add ONE registration line below; no other
// file in this directory or the dispatcher (W3) changes.
//
// Re-exports the registry surface for convenience so the W3 dispatcher
// can import everything from one path:
//   import { findRecognizingGraders, listCertGraders } from ".../certGraders/index.js";

import { registerCertGrader } from "./registry.js";
import { psaCertGrader } from "./psa.grader.js";

registerCertGrader(psaCertGrader);

// v1.5 graders register here, one line each. Pattern:
//   import { bgsCertGrader } from "./bgs.grader.js"; registerCertGrader(bgsCertGrader);
//   import { sgcCertGrader } from "./sgc.grader.js"; registerCertGrader(sgcCertGrader);
//   import { cgcCertGrader } from "./cgc.grader.js"; registerCertGrader(cgcCertGrader);

export {
  findRecognizingGraders,
  getCertGrader,
  listCertGraders,
  registerCertGrader,
} from "./registry.js";
export {
  CertGraderError,
  type CertGrader,
  type CertGraderErrorCode,
  type CertLookupResult,
} from "./certGrader.js";
