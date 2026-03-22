# 商品库存与秒杀系统设计 + 项目骨架（Spring Boot）

## 系统设计文档

### 目标与约束
- **目标**：支持商品浏览、库存扣减、下单支付（此处先实现下单创建）、秒杀高并发下的“防超卖、可追踪、可扩展”。
- **核心约束**：高并发（峰值流量）、库存一致性（不超卖）、接口幂等、可观测、可水平扩展。

### 系统架构草图（服务拆分）
采用微服务拆分（可先单体开发、后按模块拆服务），服务边界如下：用户服务、商品服务、库存服务、订单服务。

```mermaid
flowchart LR
  U[客户端 Web/APP] --> GW[API Gateway/Ingress]
  GW --> AUTH[用户服务 user-service]
  GW --> P[商品服务 product-service]
  GW --> I[库存服务 inventory-service]
  GW --> O[订单服务 order-service]

  subgraph Data[数据与中间件]
    MYSQL[(MySQL)]
    REDIS[(Redis)]
    MQ[(消息队列)]
  end

  AUTH --> MYSQL
  P --> MYSQL
  I --> MYSQL
  O --> MYSQL

  AUTH --> REDIS
  P --> REDIS
  I --> REDIS
  O --> REDIS

  O --> MQ
  I --> MQ
```

#### 服务职责
- **用户服务**：注册/登录、用户资料、鉴权（JWT）、风控基础能力（限流/黑名单可后续加）。
- **商品服务**：商品信息（SPU/SKU）、上下架、价格、活动信息查询（秒杀活动可扩展）。
- **库存服务**：库存查询、预扣/扣减、回滚、对账；秒杀核心一致性点。
- **订单服务**：创建订单、订单状态流转（创建/已支付/已取消/超时关闭）、幂等控制。

### 各服务 API 接口（RESTful，草案）
统一约定：
- Base URL：`/api/v1`
- 认证：`Authorization: Bearer <token>`
- 响应：`{ "code": 0, "message": "OK", "data": ... }`

#### 用户服务（user-service）
- **POST** `/api/v1/users/register`：用户注册（用户名/手机号 + 密码）
- **POST** `/api/v1/users/login`：登录换取 JWT
- **GET** `/api/v1/users/me`：获取当前用户信息（需登录）

请求示例（注册）：
```json
{ "username": "alice", "password": "Passw0rd!" }
```

#### 商品服务（product-service）
- **GET** `/api/v1/products`：分页列表（关键字/类目/上下架）
- **GET** `/api/v1/products/{productId}`：商品详情
- **POST** `/api/v1/products`：创建商品（后台）
- **PATCH** `/api/v1/products/{productId}`：更新商品（后台）

#### 库存服务（inventory-service）
- **GET** `/api/v1/inventories/{skuId}`：查询可用库存
- **POST** `/api/v1/inventories/{skuId}/reserve`：预扣库存（下单前）
- **POST** `/api/v1/inventories/{skuId}/commit`：确认扣减（支付成功/创建订单成功策略二选一）
- **POST** `/api/v1/inventories/{skuId}/release`：释放预扣（取消/超时）

秒杀场景建议（后续实现）：
- Redis 预减库存（Lua 原子）+ 异步落库（MQ）+ 失败补偿（对账任务）
- 或 MySQL 行锁 `update ... set available=available-1 where sku_id=? and available>0`

#### 订单服务（order-service）
- **POST** `/api/v1/orders`：创建订单（幂等键：`Idempotency-Key`）
- **GET** `/api/v1/orders/{orderId}`：订单详情
- **GET** `/api/v1/orders`：我的订单列表
- **POST** `/api/v1/orders/{orderId}/cancel`：取消订单（触发库存释放）

### 数据库 ER 图（用户表、商品表、库存表、订单表）

```mermaid
erDiagram
  USERS ||--o{ ORDERS : places}
  PRODUCTS ||--o{ INVENTORIES : has
  PRODUCTS ||--o{ ORDERS : referenced

  USERS {
    bigint id PK
    varchar username
    varchar password_hash
    varchar phone
    varchar email
    datetime created_at
    datetime updated_at
  }

  PRODUCTS {
    bigint id PK
    varchar title
    varchar sku_code
    decimal price
    tinyint status
    datetime created_at
    datetime updated_at
  }

  INVENTORIES {
    bigint id PK
    bigint product_id FK
    bigint sku_id
    int total
    int available
    int reserved
    int version
    datetime updated_at
  }

  ORDERS {
    bigint id PK
    bigint user_id FK
    bigint product_id FK
    varchar order_no
    int quantity
    decimal amount
    tinyint status
    varchar idempotency_key
    datetime created_at
    datetime updated_at
  }
```

