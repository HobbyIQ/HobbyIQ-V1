export interface SnapshotAgeInput {
  asOf?: string;
  entityType: "card" | "player";
  freshnessTier?: "hot" | "medium" | "cold";
  now?: Date;
}

export interface SnapshotInvalidationResult {
  isExpired: boolean;
  isServeableStale: boolean;
  ageMinutes: number | null;
  reason: string;
}

export class SnapshotInvalidationService {
  constructor(
    private readonly staleServeAllowedMinutes: number,
    private readonly ttlMap: Record<string, number>,
  ) {}

  evaluate(input: SnapshotAgeInput): SnapshotInvalidationResult {
    if (!input.asOf) {
      return {
        isExpired: true,
        isServeableStale: false,
        ageMinutes: null,
        reason: "missing_snapshot_timestamp",
      };
    }

    const now = input.now ?? new Date();
    const ageMinutes = Math.floor((now.getTime() - new Date(input.asOf).getTime()) / 60000);

    const ttl =
      input.entityType === "player"
        ? this.ttlMap.player
        : this.ttlMap[input.freshnessTier ?? "cold"] ?? this.ttlMap.cold;

    const isExpired = ageMinutes > ttl;
    const isServeableStale = isExpired && ageMinutes <= ttl + this.staleServeAllowedMinutes;

    return {
      isExpired,
      isServeableStale,
      ageMinutes,
      reason: isExpired ? "ttl_expired" : "fresh",
    };
  }
}
