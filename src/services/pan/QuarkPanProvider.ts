import axios from 'axios';
import { ResourceCategory } from '../../types';
import { QuarkService } from '../QuarkService';
import { CloudDriveProvider, PanSaveOptions, PanSaveResult, PanUserQuota } from './CloudDriveProvider';

export class QuarkPanProvider implements CloudDriveProvider {
  readonly panType = 'quark' as const;
  readonly displayName = '夸克网盘';
  private quarkService: QuarkService;

  constructor(quarkService?: QuarkService) {
    this.quarkService = quarkService || new QuarkService();
  }

  isConfigured(credential?: string): boolean {
    return this.quarkService.isConfigured(credential);
  }

  async getUserQuota(credential?: string): Promise<PanUserQuota | null> {
    const info = await this.quarkService.getUserInfo(credential);
    if (!info) return null;
    return {
      panType: 'quark',
      nickname: info.nickname,
      totalCapacity: info.totalCapacity,
      usedCapacity: info.usedCapacity,
      freeCapacity: info.freeCapacity,
      usagePercent: info.usagePercent,
      freeBytes: info.freeBytes,
    };
  }

  async verifyShareLink(shareId: string): Promise<boolean> {
    try {
      const resp = await axios.get(`https://pan.quark.cn/s/${shareId}`, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
        },
      });
      return !String(resp.data || '').includes('分享已失效') && !String(resp.data || '').includes('分享不存在');
    } catch {
      return true;
    }
  }

  async saveShare(
    shareId: string,
    passcode: string,
    category: ResourceCategory,
    options?: PanSaveOptions
  ): Promise<PanSaveResult> {
    const res = await this.quarkService.saveShareFiles(shareId, passcode, category, {
      customCookie: options?.credential,
      rootDir: options?.rootDir,
      standardTitle: options?.standardTitle,
      userId: options?.userId,
      autoCleanCensor: options?.autoCleanCensor,
    });
    return {
      success: res.success,
      panType: 'quark',
      message: res.message,
      targetPath: res.targetPath,
      renamedItems: res.renamedItems,
    };
  }
}
