// CompProvenanceEngine
export class CompProvenanceEngine {
  static score(comp: any) {
    // TODO: Implement trust scoring (source, parse, normalization, etc.)
    // For now, return 100 for known sources, 70 otherwise
    if (comp.source && ['ebay', 'pwcc', 'goldin'].includes(comp.source.toLowerCase())) {
      return 100;
    }
    return 70;
  }
}
