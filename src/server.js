const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const Redis = require("ioredis");
const mysql = require("mysql2/promise");
const axios = require("axios");

const DEFAULT_PORT = parseInt(process.env.PORT || "8081", 10);
const args = process.argv.slice(2);
let port = DEFAULT_PORT;
const idx = args.indexOf("--port");
if (idx !== -1 && args[idx + 1]) {
  port = parseInt(args[idx + 1], 10) || DEFAULT_PORT;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(
  morgan(":date[iso] :remote-addr :method :url :status - :response-time ms")
);

// [要求1] 引入 Redis，作为商品详情页缓存
const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});
redis.on("error", (err) => {
  console.error("[redis] error:", err.message);
});

// [要求3] MySQL 读写分离配置：写主库、读从库
const mysqlEnabledByEnv =
  (process.env.MYSQL_ENABLED || "false").toLowerCase() === "true";
const mysqlConfig = {
  port: parseInt(process.env.MYSQL_PORT || "3306", 10),
  user: process.env.MYSQL_USER || "app_user",
  password: process.env.MYSQL_PASSWORD || "app_pass123",
  database: process.env.MYSQL_DATABASE || "shop",
  waitForConnections: true,
  connectionLimit: parseInt(process.env.MYSQL_POOL_LIMIT || "10", 10),
  queueLimit: 0,
};
const mysqlWriteHost = process.env.MYSQL_WRITE_HOST || "mysql-master";
const mysqlReadHosts = (process.env.MYSQL_READ_HOSTS || "mysql-replica")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

let mysqlReady = false;
let writePool = null;
let readPools = [];
let readPoolIndex = 0;

// [要求5-可选] ElasticSearch 配置
const esEnabled = (process.env.ES_ENABLED || "false").toLowerCase() === "true";
const esHost = (process.env.ES_HOST || "http://elasticsearch:9200").replace(
  /\/+$/,
  ""
);
const esIndex = process.env.ES_INDEX || "products";

const fakeDb = {
  "1": { id: 1, name: "High Concurrency Programming Practice", price: 99.0, stock: 1000 },
  "2": { id: 2, name: "Distributed Systems Principles", price: 129.0, stock: 500 },
  "3": { id: 3, name: "Redis Design and Implementation", price: 79.0, stock: 800 },
};

let requestCount = 0;

// [要求2] 缓存防护参数：穿透/击穿/雪崩
const CACHE_KEY_PREFIX = "product:";
const CACHE_NULL_TTL = 10;
const CACHE_TTL = 60;
const LOCK_KEY_PREFIX = "lock:product:";
const LOCK_TTL = 5;
const WAIT_RETRY_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry(fn, retries, delayMs, label) {
  let lastError = null;
  for (let i = 1; i <= retries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`[${label}] attempt ${i}/${retries} failed: ${err.message}`);
      if (i < retries) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function createPoolForHost(host) {
  return mysql.createPool({ ...mysqlConfig, host });
}

function pickReadPool() {
  if (!readPools.length) return writePool;
  const pool = readPools[readPoolIndex % readPools.length];
  readPoolIndex += 1;
  return pool;
}

function normalizeProduct(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    price: Number(row.price),
    stock: Number(row.stock),
  };
}

async function initMysql() {
  if (!mysqlEnabledByEnv) return;

  // 写库连接池 -> 主库；读库连接池 -> 从库列表
  writePool = createPoolForHost(mysqlWriteHost);
  readPools = mysqlReadHosts.map((host) => createPoolForHost(host));

  await runWithRetry(
    async () => {
      await writePool.query("SELECT 1");
    },
    20,
    2000,
    "mysql-write-connect"
  );

  await Promise.all(
    readPools.map((pool, idx2) =>
      runWithRetry(
        async () => {
          await pool.query("SELECT 1");
        },
        20,
        2000,
        `mysql-read-connect-${idx2}`
      )
    )
  );

  await writePool.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      stock INT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const [rows] = await writePool.execute("SELECT COUNT(*) AS cnt FROM products");
  if (Number(rows[0].cnt) === 0) {
    await writePool.execute(
      `
      INSERT INTO products (id, name, price, stock)
      VALUES
      (1, 'High Concurrency Programming Practice', 99.00, 1000),
      (2, 'Distributed Systems Principles', 129.00, 500),
      (3, 'Redis Design and Implementation', 79.00, 800)
    `
    );
  }

  mysqlReady = true;
  console.log(
    `[mysql] read/write split enabled, write=${mysqlWriteHost}, reads=${mysqlReadHosts.join(
      ","
    )}`
  );
}

