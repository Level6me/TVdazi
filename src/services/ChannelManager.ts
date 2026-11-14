import * as path from 'path';
import { upsertEnvVar } from '../utils/FileUtils';

export interface ChannelItem {
  name: string;
  id: string;
}

export class ChannelManager {
  private channels: ChannelItem[] = [];
  private envPath: string;

  constructor(envPath?: string) {
    this.envPath = envPath || path.resolve(process.cwd(), '.env');
    this.loadChannels();
  }

  /**
   * 加载当前配置的频道
   */
  loadChannels(): ChannelItem[] {
    const raw = process.env.TG_CHANNELS || '';
    const defaultIds = [
      'shareAliyun',
      'Quark_Movies',
      'hao115',
      'guaguale115',
      'alyp_1',
      'zaihuayun',
      'PanjClub',
      'yunpanshare',
      'XiangxiuNB',
      'Aliyun_4K_Movies',
      'tgsearchers',
      'pan115_share',
      'tianyirigeng',
      'xx123pan',
      'zyzhpd123',
      'cloudtianyi',
      'tyypzhpd',
      'Oscar_4Kmovies',
      'ydypzyfx',
      'bdwpzhpd',
      'yunpanall',
      'NewQuark',
      'NewAliPan',
      'Q66share',
      'BaiduCloudDisk',
      'yunpan139',
      'yunpanuc',
      'yunpanpan',
      'qixingzhenren',
      'pankuake_share',
      'duanjucabian',
      'yoyokuakeduanju',
      'Channel_Shares_115',
      'yeqingjie_GJG666',
      'gotopan',
      'oneonefivewpfx',
      'xxziliao',
      'sndkdkdl',
      'hsndn1',
      'xuexixiaonengshou1',
      'zhenyingsg',
      'movielover8888_TV',
      'ucquark',
      'weichengduanju666',
      'yingxiangkj',
      'alyp_Animation',
      'alyp_4K_Movies',
      'BTCloudlinks',
      'QuarkFree',
      'jnjy_5'
    ];

    const channelIds = raw
      ? raw.split(',').map((c) => c.trim()).filter(Boolean)
      : defaultIds;

    this.channels = channelIds.map((id) => ({
      name: id,
      id,
    }));
    return this.channels;
  }

  getChannels(): ChannelItem[] {
    return this.channels;
  }

  cleanTelegramId(input: string): { name: string; id: string } | null {
    const s = input.trim();
    if (!s) return null;

    if (s.includes(',') || s.includes('，')) {
      const parts = s.split(/,|，/).map((p) => p.trim());
      if (parts.length >= 2 && parts[1]) {
        const id = this.extractIdOnly(parts[1]);
        if (id) return { name: parts[0], id };
      }
    }

    const id = this.extractIdOnly(s);
    if (id) {
      return { name: id, id };
    }
    return null;
  }

  private extractIdOnly(str: string): string {
    const urlMatch = str.match(/(?:https?:\/\/)?t\.me\/(?:s\/)?([a-zA-Z0-9_]+)/i);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }
    if (str.startsWith('@')) {
      return str.slice(1).trim();
    }
    if (/^[a-zA-Z0-9_]{3,}$/.test(str.trim())) {
      return str.trim();
    }
    return '';
  }

  addChannel(input: string): { success: boolean; added: string[]; message: string } {
    const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
    const added: string[] = [];

    for (const line of lines) {
      const item = this.cleanTelegramId(line);
      if (item && !this.channels.some((c) => c.id.toLowerCase() === item.id.toLowerCase())) {
        this.channels.push(item);
        added.push(item.id);
      }
    }

    if (added.length === 0) {
      return {
        success: false,
        added: [],
        message: '未能识别有效的新频道或频道已存在。支持格式：@频道ID、https://t.me/s/频道ID 或 名称,ID',
      };
    }

    const allIds = this.channels.map((c) => c.id).join(',');
    process.env.TG_CHANNELS = allIds;
    this.persistEnv('TG_CHANNELS', allIds);

    return {
      success: true,
      added,
      message: `成功添加 ${added.length} 个资源频道：${added.join(', ')}`,
    };
  }

  private persistEnv(key: string, value: string) {
    try {
      upsertEnvVar(this.envPath, key, value);
    } catch (err: any) {
      console.error('[ChannelManager] 持久化 .env 失败:', err.message);
    }
  }
}
