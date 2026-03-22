package com.distributed.productservice.web;

import com.distributed.productservice.domain.ProductDO;
import com.distributed.productservice.service.ProductService;
import com.distributed.productservice.web.dto.CreateProductRequest;
import com.distributed.productservice.web.dto.UpdateProductRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@Validated
@RequestMapping("/api/v1/products")
public class ProductController {
    private final ProductService productService;

    public ProductController(ProductService productService) {
        this.productService = productService;
    }

    @GetMapping
    public ResponseEntity<ApiResponse<Map<String, Object>>> list(
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Integer status,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size
    ) {
        return ResponseEntity.ok(ApiResponse.ok(productService.list(keyword, status, page, size)));
    }

    @GetMapping("/{productId}")
    public ResponseEntity<ApiResponse<ProductDO>> getById(@PathVariable long productId) {
        return ResponseEntity.ok(ApiResponse.ok(productService.getById(productId)));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<Map<String, Object>>> create(@Valid @RequestBody CreateProductRequest request) {
        long productId = productService.create(
                request.getTitle(),
                request.getSkuCode(),
                request.getPrice(),
                request.getStatus()
        );
        return ResponseEntity.ok(ApiResponse.ok(Map.of("productId", productId)));
    }

    @PatchMapping("/{productId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> update(
            @PathVariable long productId,
            @Valid @RequestBody UpdateProductRequest request
    ) {
        long updatedProductId = productService.update(
                productId,
                request.getTitle(),
                request.getSkuCode(),
                request.getPrice(),
                request.getStatus()
        );
        return ResponseEntity.ok(ApiResponse.ok(Map.of("productId", updatedProductId)));
    }
}
