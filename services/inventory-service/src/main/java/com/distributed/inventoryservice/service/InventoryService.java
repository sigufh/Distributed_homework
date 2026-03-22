package com.distributed.inventoryservice.service;

import com.distributed.inventoryservice.domain.InventoryDO;

import java.util.Map;

public interface InventoryService {
    InventoryDO getBySkuId(long skuId);

    Map<String, Object> reserve(long skuId, int quantity);

    Map<String, Object> commit(long skuId, int quantity);

    Map<String, Object> release(long skuId, int quantity);
}
