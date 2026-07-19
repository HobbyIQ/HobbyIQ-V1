// CF-GRADE-CALIBRATION (Drew, 2026-07-18). AUTO-GENERATED from
// backend/scripts/grade-calibrate.mjs against ch_daily_sales.
// Re-run periodically as pool grows. Ratios are graded/raw medians
// per (product-family, grader) with sample sizes ≥ 5 cardIds.
//
// Read at rung 5 of canonicalFmv.service.ts. Fallback to hardcoded
// defaults when a (family, grader) lookup misses.

export interface GradeCalibrationEntry {
  medianRatio: number;
  p25: number;
  p75: number;
  sampleSize: number;
}

export const GRADE_CALIBRATION: Record<string, Record<string, GradeCalibrationEntry>> = {
  "bowman": {
    "BGS": {
      "medianRatio": 2.55,
      "p25": 1.55,
      "p75": 3.96,
      "sampleSize": 109
    },
    "CGC": {
      "medianRatio": 4.11,
      "p25": 1.5,
      "p75": 7.4,
      "sampleSize": 84
    },
    "PSA": {
      "medianRatio": 5.03,
      "p25": 2.71,
      "p75": 9.64,
      "sampleSize": 3295
    },
    "SGC": {
      "medianRatio": 2.72,
      "p25": 1.8,
      "p75": 4.56,
      "sampleSize": 381
    }
  },
  "bowman-chrome": {
    "BGS": {
      "medianRatio": 2.13,
      "p25": 1.47,
      "p75": 3.2,
      "sampleSize": 44
    },
    "CGC": {
      "medianRatio": 2.49,
      "p25": 1.36,
      "p75": 7.99,
      "sampleSize": 30
    },
    "PSA": {
      "medianRatio": 3.46,
      "p25": 2.14,
      "p75": 7,
      "sampleSize": 992
    },
    "SGC": {
      "medianRatio": 2.09,
      "p25": 1.56,
      "p75": 4.23,
      "sampleSize": 60
    }
  },
  "bowman-chrome-draft": {
    "BGS": {
      "medianRatio": 2.08,
      "p25": 1.5,
      "p75": 2.85,
      "sampleSize": 10
    },
    "PSA": {
      "medianRatio": 5.32,
      "p25": 2.89,
      "p75": 7.35,
      "sampleSize": 57
    }
  },
  "bowman-sterling": {
    "PSA": {
      "medianRatio": 3.57,
      "p25": 2.21,
      "p75": 6.24,
      "sampleSize": 14
    }
  },
  "panini-donruss": {
    "BGS": {
      "medianRatio": 6,
      "p25": 4.12,
      "p75": 9.06,
      "sampleSize": 36
    },
    "CGC": {
      "medianRatio": 4.28,
      "p25": 2.51,
      "p75": 8.63,
      "sampleSize": 36
    },
    "PSA": {
      "medianRatio": 18.81,
      "p25": 12.34,
      "p75": 27.08,
      "sampleSize": 624
    },
    "SGC": {
      "medianRatio": 5.35,
      "p25": 3.79,
      "p75": 8.77,
      "sampleSize": 64
    }
  },
  "panini-mosaic": {
    "PSA": {
      "medianRatio": 15.87,
      "p25": 6.23,
      "p75": 31.84,
      "sampleSize": 6
    }
  },
  "panini-optic": {
    "PSA": {
      "medianRatio": 2.64,
      "p25": 2.19,
      "p75": 5.31,
      "sampleSize": 29
    }
  },
  "panini-prizm": {
    "CGC": {
      "medianRatio": 4.72,
      "p25": 2.55,
      "p75": 6.79,
      "sampleSize": 6
    },
    "PSA": {
      "medianRatio": 3.86,
      "p25": 2,
      "p75": 9.88,
      "sampleSize": 104
    }
  },
  "panini-select": {
    "PSA": {
      "medianRatio": 9.6,
      "p25": 6.42,
      "p75": 15.31,
      "sampleSize": 26
    }
  },
  "topps-chrome": {
    "BGS": {
      "medianRatio": 2.23,
      "p25": 1.56,
      "p75": 3.39,
      "sampleSize": 35
    },
    "CGC": {
      "medianRatio": 5.89,
      "p25": 2.58,
      "p75": 8.82,
      "sampleSize": 54
    },
    "PSA": {
      "medianRatio": 5.78,
      "p25": 3.06,
      "p75": 10.53,
      "sampleSize": 1092
    },
    "SGC": {
      "medianRatio": 3.87,
      "p25": 2.5,
      "p75": 6.12,
      "sampleSize": 110
    }
  },
  "topps-chrome-update": {
    "CGC": {
      "medianRatio": 4.73,
      "p25": 1.96,
      "p75": 7.32,
      "sampleSize": 19
    },
    "PSA": {
      "medianRatio": 7.11,
      "p25": 3.68,
      "p75": 11.8,
      "sampleSize": 231
    },
    "SGC": {
      "medianRatio": 2.85,
      "p25": 1.79,
      "p75": 3.45,
      "sampleSize": 18
    }
  },
  "topps-update": {
    "BGS": {
      "medianRatio": 3.12,
      "p25": 2.52,
      "p75": 3.45,
      "sampleSize": 15
    },
    "CGC": {
      "medianRatio": 5.67,
      "p25": 2.27,
      "p75": 10.25,
      "sampleSize": 34
    },
    "PSA": {
      "medianRatio": 6.4,
      "p25": 3.23,
      "p75": 10.92,
      "sampleSize": 320
    },
    "SGC": {
      "medianRatio": 2.87,
      "p25": 1.78,
      "p75": 5.69,
      "sampleSize": 38
    }
  },
  "upper-deck": {
    "BGS": {
      "medianRatio": 6.73,
      "p25": 4.52,
      "p75": 9.95,
      "sampleSize": 34
    },
    "CGC": {
      "medianRatio": 4.58,
      "p25": 3.26,
      "p75": 6.48,
      "sampleSize": 25
    },
    "PSA": {
      "medianRatio": 17.39,
      "p25": 10.91,
      "p75": 24.62,
      "sampleSize": 291
    },
    "SGC": {
      "medianRatio": 5.13,
      "p25": 3.27,
      "p75": 7.94,
      "sampleSize": 30
    }
  }
};

/** Lookup helper. Returns null when the (family, grader) is uncovered. */
export function lookupGradeRatio(family: string, grader: string): number | null {
  const entry = GRADE_CALIBRATION[family]?.[grader];
  return entry ? entry.medianRatio : null;
}

/** Product-family classifier matching the calibration script. Any set
 *  string maps to a canonical family key or "other". */
export function classifyFamily(setName: string | null | undefined): string {
  const s = String(setName ?? "").toLowerCase();
  if (s.includes("bowman chrome draft") || s.includes("bowman draft chrome")) return "bowman-chrome-draft";
  if (s.includes("bowman chrome")) return "bowman-chrome";
  if (s.includes("bowman sterling")) return "bowman-sterling";
  if (s.includes("bowman")) return "bowman";
  if (s.includes("topps chrome update")) return "topps-chrome-update";
  if (s.includes("topps chrome")) return "topps-chrome";
  if (s.includes("topps update")) return "topps-update";
  if (s.includes("topps")) return "topps";
  if (s.includes("prizm")) return "panini-prizm";
  if (s.includes("select")) return "panini-select";
  if (s.includes("mosaic")) return "panini-mosaic";
  if (s.includes("donruss")) return "panini-donruss";
  if (s.includes("optic")) return "panini-optic";
  if (s.includes("upper deck")) return "upper-deck";
  return "other";
}
