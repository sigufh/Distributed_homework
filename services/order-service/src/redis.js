const SECKILL_STOCK_PREFIX = "seckill:stock:";
const SECKILL_USER_ORDER_PREFIX = "seckill:user-order:";
const ORDER_STATUS_PREFIX = "order:status:";
const ORDER_COMPENSATE_PREFIX = "seckill:compensated:";

const SECKILL_USER_ORDER_TTL = 24 * 3600;
const ORDER_STATUS_TTL = 7 * 24 * 3600;
const ORDER_COMPENSATE_TTL = 7 * 24 * 3600;

function getSeckillStockKey(productId) {
  return `${SECKILL_STOCK_PREFIX}${productId}`;
}

function getSeckillUserOrderKey(userId, productId) {
  return `${SECKILL_USER_ORDER_PREFIX}${userId}:${productId}`;
}

function getOrderStatusKey(orderId) {
  return `${ORDER_STATUS_PREFIX}${orderId}`;
}

module.exports = {
  ORDER_COMPENSATE_PREFIX,
  ORDER_COMPENSATE_TTL,
  ORDER_STATUS_TTL,
  SECKILL_USER_ORDER_TTL,
  getOrderStatusKey,
  getSeckillStockKey,
  getSeckillUserOrderKey,
};
