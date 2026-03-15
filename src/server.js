const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const Redis = require("ioredis");

// 从命令行或环境变量读取端口
const DEFAULT_PORT = process.env.PORT || 8081;
const args = process.argv.slice(2);
let port = DEFAULT_PORT;
const idx = args.indexOf("--port");
if (idx !== -1 && args[idx + 1]) {
  port = parseInt(args[idx + 1], 10) || DEFAULT_PORT;
}

// Redis 连接（在 docker-compose 中通过服务名 redis 访问）
const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: process.env.REDIS_PORT || 6379,
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(
  morgan(":date[iso] :remote-addr :method :url :status - :response-time ms")
);

// 简单的“数据库”模拟
const fakeDb = {
  "1": { id: 1, name: "高并发编程实战", price: 99.0, stock: 1000 },
  "2": { id: 2, name: "分布式系统原理", price: 129.0, stock: 500 },
  "3": { id: 3, name: "Redis 设计与实现", price: 79.0, stock: 800 },
};

// 模拟数据库访问延迟
function queryProductFromDb(id) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(fakeDb[id] || null);
    }, 80); // e.g. 80ms
  });
}

// 统计每个实例处理的请求数量，方便前端展示
let requestCount = 0;

// 缓存 key 前缀
const CACHE_KEY_PREFIX = "product:";
const CACHE_NULL_TTL = 10; // 空对象短 TTL，防止缓存穿透
const CACHE_TTL = 60; // 正常缓存 TTL

// 简单的互斥锁实现，防止缓存击穿（单机级别）
const LOCK_KEY_PREFIX = "lock:product:";
const LOCK_TTL = 5; // 秒
const WAIT_RETRY_MS = 100;

async function acquireLock(lockKey) {
  const res = await redis.set(lockKey, "1", "NX", "EX", LOCK_TTL);
  return res === "OK";
}

async function releaseLock(lockKey) {
  try {
    await redis.del(lockKey);
  } catch (e) {
    // ignore
  }
}

// 商品详情接口：带 Redis 缓存、穿透/击穿/雪崩 保护
app.get("/api/products/:id", async (req, res) => {
  const id = req.params.id;
  requestCount += 1;

  const cacheKey = CACHE_KEY_PREFIX + id;
  const lockKey = LOCK_KEY_PREFIX + id;

  try {
    // 1. 先读缓存
    const cacheValue = await redis.get(cacheKey);
    if (cacheValue !== null) {
      if (cacheValue === "null") {
        // 空对象占位，防止缓存穿透
        return res.status(404).json({ code: 404, msg: "商品不存在(缓存)", data: null });
      }
      const data = JSON.parse(cacheValue);
      return res.json({ code: 0, msg: "OK(缓存)", data });
    }

    // 2. 缓存未命中，尝试加锁，防止缓存击穿
    let lockAcquired = await acquireLock(lockKey);
    if (!lockAcquired) {
      // 其他线程/实例正在重建缓存，当前请求稍等再读缓存
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, WAIT_RETRY_MS));
        const retryCache = await redis.get(cacheKey);
        if (retryCache !== null) {
          if (retryCache === "null") {
            return res
              .status(404)
              .json({ code: 404, msg: "商品不存在(缓存-重试)", data: null });
          }
          const retryData = JSON.parse(retryCache);
          return res.json({ code: 0, msg: "OK(缓存-重试)", data: retryData });
        }
      }
      // 仍然没有缓存，直接查库（退化处理）
    }

    // 3. 查询“数据库”
    const product = await queryProductFromDb(id);
    if (!product) {
      // 缓存空对象，短 TTL，防止缓存穿透
      await redis.setex(cacheKey, CACHE_NULL_TTL, "null");
      if (lockAcquired) await releaseLock(lockKey);
      return res
        .status(404)
        .json({ code: 404, msg: "商品不存在(数据库)", data: null });
    }

    // 4. 设置缓存，TTL 随机 + 抖动，缓解缓存雪崩
    const ttlWithJitter = CACHE_TTL + Math.floor(Math.random() * 60);
    await redis.setex(cacheKey, ttlWithJitter, JSON.stringify(product));
    if (lockAcquired) await releaseLock(lockKey);

    return res.json({ code: 0, msg: "OK(数据库)", data: product });
  } catch (err) {
    console.error("查询商品出错:", err);
    return res.status(500).json({ code: 500, msg: "服务器错误" });
  }
});

// 实例信息 & 统计，用于前端展示负载情况
app.get("/api/instance/info", (req, res) => {
  res.json({
    code: 0,
    msg: "OK",
    data: {
      port,
      requestCount,
      pid: process.pid,
    },
  });
});

app.get("/", (req, res) => {
  res.send(`Backend instance running on port ${port}`);
});

app.listen(port, () => {
  console.log(`Backend server started on port ${port}`);
});

