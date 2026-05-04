// AliasResolver: maps marketplace naming variants to canonical forms
export class AliasResolver {
  static resolve(name: string): string {
    // TODO: Implement robust alias mapping (e.g., blue shimmer <-> shimmer blue)
    return name.trim().toLowerCase();
  }
}
