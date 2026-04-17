const ACTIVE_LOCK_TTL_MS = 60_000;

export class RefreshDeduperService {
  private readonly active = new Map<string, number>();

  tryAcquire(entityType: "card" | "player", entityKey: string): boolean {
    const key = `${entityType}:${entityKey}`;
    const now = Date.now();
    const existing = this.active.get(key);

    if (existing && now - existing < ACTIVE_LOCK_TTL_MS) {
      return false;
    }

    this.active.set(key, now);
    return true;
  }

  release(entityType: "card" | "player", entityKey: string): void {
    this.active.delete(`${entityType}:${entityKey}`);
  }
}
