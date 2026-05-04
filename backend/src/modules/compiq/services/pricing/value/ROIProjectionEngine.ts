// ROIProjectionEngine

export class ROIProjectionEngine {
  static project(timing: number, trend: 'up' | 'flat' | 'down', risk: number) {
    // Conservative deterministic logic
    let roi30d = 0, roi90d = 0, roi6m = 0;
    if (trend === 'up') {
      roi30d = 3;
      roi90d = 7;
      roi6m = 12;
    } else if (trend === 'flat') {
      roi30d = 1;
      roi90d = 3;
      roi6m = 5;
    } else {
      roi30d = -2;
      roi90d = -4;
      roi6m = -7;
    }
    // Risk penalty
    roi30d -= Math.round(risk / 20);
    roi90d -= Math.round(risk / 20);
    roi6m -= Math.round(risk / 15);
    return { roi30d, roi90d, roi6m };
  }
}
