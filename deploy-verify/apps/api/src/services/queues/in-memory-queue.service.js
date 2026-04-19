"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryQueueService = void 0;
const crypto_1 = require("crypto");
class InMemoryQueueService {
    constructor() {
        this.queues = new Map();
    }
    async enqueue(queueName, payload) {
        const queue = this.queues.get(queueName) ?? [];
        queue.push({
            id: (0, crypto_1.randomUUID)(),
            payload,
            attempts: 0,
            createdAt: new Date().toISOString(),
        });
        this.queues.set(queueName, queue);
    }
    async dequeue(queueName) {
        const queue = this.queues.get(queueName) ?? [];
        const message = queue.shift() ?? null;
        this.queues.set(queueName, queue);
        return message;
    }
    async ack(_queueName, _messageId) { }
    async retry(queueName, message) {
        const queue = this.queues.get(queueName) ?? [];
        queue.push({ ...message, attempts: message.attempts + 1 });
        this.queues.set(queueName, queue);
    }
}
exports.InMemoryQueueService = InMemoryQueueService;
