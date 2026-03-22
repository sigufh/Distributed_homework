package com.distributed.inventoryservice.web;

import com.distributed.inventoryservice.domain.InventoryDO;
import com.distributed.inventoryservice.service.InventoryService;
import com.distributed.inventoryservice.web.dto.QuantityRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/inventories")
public class InventoryController {
    private final InventoryService inventoryService;

    public InventoryController(InventoryService inventoryService) {
        this.inventoryService = inventoryService;
    }

    @GetMapping("/{skuId}")
    public ResponseEntity<ApiResponse<InventoryDO>> getBySkuId(@PathVariable long skuId) {
        return ResponseEntity.ok(ApiResponse.ok(inventoryService.getBySkuId(skuId)));
    }

    @PostMapping("/{skuId}/reserve")
    public ResponseEntity<ApiResponse<Map<String, Object>>> reserve(
            @PathVariable long skuId,
            @Valid @RequestBody QuantityRequest request
    ) {
        return ResponseEntity.ok(ApiResponse.ok(inventoryService.reserve(skuId, request.getQuantity())));
    }

    @PostMapping("/{skuId}/commit")
    public ResponseEntity<ApiResponse<Map<String, Object>>> commit(
            @PathVariable long skuId,
            @Valid @RequestBody QuantityRequest request
    ) {
        return ResponseEntity.ok(ApiResponse.ok(inventoryService.commit(skuId, request.getQuantity())));
    }

    @PostMapping("/{skuId}/release")
    public ResponseEntity<ApiResponse<Map<String, Object>>> release(
            @PathVariable long skuId,
            @Valid @RequestBody QuantityRequest request
    ) {
        return ResponseEntity.ok(ApiResponse.ok(inventoryService.release(skuId, request.getQuantity())));
    }
}
