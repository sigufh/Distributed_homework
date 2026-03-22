package com.distributed.productservice.mapper;

import com.distributed.productservice.domain.ProductDO;
import org.apache.ibatis.annotations.Param;

import java.util.List;

public interface ProductMapper {
    int insert(ProductDO product);

    ProductDO selectById(@Param("id") long id);

    int updateSelective(ProductDO product);

    List<ProductDO> selectPage(@Param("keyword") String keyword,
                               @Param("status") Integer status,
                               @Param("offset") int offset,
                               @Param("size") int size);

    long selectCount(@Param("keyword") String keyword,
                     @Param("status") Integer status);
}
