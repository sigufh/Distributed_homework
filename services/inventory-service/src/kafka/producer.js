const { Kafka } = require("kafkajs");

const kafkaEnabled = (process.env.KAFKA_ENABLED || "false").toLowerCase() === "true";
const kafkaBrokers = (process.env.KAFKA_BROKERS || "kafka:9092").split(",").map((v) => v.trim()).filter(Boolean);
const kafkaClientId = process.env.KAFKA_CLIENT_ID || "inventory-service";

let kafkaProducer = null;
let kafkaReady = false;

async function initKafkaProducer() {
  if (!kafkaEnabled) return null;
  const kafka = new Kafka({ clientId: kafkaClientId, brokers: kafkaBrokers });
  kafkaProducer = kafka.producer();
  await kafkaProducer.connect();
  kafkaReady = true;
  console.log("[kafka] producer connected");
  return kafkaProducer;
}

function isKafkaReady() { return kafkaReady; }

module.exports = { initKafkaProducer, isKafkaReady };
