const CACHE_KEY_PREFIX = "product:";
const CACHE_NULL_TTL = 10;
const CACHE_TTL = 60;
const LOCK_KEY_PREFIX = "lock:product:";
const LOCK_TTL = 5;
const WAIT_RETRY_MS = 100;

function getLockToken() { return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

async function acquireLock(redis, lockKey) {
  const token = getLockToken();
  const res = await redis.set(lockKey, token, "NX", "EX", LOCK_TTL);
  return res === "OK" ? token : null;
}

async function releaseLock(redis, lockKey, token) {
  if (!token) return;
  const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
  try { await redis.eval(lua, 1, lockKey, token); }
  catch (err) { console.error("[redis-lock] release failed:", err.message); }
}

async function getFromCacheOrDb(redis, cacheKey, dbFn) {
  const cacheValue = await redis.get(cacheKey);
  if (cacheValue !== null) {
    if (cacheValue === "null") { return { fromCache: true, data: null }; }
    return { fromCache: true, data: JSON.parse(cacheValue) };
  }
  const data = await dbFn();
  if (!data) {
    await redis.setex(cacheKey, CACHE_NULL_TTL, "null");
    return { fromCache: true, data: null };
  }
  const ttlWithJitter = CACHE_TTL + Math.floor(Math.random() * 60);
  await redis.setex(cacheKey, ttlWithJitter, JSON.stringify(data));
  return { fromCache: false, data };
}

module.exports = { CACHE_KEY_PREFIX, CACHE_NULL_TTL, CACHE_TTL, LOCK_KEY_PREFIX, LOCK_TTL, WAIT_RETRY_MS, acquireLock, releaseLock, getFromCacheOrDb };
