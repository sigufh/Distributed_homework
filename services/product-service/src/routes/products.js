const express = require("express");
const router = express.Router();
const { pickReadPool } = require("../db");
const { CACHE_KEY_PREFIX, CACHE_NULL_TTL, CACHE_TTL, LOCK_KEY_PREFIX, LOCK_TTL, WAIT_RETRY_MS, acquireLock, releaseLock, getFromCacheOrDb } = require("../cache");

function normalizeProduct(row) {
  if (!row) return null;
  return { id: Number(row.id), name: row.name, price: Number(row.price), stock: Number(row.stock) };
}

async function queryProductFromDb(id) {
  const pool = pickReadPool();
  if (!pool) return null;
  const [rows] = await pool.execute("SELECT id, name, price, stock FROM products WHERE id = ? LIMIT 1", [id]);
  return normalizeProduct(rows[0] || null);
}

async function searchProductsFromDb(keyword, limit) {
  const pool = pickReadPool();
  if (!pool) return [];
  const [rows] = await pool.execute("SELECT id, name, price, stock FROM products WHERE name LIKE ? ORDER BY id LIMIT ?", [`%${keyword}%`, limit]);
  return rows.map(normalizeProduct);
}

router.get("/:id(\\d+)", async (req, res) => {
  const id = String(req.params.id);
  const cacheKey = CACHE_KEY_PREFIX + id;
  const lockKey = LOCK_KEY_PREFIX + id;
  const redis = req.app.get("redis");

  try {
    const cacheValue = await redis.get(cacheKey);
    if (cacheValue !== null) {
      if (cacheValue === "null") { return res.status(404).json({ code: 404, msg: "Product not found (cache-null)", data: null }); }
      return res.json({ code: 0, msg: "OK(cache)", data: JSON.parse(cacheValue) });
    }

    const lockToken = await acquireLock(redis, lockKey);
    if (!lockToken) {
      for (let i = 0; i < 5; i += 1) {
        await sleep(WAIT_RETRY_MS);
        const retryCache = await redis.get(cacheKey);
        if (retryCache !== null) {
          if (retryCache === "null") { return res.status(404).json({ code: 404, msg: "Product not found (cache-null-retry)", data: null }); }
          return res.json({ code: 0, msg: "OK(cache-retry)", data: JSON.parse(retryCache) });
        }
      }
    }

    const product = await queryProductFromDb(id);
    if (!product) {
      await redis.setex(cacheKey, CACHE_NULL_TTL, "null");
      if (lockToken) await releaseLock(redis, lockKey, lockToken);
      return res.status(404).json({ code: 404, msg: "Product not found (db)", data: null });
    }

    const ttlWithJitter = CACHE_TTL + Math.floor(Math.random() * 60);
    await redis.setex(cacheKey, ttlWithJitter, JSON.stringify(product));
    if (lockToken) await releaseLock(redis, lockKey, lockToken);
    return res.json({ code: 0, msg: "OK(db)", data: product });
  } catch (err) {
    console.error("query product error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.get("/search", async (req, res) => {
  const keyword = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);
  if (!keyword) { return res.status(400).json({ code: 400, msg: "q is required" }); }
  try {
    const list = await searchProductsFromDb(keyword, limit);
    return res.json({ code: 0, msg: "OK", data: { source: "mysql", list } });
  } catch (err) {
    console.error("search error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = router;
