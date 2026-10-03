/** Process-local LRU with independent entry/weight limits and a non-sliding lifetime. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { key: K; value: V; weight: number; expiresAt: number }>();
  private weight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly lifetimeMs: number,
    private readonly now = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1
      || !Number.isSafeInteger(maxWeight) || maxWeight < 1
      || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
      throw new Error("Cache limits must be positive and finite");
    }
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) {
      this.weight -= entry.weight;
      return undefined;
    }
    // Preserve the admitted key's storage. An equal string supplied for lookup may
    // be a slice that retains an entire request buffer in the JavaScript engine.
    this.entries.set(entry.key, entry);
    return entry.value;
  }

  set(key: K, value: V, weight: number): void {
    if (!Number.isSafeInteger(weight) || weight < 0) throw new Error("Cache weight must be non-negative");
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.weight -= previous.weight;
    }
    if (weight > this.maxWeight) return;
    const now = this.now();
    // Expired entries must not evict a still-valid entry that was recently accessed.
    for (const [cachedKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(cachedKey);
        this.weight -= entry.weight;
      }
    }
    this.entries.set(key, { key, value, weight, expiresAt: now + this.lifetimeMs });
    this.weight += weight;
    while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.weight -= oldest[1].weight;
    }
  }
}
