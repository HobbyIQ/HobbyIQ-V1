// CompNormalizer: normalizes raw comps against subject card
import { CompInput, NormalizedComp } from '../../../models/comp.types.js';
import { CardSubject } from '../../../models/pricing.types.js';
export class CompNormalizer {
  static normalize(comp: CompInput, subject: CardSubject): NormalizedComp {
    // TODO: Implement robust normalization and similarity scoring
    return {
      ...comp,
      normalized: true
    };
  }
}
