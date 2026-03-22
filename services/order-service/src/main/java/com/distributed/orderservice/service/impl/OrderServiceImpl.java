package com.distributed.orderservice.service.impl;

import com.distributed.orderservice.domain.OrderDO;
import com.distributed.orderservice.exception.BizException;
import com.distributed.orderservice.mapper.OrderMapper;
import com.distributed.orderservice.service.OrderService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

@Service
public class OrderServiceImpl implements OrderService {
    private static final int STATUS_CREATED = 0;
    private static final int STATUS_CANCELED = 2;

    private final OrderMapper orderMapper;

    public OrderServiceImpl(OrderMapper orderMapper) {
        this.orderMapper = orderMapper;
    }

    @Override
    @Transactional
    public Map<String, Object> createOrder(long userId,
                                           long productId,
                                           int quantity,
                                           BigDecimal amount,
                                           String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "Idempotency-Key is required");
        }

        OrderDO existing = orderMapper.selectByUserIdAndIdempotencyKey(userId, idempotencyKey);
        if (existing != null) {
            return toCreateResponse(existing);
        }

        OrderDO order = new OrderDO();
        order.setUserId(userId);
        order.setProductId(productId);
        order.setOrderNo(generateOrderNo());
        order.setQuantity(quantity);
        order.setAmount(amount);
        order.setStatus(STATUS_CREATED);
        order.setIdempotencyKey(idempotencyKey);

        try {
            orderMapper.insert(order);
        } catch (DuplicateKeyException ex) {
            OrderDO duplicated = orderMapper.selectByUserIdAndIdempotencyKey(userId, idempotencyKey);
            if (duplicated != null) {
                return toCreateResponse(duplicated);
            }
            throw new BizException(409, HttpStatus.CONFLICT, "duplicate order request");
        }

        order.setId(Objects.requireNonNull(order.getId(), "Failed to create order id"));
        return toCreateResponse(order);
    }

    @Override
    public OrderDO getById(long userId, long orderId) {
        OrderDO order = orderMapper.selectById(orderId);
        if (order == null || !order.getUserId().equals(userId)) {
            throw new BizException(404, HttpStatus.NOT_FOUND, "order not found");
        }
        return order;
    }

    @Override
    public List<OrderDO> listMine(long userId) {
        return orderMapper.selectByUserId(userId);
    }

    @Override
    @Transactional
    public Map<String, Object> cancel(long userId, long orderId) {
        OrderDO order = getById(userId, orderId);
        int affected = orderMapper.cancelByIdAndUserId(orderId, userId);
        if (affected == 0) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "order cannot be canceled in current status");
        }

        return Map.of(
                "orderId", order.getId(),
                "status", STATUS_CANCELED
        );
    }

    private Map<String, Object> toCreateResponse(OrderDO order) {
        return Map.of(
                "orderId", order.getId(),
                "orderNo", order.getOrderNo(),
                "status", order.getStatus()
        );
    }

    private String generateOrderNo() {
        String ts = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMddHHmmss"));
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8).toUpperCase();
        return "ORD" + ts + suffix;
    }
}
