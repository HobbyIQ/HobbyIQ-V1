// src/types/cards.ts
export interface Card {
  id: string;
  playerId: string;
  set: string;
  brand: string;
  year: number;
  grade: string | null;
  grader: string | null;
  isAuto: boolean;
  isNumbered: boolean;
  serialNumber: string | null;
  parallel: string | null;
  variation: string | null;
  prospect: boolean;
  mlb: boolean;
  team: string;
}
