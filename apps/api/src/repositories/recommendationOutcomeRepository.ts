// src/repositories/recommendationOutcomeRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { RecommendationOutcome } from "../types/learning";
import { mockRecommendationOutcomes } from "../data/mockLearning";

const outcomes: RecommendationOutcome[] = [...mockRecommendationOutcomes];

export const recommendationOutcomeRepository = {
  add(outcome: Omit<RecommendationOutcome, "id">): RecommendationOutcome {
    const o: RecommendationOutcome = { ...outcome, id: uuidv4() };
    outcomes.push(o);
    return o;
  },
  getByRecommendation(recommendationId: string) {
    return outcomes.filter(o => o.recommendationId === recommendationId);
  },
  getRecent(limit = 10) {
    return outcomes.slice(-limit);
  },
  getAll() {
    return [...outcomes];
  },
};
