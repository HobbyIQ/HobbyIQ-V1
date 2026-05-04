// CompDedupeEngine
export class CompDedupeEngine {
  static dedupe(comps: any[]) {
    // TODO: Implement deduplication logic (by id, title, date, price, etc.)
    // For now, return unique by id or title+date+price
    const seen = new Set();
    return comps.filter((comp: any) => {
      const key = comp.id || `${comp.title}-${comp.date}-${comp.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
