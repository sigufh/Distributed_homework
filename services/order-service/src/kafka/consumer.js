const { Kafka } = require("kafkajs");
const { processSeckillOrderMessage } = require("../orderProcessor");

const kafkaEnabled = (process.env.KAFKA_ENABLED || "false").toLowerCase() === "true";
const kafkaBrokers = (process.env.KAFKA_BROKERS || "kafka:9092").split(",").map((v) => v.trim()).filter(Boolean);
const kafkaClientId = process.env.KAFKA_CLIENT_ID || "order-service";
const kafkaTopic = process.env.KAFKA_TOPIC_SECKILL_ORDER || "seckill-order-create";
const kafkaTopicPayResult = process.env.KAFKA_TOPIC_PAYMENT_RESULT || "order-payment-result";
const kafkaConsumerGroup = process.env.KAFKA_CONSUMER_GROUP || "seckill-order-worker";

let kafkaConsumer = null;
let kafkaReady = false;

async function initKafkaConsumer(options = {}) {
  if (!kafkaEnabled) return null;
  const redis = options.redis;
  const onPaymentResult = options.onPaymentResult;
  const kafka = new Kafka({ clientId: kafkaClientId, brokers: kafkaBrokers });
  kafkaConsumer = kafka.consumer({ groupId: kafkaConsumerGroup });
  await kafkaConsumer.connect();
  await kafkaConsumer.subscribe({ topic: kafkaTopic, fromBeginning: false });
  await kafkaConsumer.subscribe({ topic: kafkaTopicPayResult, fromBeginning: false });
  await kafkaConsumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const payload = JSON.parse(message.value.toString());
      if (topic === kafkaTopic) {
        await processSeckillOrderMessage(payload, "kafka", redis);
        return;
      }
      if (topic === kafkaTopicPayResult && typeof onPaymentResult === "function") {
        await onPaymentResult(payload);
      }
    },
  });
  kafkaReady = true;
  console.log(`[kafka] consumer connected, topics=${kafkaTopic},${kafkaTopicPayResult}`);
  return kafkaConsumer;
}

function isKafkaReady() { return kafkaReady; }

module.exports = { initKafkaConsumer, isKafkaReady };
