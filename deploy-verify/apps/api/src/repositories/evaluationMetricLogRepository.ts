// src/repositories/evaluationMetricLogRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { EvaluationMetricLog } from "../types/learning";
import { mockEvaluationMetricLogs } from "../data/mockLearning";

const logs: EvaluationMetricLog[] = [...mockEvaluationMetricLogs];

export const evaluationMetricLogRepository = {
  add(log: Omit<EvaluationMetricLog, "id">): EvaluationMetricLog {
    const l: EvaluationMetricLog = { ...log, id: uuidv4() };
    logs.push(l);
    return l;
  },
  getByExperiment(experimentId: string) {
    return logs.filter(l => l.experimentId === experimentId);
  },
  getRecent(limit = 10) {
    return logs.slice(-limit);
  },
  getAll() {
    return [...logs];
  },
};
