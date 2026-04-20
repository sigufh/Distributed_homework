const express = require("express");
const router = express.Router();
const { pickOrderReadPool, getOrderWritePool } = require("../db");
const { normalizeOrder } = require("../utils/normalize");
const { getOrderStatusKey, ORDER_STATUS_TTL } = require("../redis");

async function findOrderById(redis, orderId, forceWrite = false) {
  const pool = forceWrite ? getOrderWritePool() : pickOrderReadPool();
  if (!pool) return null;
  const [rows] = await pool.execute("SELECT order_id, user_id, product_id, product_name, amount, status, created_at FROM orders WHERE order_id = ? LIMIT 1", [orderId]);
  return normalizeOrder(rows[0] || null);
}

async function findOrderByUserProduct(redis, userId, productId, forceWrite = false) {
  const pool = forceWrite ? getOrderWritePool() : pickOrderReadPool();
  if (!pool) return null;
  const [rows] = await pool.execute("SELECT order_id, user_id, product_id, product_name, amount, status, created_at FROM orders WHERE user_id = ? AND product_id = ? LIMIT 1", [userId, productId]);
  return normalizeOrder(rows[0] || null);
}

async function listOrdersByUser(redis, userId, limit) {
  const pool = pickOrderReadPool();
  if (!pool) return [];
  const [rows] = await pool.execute("SELECT order_id, user_id, product_id, product_name, amount, status, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", [userId, limit]);
  return rows.map(normalizeOrder);
}

async function setOrderStatus(redis, orderId, status, extra = {}) {
  const payload = { orderId: String(orderId), status, updateAt: new Date().toISOString(), ...extra };
  await redis.set(getOrderStatusKey(orderId), JSON.stringify(payload), "EX", ORDER_STATUS_TTL);
  return payload;
}

async function getOrderStatus(redis, orderId) {
  const raw = await redis.get(getOrderStatusKey(orderId));
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_) { return null; }
}

router.get("/orders/:orderId", async (req, res) => {
  try {
    const order = await findOrderById(req.app.get("redis"), String(req.params.orderId));
    if (!order) { return res.status(404).json({ code: 404, msg: "Order not found" }); }
    return res.json({ code: 0, msg: "OK", data: order });
  } catch (err) { console.error("query order by id error:", err); return res.status(500).json({ code: 500, msg: "Server error" }); }
});

router.get("/users/:userId(\\d+)/orders", async (req, res) => {
  const userId = Number(req.params.userId);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  try { const list = await listOrdersByUser(req.app.get("redis"), userId, limit); return res.json({ code: 0, msg: "OK", data: list }); }
  catch (err) { console.error("query orders by user error:", err); return res.status(500).json({ code: 500, msg: "Server error" }); }
});

module.exports = { router, findOrderById, findOrderByUserProduct, listOrdersByUser, setOrderStatus, getOrderStatus };
