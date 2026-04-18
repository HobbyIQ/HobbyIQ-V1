// Gold Layer: Curated Intelligence Snapshots
// Stores precomputed intelligence outputs for cards/players

export interface GoldSnapshot {
  id: string;
  entityKey: string;
  asOf: Date;
  expiresAt: Date;
  confidence: number;
  sourceCount: number;
  modelVersion: string;
  inputFeatures: any;
  output: any;
  snapshotType: string; // e.g., 'cardMarket', 'playerMarket', etc.
}
