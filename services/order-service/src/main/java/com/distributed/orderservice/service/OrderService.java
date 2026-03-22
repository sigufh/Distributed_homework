package com.distributed.orderservice.service;

import com.distributed.orderservice.domain.OrderDO;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

public interface OrderService {
    Map<String, Object> createOrder(long userId,
                                    long productId,
                                    int quantity,
                                    BigDecimal amount,
                                    String idempotencyKey);

    OrderDO getById(long userId, long orderId);

    List<OrderDO> listMine(long userId);

    Map<String, Object> cancel(long userId, long orderId);
}
