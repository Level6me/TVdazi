interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * 带容量上限与 TTL 过期淘汰的通用 LRU 缓存
 */
export class LruCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 200, defaultTtlMs: number = 10 * 60 * 1000) {
    this.maxSize = Math.max(1, maxSize);
    this.defaultTtlMs = Math.max(1, defaultTtlMs);
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // 刷新 LRU 访问顺序
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      this.pruneExpired();
      if (this.map.size >= this.maxSize) {
        const oldestKey = this.map.keys().next().value;
        if (oldestKey !== undefined) {
          this.map.delete(oldestKey);
        }
      }
    }
    this.map.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.map.entries()) {
      if (now > entry.expiresAt) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }

  stats(): { size: number; maxSize: number; hits: number; misses: number } {
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
