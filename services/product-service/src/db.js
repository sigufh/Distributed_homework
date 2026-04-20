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
const mysqlReadHosts = (process.env.MYSQL_READ_HOSTS || "mysql-replica").split(",").map((v) => v.trim()).filter(Boolean);

let readPools = [];
let readPoolIndex = 0;

function createPoolForHost(host) { return mysql.createPool({ ...mysqlConfig, host }); }
function pickReadPool() { if (!readPools.length) return null; const pool = readPools[readPoolIndex % readPools.length]; readPoolIndex += 1; return pool; }

async function initMysql() {
  readPools = mysqlReadHosts.map((host) => createPoolForHost(host));
  await Promise.all(readPools.map((pool, i) => runWithRetry(async () => { await pool.query("SELECT 1"); }, 20, 2000, `mysql-read-connect-${i}`)));
  console.log(`[mysql] read-only mode enabled, reads=${mysqlReadHosts.join(",")}`);
}

async function runWithRetry(fn, retries, delayMs, label) {
  let lastError = null;
  for (let i = 1; i <= retries; i += 1) {
    try { return await fn(); }
    catch (err) {
      lastError = err;
      console.error(`[${label}] attempt ${i}/${retries} failed: ${err.message}`);
      if (i < retries) { await sleep(delayMs); }
    }
  }
  throw lastError;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { initMysql, pickReadPool };
