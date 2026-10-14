/**
 * Small in-memory cache with a time-to-live. A Databricks statement can take
 * around one second, and src/proxy.ts checks access on every page and API
 * request, so each person's access result should be cached briefly (about
 * 30 seconds) and that person's entry cleared whenever User Management
 * changes them.
 *
 * Not wired into CI yet: the CI user lookup has no Databricks source. When
 * the CI Databricks repository is connected, use it for the per-request user
 * lookup (server/ci/access.ts and server/ci/current-user.ts) and call
 * `delete(email)` from every User Management write.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  private static key(key: string): string {
    return key.trim().toLowerCase();
  }

  get(key: string): V | undefined {
    const hit = this.entries.get(TtlCache.key(key));
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(TtlCache.key(key));
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.entries.set(TtlCache.key(key), { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string | null | undefined): void {
    if (key) this.entries.delete(TtlCache.key(key));
  }

  clear(): void {
    this.entries.clear();
  }

  /** Cached value, or load + cache it. */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await load();
    this.set(key, value);
    return value;
  }
}
