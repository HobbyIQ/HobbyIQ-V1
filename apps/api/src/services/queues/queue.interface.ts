export interface QueueMessage<T> {
  id: string;
  payload: T;
  attempts: number;
  createdAt: string;
}

export interface QueueService<T> {
  enqueue(queueName: string, payload: T): Promise<void>;
  dequeue(queueName: string): Promise<QueueMessage<T> | null>;
  ack(queueName: string, messageId: string): Promise<void>;
  retry(queueName: string, message: QueueMessage<T>): Promise<void>;
}
