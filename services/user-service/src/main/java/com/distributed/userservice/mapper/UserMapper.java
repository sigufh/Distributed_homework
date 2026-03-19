package com.distributed.userservice.mapper;

import com.distributed.userservice.domain.UserDO;
import org.apache.ibatis.annotations.Param;

public interface UserMapper {
    int insert(UserDO user);

    UserDO selectByUsername(@Param("username") String username);

    UserDO selectById(@Param("id") long id);
}

