/**
 * DEPRECATED: Legacy mock PlayerIQ service.
 * This service has been replaced and should not be used.
 * PlayerIQ functionality has moved to DailyIQ (/api/dailyiq).
 */

exports.analyzePlayeriq = async (input) => {
  throw new Error(
    "[PlayerIQ] analyzePlayeriq() is deprecated and returns only mock data. " +
    "Use /api/dailyiq for player performance tracking instead."
  );
};
