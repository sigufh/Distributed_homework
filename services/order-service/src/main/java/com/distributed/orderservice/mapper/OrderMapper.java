package com.distributed.orderservice.mapper;

import com.distributed.orderservice.domain.OrderDO;
import org.apache.ibatis.annotations.Param;

import java.util.List;

public interface OrderMapper {
    int insert(OrderDO order);

    OrderDO selectById(@Param("id") long id);

    OrderDO selectByUserIdAndIdempotencyKey(@Param("userId") long userId,
                                            @Param("idempotencyKey") String idempotencyKey);

    List<OrderDO> selectByUserId(@Param("userId") long userId);

    int cancelByIdAndUserId(@Param("id") long id, @Param("userId") long userId);
}
