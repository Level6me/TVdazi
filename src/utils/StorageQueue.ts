import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from './FileUtils';

/**
 * 串行化 JSON 原子落盘队列：
 * 对同一文件路径的并发写操作进行合并与异步串行排队，避免 Read-Modify-Write 竞态覆写丢失更新
 */
export class SerializedJsonStore {
  private static queues = new Map<string, Promise<void>>();
  private static pendingContent = new Map<string, string>();
  private static tmpSeq = 0;

  /**
   * 同步安全写入（用于进程退出前或需要立即落盘的场景）
   */
  static writeSync(filePath: string, data: unknown): void {
    const serialized = JSON.stringify(data, null, 2);
    atomicWriteFileSync(filePath, serialized);
  }

  /**
   * 异步串行原子落盘（同一文件路径的并发写入会自动合并为最新快照并按序原子替换）
   */
  static enqueueWrite(filePath: string, data: unknown): Promise<void> {
    const serialized = JSON.stringify(data, null, 2);
    this.pendingContent.set(filePath, serialized);

    const existing = this.queues.get(filePath);
    if (existing) {
      return existing;
    }

    const job = (async () => {
      // 让出当前微任务微周期，使同一事件循环周期内的多次并发修改合并为最新快照
      await Promise.resolve();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      try {
        while (this.pendingContent.has(filePath)) {
          const next = this.pendingContent.get(filePath)!;
          this.pendingContent.delete(filePath);
          const seq = ++this.tmpSeq;
          const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${seq}.tmp`;
          await fs.promises.writeFile(tmpPath, next, 'utf-8');
          await fs.promises.rename(tmpPath, filePath);
        }
      } finally {
        this.queues.delete(filePath);
      }
    })();

    this.queues.set(filePath, job);
    return job;
  }
}
