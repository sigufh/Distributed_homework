const express = require("express");
const {
  RESERVE_CODE_DUPLICATE,
  RESERVE_CODE_SOLD_OUT,
  RESERVE_CODE_SUCCESS,
  confirmReservation,
  getReservation,
  queryProductById,
  releaseReservation,
  reserveSeckillStock,
  syncSeckillStockFromDb,
  updateProductStock,
} = require("../redis");

const router = express.Router();

router.get("/products/:id(\\d+)", async (req, res) => {
  try {
    const product = await queryProductById(Number(req.params.id));
    if (!product) {
      return res.status(404).json({ code: 404, msg: "Product not found" });
    }
    return res.json({ code: 0, msg: "OK", data: product });
  } catch (err) {
    console.error("query product error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.post("/stock/sync", async (req, res) => {
  try {
    await syncSeckillStockFromDb(req.app.get("redis"));
    return res.json({ code: 0, msg: "OK", data: { scope: "all-products" } });
  } catch (err) {
    console.error("sync seckill stock error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.post("/stock/sync/:productId(\\d+)", async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    await syncSeckillStockFromDb(req.app.get("redis"), productId);
    return res.json({ code: 0, msg: "OK", data: { productId } });
  } catch (err) {
    console.error("sync seckill stock error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.put("/products/:id/stock", async (req, res) => {
  const id = Number(req.params.id);
  const stock = Number(req.body?.stock);
  if (!Number.isInteger(stock) || stock < 0) {
    return res.status(400).json({ code: 400, msg: "stock must be a non-negative integer" });
  }
  try {
    const updated = await updateProductStock(req.app.get("redis"), id, stock);
    if (!updated) {
      return res.status(404).json({ code: 404, msg: "Product not found" });
    }
    return res.json({ code: 0, msg: "OK", data: { id, stock } });
  } catch (err) {
    console.error("update stock error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.post("/internal/seckill/reserve", async (req, res) => {
  const userId = Number(req.body?.userId);
  const productId = Number(req.body?.productId);
  const orderId = String(req.body?.orderId || "");
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(productId) || productId <= 0 || !orderId) {
    return res.status(400).json({ code: 400, msg: "userId, productId and orderId are required" });
  }

  try {
    const result = await reserveSeckillStock(req.app.get("redis"), productId, userId, orderId);
    if (result.code === 404) {
      return res.status(404).json({ code: 404, msg: "Product not found" });
    }
    if (result.code === RESERVE_CODE_SOLD_OUT) {
      return res.status(409).json({ code: 409, msg: "Sold out", data: { userId, productId } });
    }
    if (result.code === RESERVE_CODE_DUPLICATE) {
      return res.status(409).json({
        code: 409,
        msg: "Duplicate order",
        data: { userId, productId, existingOrderId: result.value },
      });
    }
    if (result.code !== RESERVE_CODE_SUCCESS) {
      return res.status(503).json({ code: 503, msg: "Seckill stock not ready" });
    }
    return res.json({
      code: 0,
      msg: "OK",
      data: {
        orderId,
        userId,
        productId,
        product: result.product,
      },
    });
  } catch (err) {
    console.error("reserve seckill stock error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.post("/internal/seckill/confirm", async (req, res) => {
  const userId = Number(req.body?.userId);
  const productId = Number(req.body?.productId);
  const orderId = String(req.body?.orderId || "");
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(productId) || productId <= 0 || !orderId) {
    return res.status(400).json({ code: 400, msg: "userId, productId and orderId are required" });
  }
  try {
    const result = await confirmReservation(req.app.get("redis"), orderId, userId, productId);
    if (result.code === 404) {
      return res.status(404).json({ code: 404, msg: "Reservation not found", data: result });
    }
    if (result.code === 409) {
      return res.status(409).json({ code: 409, msg: "Reservation already released", data: result });
    }
    return res.json({ code: 0, msg: "OK", data: result });
  } catch (err) {
    console.error("confirm reservation error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.post("/internal/seckill/release", async (req, res) => {
  const userId = Number(req.body?.userId);
  const productId = Number(req.body?.productId);
  const orderId = String(req.body?.orderId || "");
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(productId) || productId <= 0 || !orderId) {
    return res.status(400).json({ code: 400, msg: "userId, productId and orderId are required" });
  }
  try {
    const result = await releaseReservation(req.app.get("redis"), orderId, userId, productId, {
      restoreUserOrderId: req.body?.restoreUserOrderId || null,
      reason: req.body?.reason || null,
    });
    return res.json({ code: 0, msg: "OK", data: result });
  } catch (err) {
    console.error("release reservation error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

router.get("/internal/seckill/reservations/:orderId", async (req, res) => {
  try {
    const reservation = await getReservation(req.app.get("redis"), String(req.params.orderId));
    if (!reservation) {
      return res.status(404).json({ code: 404, msg: "Reservation not found" });
    }
    return res.json({ code: 0, msg: "OK", data: reservation });
  } catch (err) {
    console.error("get reservation error:", err);
    return res.status(500).json({ code: 500, msg: "Server error" });
  }
});

module.exports = router;
