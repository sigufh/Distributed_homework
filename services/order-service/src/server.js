const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");
const Redis = require("ioredis");
const { initMysql: initMysqlDb, isMysqlReady, getOrderWritePool } = require("./db");
const {
  initKafkaProducer,
  sendOrderCreateMessage,
  sendPaymentResultMessage,
  isKafkaReady: isKafkaProducerReady,
} = require("./kafka/producer");
const { initKafkaConsumer, isKafkaReady: isKafkaConsumerReady } = require("./kafka/consumer");
const { SnowflakeIdGenerator } = require("./utils/idgen");
const { getSeckillUserOrderKey } = require("./redis");
const { processSeckillOrderMessage } = require("./orderProcessor");
const ordersRouter = require("./routes/orders");
const { findOrderById, setOrderStatus, getOrderStatus } = require("./routes/orders");

const DEFAULT_PORT = parseInt(process.env.PORT || "8083", 10);
const args = process.argv.slice(2);
let port = DEFAULT_PORT;
const idx = args.indexOf("--port");
if (idx !== -1 && args[idx + 1]) {
  port = parseInt(args[idx + 1], 10) || DEFAULT_PORT;
}

const inventoryServiceBaseUrl = (
  process.env.INVENTORY_SERVICE_BASE_URL || "http://inventory-service:8082/api"
).replace(/\/+$/, "");
const inventoryRequestTimeoutMs = Math.min(
  Math.max(parseInt(process.env.INVENTORY_HTTP_TIMEOUT_MS || "3000", 10), 500),
  10000
);
const paymentOutboxDispatchIntervalMs = Math.min(
  Math.max(parseInt(process.env.PAYMENT_OUTBOX_DISPATCH_MS || "2000", 10), 500),
  10000
);
const paymentEventConsumedTtlSeconds = 7 * 24 * 3600;
const PAYMENT_EVENT_CONSUMED_PREFIX = "payment:event:consumed:";

const ORDER_DB_STATUS_CREATED = "CREATED";
const ORDER_DB_STATUS_PAY_PENDING = "PAY_PENDING";
const ORDER_DB_STATUS_PAID = "PAID";
const ORDER_DB_STATUS_PAY_FAILED = "PAY_FAILED";

let paymentOutboxTimer = null;

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan(":date[iso] :remote-addr :method :url :status - :response-time ms"));

const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});
redis.on("error", (err) => console.error("[redis] error:", err.message));

const idGenerator = new SnowflakeIdGenerator(parseInt(process.env.WORKER_ID || String(port % 1024), 10));

app.set("redis", redis);
app.set("idGenerator", idGenerator);

function buildInventoryUrl(pathname) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${inventoryServiceBaseUrl}${normalizedPath}`;
}

async function callInventoryApi(pathname, payload) {
  return axios.post(buildInventoryUrl(pathname), payload, {
    timeout: inventoryRequestTimeoutMs,
    validateStatus: () => true,
  });
}

function makePaymentEventId(orderId) {
  return `pay-${orderId}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getPaymentEventConsumedKey(eventId) {
  return `${PAYMENT_EVENT_CONSUMED_PREFIX}${eventId}`;
}

async function enqueueOrderCreate(payload) {
  const sent = await sendOrderCreateMessage(payload);
  if (sent) return "kafka";
  await processSeckillOrderMessage(payload, "direct", redis);
  return "direct";
}

