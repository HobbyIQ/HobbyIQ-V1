// CompStrengthEngine: scores comp strength
import { NormalizedComp } from '../../../models/comp.types.js';
export class CompStrengthEngine {
  static score(comp: NormalizedComp): number {
    // TODO: Use recency, auction/BIN, bidder count, feedback, completeness, etc.
    return 80;
  }
}
