const express = require("express");
const router = express.Router();
const { pickReadPool } = require("../db");
const { normalizeOrder } = require("../utils/normalize");

async function listOrdersByUser(redis, userId, limit) {
  const pool = pickReadPool();
  if (!pool) return [];
  const [rows] = await pool.execute("SELECT order_id, user_id, product_id, product_name, amount, status, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", [userId, limit]);
  return rows.map(normalizeOrder);
}

router.get("/:userId(\\d+)/orders", async (req, res) => {
  const userId = Number(req.params.userId);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  try { const list = await listOrdersByUser(req.app.get("redis"), userId, limit); return res.json({ code: 0, msg: "OK", data: list }); }
  catch (err) { console.error("query orders by user error:", err); return res.status(500).json({ code: 500, msg: "Server error" }); }
});

module.exports = router;
