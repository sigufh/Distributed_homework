const mysql = require("mysql2/promise");

const mysqlConfig = {
  port: parseInt(process.env.ORDER_DB_PORT || process.env.MYSQL_PORT || "3306", 10),
  user: process.env.ORDER_DB_USER || process.env.MYSQL_USER || "app_user",
  password: process.env.ORDER_DB_PASSWORD || process.env.MYSQL_PASSWORD || "app_pass123",
  database: process.env.ORDER_DB_DATABASE || process.env.MYSQL_DATABASE || "shop_order",
  waitForConnections: true,
  connectionLimit: parseInt(process.env.MYSQL_POOL_LIMIT || "10", 10),
  queueLimit: 0,
  supportBigNumbers: true,
  bigNumberStrings: true,
};

const mysqlWriteHost = process.env.ORDER_DB_HOST || process.env.MYSQL_WRITE_HOST || "mysql-master";
const mysqlReadHosts = (
  process.env.ORDER_DB_READ_HOSTS ||
  process.env.ORDER_DB_HOST ||
  process.env.MYSQL_READ_HOSTS ||
  process.env.MYSQL_WRITE_HOST ||
  "mysql-master"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

let writePool = null;
let readPools = [];
let readPoolIndex = 0;
let mysqlReady = false;

function createPoolForHost(host) {
  return mysql.createPool({ ...mysqlConfig, host });
}

function getOrderWritePool() {
  return writePool;
}

function pickOrderReadPool() {
  if (!readPools.length) return writePool;
  const pool = readPools[readPoolIndex % readPools.length];
  readPoolIndex += 1;
  return pool;
}

function isMysqlReady() {
  return mysqlReady;
}

async function initMysql() {
  writePool = createPoolForHost(mysqlWriteHost);
  readPools = mysqlReadHosts.map((host) => createPoolForHost(host));

  await runWithRetry(async () => {
    await writePool.query("SELECT 1");
  }, 20, 2000, "order-db-write-connect");

  await Promise.all(
    readPools.map((pool, index) =>
      runWithRetry(async () => {
        await pool.query("SELECT 1");
      }, 20, 2000, `order-db-read-connect-${index}`)
    )
  );

  await writePool.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id BIGINT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      product_id BIGINT NOT NULL,
      product_name VARCHAR(128) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      status VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_product (user_id, product_id),
      KEY idx_user_id (user_id),
      KEY idx_product_id (product_id)
    )
  `);

  await writePool.execute(`
    CREATE TABLE IF NOT EXISTS payment_outbox (
      event_id VARCHAR(64) PRIMARY KEY,
      order_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      product_id BIGINT NOT NULL,
      payment_status VARCHAR(32) NOT NULL,
      fail_reason VARCHAR(255) NULL,
      payload_json JSON NOT NULL,
      dispatch_status VARCHAR(16) NOT NULL DEFAULT 'NEW',
      dispatched_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_dispatch_status_created (dispatch_status, created_at)
    )
  `);

  mysqlReady = true;
  console.log(`[mysql] order service ready, write=${mysqlWriteHost}, reads=${mysqlReadHosts.join(",")}`);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getOrderWritePool,
  initMysql,
  isMysqlReady,
  pickOrderReadPool,
};
