function normalizeProduct(row) {
  if (!row) return null;
  return { id: Number(row.id), name: row.name, price: Number(row.price), stock: Number(row.stock) };
}

function normalizeOrder(row) {
  if (!row) return null;
  return { orderId: String(row.order_id), userId: Number(row.user_id), productId: Number(row.product_id), productName: row.product_name, amount: Number(row.amount), status: row.status, createdAt: row.created_at };
}

module.exports = { normalizeProduct, normalizeOrder };
