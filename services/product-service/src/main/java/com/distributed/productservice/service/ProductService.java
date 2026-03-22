package com.distributed.productservice.service;

import com.distributed.productservice.domain.ProductDO;

import java.math.BigDecimal;
import java.util.Map;

public interface ProductService {
    long create(String title, String skuCode, BigDecimal price, Integer status);

    long update(long productId, String title, String skuCode, BigDecimal price, Integer status);

    ProductDO getById(long productId);

    Map<String, Object> list(String keyword, Integer status, int page, int size);
}
