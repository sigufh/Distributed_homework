# 分布式作业：Redis 缓存 + MySQL 读写分离 + 可选 ES 搜索

本项目基于 `Node.js + Redis + MySQL 主从 + Nginx + Docker`，实现以下要求：

- 商品详情页缓存（Redis）
- 缓存穿透、击穿、雪崩防护
- MySQL 读写分离（写主库、读从库）
- 代码内可直接验证读写分离效果
- 可选：ElasticSearch 商品搜索

## 1. 目录结构

```text
.
├─ src/server.js              # 后端服务（缓存、读写分离、搜索）
├─ public/index.html          # 演示页面
├─ nginx/nginx.conf           # Nginx 负载均衡 + 动静分离
├─ docker-compose.yml         # Redis + MySQL主从 + 多后端 + Nginx + 可选ES
├─ Dockerfile
└─ package.json
```

## 2. 启动方式

### 2.1 默认启动（不启用 ES）

```bash
docker-compose up -d --build
```

访问：

- 前端页面：`http://localhost/`
- 后端实例：`http://localhost:8081` ~ `8084`
- Redis：`localhost:6379`
- MySQL 主库：`localhost:3307`
- MySQL 从库：`localhost:3308`

### 2.2 启用 ES（可选）

```bash
ES_ENABLED=true docker-compose --profile search up -d --build
```

ES 地址：

- `http://localhost:9200`

## 3. Redis 缓存与三大问题处理

商品详情接口：`GET /api/products/:id`

代码位置：`src/server.js`

- 缓存穿透：
  - 对不存在商品写入空值 `"null"`，短 TTL（`CACHE_NULL_TTL=10s`）
- 缓存击穿：
  - 对热点 key 加 Redis 分布式锁（`SET NX EX` + Lua 安全释放）
  - 其他请求短暂等待并重试缓存
- 缓存雪崩：
  - 正常缓存 TTL 加随机抖动（`60 + [0,60)` 秒）

## 4. MySQL 读写分离

### 4.1 环境

- 主库：`mysql-master`
- 从库：`mysql-replica`
- 容器使用 `bitnami/mysql` 复制模式

### 4.2 代码读写路由

`src/server.js` 中实现：

- 写操作走主库（`writePool`）
- 读操作走从库（`readPools`，轮询）

典型接口：

- 读详情（走从库）：`GET /api/products/:id`
- 写库存（走主库）：`PUT /api/products/:id/stock`

写后会执行：

- 删除 Redis 商品缓存，保证下次读到新数据
- 若 ES 开启则同步索引文档

## 5. 在代码中测试读写分离效果

新增验证接口：

- `GET /api/db/rw-status`
  - 返回当前写节点和读节点信息（`@@hostname`, `@@read_only`）
- `POST /api/db/rw-test`
  - 示例参数：`{ "id": 1, "delta": 5, "waitMs": 1200 }`
  - 执行过程：
    1. 读主库和从库库存（写前）
    2. 向主库写入库存变化
    3. 立即再次读取主库和从库
    4. 等待 `waitMs` 后再次读从库
  - 用于观察主从复制延迟与读写分离效果

## 6. 商品搜索（可选）

接口：`GET /api/products/search?q=Redis&limit=10`

- 若 `ES_ENABLED=true` 且 ES 可用：优先走 ElasticSearch
- 若 ES 不可用或关闭：自动降级到数据库 `LIKE` 搜索

## 7. 页面演示

`public/index.html` 提供了以下可视化操作：

- 商品详情查询（命中缓存与回源观察）
- 库存更新（写主库 + 删缓存）
- 查看主从路由状态
- 一键执行读写分离测试
- 商品搜索（ES 或 DB）
- 实例请求计数展示

## 8. 常用测试命令（可选）

```bash
# 商品详情（走 Nginx）
curl http://localhost/api/products/1

# 写库存（主库写入）
curl -X PUT http://localhost/api/products/1/stock \
  -H "Content-Type: application/json" \
  -d '{"stock": 888}'

# 查看读写节点
curl http://localhost/api/db/rw-status

# 读写分离测试
curl -X POST http://localhost/api/db/rw-test \
  -H "Content-Type: application/json" \
  -d '{"id":1,"delta":5,"waitMs":1200}'

# 搜索（ES 开启时优先用 ES）
curl "http://localhost/api/products/search?q=Redis&limit=10"
```

## 9. 停止服务

```bash
docker-compose down
```

如果需要同时删除数据卷（清空 MySQL/ES 持久化数据）：

```bash
docker-compose down -v
```
