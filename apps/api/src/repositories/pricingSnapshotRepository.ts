// src/repositories/pricingSnapshotRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { PricingSnapshot } from "../types/learning";
import { mockPricingSnapshots } from "../data/mockLearning";

const snapshots: PricingSnapshot[] = [...mockPricingSnapshots];

export const pricingSnapshotRepository = {
  add(snapshot: Omit<PricingSnapshot, "id">): PricingSnapshot {
    const snap: PricingSnapshot = { ...snapshot, id: uuidv4() };
    snapshots.push(snap);
    return snap;
  },
  getByCard(cardId: string) {
    return snapshots.filter(s => s.cardId === cardId);
  },
  getRecent(limit = 10) {
    return snapshots.slice(-limit);
  },
  getUnresolved() {
    // Snapshots with no matching outcome
    return snapshots.filter(s => !snapshots.some(o => o.id === s.id));
  },
  getAll() {
    return [...snapshots];
  },
};
