const axios = require("axios");
const { getOrderWritePool } = require("./db");
const {
  getSeckillUserOrderKey,
  ORDER_COMPENSATE_PREFIX,
  ORDER_COMPENSATE_TTL,
  SECKILL_USER_ORDER_TTL,
} = require("./redis");
const {
  findOrderById,
  findOrderByUserProduct,
  setOrderStatus,
} = require("./routes/orders");

const inventoryServiceBaseUrl = (
  process.env.INVENTORY_SERVICE_BASE_URL || "http://inventory-service:8082/api"
).replace(/\/+$/, "");
const inventoryRequestTimeoutMs = Math.min(
  Math.max(parseInt(process.env.INVENTORY_HTTP_TIMEOUT_MS || "3000", 10), 500),
  10000
);

const ORDER_STATUS_CREATED = "CREATED";

function buildInventoryUrl(pathname) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${inventoryServiceBaseUrl}${normalizedPath}`;
}

async function callInventoryApi(pathname, payload) {
  const resp = await axios.post(buildInventoryUrl(pathname), payload, {
    timeout: inventoryRequestTimeoutMs,
    validateStatus: () => true,
  });
  return resp;
}

async function compensateReservation(redis, orderId, userId, productId, opts) {
  const compensateKey = `${ORDER_COMPENSATE_PREFIX}${orderId}`;
  const lockRes = await redis.set(compensateKey, "1", "NX", "EX", ORDER_COMPENSATE_TTL);
  if (lockRes !== "OK") return;

  const releasePayload = {
    orderId: String(orderId),
    userId: Number(userId),
    productId: Number(productId),
    reason: opts.reason || null,
    restoreUserOrderId: opts.restoreUserOrderId || null,
  };

  let releaseSucceeded = false;
  try {
    const releaseResp = await callInventoryApi("/internal/seckill/release", releasePayload);
    releaseSucceeded = releaseResp.status >= 200 && releaseResp.status < 300;
  } catch (err) {
    console.error("[seckill] inventory release call failed:", err.message);
  }

  if (!releaseSucceeded && opts.restoreUserOrderId) {
    await redis.set(
      getSeckillUserOrderKey(userId, productId),
      String(opts.restoreUserOrderId),
      "EX",
      SECKILL_USER_ORDER_TTL
    );
  }

  await setOrderStatus(redis, orderId, opts.status, {
    reason: opts.reason,
    userId: Number(userId),
    productId: Number(productId),
    restoreOrderId: opts.restoreUserOrderId || null,
    releaseSucceeded,
  });
}

async function processSeckillOrderMessage(payload, source, redis) {
  const orderId = String(payload.orderId);
  const userId = Number(payload.userId);
  const productId = Number(payload.productId);

  try {
    const existingByOrderId = await findOrderById(redis, orderId, true);
    if (existingByOrderId) {
      await setOrderStatus(redis, orderId, "SUCCESS", {
        userId,
        productId,
        source,
        message: "idempotent-hit-order-id",
      });
      return;
    }

    const writePool = getOrderWritePool();
    if (!writePool) {
      await compensateReservation(redis, orderId, userId, productId, {
        status: "FAILED",
        reason: "mysql-not-enabled",
      });
      return;
    }

    const conn = await writePool.getConnection();
    const productName = payload.product?.name || payload.productName || "Seckill Product";
    const productAmount = Number(payload.product?.price ?? payload.amount ?? 0);
    try {
      await conn.beginTransaction();

      const [dupRows] = await conn.execute(
        "SELECT order_id FROM orders WHERE user_id = ? AND product_id = ? LIMIT 1 FOR UPDATE",
        [userId, productId]
      );
      if (dupRows.length) {
        await conn.commit();
        await compensateReservation(redis, orderId, userId, productId, {
          status: "DUPLICATE",
          reason: "duplicate-user-product",
          restoreUserOrderId: String(dupRows[0].order_id),
        });
        return;
      }

      await conn.execute(
        "INSERT INTO orders (order_id, user_id, product_id, product_name, amount, status) VALUES (?, ?, ?, ?, ?, ?)",
        [
          orderId,
          userId,
          productId,
          productName,
          productAmount,
          ORDER_STATUS_CREATED,
        ]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err.code === "ER_DUP_ENTRY") {
        const dup = await findOrderByUserProduct(redis, userId, productId, true);
        await compensateReservation(redis, orderId, userId, productId, {
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

    const confirmResp = await callInventoryApi("/internal/seckill/confirm", {
      orderId,
      userId,
      productId,
    });
    if (confirmResp.status < 200 || confirmResp.status >= 300) {
      await writePool.execute("UPDATE orders SET status = ? WHERE order_id = ?", ["CANCELLED", orderId]);
      await compensateReservation(redis, orderId, userId, productId, {
        status: "FAILED",
        reason: `inventory-confirm-failed:${confirmResp.status}`,
      });
      return;
    }

    await setOrderStatus(redis, orderId, "SUCCESS", { userId, productId, source });
  } catch (err) {
    console.error("[seckill] process message failed:", err);
    await compensateReservation(redis, orderId, userId, productId, {
      status: "FAILED",
      reason: "internal-error",
    });
  }
}

module.exports = { processSeckillOrderMessage, compensateReservation };
