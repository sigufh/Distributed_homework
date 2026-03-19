package com.distributed.userservice.service.impl;

import com.distributed.userservice.domain.UserDO;
import com.distributed.userservice.mapper.UserMapper;
import com.distributed.userservice.security.JwtService;
import com.distributed.userservice.service.UserService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Objects;

@Service
public class UserServiceImpl implements UserService {
    private final UserMapper userMapper;
    private final BCryptPasswordEncoder passwordEncoder;
    private final JwtService jwtService;

    public UserServiceImpl(UserMapper userMapper, JwtService jwtService) {
        this.userMapper = userMapper;
        this.jwtService = jwtService;
        this.passwordEncoder = new BCryptPasswordEncoder();
    }

    @Override
    @Transactional
    public long register(String username, String password, String phone, String email) {
        UserDO existing = userMapper.selectByUsername(username);
        if (existing != null) {
            throw new IllegalArgumentException("用户名已存在");
        }

        UserDO user = new UserDO();
        user.setUsername(username);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setPhone(phone);
        user.setEmail(email);

        userMapper.insert(user);
        return Objects.requireNonNull(user.getId(), "用户ID生成失败");
    }

    @Override
    public String login(String username, String password) {
        UserDO user = userMapper.selectByUsername(username);
        if (user == null) {
            throw new IllegalArgumentException("账号或密码错误");
        }
        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            throw new IllegalArgumentException("账号或密码错误");
        }
        return jwtService.createToken(user.getId(), user.getUsername());
    }

    @Override
    public UserDO getById(long userId) {
        UserDO user = userMapper.selectById(userId);
        if (user == null) {
            throw new IllegalArgumentException("用户不存在");
        }
        return user;
    }
}

