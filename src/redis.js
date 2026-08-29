import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
  lazyConnect: false,
});

redis.on("error", (err) => console.error("[redis] connection error:", err.message));

/**
 * Runs fn() while holding a short-lived per-key lock, so two app replicas
 * polling on their own cron schedules can't process the same repo at once.
 * Returns null (and skips fn) if the lock is already held.
 */
export async function withLock(key, ttlMs, fn) {
  const lockKey = `lock:${key}`;
  const token = `${process.pid}:${Date.now()}`;

  const acquired = await redis.set(lockKey, token, "PX", ttlMs, "NX");
  if (!acquired) return null;

  try {
    return await fn();
  } finally {
    // Only release if we still hold it (best-effort — a stale lock just expires via TTL).
    const current = await redis.get(lockKey).catch(() => null);
    if (current === token) await redis.del(lockKey).catch(() => {});
  }
}

/**
 * Cache-aside helper for hot, frequently-read, rarely-changing values
 * (e.g. the dashboard's repo/alert lists) — cuts Postgres load without
 * needing explicit invalidation, since the TTL is short.
 */
export async function cached(key, ttlSec, fn) {
  const cacheKey = `cache:${key}`;
  const hit = await redis.get(cacheKey).catch(() => null);
  if (hit !== null) return JSON.parse(hit);

  const value = await fn();
  await redis.set(cacheKey, JSON.stringify(value), "EX", ttlSec).catch(() => {});
  return value;
}

export default redis;
