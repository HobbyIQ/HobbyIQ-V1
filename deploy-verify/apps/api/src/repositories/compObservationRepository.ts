// src/repositories/compObservationRepository.ts
import { v4 as uuidv4 } from "uuid";
import type { CompObservation } from "../types/learning";

const compObservations: CompObservation[] = [];

export const compObservationRepository = {
  add(observation: Omit<CompObservation, "id">): CompObservation {
    const obs: CompObservation = { ...observation, id: uuidv4() };
    compObservations.push(obs);
    return obs;
  },
  getByCard(cardId: string) {
    return compObservations.filter(o => o.cardId === cardId);
  },
  getRecent(limit = 10) {
    return compObservations.slice(-limit);
  },
  getAll() {
    return [...compObservations];
  },
};