### 技术栈选型说明（初选）
- **语言**：Java 17
- **框架**：Spring Boot 3（Web/Validation）
- **ORM**：MyBatis（配合 XML/注解 Mapper）
- **数据库**：MySQL 8
- **缓存**：Redis（库存热点、令牌桶限流、会话/黑名单）
- **消息队列**：RabbitMQ / Kafka（异步下单、库存落库、延时关单）
- **网关**：Spring Cloud Gateway / Nginx Ingress（后续按部署形态选择）
- **鉴权**：JWT（用户服务签发；其他服务校验）
- **迁移**：Flyway（建表版本化）
- **容器化**：Docker Compose（本地一键起 MySQL/Redis）

---

## 环境准备（本地开发）
- **JDK**：17+
- **Maven**：3.9+
- **Docker Desktop**：用于启动 MySQL/Redis

---

## 当前实现进度
- 已完成：`user-service`、`product-service`、`inventory-service`、`order-service` 四个服务骨架与 API 落地
- 已完成：MyBatis + Flyway 初始化脚本（users/products/inventories/orders）
- 已完成：统一响应结构 `{"code":0,"message":"OK","data":...}`

---

## 当前代码快速启动（四服务）

### 1. 启动依赖（MySQL + Redis）
默认方式（本机 `3306` 空闲）：
1. `docker compose up -d mysql redis`

如果本机 `3306` 被占用，可改用 `3307`（Windows PowerShell）：
1. `docker run -d --name seckill-mysql-3307 -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=seckill -e MYSQL_USER=seckill -e MYSQL_PASSWORD=seckill -e TZ=Asia/Shanghai -p 3307:3306 mysql:8.0 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci --default-authentication-plugin=mysql_native_password`
2. `docker compose up -d redis`

### 2. 配置环境变量
在启动服务前设置（`user-service` 与 `order-service` 必须使用同一 JWT 密钥）：

```powershell
$env:DB_URL="jdbc:mysql://localhost:3306/seckill?useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true"
$env:DB_USERNAME="seckill"
$env:DB_PASSWORD="seckill"
$env:APP_JWT_SECRET="change-me-to-a-long-random-secret-at-least-32-bytes"
```

若你使用 `3307`，把 `DB_URL` 改成：
```powershell
$env:DB_URL="jdbc:mysql://localhost:3307/seckill?useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true"
```

### 3. 编译
1. `mvn -DskipTests package`

### 4. 分别启动 4 个服务（建议四个终端）
1. `mvn -pl services/user-service spring-boot:run`
2. `mvn -pl services/product-service spring-boot:run`
3. `mvn -pl services/inventory-service spring-boot:run`
4. `mvn -pl services/order-service spring-boot:run`

端口：
- `user-service`: `8081`
- `product-service`: `8082`
- `inventory-service`: `8083`
- `order-service`: `8084`

### 5. 打开内置前端页面
启动 `user-service` 后，浏览器访问：
1. `http://localhost:8081/`

页面位置：
1. `services/user-service/src/main/resources/static/index.html`

### 6. 快速自检接口

注册：
```bash
curl -s -X POST "http://localhost:8081/api/v1/users/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"Passw0rd!","phone":"13800000000","email":"alice@example.com"}'
```

登录：
```bash
curl -s -X POST "http://localhost:8081/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"Passw0rd!"}'
```

获取当前用户信息（示例 token 需要替换为登录返回的 token）：
```bash
curl -s -X GET "http://localhost:8081/api/v1/users/me" \
  -H "Authorization: Bearer <token>"
```

创建商品：
```bash
curl -s -X POST "http://localhost:8082/api/v1/products" \
  -H "Content-Type: application/json" \
  -d '{"title":"iPhone 15","skuCode":"SKU-IP15-001","price":5999.00,"status":1}'
```

查询库存：
```bash
curl -s -X GET "http://localhost:8083/api/v1/inventories/10001"
```

创建订单（需要登录 token + 幂等键）：
```bash
curl -s -X POST "http://localhost:8084/api/v1/orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: create-order-demo-001" \
  -d '{"productId":1,"quantity":1,"amount":5999.00}'
```

