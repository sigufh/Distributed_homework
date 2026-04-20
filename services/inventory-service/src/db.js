const mysql = require("mysql2/promise");

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
const mysqlReadHosts = (process.env.MYSQL_READ_HOSTS || process.env.MYSQL_WRITE_HOST || "mysql-master")
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

function getWritePool() {
  return writePool;
}

function pickReadPool() {
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
  }, 20, 2000, "inventory-mysql-write-connect");

  await Promise.all(
    readPools.map((pool, index) =>
      runWithRetry(async () => {
        await pool.query("SELECT 1");
      }, 20, 2000, `inventory-mysql-read-connect-${index}`)
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
    `[mysql] inventory service ready, write=${mysqlWriteHost}, reads=${mysqlReadHosts.join(",")}`
  );
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
  getWritePool,
  initMysql,
  isMysqlReady,
  pickReadPool,
};
