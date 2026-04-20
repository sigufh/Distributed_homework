const { getWritePool } = require("./db");

const SECKILL_STOCK_PREFIX = "seckill:stock:";
const SECKILL_USER_ORDER_PREFIX = "seckill:user-order:";
const SECKILL_RESERVATION_PREFIX = "seckill:reservation:";
const SECKILL_USER_ORDER_TTL = 24 * 3600;
const SECKILL_RESERVATION_TTL = 7 * 24 * 3600;

const RESERVE_CODE_SUCCESS = 1;
const RESERVE_CODE_SOLD_OUT = 0;
const RESERVE_CODE_DUPLICATE = 2;
const RESERVE_CODE_STOCK_NOT_READY = -1;

const RESERVATION_STATUS_RESERVED = "RESERVED";
const RESERVATION_STATUS_CONFIRMED = "CONFIRMED";
const RESERVATION_STATUS_RELEASED = "RELEASED";

function getSeckillStockKey(productId) {
  return `${SECKILL_STOCK_PREFIX}${productId}`;
}

function getSeckillUserOrderKey(userId, productId) {
  return `${SECKILL_USER_ORDER_PREFIX}${userId}:${productId}`;
}

function getReservationKey(orderId) {
  return `${SECKILL_RESERVATION_PREFIX}${orderId}`;
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

const RESERVE_STOCK_LUA = `
local stockKey = KEYS[1]
local userOrderKey = KEYS[2]
local reservationKey = KEYS[3]
local orderId = ARGV[1]
local userId = ARGV[2]
local productId = ARGV[3]
local userOrderTtl = tonumber(ARGV[4])
local reservationTtl = tonumber(ARGV[5])

if redis.call("EXISTS", userOrderKey) == 1 then
  return {2, redis.call("GET", userOrderKey)}
end

local stock = tonumber(redis.call("GET", stockKey) or "-1")
if stock < 0 then
  return {-1, "NOT_READY"}
end
if stock <= 0 then
  return {0, tostring(stock)}
end

redis.call("DECR", stockKey)
redis.call("SET", userOrderKey, orderId, "EX", userOrderTtl)
redis.call(
  "SET",
  reservationKey,
  cjson.encode({ status = "RESERVED", orderId = orderId, userId = tonumber(userId), productId = tonumber(productId) }),
  "EX",
  reservationTtl
)
return {1, tostring(stock - 1)}
`;

async function queryProductById(productId) {
  const pool = getWritePool();
  if (!pool) return null;
  const [rows] = await pool.execute(
    "SELECT id, name, price, stock FROM products WHERE id = ? LIMIT 1",
    [productId]
  );
  return normalizeProduct(rows[0] || null);
}

async function syncSeckillStockFromDb(redis, productId = null) {
  const pool = getWritePool();
  if (!pool) return;

  if (productId !== null) {
    const [rows] = await pool.execute("SELECT id, stock FROM products WHERE id = ? LIMIT 1", [productId]);
    if (!rows.length) return;
    await redis.set(getSeckillStockKey(productId), String(Number(rows[0].stock)));
    return;
  }

  const [rows] = await pool.execute("SELECT id, stock FROM products");
  if (!rows.length) return;
  const pipe = redis.pipeline();
  for (const row of rows) {
    pipe.set(getSeckillStockKey(row.id), String(Number(row.stock)));
  }
  await pipe.exec();
}

async function ensureSeckillStockLoaded(redis, productId) {
  const stockKey = getSeckillStockKey(productId);
  const exists = await redis.exists(stockKey);
  if (!exists) {
    await syncSeckillStockFromDb(redis, productId);
  }
}

async function getReservation(redis, orderId) {
  const raw = await redis.get(getReservationKey(orderId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      orderId: parsed.orderId != null ? String(parsed.orderId) : String(orderId),
      userId: parsed.userId != null ? Number(parsed.userId) : null,
      productId: parsed.productId != null ? Number(parsed.productId) : null,
    };
  } catch (_) {
    return null;
  }
}

async function setReservation(redis, orderId, payload) {
  const reservation = {
    orderId: String(orderId),
    status: payload.status,
    userId: Number(payload.userId),
    productId: Number(payload.productId),
    updatedAt: new Date().toISOString(),
  };
  await redis.set(getReservationKey(orderId), JSON.stringify(reservation), "EX", SECKILL_RESERVATION_TTL);
  return reservation;
}

async function reserveSeckillStock(redis, productId, userId, orderId) {
  await ensureSeckillStockLoaded(redis, productId);
  const product = await queryProductById(productId);
  if (!product) {
    return { code: 404, value: null, product: null };
  }

  const result = await redis.eval(
    RESERVE_STOCK_LUA,
    3,
    getSeckillStockKey(productId),
    getSeckillUserOrderKey(userId, productId),
    getReservationKey(orderId),
    String(orderId),
    String(userId),
    String(productId),
    String(SECKILL_USER_ORDER_TTL),
    String(SECKILL_RESERVATION_TTL)
  );

  return {
    code: Number(result?.[0] ?? RESERVE_CODE_STOCK_NOT_READY),
    value: result?.[1] != null ? String(result[1]) : null,
    product,
  };
}

async function confirmReservation(redis, orderId, userId, productId) {
  const reservation = await getReservation(redis, orderId);
  if (!reservation) {
    return { code: 404, state: "NOT_FOUND" };
  }
  if (reservation.status === RESERVATION_STATUS_CONFIRMED) {
    return { code: 0, state: RESERVATION_STATUS_CONFIRMED };
  }
  if (reservation.status === RESERVATION_STATUS_RELEASED) {
    return { code: 409, state: RESERVATION_STATUS_RELEASED };
  }

  const pool = getWritePool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT id, stock FROM products WHERE id = ? LIMIT 1 FOR UPDATE",
      [productId]
    );
    if (!rows.length) {
      await conn.rollback();
      return { code: 404, state: "PRODUCT_NOT_FOUND" };
    }
    if (Number(rows[0].stock) <= 0) {
      await conn.rollback();
      return { code: 409, state: "DB_SOLD_OUT" };
    }
    await conn.execute("UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0", [productId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await setReservation(redis, orderId, {
    status: RESERVATION_STATUS_CONFIRMED,
    userId,
    productId,
  });
  return { code: 0, state: RESERVATION_STATUS_CONFIRMED };
}

async function releaseReservation(redis, orderId, userId, productId, opts = {}) {
  const reservation = await getReservation(redis, orderId);
  if (reservation?.status === RESERVATION_STATUS_RELEASED) {
    return { code: 0, state: RESERVATION_STATUS_RELEASED };
  }

  if (reservation?.status === RESERVATION_STATUS_CONFIRMED) {
    const pool = getWritePool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE products SET stock = stock + 1 WHERE id = ?", [productId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  const tx = redis.multi();
  tx.incr(getSeckillStockKey(productId));
  if (opts.restoreUserOrderId) {
    tx.set(
      getSeckillUserOrderKey(userId, productId),
      String(opts.restoreUserOrderId),
      "EX",
      SECKILL_USER_ORDER_TTL
    );
  } else {
    tx.del(getSeckillUserOrderKey(userId, productId));
  }
  tx.set(
    getReservationKey(orderId),
    JSON.stringify({
      orderId: String(orderId),
      status: RESERVATION_STATUS_RELEASED,
      userId: Number(userId),
      productId: Number(productId),
      reason: opts.reason || null,
      updatedAt: new Date().toISOString(),
    }),
    "EX",
    SECKILL_RESERVATION_TTL
  );
  await tx.exec();

  return { code: 0, state: RESERVATION_STATUS_RELEASED };
}

async function updateProductStock(redis, id, stock) {
  const pool = getWritePool();
  if (!pool) return false;
  const [res] = await pool.execute("UPDATE products SET stock = ? WHERE id = ?", [stock, id]);
  if (Number(res.affectedRows || 0) > 0) {
    await redis.set(getSeckillStockKey(id), String(stock));
    return true;
  }
  return false;
}

module.exports = {
  RESERVE_CODE_DUPLICATE,
  RESERVE_CODE_SOLD_OUT,
  RESERVE_CODE_STOCK_NOT_READY,
  RESERVE_CODE_SUCCESS,
  RESERVATION_STATUS_CONFIRMED,
  RESERVATION_STATUS_RELEASED,
  RESERVATION_STATUS_RESERVED,
  confirmReservation,
  ensureSeckillStockLoaded,
  getReservation,
  getReservationKey,
  getSeckillStockKey,
  getSeckillUserOrderKey,
  queryProductById,
  releaseReservation,
  reserveSeckillStock,
  syncSeckillStockFromDb,
  updateProductStock,
};
