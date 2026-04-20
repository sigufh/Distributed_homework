const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const Redis = require("ioredis");
const { initMysql, isMysqlReady } = require("./db");
const { initKafkaConsumer, isKafkaReady } = require("./kafka/consumer");
const inventoryRouter = require("./routes/inventory");
const { syncSeckillStockFromDb } = require("./redis");

const DEFAULT_PORT = parseInt(process.env.PORT || "8083", 10);
const args = process.argv.slice(2);
let port = DEFAULT_PORT;
const index = args.indexOf("--port");
if (index !== -1 && args[index + 1]) {
  port = parseInt(args[index + 1], 10) || DEFAULT_PORT;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan(":date[iso] :remote-addr :method :url :status - :response-time ms"));

const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});
redis.on("error", (err) => console.error("[redis] error:", err.message));

app.set("redis", redis);

app.use("/api", inventoryRouter);

app.get("/api/instance/info", (req, res) => {
  res.json({
    code: 0,
    msg: "OK",
    data: {
      port,
      pid: process.pid,
      mysqlReady: isMysqlReady(),
      kafkaReady: isKafkaReady(),
    },
  });
});

app.get("/", (req, res) => {
  res.send(`Inventory service running on port ${port}`);
});

async function bootstrap() {
  try {
    await initMysql();
    await syncSeckillStockFromDb(redis);
  } catch (err) {
    console.error("[mysql] inventory init failed:", err.message);
  }

  try {
    await initKafkaConsumer(redis);
  } catch (err) {
    console.error("[kafka] inventory init failed:", err.message);
  }

  app.listen(port, () => {
    console.log(`Inventory service started on port ${port}`);
  });
}

bootstrap();
