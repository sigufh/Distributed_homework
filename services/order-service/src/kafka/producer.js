const { Kafka } = require("kafkajs");

const kafkaEnabled = (process.env.KAFKA_ENABLED || "false").toLowerCase() === "true";
const kafkaBrokers = (process.env.KAFKA_BROKERS || "kafka:9092").split(",").map((v) => v.trim()).filter(Boolean);
const kafkaClientId = process.env.KAFKA_CLIENT_ID || "order-service";
const kafkaTopic = process.env.KAFKA_TOPIC_SECKILL_ORDER || "seckill-order-create";
const kafkaTopicPayResult = process.env.KAFKA_TOPIC_PAYMENT_RESULT || "order-payment-result";

let kafkaProducer = null;
let kafkaReady = false;

async function initKafkaProducer() {
  if (!kafkaEnabled) return null;
  const kafka = new Kafka({ clientId: kafkaClientId, brokers: kafkaBrokers });
  kafkaProducer = kafka.producer();
  await kafkaProducer.connect();
  kafkaReady = true;
  console.log(`[kafka] producer connected, topic=${kafkaTopic}`);
  return kafkaProducer;
}

async function sendOrderCreateMessage(payload) {
  if (!kafkaProducer || !kafkaReady) { return false; }
  await kafkaProducer.send({ topic: kafkaTopic, messages: [{ key: String(payload.userId), value: JSON.stringify(payload) }] });
  return true;
}

async function sendPaymentResultMessage(payload) {
  if (!kafkaProducer || !kafkaReady) { return false; }
  await kafkaProducer.send({ topic: kafkaTopicPayResult, messages: [{ key: String(payload.orderId), value: JSON.stringify(payload) }] });
  return true;
}

function isKafkaReady() { return kafkaReady; }

module.exports = { initKafkaProducer, sendOrderCreateMessage, sendPaymentResultMessage, isKafkaReady };
