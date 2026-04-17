// Abstracts queue operations for Azure or other providers
export interface QueueAbstraction<T> {
  enqueue(item: T): Promise<void>;
  dequeue(): Promise<T | null>;
  peek(): Promise<T | null>;
  length(): Promise<number>;
}
