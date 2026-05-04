// ScenarioEngine

export class ScenarioEngine {
  static scenarios(fmv: number, confidence: number, volatility: number) {
    // Conservative bands
    const bear = Math.round(fmv * (1 - 0.12 - volatility / 200));
    const base = fmv;
    const bull = Math.round(fmv * (1 + 0.10 - (100 - confidence) / 500));
    return { bear, base, bull };
  }
}
