package com.distributed.orderservice.web;

import com.distributed.orderservice.domain.OrderDO;
import com.distributed.orderservice.exception.BizException;
import com.distributed.orderservice.security.JwtService;
import com.distributed.orderservice.service.OrderService;
import com.distributed.orderservice.web.dto.CreateOrderRequest;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/orders")
public class OrderController {
    private final OrderService orderService;
    private final JwtService jwtService;

    public OrderController(OrderService orderService, JwtService jwtService) {
        this.orderService = orderService;
        this.jwtService = jwtService;
    }

    @PostMapping
    public ResponseEntity<ApiResponse<Map<String, Object>>> create(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody CreateOrderRequest request,
            HttpServletRequest httpRequest
    ) {
        long userId = extractUserId(httpRequest);
        Map<String, Object> data = orderService.createOrder(
                userId,
                request.getProductId(),
                request.getQuantity(),
                request.getAmount(),
                idempotencyKey
        );
        return ResponseEntity.ok(ApiResponse.ok(data));
    }

    @GetMapping("/{orderId}")
    public ResponseEntity<ApiResponse<OrderDO>> getById(@PathVariable long orderId, HttpServletRequest httpRequest) {
        long userId = extractUserId(httpRequest);
        return ResponseEntity.ok(ApiResponse.ok(orderService.getById(userId, orderId)));
    }

    @GetMapping
    public ResponseEntity<ApiResponse<List<OrderDO>>> listMine(HttpServletRequest httpRequest) {
        long userId = extractUserId(httpRequest);
        return ResponseEntity.ok(ApiResponse.ok(orderService.listMine(userId)));
    }

    @PostMapping("/{orderId}/cancel")
    public ResponseEntity<ApiResponse<Map<String, Object>>> cancel(
            @PathVariable long orderId,
            HttpServletRequest httpRequest
    ) {
        long userId = extractUserId(httpRequest);
        return ResponseEntity.ok(ApiResponse.ok(orderService.cancel(userId, orderId)));
    }

    private long extractUserId(HttpServletRequest request) {
        String authHeader = request.getHeader("Authorization");
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            throw new BizException(401, HttpStatus.UNAUTHORIZED, "missing bearer token");
        }

        String token = authHeader.substring("Bearer ".length());
        Claims claims = jwtService.parseClaims(token);
        return Long.parseLong(claims.getSubject());
    }
}
