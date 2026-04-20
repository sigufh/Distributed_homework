local stockKey = KEYS[1]
local userOrderKey = KEYS[2]
local orderId = ARGV[1]
local ttl = tonumber(ARGV[2])

if redis.call("EXISTS", userOrderKey) == 1 then
  return {2, redis.call("GET", userOrderKey)}
end

local stock = tonumber(redis.call("GET", stockKey) or "-1")
if stock <= 0 then
  return {0, tostring(stock)}
end

redis.call("DECR", stockKey)
redis.call("SET", userOrderKey, orderId, "EX", ttl)
return {1, tostring(stock - 1)}
