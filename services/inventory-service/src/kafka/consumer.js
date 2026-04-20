const { Kafka } = require("kafkajs");
const { compensateReservation } = require("../utils/compensation");

const kafkaEnabled = (process.env.KAFKA_ENABLED || "false").toLowerCase() === "true";
const kafkaBrokers = (process.env.KAFKA_BROKERS || "kafka:9092")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const kafkaClientId = process.env.KAFKA_CLIENT_ID || "inventory-service";
const kafkaTopicPayResult = process.env.KAFKA_TOPIC_PAYMENT_RESULT || "order-payment-result";
const kafkaConsumerGroup = process.env.KAFKA_CONSUMER_GROUP_PAYMENT || "inventory-payment-worker";

let kafkaConsumer = null;
let kafkaReady = false;

async function initKafkaConsumer(redis) {
  if (!kafkaEnabled) return null;
  const kafka = new Kafka({ clientId: kafkaClientId, brokers: kafkaBrokers });
  kafkaConsumer = kafka.consumer({ groupId: kafkaConsumerGroup });
  await kafkaConsumer.connect();
  await kafkaConsumer.subscribe({ topic: kafkaTopicPayResult, fromBeginning: false });
  await kafkaConsumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try {
        const payload = JSON.parse(message.value.toString());
        if (payload.status === "FAILED") {
          await compensateReservation(redis, payload.orderId, payload.userId, payload.productId, {
            reason: payload.failReason || "payment-failed",
          });
        }
      } catch (err) {
        console.error("[kafka] inventory payment result consume failed:", err.message);
      }
    },
  });
  kafkaReady = true;
  console.log(`[kafka] inventory payment consumer ready, topic=${kafkaTopicPayResult}`);
  return kafkaConsumer;
}

function isKafkaReady() {
  return kafkaReady;
}

module.exports = { initKafkaConsumer, isKafkaReady };
