import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { SerializedJsonStore } from '../utils/StorageQueue';

export interface ChannelHealthRecord {
  channelId: string;
  successCount: number;
  failCount: number;
  hitCount: number; // 成功提取到网盘链接的次数
  consecutiveFails: number;
  avgLatencyMs: number;
  lastSuccessAt?: number;
  lastFailAt?: number;
  circuitOpenUntil?: number;
}

/**
 * Telegram 资源频道健康度追踪与动态熔断器
 * - 连续失败 >= 3 次自动熔断 5 分钟，避免慢频道拖垮全网检索
 * - 根据成功率、平均延迟与有效命中率动态排序频道执行优先级
 */
export class ChannelHealthService {
  private static instance: ChannelHealthService;
  private records = new Map<string, ChannelHealthRecord>();
  private readonly storePath: string;
  private readonly failThreshold = 3;
  private readonly circuitCooldownMs = 5 * 60 * 1000;
  private saveTimer: NodeJS.Timeout | null = null;
  private activeProbePromise: Promise<Array<ChannelHealthRecord & { score: number; circuitOpen: boolean }>> | null = null;

  private constructor(storePath?: string) {
    this.storePath = storePath || path.resolve(process.cwd(), 'data/channel_health.json');
    this.load();
  }

  static getInstance(): ChannelHealthService {
    if (!ChannelHealthService.instance) {
      ChannelHealthService.instance = new ChannelHealthService();
    }
    return ChannelHealthService.instance;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if (Array.isArray(parsed)) {
          for (const rec of parsed) {
            if (rec && rec.channelId) {
              this.records.set(rec.channelId, rec);
            }
          }
        }
      }
    } catch {
      this.records.clear();
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      SerializedJsonStore.enqueueWrite(this.storePath, Array.from(this.records.values())).catch(() => {});
    }, 3000);
    this.saveTimer.unref?.();
  }

  private getOrCreate(channelId: string): ChannelHealthRecord {
    let rec = this.records.get(channelId);
    if (!rec) {
      rec = {
        channelId,
        successCount: 0,
        failCount: 0,
        hitCount: 0,
        consecutiveFails: 0,
        avgLatencyMs: 0,
      };
      this.records.set(channelId, rec);
    }
    return rec;
  }

  isCircuitOpen(channelId: string, now: number = Date.now()): boolean {
    const rec = this.records.get(channelId);
    if (!rec || !rec.circuitOpenUntil) return false;
    if (now >= rec.circuitOpenUntil) {
      // 冷却期结束，进入半开探测状态
      rec.circuitOpenUntil = undefined;
      rec.consecutiveFails = Math.max(0, this.failThreshold - 1);
      return false;
    }
    return true;
  }

  recordSuccess(channelId: string, latencyMs: number, extractedItems: number = 0): void {
    const rec = this.getOrCreate(channelId);
    rec.successCount += 1;
    if (extractedItems > 0) {
      rec.hitCount += 1;
    }
    rec.consecutiveFails = 0;
    rec.circuitOpenUntil = undefined;
    rec.lastSuccessAt = Date.now();
    rec.avgLatencyMs =
      rec.avgLatencyMs <= 0
        ? Math.round(latencyMs)
        : Math.round(rec.avgLatencyMs * 0.7 + latencyMs * 0.3);
    this.schedulePersist();
  }

  recordFailure(channelId: string, latencyMs: number = 5500): void {
    const rec = this.getOrCreate(channelId);
    rec.failCount += 1;
    rec.consecutiveFails += 1;
    rec.lastFailAt = Date.now();
    rec.avgLatencyMs =
      rec.avgLatencyMs <= 0
        ? Math.round(latencyMs)
        : Math.round(rec.avgLatencyMs * 0.7 + latencyMs * 0.3);

    if (rec.consecutiveFails >= this.failThreshold) {
      rec.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
    }
    this.schedulePersist();
  }

  /**
   * 计算频道健康评分 (0~100)
   */
  getHealthScore(channelId: string): number {
    const rec = this.records.get(channelId);
    if (!rec) return 75; // 未知新频道给予中等基准分以获得探测机会
    if (this.isCircuitOpen(channelId)) return 0;

    const total = rec.successCount + rec.failCount;
    if (total === 0) return 75;

    const successRate = rec.successCount / total;
    const hitRate = rec.successCount > 0 ? rec.hitCount / rec.successCount : 0;
    const latencyPenalty = Math.min(25, Math.max(0, (rec.avgLatencyMs - 1000) / 180));

    return Math.max(5, Math.min(100, Math.round(successRate * 75 + hitRate * 25 - latencyPenalty)));
  }

  /**
   * 过滤掉熔断中的频道，并按健康评分降序排列（若全部熔断则放开保底全量探测）
   */
  prioritizeChannels(channels: string[]): string[] {
    const now = Date.now();
    const healthy = channels.filter((c) => !this.isCircuitOpen(c, now));
    const pool = healthy.length > 0 ? [...healthy] : [...channels];

    return pool.sort((a, b) => this.getHealthScore(b) - this.getHealthScore(a));
  }

  getAllStats(allChannelIds?: string[]): Array<ChannelHealthRecord & { score: number; circuitOpen: boolean }> {
    const now = Date.now();
    const ids = allChannelIds && allChannelIds.length > 0
      ? Array.from(new Set([...allChannelIds, ...this.records.keys()]))
      : Array.from(this.records.keys());

    return ids
      .map((id) => {
        const rec = this.records.get(id) || {
          channelId: id,
          successCount: 0,
          failCount: 0,
          hitCount: 0,
          consecutiveFails: 0,
          avgLatencyMs: 0,
        };
        return {
          ...rec,
          score: this.getHealthScore(id),
          circuitOpen: this.isCircuitOpen(id, now),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  resetChannel(channelId: string): void {
    this.records.delete(channelId);
    this.schedulePersist();
  }

  private persistNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      SerializedJsonStore.writeSync(this.storePath, Array.from(this.records.values()));
    } catch {
      this.schedulePersist();
    }
  }

  /**
   * 并发探测 Telegram 频道真实可达性与响应延迟，并持久化健康度评分
   */
  async probeChannels(
    channelIds: string[],
    concurrency: number = 12,
    timeoutMs: number = 3500
  ): Promise<Array<ChannelHealthRecord & { score: number; circuitOpen: boolean }>> {
    if (this.activeProbePromise) {
      return this.activeProbePromise;
    }

    const targets = Array.from(new Set(channelIds.map((id) => String(id || '').trim()).filter(Boolean)));
    if (targets.length === 0) {
      return this.getAllStats([]);
    }

    this.activeProbePromise = (async () => {
      let cursor = 0;
      const workerCount = Math.min(Math.max(1, concurrency), targets.length);
      const netdiskHintRegex = /(?:pan\.quark\.cn|alipan\.com|aliyundrive\.com|115\.com|anxia\.com|drive\.uc\.cn|pan\.baidu\.com|123pan)/i;

      const worker = async () => {
        while (cursor < targets.length) {
          const channelId = targets[cursor++];
          const start = Date.now();
          try {
            const url = `https://t.me/s/${encodeURIComponent(channelId)}`;
            const resp = await axios.get(url, {
              timeout: timeoutMs,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              },
            });
            const latency = Math.max(1, Date.now() - start);
            const html = typeof resp.data === 'string' ? resp.data : '';
            if (resp.status >= 200 && resp.status < 400 && html.includes('tgme_widget_message')) {
              const hasNetdiskHit = netdiskHintRegex.test(html);
              this.recordSuccess(channelId, latency, hasNetdiskHit ? 1 : 0);
            } else {
              this.recordFailure(channelId, latency);
            }
          } catch {
            const latency = Math.max(1, Date.now() - start);
            this.recordFailure(channelId, latency);
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      this.persistNow();
      return this.getAllStats(targets);
    })();

    try {
      return await this.activeProbePromise;
    } finally {
      this.activeProbePromise = null;
    }
  }
}
