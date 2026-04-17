import { QueueMessage, QueueService } from "./queue.interface";
import { randomUUID } from "crypto";

export class InMemoryQueueService<T> implements QueueService<T> {
  private readonly queues = new Map<string, QueueMessage<T>[]>()

  async enqueue(queueName: string, payload: T): Promise<void> {
    const queue = this.queues.get(queueName) ?? [];
    queue.push({
      id: randomUUID(),
      payload,
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
    this.queues.set(queueName, queue);
  }

  async dequeue(queueName: string): Promise<QueueMessage<T> | null> {
    const queue = this.queues.get(queueName) ?? [];
    const message = queue.shift() ?? null;
    this.queues.set(queueName, queue);
    return message;
  }

  async ack(_queueName: string, _messageId: string): Promise<void> {}

  async retry(queueName: string, message: QueueMessage<T>): Promise<void> {
    const queue = this.queues.get(queueName) ?? [];
    queue.push({ ...message, attempts: message.attempts + 1 });
    this.queues.set(queueName, queue);
  }
}
