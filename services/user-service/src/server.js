const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const Redis = require("ioredis");
const { initMysql: initMysqlDb } = require("./db");
const usersRouter = require("./routes/users");

const DEFAULT_PORT = parseInt(process.env.PORT || "8084", 10);
const args = process.argv.slice(2);
let port = DEFAULT_PORT;
const idx = args.indexOf("--port");
if (idx !== -1 && args[idx + 1]) { port = parseInt(args[idx + 1], 10) || DEFAULT_PORT; }

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan(":date[iso] :remote-addr :method :url :status - :response-time ms"));

const redis = new Redis({ host: process.env.REDIS_HOST || "redis", port: parseInt(process.env.REDIS_PORT || "6379", 10) });
redis.on("error", (err) => console.error("[redis] error:", err.message));

app.set("redis", redis);

app.use("/api/users", usersRouter);

app.get("/api/instance/info", (req, res) => {
  res.json({ code: 0, msg: "OK", data: { port, pid: process.pid } });
});

app.get("/", (req, res) => { res.send(`User service running on port ${port}`); });

async function bootstrap() {
  await initMysqlDb();
  app.listen(port, () => { console.log(`User service started on port ${port}`); });
}

bootstrap();
