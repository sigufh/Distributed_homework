const { releaseReservation } = require("../redis");

async function compensateReservation(redis, orderId, userId, productId, opts = {}) {
  return releaseReservation(redis, orderId, userId, productId, opts);
}

module.exports = { compensateReservation };
