package com.distributed.productservice.service.impl;

import com.distributed.productservice.domain.ProductDO;
import com.distributed.productservice.exception.BizException;
import com.distributed.productservice.mapper.ProductMapper;
import com.distributed.productservice.service.ProductService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

@Service
public class ProductServiceImpl implements ProductService {
    private final ProductMapper productMapper;

    public ProductServiceImpl(ProductMapper productMapper) {
        this.productMapper = productMapper;
    }

    @Override
    @Transactional
    public long create(String title, String skuCode, BigDecimal price, Integer status) {
        ProductDO product = new ProductDO();
        product.setTitle(title);
        product.setSkuCode(skuCode);
        product.setPrice(price);
        product.setStatus(status == null ? 1 : status);

        try {
            productMapper.insert(product);
        } catch (DuplicateKeyException ex) {
            String message = ex.getMessage() == null ? "" : ex.getMessage().toLowerCase(Locale.ROOT);
            if (message.contains("uk_products_sku_code")) {
                throw new BizException(400, HttpStatus.BAD_REQUEST, "skuCode already exists");
            }
            throw new BizException(400, HttpStatus.BAD_REQUEST, "duplicate product data");
        }

        return Objects.requireNonNull(product.getId(), "Failed to create product id");
    }

    @Override
    @Transactional
    public long update(long productId, String title, String skuCode, BigDecimal price, Integer status) {
        ProductDO existing = productMapper.selectById(productId);
        if (existing == null) {
            throw new BizException(404, HttpStatus.NOT_FOUND, "product not found");
        }

        if (title == null && skuCode == null && price == null && status == null) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "no fields to update");
        }

        ProductDO product = new ProductDO();
        product.setId(productId);
        product.setTitle(title);
        product.setSkuCode(skuCode);
        product.setPrice(price);
        product.setStatus(status);

        try {
            productMapper.updateSelective(product);
        } catch (DuplicateKeyException ex) {
            String message = ex.getMessage() == null ? "" : ex.getMessage().toLowerCase(Locale.ROOT);
            if (message.contains("uk_products_sku_code")) {
                throw new BizException(400, HttpStatus.BAD_REQUEST, "skuCode already exists");
            }
            throw new BizException(400, HttpStatus.BAD_REQUEST, "duplicate product data");
        }

        return productId;
    }

    @Override
    public ProductDO getById(long productId) {
        ProductDO product = productMapper.selectById(productId);
        if (product == null) {
            throw new BizException(404, HttpStatus.NOT_FOUND, "product not found");
        }
        return product;
    }

    @Override
    public Map<String, Object> list(String keyword, Integer status, int page, int size) {
        if (page < 1 || size < 1 || size > 100) {
            throw new BizException(400, HttpStatus.BAD_REQUEST, "invalid page or size");
        }

        int offset = (page - 1) * size;
        List<ProductDO> items = productMapper.selectPage(keyword, status, offset, size);
        long total = productMapper.selectCount(keyword, status);

        return Map.of(
                "page", page,
                "size", size,
                "total", total,
                "items", items
        );
    }
}
