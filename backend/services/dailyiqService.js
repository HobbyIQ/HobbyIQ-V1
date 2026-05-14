/**
 * DEPRECATED: Legacy mock DailyIQ service.
 * This service has been replaced by real TypeScript implementations.
 * See backend/src/services/dailyiq/ for live data implementations.
 */

exports.getDailyBrief = async () => {
  throw new Error(
    "[DailyIQ] getDailyBrief() is deprecated and returns only mock data. " +
    "Use the TypeScript DailyIQ routes instead (/api/dailyiq)."
  );
};
