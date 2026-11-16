import axios from 'axios';
import * as crypto from 'crypto';
import { createLogger } from '../utils/Logger';

const log = createLogger('WebhookService');

export interface MediaSavedPayload {
  event: 'media.saved';
  userId: string;
  title?: string;
  category?: string;
  panType: string;
  targetPath: string;
  shareUrl?: string;
  timestamp: number;
}

/**
 * 媒体库联动 Webhook 通知服务（支持 Alist 刷新 / Emby & Jellyfin 扫库触发）
 */
export class WebhookService {
  static async notifyMediaSaved(
    webhookUrl: string | undefined,
    payload: Omit<MediaSavedPayload, 'event' | 'timestamp'>
  ): Promise<boolean> {
    const target = (webhookUrl || process.env.MEDIA_WEBHOOK_URL || '').trim();
    if (!target || !/^https?:\/\//i.test(target)) {
      return false;
    }

    const fullPayload: MediaSavedPayload = {
      event: 'media.saved',
      ...payload,
      timestamp: Date.now(),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'TVdazi-Webhook/1.0',
    };

    const secret = (process.env.MEDIA_WEBHOOK_SECRET || '').trim();
    if (secret) {
      const sig = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(fullPayload))
        .digest('hex');
      headers['X-TVdazi-Signature'] = `sha256=${sig}`;
    }

    try {
      await axios.post(target, fullPayload, { headers, timeout: 4500 });
      log.info(`媒体库 Webhook 通知成功 -> ${payload.targetPath}`);
      return true;
    } catch (err: any) {
      log.warn(`媒体库 Webhook 通知失败: ${err.message}`);
      return false;
    }
  }
}