async function queryProductFromDb(id) {
  if (mysqlEnabledByEnv && mysqlReady) {
    // 读请求走从库（轮询）
    const pool = pickReadPool();
    const [rows] = await pool.execute(
      "SELECT id, name, price, stock FROM products WHERE id = ? LIMIT 1",
      [id]
    );
    return normalizeProduct(rows[0] || null);
  }

  await sleep(80);
  return fakeDb[id] || null;
}

async function queryProductFromWriteDb(id) {
  if (mysqlEnabledByEnv && mysqlReady) {
    // 强制读主库，用于读写分离对比测试
    const [rows] = await writePool.execute(
      "SELECT id, name, price, stock FROM products WHERE id = ? LIMIT 1",
      [id]
    );
    return normalizeProduct(rows[0] || null);
  }
  return fakeDb[id] || null;
}

async function updateProductStock(id, stock) {
  if (mysqlEnabledByEnv && mysqlReady) {
    // 写请求只走主库
    const [res] = await writePool.execute(
      "UPDATE products SET stock = ? WHERE id = ?",
      [stock, id]
    );
    return res.affectedRows > 0;
  }
  if (!fakeDb[id]) return false;
  fakeDb[id].stock = stock;
  return true;
}

async function searchProductsFromDb(keyword, limit) {
  if (mysqlEnabledByEnv && mysqlReady) {
    const pool = pickReadPool();
    const [rows] = await pool.execute(
      "SELECT id, name, price, stock FROM products WHERE name LIKE ? ORDER BY id LIMIT ?",
      [`%${keyword}%`, limit]
    );
    return rows.map(normalizeProduct);
  }
  return Object.values(fakeDb)
    .filter((p) => p.name.toLowerCase().includes(keyword.toLowerCase()))
    .slice(0, limit);
}

function getLockToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function acquireLock(lockKey) {
  // [要求2-击穿] 使用 SET NX EX 做互斥锁
  const token = getLockToken();
  const res = await redis.set(lockKey, token, "NX", "EX", LOCK_TTL);
  return res === "OK" ? token : null;
}

async function releaseLock(lockKey, token) {
  if (!token) return;
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;
  try {
    await redis.eval(lua, 1, lockKey, token);
  } catch (err) {
    console.error("[redis-lock] release failed:", err.message);
  }
}

async function getDbNodeInfo(pool) {
  const [rows] = await pool.query(
    "SELECT @@hostname AS host, @@read_only AS readOnly, @@server_id AS serverId"
  );
  return {
    host: rows[0].host,
    readOnly: Number(rows[0].readOnly),
    serverId: Number(rows[0].serverId),
  };
}

async function ensureEsIndex() {
  const url = `${esHost}/${esIndex}`;
  const body = {
    mappings: {
      properties: {
        id: { type: "long" },
        name: { type: "text" },
        price: { type: "double" },
        stock: { type: "integer" },
      },
    },
  };
  const resp = await axios.put(url, body, {
    timeout: 3000,
    validateStatus: (status) => status < 500,
  });
  if (resp.status !== 200 && resp.status !== 201 && resp.status !== 400) {
    throw new Error(`create index failed with status ${resp.status}`);
  }
}

async function syncProductToEs(product) {
  if (!esEnabled) return;
  await axios.put(`${esHost}/${esIndex}/_doc/${product.id}`, product, {
    params: { refresh: "wait_for" },
    timeout: 3000,
  });
}

async function syncAllProductsToEs() {
  if (!esEnabled) return;

  const source = mysqlEnabledByEnv && mysqlReady ? "mysql" : "fake-db";
  let products = [];
  if (source === "mysql") {
    const [rows] = await writePool.execute(
      "SELECT id, name, price, stock FROM products ORDER BY id"
    );
    products = rows.map(normalizeProduct);
  } else {
    products = Object.values(fakeDb);
  }

  for (const p of products) {
    await syncProductToEs(p);
  }
  console.log(`[es] synced ${products.length} products from ${source}`);
}

