// src/repositories/pricingOutcomeRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { PricingOutcome } from "../types/learning";
import { mockPricingOutcomes } from "../data/mockLearning";

const outcomes: PricingOutcome[] = [...mockPricingOutcomes];

export const pricingOutcomeRepository = {
  add(outcome: Omit<PricingOutcome, "id">): PricingOutcome {
    const o: PricingOutcome = { ...outcome, id: uuidv4() };
    outcomes.push(o);
    return o;
  },
  getBySnapshot(snapshotId: string) {
    return outcomes.filter(o => o.snapshotId === snapshotId);
  },
  getRecent(limit = 10) {
    return outcomes.slice(-limit);
  },
  getAll() {
    return [...outcomes];
  },
};