async function applyPaymentResult(payload, source) {
  const orderId = String(payload.orderId || "");
  const eventId = payload.eventId ? String(payload.eventId) : null;
  const status = String(payload.status || "").toUpperCase();
  if (!orderId || (status !== "SUCCESS" && status !== "FAILED")) return false;

  if (eventId) {
    const consumedKey = getPaymentEventConsumedKey(eventId);
    const consumed = await redis.set(consumedKey, "1", "NX", "EX", paymentEventConsumedTtlSeconds);
    if (consumed !== "OK") return true;
  }

  const writePool = getOrderWritePool();
  if (!writePool) return false;

  const order = await findOrderById(redis, orderId, true);
  if (!order) return false;

  const targetStatus = status === "SUCCESS" ? ORDER_DB_STATUS_PAID : ORDER_DB_STATUS_PAY_FAILED;
  const allowedFromStatuses =
    targetStatus === ORDER_DB_STATUS_PAID
      ? [ORDER_DB_STATUS_CREATED, ORDER_DB_STATUS_PAY_PENDING, ORDER_DB_STATUS_PAY_FAILED]
      : [ORDER_DB_STATUS_CREATED, ORDER_DB_STATUS_PAY_PENDING];
  const placeholders = allowedFromStatuses.map(() => "?").join(",");
  await writePool.execute(
    `UPDATE orders SET status = ? WHERE order_id = ? AND status IN (${placeholders})`,
    [targetStatus, orderId, ...allowedFromStatuses]
  );

  await setOrderStatus(redis, orderId, targetStatus, {
    source,
    userId: order.userId,
    productId: order.productId,
    failReason: payload.failReason || null,
  });

  if (targetStatus === ORDER_DB_STATUS_PAY_FAILED) {
    try {
      await callInventoryApi("/internal/seckill/release", {
        orderId,
        userId: order.userId,
        productId: order.productId,
        reason: payload.failReason || "payment-failed",
      });
    } catch (err) {
      console.error("[payment] release reservation failed:", err.message);
    }
  }

  return true;
}

async function flushPaymentOutboxOnce() {
  const writePool = getOrderWritePool();
  if (!writePool) return;

  const [rows] = await writePool.execute(
    "SELECT event_id, payload_json FROM payment_outbox WHERE dispatch_status = 'NEW' ORDER BY created_at LIMIT 50"
  );
  if (!rows.length) return;

  for (const row of rows) {
    const eventId = String(row.event_id);
    try {
      const payload = typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
      if (isKafkaProducerReady()) {
        await sendPaymentResultMessage(payload);
      } else {
        await applyPaymentResult(payload, "outbox-local");
      }
      await writePool.execute(
        "UPDATE payment_outbox SET dispatch_status = 'SENT', dispatched_at = CURRENT_TIMESTAMP WHERE event_id = ? AND dispatch_status = 'NEW'",
        [eventId]
      );
    } catch (err) {
      console.error(`[payment-outbox] dispatch failed eventId=${eventId}:`, err.message);
    }
  }
}

function startPaymentOutboxDispatcher() {
  if (paymentOutboxTimer) return;
  paymentOutboxTimer = setInterval(() => {
    flushPaymentOutboxOnce().catch((err) => {
      console.error("[payment-outbox] loop failed:", err.message);
    });
  }, paymentOutboxDispatchIntervalMs);
}

