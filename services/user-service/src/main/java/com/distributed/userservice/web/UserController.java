package com.distributed.userservice.web;

import com.distributed.userservice.domain.UserDO;
import com.distributed.userservice.exception.BizException;
import com.distributed.userservice.security.JwtService;
import com.distributed.userservice.service.UserService;
import com.distributed.userservice.web.dto.LoginRequest;
import com.distributed.userservice.web.dto.MeResponse;
import com.distributed.userservice.web.dto.RegisterRequest;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/users")
public class UserController {
    private final UserService userService;
    private final JwtService jwtService;

    public UserController(UserService userService, JwtService jwtService) {
        this.userService = userService;
        this.jwtService = jwtService;
    }

    @PostMapping("/register")
    public ResponseEntity<ApiResponse<Map<String, Object>>> register(@Valid @RequestBody RegisterRequest request) {
        long userId = userService.register(
                request.getUsername(),
                request.getPassword(),
                request.getPhone(),
                request.getEmail()
        );
        String token = userService.login(request.getUsername(), request.getPassword());
        return ResponseEntity.ok(ApiResponse.ok(Map.of("userId", userId, "token", token)));
    }

    @PostMapping("/login")
    public ResponseEntity<ApiResponse<Map<String, Object>>> login(@Valid @RequestBody LoginRequest request) {
        String token = userService.login(request.getUsername(), request.getPassword());
        Claims claims = jwtService.parseClaims(token);
        long userId = Long.parseLong(claims.getSubject());
        return ResponseEntity.ok(ApiResponse.ok(Map.of(
                "token", token,
                "userId", userId,
                "username", request.getUsername()
        )));
    }

    @GetMapping("/me")
    public ResponseEntity<ApiResponse<MeResponse>> me(HttpServletRequest request) {
        Claims claims = jwtService.parseClaims(extractBearerToken(request));
        long userId = Long.parseLong(claims.getSubject());

        UserDO user = userService.getById(userId);
        MeResponse resp = new MeResponse();
        resp.setId(user.getId());
        resp.setUsername(user.getUsername());
        resp.setPhone(user.getPhone());
        resp.setEmail(user.getEmail());
        return ResponseEntity.ok(ApiResponse.ok(resp));
    }

    private String extractBearerToken(HttpServletRequest request) {
        String authHeader = request.getHeader("Authorization");
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            throw new BizException(401, HttpStatus.UNAUTHORIZED, "missing bearer token");
        }
        return authHeader.substring("Bearer ".length());
    }
}