async function searchProductsFromEs(keyword, limit) {
  if (!esEnabled) return null;
  const resp = await axios.post(
    `${esHost}/${esIndex}/_search`,
    {
      size: limit,
      query: {
        multi_match: {
          query: keyword,
          fields: ["name^2"],
        },
      },
      sort: [{ _score: "desc" }, { id: "asc" }],
    },
    { timeout: 3000 }
  );

  const hits = resp.data?.hits?.hits || [];
  return hits.map((hit) => normalizeProduct(hit._source));
}

app.get("/api/products/:id(\\d+)", async (req, res) => {
  // [要求1+2] 商品详情缓存：包含穿透、击穿、雪崩处理
  const id = String(req.params.id);
  requestCount += 1;

  const cacheKey = CACHE_KEY_PREFIX + id;
  const lockKey = LOCK_KEY_PREFIX + id;

  try {
    const cacheValue = await redis.get(cacheKey);
    if (cacheValue !== null) {
      if (cacheValue === "null") {
        return res
          .status(404)
          .json({ code: 404, msg: "Product not found (cache-null)", data: null });
      }
      const data = JSON.parse(cacheValue);
      return res.json({ code: 0, msg: "OK(cache)", data });
    }

    let lockToken = await acquireLock(lockKey);
    if (!lockToken) {
      for (let i = 0; i < 5; i += 1) {
        await sleep(WAIT_RETRY_MS);
        const retryCache = await redis.get(cacheKey);
        if (retryCache !== null) {
          if (retryCache === "null") {
            return res.status(404).json({
              code: 404,
              msg: "Product not found (cache-null-retry)",
              data: null,
            });
          }
          return res.json({
            code: 0,
            msg: "OK(cache-retry)",
            data: JSON.parse(retryCache),
          });
        }
      }
    }

    const product = await queryProductFromDb(id);
    if (!product) {
      // [要求2-穿透] 空值缓存，短 TTL
      await redis.setex(cacheKey, CACHE_NULL_TTL, "null");
      await releaseLock(lockKey, lockToken);
      return res
        .status(404)
        .json({ code: 404, msg: "Product not found (db)", data: null });
    }

    // [要求2-雪崩] TTL 增加随机抖动，避免同一时刻集中失效
    const ttlWithJitter = CACHE_TTL + Math.floor(Math.random() * 60);
    await redis.setex(cacheKey, ttlWithJitter, JSON.stringify(product));
    await releaseLock(lockKey, lockToken);

    return res.json({ code: 0, msg: "OK(db)", data: product });
  } catch (err) {
    console.error("query product error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.put("/api/products/:id/stock", async (req, res) => {
  // [要求3] 写操作：写主库并删除缓存，保证数据一致性
  const id = String(req.params.id);
  const stock = Number(req.body?.stock);
  if (!Number.isInteger(stock) || stock < 0) {
    return res.status(400).json({ code: 400, msg: "stock must be a non-negative integer" });
  }

  try {
    const updated = await updateProductStock(id, stock);
    if (!updated) {
      return res.status(404).json({ code: 404, msg: "Product not found", data: null });
    }

    const product = await queryProductFromWriteDb(id);
    await redis.del(CACHE_KEY_PREFIX + id);
    if (esEnabled) {
      try {
        await syncProductToEs(product);
      } catch (err) {
        console.error("[es] sync on write failed:", err.message);
      }
    }

    return res.json({
      code: 0,
      msg: "Stock updated on write DB. Product cache invalidated.",
      data: product,
    });
  } catch (err) {
    console.error("update stock error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/db/rw-status", async (req, res) => {
  // [要求4] 返回当前读写路由节点信息，便于验证读写分离
  if (!(mysqlEnabledByEnv && mysqlReady)) {
    return res.status(400).json({
      code: 400,
      msg: "MySQL read/write split not enabled. Set MYSQL_ENABLED=true.",
    });
  }

  try {
    const readPool = pickReadPool();
    const [writeNode, readNode] = await Promise.all([
      getDbNodeInfo(writePool),
      getDbNodeInfo(readPool),
    ]);

    return res.json({
      code: 0,
      msg: "OK",
      data: {
        writeNode,
        readNode,
        strategy: "writes->master, reads->replica(round-robin)",
      },
    });
  } catch (err) {
    console.error("rw-status error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.post("/api/db/rw-test", async (req, res) => {
  // [要求4] 代码内测试：写主库后对比主从读取结果
  if (!(mysqlEnabledByEnv && mysqlReady)) {
    return res.status(400).json({
      code: 400,
      msg: "MySQL read/write split not enabled. Set MYSQL_ENABLED=true.",
    });
  }

  const id = String(req.body?.id || "1");
  const delta = Number(req.body?.delta ?? 1);
  const waitMs = Math.min(Math.max(Number(req.body?.waitMs ?? 1200), 0), 5000);

  if (!Number.isInteger(delta) || delta === 0) {
    return res.status(400).json({ code: 400, msg: "delta must be a non-zero integer" });
  }

  try {
    const readPool = pickReadPool();
    const [beforeMaster, beforeReplica] = await Promise.all([
      queryProductFromWriteDb(id),
      queryProductFromDb(id),
    ]);

    if (!beforeMaster) {
      return res.status(404).json({ code: 404, msg: "Product not found", data: null });
    }

    const newStock = beforeMaster.stock + delta;
    if (newStock < 0) {
      return res.status(400).json({ code: 400, msg: "resulting stock cannot be negative" });
    }

    await updateProductStock(id, newStock);
    await redis.del(CACHE_KEY_PREFIX + id);

    const [immediateMaster, immediateReplica, writeNode, readNode] = await Promise.all([
      queryProductFromWriteDb(id),
      queryProductFromDb(id),
      getDbNodeInfo(writePool),
      getDbNodeInfo(readPool),
    ]);

    await sleep(waitMs);
    const delayedReplica = await queryProductFromDb(id);

    return res.json({
      code: 0,
      msg: "OK",
      data: {
        writeNode,
        readNode,
        productId: Number(id),
        delta,
        before: {
          masterStock: beforeMaster?.stock ?? null,
          replicaStock: beforeReplica?.stock ?? null,
        },
        immediateAfterWrite: {
          masterStock: immediateMaster?.stock ?? null,
          replicaStock: immediateReplica?.stock ?? null,
        },
        delayedReplicaAfterWaitMs: {
          waitMs,
          replicaStock: delayedReplica?.stock ?? null,
        },
      },
    });
  } catch (err) {
    console.error("rw-test error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/products/search", async (req, res) => {
  // [要求5-可选] 商品搜索：优先 ES，失败回退到 DB
  const keyword = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);
  if (!keyword) {
    return res.status(400).json({ code: 400, msg: "q is required" });
  }

  if (esEnabled) {
    try {
      const products = await searchProductsFromEs(keyword, limit);
      return res.json({
        code: 0,
        msg: "OK",
        data: { source: "elasticsearch", list: products },
      });
    } catch (err) {
      console.error("[es] search failed, fallback to db:", err.message);
    }
  }

  try {
    const list = await searchProductsFromDb(keyword, limit);
    return res.json({
      code: 0,
      msg: "OK",
      data: { source: mysqlEnabledByEnv && mysqlReady ? "mysql-like" : "fake-db", list },
    });
  } catch (err) {
    console.error("search error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/instance/info", (req, res) => {
  res.json({
    code: 0,
    msg: "OK",
    data: {
      port,
      requestCount,
      pid: process.pid,
      mysqlReadWriteSplit: mysqlEnabledByEnv && mysqlReady,
      esEnabled,
    },
  });
});

app.get("/", (req, res) => {
  res.send(`Backend instance running on port ${port}`);
});

async function bootstrap() {
  try {
    await initMysql();
  } catch (err) {
    console.error("[mysql] init failed, fallback to fake-db:", err.message);
  }

  if (esEnabled) {
    try {
      await runWithRetry(ensureEsIndex, 20, 2000, "es-init-index");
      await runWithRetry(syncAllProductsToEs, 20, 2000, "es-sync-products");
    } catch (err) {
      console.error("[es] init failed, search will fallback to db:", err.message);
    }
  }

  app.listen(port, () => {
    console.log(`Backend server started on port ${port}`);
  });
}

bootstrap();
