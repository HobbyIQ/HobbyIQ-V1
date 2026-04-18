// CompQualityService: Grades comp quality for a set of comps
import type { CompQualityGrade } from "../../../types/marketDecision";

export function gradeCompQuality(context: any): CompQualityGrade {
  // TODO: Use real comp data
  return {
    grade: "A",
    compCount: context.compCount || 5,
    recencyScore: 0.9,
    cleanlinessScore: 0.95,
    normalizationRiskScore: 0.1,
    thinMarket: false,
    outlierRisk: false,
    explanation: ["Many recent, clean comps with low normalization risk."]
  };
}