app.post("/api/seckill/place-order", async (req, res) => {
  const userId = Number(req.body?.userId);
  const productId = Number(req.body?.productId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ code: 400, msg: "userId must be a positive integer" });
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ code: 400, msg: "productId must be a positive integer" });
  }

  try {
    const orderId = idGenerator.nextId();
    const reserveResp = await callInventoryApi("/internal/seckill/reserve", { userId, productId, orderId });

    if (reserveResp.status === 409) {
      return res.status(409).json(reserveResp.data);
    }
    if (reserveResp.status === 404) {
      return res.status(404).json(reserveResp.data);
    }
    if (reserveResp.status < 200 || reserveResp.status >= 300) {
      return res.status(503).json({ code: 503, msg: "Reserve stock failed", data: { userId, productId } });
    }

    const product = reserveResp.data?.data?.product || null;
    const payload = {
      orderId,
      userId,
      productId,
      productName: product?.name || "Seckill Product",
      amount: Number(product?.price ?? 0),
      requestedAt: new Date().toISOString(),
    };

    await setOrderStatus(redis, orderId, "PENDING", payload);
    const queue = await enqueueOrderCreate(payload);

    return res.status(202).json({
      code: 0,
      msg: "Seckill request accepted",
      data: { orderId, userId, productId, queue },
    });
  } catch (err) {
    console.error("place seckill order error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.get("/api/seckill/result", async (req, res) => {
  const orderId = req.query.orderId ? String(req.query.orderId) : null;
  const userId = req.query.userId ? Number(req.query.userId) : null;
  const productId = req.query.productId ? Number(req.query.productId) : null;

  try {
    if (orderId) {
      const status = (await getOrderStatus(redis, orderId)) || (await findOrderById(redis, orderId));
      if (!status) {
        return res.status(404).json({ code: 404, msg: "Order not found" });
      }
      return res.json({ code: 0, msg: "OK", data: status });
    }

    if (!Number.isInteger(userId) || !Number.isInteger(productId)) {
      return res.status(400).json({ code: 400, msg: "Provide orderId, or provide both userId and productId" });
    }
    const userOrderKey = getSeckillUserOrderKey(userId, productId);
    const mappedOrderId = await redis.get(userOrderKey);
    if (!mappedOrderId) {
      return res.json({ code: 0, msg: "OK", data: { userId, productId, status: "NOT_FOUND" } });
    }
    const status = (await getOrderStatus(redis, mappedOrderId)) || (await findOrderById(redis, mappedOrderId));
    return res.json({ code: 0, msg: "OK", data: status || { orderId: mappedOrderId, status: "PENDING" } });
  } catch (err) {
    console.error("seckill result error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

app.post("/api/orders/:orderId/pay", async (req, res) => {
  const orderId = String(req.params.orderId || "");
  const success = req.body?.success !== false;
  const failReason = success ? null : String(req.body?.failReason || "mock-payment-failed");
  if (!orderId) {
    return res.status(400).json({ code: 400, msg: "orderId is required" });
  }

  const writePool = getOrderWritePool();
  if (!writePool) {
    return res.status(503).json({ code: 503, msg: "Order DB is not ready" });
  }

  const conn = await writePool.getConnection();
  let eventId = null;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      "SELECT order_id, user_id, product_id, status FROM orders WHERE order_id = ? LIMIT 1 FOR UPDATE",
      [orderId]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ code: 404, msg: "Order not found" });
    }

    const order = rows[0];
    const currStatus = String(order.status || "").toUpperCase();
    if (currStatus === ORDER_DB_STATUS_PAID && success) {
      await conn.rollback();
      return res.json({ code: 0, msg: "Order already paid", data: { orderId, status: ORDER_DB_STATUS_PAID } });
    }
    if (![ORDER_DB_STATUS_CREATED, ORDER_DB_STATUS_PAY_PENDING, ORDER_DB_STATUS_PAY_FAILED].includes(currStatus)) {
      await conn.rollback();
      return res.status(409).json({ code: 409, msg: `Order status ${currStatus} is not payable` });
    }

    await conn.execute("UPDATE orders SET status = ? WHERE order_id = ?", [ORDER_DB_STATUS_PAY_PENDING, orderId]);

    eventId = makePaymentEventId(orderId);
    const eventPayload = {
      eventId,
      orderId,
      userId: Number(order.user_id),
      productId: Number(order.product_id),
      status: success ? "SUCCESS" : "FAILED",
      failReason,
      createdAt: new Date().toISOString(),
    };
    await conn.execute(
      "INSERT INTO payment_outbox (event_id, order_id, user_id, product_id, payment_status, fail_reason, payload_json, dispatch_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'NEW')",
      [
        eventId,
        orderId,
        Number(order.user_id),
        Number(order.product_id),
        eventPayload.status,
        failReason,
        JSON.stringify(eventPayload),
      ]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error("pay order error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  } finally {
    conn.release();
  }

  await setOrderStatus(redis, orderId, ORDER_DB_STATUS_PAY_PENDING, { eventId });
  await flushPaymentOutboxOnce();

  return res.status(202).json({
    code: 0,
    msg: "Payment request accepted",
    data: { orderId, eventId, status: ORDER_DB_STATUS_PAY_PENDING },
  });
});

app.use("/api", ordersRouter.router);

app.get("/api/instance/info", (req, res) => {
  res.json({
    code: 0,
    msg: "OK",
    data: {
      port,
      pid: process.pid,
      mysqlReady: isMysqlReady(),
      kafkaEnabled: (process.env.KAFKA_ENABLED || "false").toLowerCase() === "true",
      kafkaReady: isKafkaConsumerReady() || isKafkaProducerReady(),
      paymentOutboxDispatcher: !!paymentOutboxTimer,
    },
  });
});

app.get("/", (req, res) => {
  res.send(`Order service running on port ${port}`);
});

async function bootstrap() {
  try {
    await initMysqlDb();
  } catch (err) {
    console.error("[mysql] init failed:", err.message);
  }

  try {
    await initKafkaProducer();
    await initKafkaConsumer({
      redis,
      onPaymentResult: async (payload) => {
        await applyPaymentResult(payload, "kafka");
      },
    });
  } catch (err) {
    console.error("[kafka] init failed:", err.message);
  }

  startPaymentOutboxDispatcher();
  app.listen(port, () => {
    console.log(`Order service started on port ${port}`);
  });
}

bootstrap();
