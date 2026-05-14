/**
 * DEPRECATED: Legacy mock CompIQ service.
 * This service has been replaced by real implementations and should not be used.
 * See backend/src/services/compiq/ for live data implementations.
 */

exports.analyzeCompiq = async (input) => {
  throw new Error(
    "[CompIQ] analyzeCompiq() is deprecated and returns only mock data. " +
    "Use searchAndPrice() or compiqEstimate() instead for live data."
  );
};
