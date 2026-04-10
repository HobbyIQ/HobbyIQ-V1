// src/repositories/modelWeightProfileRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { ModelWeightProfile } from "../types/learning";
import { mockWeightProfiles } from "../data/mockLearning";

const profiles: ModelWeightProfile[] = [...mockWeightProfiles];

export const modelWeightProfileRepository = {
  add(profile: Omit<ModelWeightProfile, "id">): ModelWeightProfile {
    const p: ModelWeightProfile = { ...profile, id: uuidv4() };
    profiles.push(p);
    return p;
  },
  getBySegment(segment: string) {
    return profiles.filter(p => p.marketSegment === segment);
  },
  getActiveBySegment(segment: string) {
    // Return latest approved profile for segment
    return profiles.filter(p => p.marketSegment === segment && p.approved)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  },
  getAll() {
    return [...profiles];
  },
};
