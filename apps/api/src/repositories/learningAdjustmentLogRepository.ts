// src/repositories/learningAdjustmentLogRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { LearningAdjustmentLog } from "../types/learning";
import { mockLearningAdjustmentLogs } from "../data/mockLearning";

const logs: LearningAdjustmentLog[] = [...mockLearningAdjustmentLogs];

export const learningAdjustmentLogRepository = {
  add(log: Omit<LearningAdjustmentLog, "id">): LearningAdjustmentLog {
    const l: LearningAdjustmentLog = { ...log, id: uuidv4() };
    logs.push(l);
    return l;
  },
  getBySegment(segment: string) {
    return logs.filter(l => l.marketSegment === segment);
  },
  getRecent(limit = 10) {
    return logs.slice(-limit);
  },
  getAll() {
    return [...logs];
  },
};
