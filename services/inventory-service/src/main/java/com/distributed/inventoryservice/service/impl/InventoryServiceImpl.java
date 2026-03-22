package com.distributed.inventoryservice.service.impl;

import com.distributed.inventoryservice.domain.InventoryDO;
import com.distributed.inventoryservice.exception.BizException;
import com.distributed.inventoryservice.mapper.InventoryMapper;
import com.distributed.inventoryservice.service.InventoryService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;

@Service
public class InventoryServiceImpl implements InventoryService {
    private final InventoryMapper inventoryMapper;

    public InventoryServiceImpl(InventoryMapper inventoryMapper) {
        this.inventoryMapper = inventoryMapper;
    }

    @Override
    public InventoryDO getBySkuId(long skuId) {
        InventoryDO inventory = inventoryMapper.selectBySkuId(skuId);
        if (inventory == null) {
            throw new BizException(404, HttpStatus.NOT_FOUND, "inventory not found");
        }
        return inventory;
    }

    @Override
    @Transactional
    public Map<String, Object> reserve(long skuId, int quantity) {
        validateQuantity(quantity);
        ensureInventoryExists(skuId);

        int affected = inventoryMapper.reserve(skuId, quantity);
        if (affected == 0) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "insufficient available inventory");
        }

        InventoryDO inventory = getBySkuId(skuId);
        return Map.of("skuId", skuId, "available", inventory.getAvailable(), "reserved", inventory.getReserved());
    }

    @Override
    @Transactional
    public Map<String, Object> commit(long skuId, int quantity) {
        validateQuantity(quantity);
        ensureInventoryExists(skuId);

        int affected = inventoryMapper.commit(skuId, quantity);
        if (affected == 0) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "insufficient reserved inventory");
        }

        InventoryDO inventory = getBySkuId(skuId);
        return Map.of(
                "skuId", skuId,
                "total", inventory.getTotal(),
                "available", inventory.getAvailable(),
                "reserved", inventory.getReserved()
        );
    }

    @Override
    @Transactional
    public Map<String, Object> release(long skuId, int quantity) {
        validateQuantity(quantity);
        ensureInventoryExists(skuId);

        int affected = inventoryMapper.release(skuId, quantity);
        if (affected == 0) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "insufficient reserved inventory");
        }

        InventoryDO inventory = getBySkuId(skuId);
        return Map.of("skuId", skuId, "available", inventory.getAvailable(), "reserved", inventory.getReserved());
    }

    private void ensureInventoryExists(long skuId) {
        if (inventoryMapper.selectBySkuId(skuId) == null) {
            throw new BizException(404, HttpStatus.NOT_FOUND, "inventory not found");
        }
    }

    private void validateQuantity(int quantity) {
        if (quantity <= 0) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "quantity must be greater than 0");
        }
    }
}
