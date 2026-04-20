
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const Redis = require("ioredis");
const mysql = require("mysql2/promise");
const axios = require("axios");
const { Kafka, logLevel } = require("kafkajs");

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

// [要求1] Redis 缓存
const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});
redis.on("error", (err) => {
  console.error("[redis] error:", err.message);
});

// [要求3] MySQL 读写分离
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
  supportBigNumbers: true,
  bigNumberStrings: true,
};
const mysqlWriteHost = process.env.MYSQL_WRITE_HOST || "mysql-master";
const mysqlReadHosts = (process.env.MYSQL_READ_HOSTS || "mysql-replica")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

// [选做] 订单分库分表（ShardingSphere-Proxy）
const orderShardingEnabled =
  (process.env.ORDER_SHARDING_ENABLED || "false").toLowerCase() === "true";
const orderDbPort = parseInt(process.env.ORDER_DB_PORT || process.env.MYSQL_PORT || "3306", 10);
const orderDbUser = process.env.ORDER_DB_USER || process.env.MYSQL_USER || "app_user";
const orderDbPassword =
  process.env.ORDER_DB_PASSWORD || process.env.MYSQL_PASSWORD || "app_pass123";
const orderDbName = process.env.ORDER_DB_DATABASE || process.env.MYSQL_DATABASE || "shop";
const orderDbWriteHost = process.env.ORDER_DB_HOST || mysqlWriteHost;
const orderDbReadHosts = (
  process.env.ORDER_DB_READ_HOSTS ||
  process.env.ORDER_DB_HOST ||
  mysqlReadHosts.join(",")
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

// [要求5-可选] ElasticSearch
const esEnabled = (process.env.ES_ENABLED || "false").toLowerCase() === "true";
const esHost = (process.env.ES_HOST || "http://elasticsearch:9200").replace(
  /\/+$/,
  ""
);
const esIndex = process.env.ES_INDEX || "products";

// [秒杀扩展] Kafka 异步下单
const kafkaEnabled = (process.env.KAFKA_ENABLED || "false").toLowerCase() === "true";
const kafkaBrokers = (process.env.KAFKA_BROKERS || "kafka:9092")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const kafkaClientId = process.env.KAFKA_CLIENT_ID || "distributed-homework";
const kafkaTopic = process.env.KAFKA_TOPIC_SECKILL_ORDER || "seckill-order-create";
const kafkaTopicPayRequest =
  process.env.KAFKA_TOPIC_PAYMENT_REQUEST || "order-payment-request";
const kafkaTopicPayResult = process.env.KAFKA_TOPIC_PAYMENT_RESULT || "order-payment-result";
const kafkaConsumerGroup = process.env.KAFKA_CONSUMER_GROUP || "seckill-order-worker";
const paymentOutboxDispatchIntervalMs = Math.min(
  Math.max(parseInt(process.env.PAYMENT_OUTBOX_DISPATCH_MS || "2000", 10), 500),
  10000
);

let mysqlReady = false;
let writePool = null;
let readPools = [];
let readPoolIndex = 0;
let orderWritePool = null;
let orderReadPools = [];
let orderReadPoolIndex = 0;

let kafkaReady = false;
let kafkaProducer = null;
let kafkaConsumer = null;
let paymentOutboxTimer = null;

const fakeDb = {
  "1": { id: 1, name: "High Concurrency Programming Practice", price: 99.0, stock: 1000 },
  "2": { id: 2, name: "Distributed Systems Principles", price: 129.0, stock: 500 },
  "3": { id: 3, name: "Redis Design and Implementation", price: 79.0, stock: 800 },
};
const fakeOrders = new Map();
const fakeUserProductOrders = new Map();
const fakePaymentsByOrder = new Map();

let requestCount = 0;

const CACHE_KEY_PREFIX = "product:";
const CACHE_NULL_TTL = 10;
const CACHE_TTL = 60;
const LOCK_KEY_PREFIX = "lock:product:";
const LOCK_TTL = 5;
const WAIT_RETRY_MS = 100;

const SECKILL_STOCK_PREFIX = "seckill:stock:";
const SECKILL_USER_ORDER_PREFIX = "seckill:user-order:";
const SECKILL_USER_ORDER_TTL = 24 * 3600;
const ORDER_STATUS_PREFIX = "order:status:";
const ORDER_STATUS_TTL = 7 * 24 * 3600;
const ORDER_COMPENSATE_PREFIX = "seckill:compensated:";
const ORDER_COMPENSATE_TTL = 7 * 24 * 3600;
const PAYMENT_EVENT_CONSUMED_PREFIX = "payment:event:consumed:";

const ORDER_DB_STATUS_CREATED = "CREATED";
const ORDER_DB_STATUS_PAY_PENDING = "PAY_PENDING";
const ORDER_DB_STATUS_PAID = "PAID";
const ORDER_DB_STATUS_PAY_FAILED = "PAY_FAILED";

class SnowflakeIdGenerator {
  constructor(workerId) {
    this.epoch = BigInt(1704067200000);
    this.workerIdBits = BigInt(10);
    this.sequenceBits = BigInt(12);
    this.maxWorkerId = (1n << this.workerIdBits) - 1n;
    this.maxSequence = (1n << this.sequenceBits) - 1n;
    this.workerId = BigInt(workerId) & this.maxWorkerId;
    this.lastTimestamp = -1n;
    this.sequence = 0n;
  }

  currentMillis() {
    return BigInt(Date.now());
  }

  waitNextMillis(lastTs) {
    let ts = this.currentMillis();
    while (ts <= lastTs) {
      ts = this.currentMillis();
    }
    return ts;
  }

  nextId() {
    let ts = this.currentMillis();
    if (ts < this.lastTimestamp) {
      ts = this.lastTimestamp;
    }

    if (ts === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & this.maxSequence;
      if (this.sequence === 0n) {
        ts = this.waitNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = ts;

    const timePart = (ts - this.epoch) << (this.workerIdBits + this.sequenceBits);
    const workerPart = this.workerId << this.sequenceBits;
    const id = timePart | workerPart | this.sequence;
    return id.toString();
  }
}

const idGenerator = new SnowflakeIdGenerator(
  parseInt(process.env.WORKER_ID || String(port % 1024), 10)
);

const RESERVE_STOCK_LUA = `
local stockKey = KEYS[1]
local userOrderKey = KEYS[2]
local orderId = ARGV[1]
local ttl = tonumber(ARGV[2])
if redis.call("EXISTS", userOrderKey) == 1 then
  return {2, redis.call("GET", userOrderKey)}
end
local stock = tonumber(redis.call("GET", stockKey) or "-1")
if stock <= 0 then
  return {0, tostring(stock)}
end
redis.call("DECR", stockKey)
redis.call("SET", userOrderKey, orderId, "EX", ttl)
return {1, tostring(stock - 1)}
`;

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

function createOrderPoolForHost(host) {
  return mysql.createPool({
    ...mysqlConfig,
    host,
    port: orderDbPort,
    user: orderDbUser,
    password: orderDbPassword,
    database: orderDbName,
  });
}

function pickOrderReadPool() {
  if (!orderReadPools.length) return orderWritePool;
  const pool = orderReadPools[orderReadPoolIndex % orderReadPools.length];
  orderReadPoolIndex += 1;
  return pool;
}

function getOrderWritePool() {
  return orderWritePool || writePool;
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

function normalizeOrder(row) {
  if (!row) return null;
  return {
    orderId: String(row.order_id),
    userId: Number(row.user_id),
    productId: Number(row.product_id),
    productName: row.product_name,
    amount: Number(row.amount),
    status: row.status,
    createdAt: row.created_at,
  };
}

function normalizePayment(row) {
  if (!row) return null;
  return {
    paymentId: String(row.payment_id),
    orderId: String(row.order_id),
    userId: Number(row.user_id),
    amount: Number(row.amount),
    status: row.status,
    failReason: row.fail_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeOrderStatus(status) {
  return String(status || "").trim().toUpperCase();
}

function isOrderPaidStatus(status) {
  return normalizeOrderStatus(status) === ORDER_DB_STATUS_PAID;
}

function isOrderPayableStatus(status) {
  const s = normalizeOrderStatus(status);
  return (
    s === ORDER_DB_STATUS_CREATED ||
    s === ORDER_DB_STATUS_PAY_PENDING ||
    s === ORDER_DB_STATUS_PAY_FAILED ||
    s === "SUCCESS"
  );
}

function mapDbOrderStatusToRuntimeStatus(status) {
  const s = normalizeOrderStatus(status);
  if (s === ORDER_DB_STATUS_CREATED || s === "SUCCESS") return "ORDER_CREATED";
  if (s === ORDER_DB_STATUS_PAY_PENDING) return "PAY_PENDING";
  if (s === ORDER_DB_STATUS_PAID) return ORDER_DB_STATUS_PAID;
  if (s === ORDER_DB_STATUS_PAY_FAILED) return ORDER_DB_STATUS_PAY_FAILED;
  return s || "UNKNOWN";
}

function getSeckillStockKey(productId) {
  return `${SECKILL_STOCK_PREFIX}${productId}`;
}

function getSeckillUserOrderKey(userId, productId) {
  return `${SECKILL_USER_ORDER_PREFIX}${userId}:${productId}`;
}

function getOrderStatusKey(orderId) {
  return `${ORDER_STATUS_PREFIX}${orderId}`;
}

function getOrderCompensateKey(orderId) {
  return `${ORDER_COMPENSATE_PREFIX}${orderId}`;
}

function getPaymentEventConsumedKey(eventId) {
  return `${PAYMENT_EVENT_CONSUMED_PREFIX}${eventId}`;
}

async function setOrderStatus(orderId, status, extra = {}) {
  const payload = {
    orderId: String(orderId),
    status,
    updateAt: new Date().toISOString(),
    ...extra,
  };
  await redis.set(getOrderStatusKey(orderId), JSON.stringify(payload), "EX", ORDER_STATUS_TTL);
  return payload;
}

async function getOrderStatus(orderId) {
  const raw = await redis.get(getOrderStatusKey(orderId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function updateOrderDbStatus(orderId, toStatus, allowedFromStatuses) {
  if (mysqlEnabledByEnv && mysqlReady) {
    const writeOrderPool = getOrderWritePool();
    if (!writeOrderPool) return 0;
    if (!allowedFromStatuses || !allowedFromStatuses.length) {
      const [res] = await writeOrderPool.execute(
        "UPDATE orders SET status = ? WHERE order_id = ?",
        [toStatus, orderId]
      );
      return Number(res.affectedRows || 0);
    }

    const placeholders = allowedFromStatuses.map(() => "?").join(",");
    const [res] = await writeOrderPool.execute(
      `UPDATE orders SET status = ? WHERE order_id = ? AND status IN (${placeholders})`,
      [toStatus, orderId, ...allowedFromStatuses]
    );
    return Number(res.affectedRows || 0);
  }

  const existing = fakeOrders.get(String(orderId));
  if (!existing) return 0;
  if (!allowedFromStatuses || !allowedFromStatuses.length) {
    existing.status = toStatus;
    fakeOrders.set(String(orderId), existing);
    return 1;
  }
  if (allowedFromStatuses.includes(String(existing.status))) {
    existing.status = toStatus;
    fakeOrders.set(String(orderId), existing);
    return 1;
  }
  return 0;
}

async function initMysql() {
  if (!mysqlEnabledByEnv) return;

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
    readPools.map((pool, i) =>
      runWithRetry(
        async () => {
          await pool.query("SELECT 1");
        },
        20,
        2000,
        `mysql-read-connect-${i}`
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

  if (orderShardingEnabled) {
    orderWritePool = createOrderPoolForHost(orderDbWriteHost);
    orderReadPools = orderDbReadHosts.map((host) => createOrderPoolForHost(host));

    await runWithRetry(
      async () => {
        await orderWritePool.query("SELECT 1");
      },
      20,
      2000,
      "order-db-write-connect"
    );

    await Promise.all(
      orderReadPools.map((pool, i) =>
        runWithRetry(
          async () => {
            await pool.query("SELECT 1");
          },
          20,
          2000,
          `order-db-read-connect-${i}`
        )
      )
    );
  } else {
    orderWritePool = writePool;
    orderReadPools = readPools;
    await writePool.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id BIGINT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        product_id BIGINT NOT NULL,
        product_name VARCHAR(128) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_product (user_id, product_id),
        KEY idx_user_id (user_id),
        KEY idx_product_id (product_id)
      )
    `);
  }

  const [rows] = await writePool.execute("SELECT COUNT(*) AS cnt FROM products");
  if (Number(rows[0].cnt) === 0) {
    await writePool.execute(`
      INSERT INTO products (id, name, price, stock)
      VALUES
      (1, 'High Concurrency Programming Practice', 99.00, 1000),
      (2, 'Distributed Systems Principles', 129.00, 500),
      (3, 'Redis Design and Implementation', 79.00, 800)
    `);
  }

  mysqlReady = true;
  console.log(
    `[mysql] read/write split enabled, write=${mysqlWriteHost}, reads=${mysqlReadHosts.join(
      ","
    )}`
  );
  if (orderShardingEnabled) {
    console.log(
      `[order-sharding] enabled via proxy, write=${orderDbWriteHost}:${orderDbPort}, reads=${orderDbReadHosts.join(
        ","
      )}`
    );
  }
}

async function syncSeckillStockFromDb(productId = null) {
  if (!(mysqlEnabledByEnv && mysqlReady)) return;

  if (productId !== null) {
    const [rows] = await writePool.execute(
      "SELECT id, stock FROM products WHERE id = ? LIMIT 1",
      [productId]
    );
    if (!rows.length) return;
    await redis.set(getSeckillStockKey(productId), String(Number(rows[0].stock)));
    return;
  }

  const [rows] = await writePool.execute("SELECT id, stock FROM products");
  if (!rows.length) return;
  const pipe = redis.pipeline();
  for (const row of rows) {
    pipe.set(getSeckillStockKey(row.id), String(Number(row.stock)));
  }
  await pipe.exec();
}

async function ensureSeckillStockLoaded(productId) {
  const key = getSeckillStockKey(productId);
  const exists = await redis.exists(key);
  if (!exists) {
    if (mysqlEnabledByEnv && mysqlReady) {
      await syncSeckillStockFromDb(productId);
    } else if (fakeDb[String(productId)]) {
      await redis.set(key, String(Number(fakeDb[String(productId)].stock)));
    }
  }
}

async function queryProductFromDb(id) {
  if (mysqlEnabledByEnv && mysqlReady) {
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

async function findOrderById(orderId, forceWrite = false) {
  if (mysqlEnabledByEnv && mysqlReady) {
    const pool = forceWrite ? getOrderWritePool() : pickOrderReadPool();
    const [rows] = await pool.execute(
      "SELECT order_id, user_id, product_id, product_name, amount, status, created_at FROM orders WHERE order_id = ? LIMIT 1",
      [orderId]
    );
    return normalizeOrder(rows[0] || null);
  }
  return fakeOrders.get(String(orderId)) || null;
}

async function findOrderByUserProduct(userId, productId, forceWrite = false) {
  if (mysqlEnabledByEnv && mysqlReady) {
    const pool = forceWrite ? getOrderWritePool() : pickOrderReadPool();
    const [rows] = await pool.execute(
      "SELECT order_id, user_id, product_id, product_name, amount, status, created_at FROM orders WHERE user_id = ? AND product_id = ? LIMIT 1",
      [userId, productId]
    );
    return normalizeOrder(rows[0] || null);
  }
  const orderId = fakeUserProductOrders.get(`${userId}:${productId}`);
  if (!orderId) return null;
  return fakeOrders.get(orderId) || null;
}

async function listOrdersByUser(userId, limit) {
  if (mysqlEnabledByEnv && mysqlReady) {
    const pool = pickOrderReadPool();
    const [rows] = await pool.execute(
      "SELECT order_id, user_id, product_id, product_name, amount, status, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
      [userId, limit]
    );
    return rows.map(normalizeOrder);
  }

  const list = [];
  for (const order of fakeOrders.values()) {
    if (Number(order.userId) === Number(userId)) {
      list.push(order);
    }
  }
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return list.slice(0, limit);
}

async function reserveSeckillStock(productId, userId, orderId) {
  const stockKey = getSeckillStockKey(productId);
  const userOrderKey = getSeckillUserOrderKey(userId, productId);
  const result = await redis.eval(
    RESERVE_STOCK_LUA,
    2,
    stockKey,
    userOrderKey,
    String(orderId),
    String(SECKILL_USER_ORDER_TTL)
  );
  return {
    code: Number(result?.[0] ?? -1),
    value: result?.[1] != null ? String(result[1]) : null,
  };
}

async function compensateReservation(orderId, userId, productId, opts) {
  const compensateKey = getOrderCompensateKey(orderId);
  const lockRes = await redis.set(compensateKey, "1", "NX", "EX", ORDER_COMPENSATE_TTL);
  if (lockRes !== "OK") {
    return;
  }

  const stockKey = getSeckillStockKey(productId);
  const userOrderKey = getSeckillUserOrderKey(userId, productId);
  const tx = redis.multi();
  tx.incr(stockKey);
  if (opts.restoreUserOrderId) {
    tx.set(userOrderKey, String(opts.restoreUserOrderId), "EX", SECKILL_USER_ORDER_TTL);
  } else {
    tx.del(userOrderKey);
  }
  await tx.exec();
  await setOrderStatus(orderId, opts.status, {
    reason: opts.reason,
    userId: Number(userId),
    productId: Number(productId),
    restoreOrderId: opts.restoreUserOrderId || null,
  });
}

async function enqueueOrderCreate(payload) {
  if (!kafkaEnabled || !kafkaProducer || !kafkaReady) {
    await processSeckillOrderMessage(payload, "direct");
    return;
  }
  await kafkaProducer.send({
    topic: kafkaTopic,
    messages: [{ key: String(payload.userId), value: JSON.stringify(payload) }],
  });
}

async function processSeckillOrderMessage(payload, source) {
  const orderId = String(payload.orderId);
  const userId = Number(payload.userId);
  const productId = Number(payload.productId);
  try {
    const existingByOrderId = await findOrderById(orderId, true);
    if (existingByOrderId) {
      await setOrderStatus(orderId, "SUCCESS", {
        userId,
        productId,
        source,
        message: "idempotent-hit-order-id",
      });
      return;
    }

    if (mysqlEnabledByEnv && mysqlReady) {
      if (!orderShardingEnabled) {
        const conn = await writePool.getConnection();
        try {
          await conn.beginTransaction();

          const [dupRows] = await conn.execute(
            "SELECT order_id FROM orders WHERE user_id = ? AND product_id = ? LIMIT 1 FOR UPDATE",
            [userId, productId]
          );
          if (dupRows.length) {
            await conn.commit();
            await compensateReservation(orderId, userId, productId, {
              status: "DUPLICATE",
              reason: "duplicate-user-product",
              restoreUserOrderId: String(dupRows[0].order_id),
            });
            return;
          }

          const [productRows] = await conn.execute(
            "SELECT id, name, price, stock FROM products WHERE id = ? LIMIT 1 FOR UPDATE",
            [productId]
          );
          if (!productRows.length) {
            await conn.rollback();
            await compensateReservation(orderId, userId, productId, {
              status: "FAILED",
              reason: "product-not-found",
            });
            return;
          }

          const product = normalizeProduct(productRows[0]);
          if (product.stock <= 0) {
            await conn.rollback();
            await compensateReservation(orderId, userId, productId, {
              status: "SOLD_OUT",
              reason: "db-stock-empty",
            });
            return;
          }

          await conn.execute(
            "INSERT INTO orders (order_id, user_id, product_id, product_name, amount, status) VALUES (?, ?, ?, ?, ?, ?)",
            [orderId, userId, productId, product.name, product.price, "SUCCESS"]
          );

          const [updateRes] = await conn.execute(
            "UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0",
            [productId]
          );
          if (updateRes.affectedRows === 0) {
            await conn.rollback();
            await compensateReservation(orderId, userId, productId, {
              status: "SOLD_OUT",
              reason: "db-update-stock-failed",
            });
            return;
          }

          await conn.commit();
        } catch (err) {
          await conn.rollback();
          if (err.code === "ER_DUP_ENTRY") {
            const dup = await findOrderByUserProduct(userId, productId, true);
            await compensateReservation(orderId, userId, productId, {
              status: "DUPLICATE",
              reason: "db-unique-constraint",
              restoreUserOrderId: dup ? dup.orderId : null,
            });
            return;
          }
          throw err;
        } finally {
          conn.release();
        }
      } else {
        const dup = await findOrderByUserProduct(userId, productId, true);
        if (dup) {
          await compensateReservation(orderId, userId, productId, {
            status: "DUPLICATE",
            reason: "duplicate-user-product-sharding",
            restoreUserOrderId: dup.orderId,
          });
          return;
        }

        const stockConn = await writePool.getConnection();
        let product = null;
        try {
          await stockConn.beginTransaction();
          const [productRows] = await stockConn.execute(
            "SELECT id, name, price, stock FROM products WHERE id = ? LIMIT 1 FOR UPDATE",
            [productId]
          );
          if (!productRows.length) {
            await stockConn.rollback();
            await compensateReservation(orderId, userId, productId, {
              status: "FAILED",
              reason: "product-not-found",
            });
            return;
          }

          product = normalizeProduct(productRows[0]);
          if (product.stock <= 0) {
            await stockConn.rollback();
            await compensateReservation(orderId, userId, productId, {
              status: "SOLD_OUT",
              reason: "db-stock-empty",
            });
            return;
          }

          const [updateRes] = await stockConn.execute(
            "UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0",
            [productId]
          );
          if (updateRes.affectedRows === 0) {
            await stockConn.rollback();
            await compensateReservation(orderId, userId, productId, {
              status: "SOLD_OUT",
              reason: "db-update-stock-failed",
            });
            return;
          }
          await stockConn.commit();
        } catch (err) {
          await stockConn.rollback();
          throw err;
        } finally {
          stockConn.release();
        }

        try {
          await getOrderWritePool().execute(
            "INSERT INTO orders (order_id, user_id, product_id, product_name, amount, status) VALUES (?, ?, ?, ?, ?, ?)",
            [orderId, userId, productId, product.name, product.price, "SUCCESS"]
          );
        } catch (err) {
          await writePool.execute("UPDATE products SET stock = stock + 1 WHERE id = ?", [productId]);
          await syncSeckillStockFromDb(productId);
          if (err.code === "ER_DUP_ENTRY") {
            const latestDup = await findOrderByUserProduct(userId, productId, true);
            await compensateReservation(orderId, userId, productId, {
              status: "DUPLICATE",
              reason: "order-sharding-unique-hit",
              restoreUserOrderId: latestDup ? latestDup.orderId : null,
            });
            return;
          }
          await compensateReservation(orderId, userId, productId, {
            status: "FAILED",
            reason: "order-insert-failed-after-stock-deduct",
          });
          return;
        }
      }

      await redis.del(`${CACHE_KEY_PREFIX}${productId}`);
      await syncSeckillStockFromDb(productId);
      await setOrderStatus(orderId, "SUCCESS", {
        userId,
        productId,
        source,
        orderShardingEnabled,
      });
      return;
    }

    const product = fakeDb[String(productId)];
    if (!product) {
      await compensateReservation(orderId, userId, productId, {
        status: "FAILED",
        reason: "product-not-found-fake-db",
      });
      return;
    }
    if (fakeUserProductOrders.has(`${userId}:${productId}`)) {
      await compensateReservation(orderId, userId, productId, {
        status: "DUPLICATE",
        reason: "duplicate-fake-db",
        restoreUserOrderId: fakeUserProductOrders.get(`${userId}:${productId}`),
      });
      return;
    }
    if (product.stock <= 0) {
      await compensateReservation(orderId, userId, productId, {
        status: "SOLD_OUT",
        reason: "stock-empty-fake-db",
      });
      return;
    }

    product.stock -= 1;
    fakeUserProductOrders.set(`${userId}:${productId}`, orderId);
    fakeOrders.set(orderId, {
      orderId,
      userId,
      productId,
      productName: product.name,
      amount: product.price,
      status: "SUCCESS",
      createdAt: new Date().toISOString(),
    });
    await setOrderStatus(orderId, "SUCCESS", { userId, productId, source });
  } catch (err) {
    console.error("[seckill] process message failed:", err);
    await compensateReservation(orderId, userId, productId, {
      status: "FAILED",
      reason: "internal-error",
    });
  }
}

async function initKafka() {
  if (!kafkaEnabled) return;
  const kafka = new Kafka({
    clientId: kafkaClientId,
    brokers: kafkaBrokers,
    logLevel: logLevel.ERROR,
  });
  kafkaProducer = kafka.producer();
  kafkaConsumer = kafka.consumer({ groupId: kafkaConsumerGroup });

  await runWithRetry(
    async () => {
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic: kafkaTopic, numPartitions: 3, replicationFactor: 1 }],
      });
      await admin.disconnect();

      await kafkaProducer.connect();
      await kafkaConsumer.connect();
      await kafkaConsumer.subscribe({ topic: kafkaTopic, fromBeginning: false });
      await kafkaConsumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          const payload = JSON.parse(message.value.toString());
          await processSeckillOrderMessage(payload, "kafka");
        },
      });
    },
    20,
    3000,
    "kafka-init"
  );

  kafkaReady = true;
  console.log(`[kafka] async order pipeline enabled, topic=${kafkaTopic}`);
}

app.get("/api/products/:id(\\d+)", async (req, res) => {
  // [要求1+2] 商品详情缓存：穿透/击穿/雪崩
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
      return res.json({ code: 0, msg: "OK(cache)", data: JSON.parse(cacheValue) });
    }

    const lockToken = await acquireLock(lockKey);
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
      await redis.setex(cacheKey, CACHE_NULL_TTL, "null");
      await releaseLock(lockKey, lockToken);
      return res
        .status(404)
        .json({ code: 404, msg: "Product not found (db)", data: null });
    }

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
  // [要求3] 写操作走主库；同时刷新缓存和秒杀库存缓存
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
    await redis.set(getSeckillStockKey(id), String(stock));
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
  // [要求4] 代码中验证读写分离
  if (!(mysqlEnabledByEnv && mysqlReady)) {
    return res.status(400).json({
      code: 400,
      msg: "MySQL read/write split not enabled. Set MYSQL_ENABLED=true.",
    });
  }

  try {
    const readPool = pickReadPool();
    const promises = [
      getDbNodeInfo(writePool),
      getDbNodeInfo(readPool),
    ];
    if (orderShardingEnabled && getOrderWritePool()) {
      promises.push(getDbNodeInfo(getOrderWritePool()));
    }
    const [writeNode, readNode, orderWriteNode] = await Promise.all(promises);

    return res.json({
      code: 0,
      msg: "OK",
      data: {
        writeNode,
        readNode,
        orderWriteNode: orderWriteNode || null,
        strategy: "writes->master, reads->replica(round-robin)",
      },
    });
  } catch (err) {
    console.error("rw-status error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.post("/api/db/rw-test", async (req, res) => {
  // [要求4] 读写分离效果测试接口
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
    await redis.set(getSeckillStockKey(id), String(newStock));

    const [immediateMaster, immediateReplica] = await Promise.all([
      queryProductFromWriteDb(id),
      queryProductFromDb(id),
    ]);
    await sleep(waitMs);
    const delayedReplica = await queryProductFromDb(id);

    return res.json({
      code: 0,
      msg: "OK",
      data: {
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

app.post("/api/seckill/stock/sync", async (req, res) => {
  try {
    await syncSeckillStockFromDb();
    return res.json({ code: 0, msg: "OK", data: { scope: "all-products" } });
  } catch (err) {
    console.error("sync seckill stock error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.post("/api/seckill/stock/sync/:productId(\\d+)", async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    await syncSeckillStockFromDb(productId);
    return res.json({ code: 0, msg: "OK", data: { productId } });
  } catch (err) {
    console.error("sync seckill stock error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.post("/api/seckill/place-order", async (req, res) => {
  // [新增] 秒杀下单：Redis 预扣 + Kafka 异步创建订单
  const userId = Number(req.body?.userId);
  const productId = Number(req.body?.productId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ code: 400, msg: "userId must be a positive integer" });
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ code: 400, msg: "productId must be a positive integer" });
  }

  try {
    await ensureSeckillStockLoaded(productId);

    const orderId = idGenerator.nextId();
    const reserve = await reserveSeckillStock(productId, userId, orderId);

    if (reserve.code === 0) {
      return res.status(409).json({
        code: 409,
        msg: "Sold out",
        data: { userId, productId },
      });
    }

    if (reserve.code === 2) {
      const existingOrderId = reserve.value;
      const status =
        (await getOrderStatus(existingOrderId)) ||
        (await findOrderById(existingOrderId)) || { status: "DUPLICATE" };
      return res.status(409).json({
        code: 409,
        msg: "Duplicate order: one user can seckill one product only",
        data: { userId, productId, existingOrderId, status },
      });
    }

    if (reserve.code !== 1) {
      return res.status(500).json({ code: 500, msg: "Reserve stock failed" });
    }

    const payload = {
      orderId,
      userId,
      productId,
      requestedAt: new Date().toISOString(),
    };
    await setOrderStatus(orderId, "PENDING", payload);
    await enqueueOrderCreate(payload);

    return res.status(202).json({
      code: 0,
      msg: "Seckill request accepted",
      data: {
        orderId,
        userId,
        productId,
        queue: kafkaEnabled ? "kafka" : "direct",
      },
    });
  } catch (err) {
    console.error("place seckill order error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/seckill/result", async (req, res) => {
  // 支持按 orderId 查询，也支持按 userId+productId 查询
  const orderId = req.query.orderId ? String(req.query.orderId) : null;
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const productId = req.query.productId ? Number(req.query.productId) : null;

  try {
    if (orderId) {
      const status = (await getOrderStatus(orderId)) || (await findOrderById(orderId));
      if (!status) {
        return res.status(404).json({ code: 404, msg: "Order not found" });
      }
      return res.json({ code: 0, msg: "OK", data: status });
    }

    if (!Number.isInteger(userId) || !Number.isInteger(productId)) {
      return res.status(400).json({
        code: 400,
        msg: "Provide orderId, or provide both userId and productId",
      });
    }

    const userOrderKey = getSeckillUserOrderKey(userId, productId);
    const mappedOrderId = await redis.get(userOrderKey);
    if (!mappedOrderId) {
      return res.json({
        code: 0,
        msg: "OK",
        data: { userId, productId, status: "NOT_FOUND" },
      });
    }
    const status =
      (await getOrderStatus(mappedOrderId)) || (await findOrderById(mappedOrderId));
    return res.json({
      code: 0,
      msg: "OK",
      data: status || { orderId: mappedOrderId, status: "PENDING" },
    });
  } catch (err) {
    console.error("seckill result error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/orders/:orderId", async (req, res) => {
  // 按订单 ID 查询
  try {
    const order = await findOrderById(String(req.params.orderId));
    if (!order) {
      return res.status(404).json({ code: 404, msg: "Order not found" });
    }
    return res.json({ code: 0, msg: "OK", data: order });
  } catch (err) {
    console.error("query order by id error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/users/:userId(\\d+)/orders", async (req, res) => {
  // 按用户 ID 查询订单列表
  const userId = Number(req.params.userId);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  try {
    const list = await listOrdersByUser(userId, limit);
    return res.json({ code: 0, msg: "OK", data: list });
  } catch (err) {
    console.error("query orders by user error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/products/search", async (req, res) => {
  // [要求5-可选] 商品搜索：优先 ES，失败回退 DB
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
      orderShardingEnabled,
      esEnabled,
      kafkaEnabled,
      kafkaReady,
    },
  });
});

app.get("/", (req, res) => {
  res.send(`Backend instance running on port ${port}`);
});

async function bootstrap() {
  try {
    await initMysql();
    await syncSeckillStockFromDb();
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

  try {
    await initKafka();
  } catch (err) {
    console.error("[kafka] init failed, fallback to direct processing:", err.message);
  }

  app.listen(port, () => {
    console.log(`Backend server started on port ${port}`);
  });
}

bootstrap();

