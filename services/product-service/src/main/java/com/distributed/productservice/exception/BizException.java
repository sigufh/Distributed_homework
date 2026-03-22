package com.distributed.productservice.exception;

import org.springframework.http.HttpStatus;

public class BizException extends RuntimeException {
    private final int code;
    private final HttpStatus status;

    public BizException(int code, HttpStatus status, String message) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public int getCode() {
        return code;
    }

    public HttpStatus getStatus() {
        return status;
    }
}
