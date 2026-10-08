import { env } from "./env";
import { log } from "./logger";

/**
 * Fixed-window rate limiter. Uses Redis when REDIS_URL is configured so limits
 * hold across instances; falls back to process memory for local development.
 */
export class RateLimitedError extends Error {}

const memory = new Map<string, { count: number; resetAt: number }>();
let redisClient: import("ioredis").Redis | null | undefined;

async function redis() {
  if (redisClient !== undefined) return redisClient;
  const url = env().REDIS_URL;
  if (!url || env().NODE_ENV === "test") return (redisClient = null);
  try {
    const { Redis } = await import("ioredis");
    redisClient = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false });
    await redisClient.connect();
  } catch (e) {
    log.warn("rate limiter falling back to memory", { error: e });
    redisClient = null;
  }
  return redisClient;
}

export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const r = await redis();
  if (r) {
    const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, windowSeconds);
    if (n > limit) throw new RateLimitedError(key);
    return;
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt < now) {
    memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return;
  }
  entry.count++;
  if (entry.count > limit) throw new RateLimitedError(key);
}
