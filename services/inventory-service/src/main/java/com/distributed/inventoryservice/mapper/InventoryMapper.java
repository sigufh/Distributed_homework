package com.distributed.inventoryservice.mapper;

import com.distributed.inventoryservice.domain.InventoryDO;
import org.apache.ibatis.annotations.Param;

public interface InventoryMapper {
    InventoryDO selectBySkuId(@Param("skuId") long skuId);

    int reserve(@Param("skuId") long skuId, @Param("quantity") int quantity);

    int commit(@Param("skuId") long skuId, @Param("quantity") int quantity);

    int release(@Param("skuId") long skuId, @Param("quantity") int quantity);
}
