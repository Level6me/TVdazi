import axios from 'axios';
import { ResourceCategory } from '../../types';
import { CloudDriveProvider, PanSaveOptions, PanSaveResult, PanUserQuota } from './CloudDriveProvider';

/**
 * 115 网盘适配器（支持 Cookie 凭证检查、空间查询与分享链接接收转存）
 */
export class Pan115Provider implements CloudDriveProvider {
  readonly panType = '115' as const;
  readonly displayName = '115网盘';
  private defaultCookie: string;

  constructor(cookie?: string) {
    this.defaultCookie = (cookie || process.env.PAN115_COOKIE || '').trim();
  }

  isConfigured(credential?: string): boolean {
    const ck = (credential || this.defaultCookie || '').trim();
    return ck.includes('UID=') && ck.includes('CID=') && ck.includes('SEID=');
  }

  private getHeaders(cookie: string) {
    return {
      Cookie: cookie,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://115.com/',
    };
  }

  async getUserQuota(credential?: string): Promise<PanUserQuota | null> {
    const ck = (credential || this.defaultCookie || '').trim();
    if (!this.isConfigured(ck)) return null;
    try {
      const resp = await axios.get('https://webapi.115.com/files/index_info', {
        headers: this.getHeaders(ck),
        timeout: 7000,
      });
      const space = resp.data?.data?.space_info;
      if (!space) return null;
      return {
        panType: '115',
        nickname: '115网盘用户',
        totalCapacity: space.all_total?.size_format || '未知',
        usedCapacity: space.all_use?.size_format,
        freeCapacity: space.all_remain?.size_format || '未知',
      };
    } catch {
      return null;
    }
  }

  async verifyShareLink(shareId: string): Promise<boolean> {
    try {
      const resp = await axios.get('https://webapi.115.com/share/snap', {
        params: { share_code: shareId, offset: 0, limit: 1 },
        timeout: 5000,
      });
      return Boolean(resp.data?.state);
    } catch {
      return false;
    }
  }

  async saveShare(
    shareId: string,
    passcode: string,
    category: ResourceCategory,
    options?: PanSaveOptions
  ): Promise<PanSaveResult> {
    const ck = (options?.credential || this.defaultCookie || '').trim();
    const targetPath = `${options?.rootDir || '/我的资源'}/${category}`.replace(/\/+/g, '/');

    if (!this.isConfigured(ck)) {
      return {
        success: false,
        panType: '115',
        targetPath,
        message: '尚未绑定 115 网盘 Cookie（需含 UID/CID/SEID），请发送「/set-115 <Cookie>」后即可一键接收 115 分享！',
      };
    }

    try {
      const snapRes = await axios.get('https://webapi.115.com/share/snap', {
        params: { share_code: shareId, receive_code: passcode || '', offset: 0, limit: 50 },
        headers: this.getHeaders(ck),
        timeout: 8000,
      });
      const list = snapRes.data?.data?.list || [];
      if (!snapRes.data?.state || list.length === 0) {
        return {
          success: false,
          panType: '115',
          targetPath,
          message: snapRes.data?.error || '115 分享链接已失效或缺少访问码',
        };
      }

      const fileIds = list.map((x: any) => x.cid || x.fid).filter(Boolean).join(',');
      const recvRes = await axios.post(
        'https://webapi.115.com/share/receive',
        new URLSearchParams({
          share_code: shareId,
          receive_code: passcode || '',
          file_id: fileIds,
          cid: '0',
        }).toString(),
        {
          headers: {
            ...this.getHeaders(ck),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        }
      );

      if (recvRes.data?.state) {
        return {
          success: true,
          panType: '115',
          targetPath: '/根目录',
          message: `✅ 已成功接收 ${list.length} 项到您的 115 网盘！`,
        };
      }

      return {
        success: false,
        panType: '115',
        targetPath,
        message: `115 转存失败：${recvRes.data?.error || '未知错误'}`,
      };
    } catch (err: any) {
      return {
        success: false,
        panType: '115',
        targetPath,
        message: `115 转存异常：${err.message}`,
      };
    }
  }
}
