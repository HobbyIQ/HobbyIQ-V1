// src/repositories/promptExperimentRunRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { PromptExperimentRun } from "../types/learning";
import { mockPromptExperimentRuns } from "../data/mockLearning";

const runs: PromptExperimentRun[] = [...mockPromptExperimentRuns];

export const promptExperimentRunRepository = {
  add(run: Omit<PromptExperimentRun, "id">): PromptExperimentRun {
    const r: PromptExperimentRun = { ...run, id: uuidv4() };
    runs.push(r);
    return r;
  },
  getRecent(limit = 10) {
    return runs.slice(-limit);
  },
  getAll() {
    return [...runs];
  },
};
