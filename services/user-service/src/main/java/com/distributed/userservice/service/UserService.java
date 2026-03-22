package com.distributed.userservice.service;

import com.distributed.userservice.domain.UserDO;

public interface UserService {
    long register(String username, String password, String phone, String email);

    String login(String username, String password);

    UserDO getById(long userId);
}
