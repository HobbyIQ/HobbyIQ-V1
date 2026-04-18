// Redis Hot Cache Layer
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || '');

export async function getFromCache(key: string) {
  const val = await redis.get(key);
  return val ? JSON.parse(val) : null;
}

export async function setToCache(key: string, value: any, ttlSeconds: number) {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}
