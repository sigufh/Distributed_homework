package com.distributed.userservice.service.impl;

import com.distributed.userservice.domain.UserDO;
import com.distributed.userservice.exception.BizException;
import com.distributed.userservice.mapper.UserMapper;
import com.distributed.userservice.security.JwtService;
import com.distributed.userservice.service.UserService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Locale;
import java.util.Objects;

@Service
public class UserServiceImpl implements UserService {
    private static final int BIZ_BAD_REQUEST = 400;
    private static final int BIZ_UNAUTHORIZED = 401;
    private static final int BIZ_NOT_FOUND = 404;

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
            throw new BizException(BIZ_BAD_REQUEST, HttpStatus.BAD_REQUEST, "username already exists");
        }

        UserDO user = new UserDO();
        user.setUsername(username);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setPhone(phone);
        user.setEmail(email);

        try {
            userMapper.insert(user);
        } catch (DuplicateKeyException ex) {
            String message = ex.getMessage() == null ? "" : ex.getMessage().toLowerCase(Locale.ROOT);
            if (message.contains("uk_users_phone")) {
                throw new BizException(BIZ_BAD_REQUEST, HttpStatus.BAD_REQUEST, "phone already exists");
            }
            if (message.contains("uk_users_username")) {
                throw new BizException(BIZ_BAD_REQUEST, HttpStatus.BAD_REQUEST, "username already exists");
            }
            throw new BizException(BIZ_BAD_REQUEST, HttpStatus.BAD_REQUEST, "duplicate user data");
        }

        return Objects.requireNonNull(user.getId(), "Failed to create user id");
    }

    @Override
    public String login(String username, String password) {
        UserDO user = userMapper.selectByUsername(username);
        if (user == null || !passwordEncoder.matches(password, user.getPasswordHash())) {
            throw new BizException(BIZ_UNAUTHORIZED, HttpStatus.UNAUTHORIZED, "invalid username or password");
        }
        return jwtService.createToken(user.getId(), user.getUsername());
    }

    @Override
    public UserDO getById(long userId) {
        UserDO user = userMapper.selectById(userId);
        if (user == null) {
            throw new BizException(BIZ_NOT_FOUND, HttpStatus.NOT_FOUND, "user not found");
        }
        return user;
    }
}
